use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

static ACTIVE_WATCHERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_watchers() -> &'static Mutex<HashSet<String>> {
    ACTIVE_WATCHERS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeStatusEvent {
    pub node_id: String,
    pub state: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresignResponse {
    already_exists: bool,
    storage_key: String,
    upload_url: Option<String>,
}

fn compute_sha256_with_retry(path: &Path) -> Result<String, String> {
    for attempt in 0..5 {
        match fs::read(path) {
            Ok(bytes) => {
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                return Ok(hex::encode(hasher.finalize()));
            }
            Err(_) if attempt < 4 => {
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => return Err(format!("读取本地文件失败: {}", e)),
        }
    }
    Err("无法读取被占用的本地文件".to_string())
}

fn is_office_temp_file(name: &str) -> bool {
    name.starts_with("~$")
        || name.starts_with("~WRL")
        || name.ends_with(".tmp")
        || name.ends_with(".TMP")
}

#[tauri::command]
pub async fn open_office_node(
    app: AppHandle,
    node_id: String,
    file_name: String,
    download_url: String,
    sha256: String,
    base_version: i32,
    api_base: String,
    auth_token: String,
) -> Result<String, String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取本地缓存目录失败: {}", e))?;
    let node_dir: PathBuf = cache_root.join("office_workspace").join(&node_id);
    fs::create_dir_all(&node_dir).map_err(|e| format!("创建节点缓存目录失败: {}", e))?;

    let local_path = node_dir.join(&file_name);

    let need_download = match compute_sha256_with_retry(&local_path) {
        Ok(local_hash) => local_hash != sha256,
        Err(_) => true,
    };

    if need_download {
        let resp = reqwest::get(&download_url)
            .await
            .map_err(|e| format!("下载文件失败: {}", e))?;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取下载流失败: {}", e))?;
        fs::write(&local_path, &bytes).map_err(|e| format!("写入本地缓存失败: {}", e))?;
    }

    let path_str = local_path.to_string_lossy().to_string();
    app.opener()
        .open_path(&path_str, None::<&str>)
        .map_err(|e| format!("唤起本机 Office 失败: {}", e))?;

    let _ = app.emit(
        "office:status",
        OfficeStatusEvent {
            node_id: node_id.clone(),
            state: "editing_local".to_string(),
            message: "已调用本机 Office 打开，保存后将自动同步回云端".to_string(),
        },
    );

    // 防止同一节点重复打开时创建多个重复监听线程（避免内存泄漏与重复上传）
    {
        let mut guard = active_watchers().lock().map_err(|e| e.to_string())?;
        if guard.contains(&node_id) {
            return Ok(path_str);
        }
        guard.insert(node_id.clone());
    }

    let watch_dir = node_dir.clone();
    let target_file = local_path.clone();
    let target_name = file_name.clone();
    let app_clone = app.clone();
    let watched_node_id = node_id.clone();

    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else {
            if let Ok(mut g) = active_watchers().lock() {
                g.remove(&watched_node_id);
            }
            return;
        };
        if watcher
            .watch(&watch_dir, RecursiveMode::NonRecursive)
            .is_err()
        {
            if let Ok(mut g) = active_watchers().lock() {
                g.remove(&watched_node_id);
            }
            return;
        }

        // 复用单一 HTTP Client，避免每次保存重建连接池与 Tokio Runtime
        let http_client = reqwest::Client::new();
        let mut last_synced_hash = sha256;
        let mut current_version = base_version;
        let mut last_event = Instant::now() - Duration::from_secs(10);

        while let Ok(res) = rx.recv() {
            let Ok(event) = res else { continue };
            let relevant = matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Any
            );
            if !relevant {
                continue;
            }

            let matched = event.paths.iter().any(|p| {
                let Some(fname) = p.file_name().and_then(|n| n.to_str()) else {
                    return false;
                };
                !is_office_temp_file(fname) && fname == target_name
            });
            if !matched {
                continue;
            }

            if last_event.elapsed() < Duration::from_millis(1200) {
                continue;
            }
            last_event = Instant::now();
            std::thread::sleep(Duration::from_millis(1200));

            let Ok(new_hash) = compute_sha256_with_retry(&target_file) else {
                continue;
            };
            if new_hash == last_synced_hash {
                continue;
            }

            let _ = app_clone.emit(
                "office:status",
                OfficeStatusEvent {
                    node_id: watched_node_id.clone(),
                    state: "uploading".to_string(),
                    message: "检测到保存变更，正在自动上传新版本...".to_string(),
                },
            );

            let upload_result: Result<i32, String> = tauri::async_runtime::block_on(async {
                let bytes = fs::read(&target_file).map_err(|e| e.to_string())?;
                let mime = if target_name.to_lowercase().ends_with(".xlsx") {
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                } else {
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                };

                let presign: PresignResponse = http_client
                    .post(format!("{}/api/v1/files/presign", api_base))
                    .bearer_auth(&auth_token)
                    .json(&serde_json::json!({
                        "nodeId": watched_node_id,
                        "fileName": target_name,
                        "fileSize": bytes.len(),
                        "sha256": new_hash,
                        "mimeType": mime
                    }))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .json()
                    .await
                    .map_err(|e| e.to_string())?;

                if !presign.already_exists {
                    if let Some(url) = presign.upload_url {
                        http_client
                            .put(url)
                            .header("Content-Type", mime)
                            .body(bytes.clone())
                            .send()
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }

                let commit_resp = http_client
                    .post(format!("{}/api/v1/files/commit", api_base))
                    .bearer_auth(&auth_token)
                    .json(&serde_json::json!({
                        "nodeId": watched_node_id,
                        "baseVersion": current_version,
                        "storageKey": presign.storage_key,
                        "fileName": target_name,
                        "mimeType": mime,
                        "fileSize": bytes.len(),
                        "sha256": new_hash,
                        "deviceName": "Windows 桌面端"
                    }))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;

                if commit_resp.status().as_u16() == 409 {
                    let _ = http_client
                        .post(format!("{}/api/v1/files/commit", api_base))
                        .bearer_auth(&auth_token)
                        .json(&serde_json::json!({
                            "nodeId": watched_node_id,
                            "baseVersion": current_version,
                            "storageKey": presign.storage_key,
                            "fileName": target_name,
                            "mimeType": mime,
                            "fileSize": bytes.len(),
                            "sha256": new_hash,
                            "deviceName": "Windows 桌面端（冲突副本）",
                            "forceConflictCopy": true
                        }))
                        .send()
                        .await;
                    return Err("conflict".to_string());
                }

                Ok(current_version + 1)
            });

            match upload_result {
                Ok(next_ver) => {
                    last_synced_hash = new_hash;
                    current_version = next_ver;
                    let _ = app_clone.emit(
                        "office:status",
                        OfficeStatusEvent {
                            node_id: watched_node_id.clone(),
                            state: "synced".to_string(),
                            message: format!("已自动同步至云端（v{}）", next_ver),
                        },
                    );
                }
                Err(code) if code == "conflict" => {
                    let _ = app_clone.emit(
                        "office:status",
                        OfficeStatusEvent {
                            node_id: watched_node_id.clone(),
                            state: "conflict".to_string(),
                            message: "检测到云端版本冲突，已自动为你创建冲突副本".to_string(),
                        },
                    );
                }
                Err(err) => {
                    let _ = app_clone.emit(
                        "office:status",
                        OfficeStatusEvent {
                            node_id: watched_node_id.clone(),
                            state: "error".to_string(),
                            message: format!("自动回传失败: {}", err),
                        },
                    );
                }
            }
        }

        if let Ok(mut g) = active_watchers().lock() {
            g.remove(&watched_node_id);
        }
    });

    Ok(path_str)
}
