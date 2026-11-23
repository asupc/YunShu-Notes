use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedOneNotePage {
    pub title: String,
    pub folder_path: Vec<String>,
    pub level: i32,
    pub html_content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedOnePkgResult {
    pub root_title: String,
    pub pages: Vec<ParsedOneNotePage>,
}

/// 解析本地 .onepkg / .zip 归档中的分区清单（可进一步接入 onenote_parser 深度解析二进制 .one）
#[tauri::command]
pub async fn parse_onepkg_file(file_path: String) -> Result<ParsedOnePkgResult, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("指定的 .onepkg 文件不存在".to_string());
    }
    let root_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("OneNote 归档")
        .to_string();

    let file = File::open(path).map_err(|e| format!("打开归档失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|_| "该 .onepkg 使用旧版 CAB 封装，请先用 7-Zip 解压或改用 Graph API 通道导入".to_string())?;

    let mut pages = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.ends_with(".html") || name.ends_with(".htm") || name.ends_with(".md") {
            let mut content = String::new();
            let _ = entry.read_to_string(&mut content);
            pages.push(ParsedOneNotePage {
                title: Path::new(&name)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("未命名页面")
                    .to_string(),
                folder_path: vec![root_title.clone()],
                level: 0,
                html_content: content,
            });
        } else if name.ends_with(".one") {
            let section_name = Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("分区")
                .to_string();
            pages.push(ParsedOneNotePage {
                title: format!("{}（已识别 .one 分区）", section_name),
                folder_path: vec![root_title.clone(), section_name],
                level: 0,
                html_content: "<p>已识别 OneNote 分区文件，可结合 Graph API 通道完整抽取正文与图片。</p>".to_string(),
            });
        }
    }

    Ok(ParsedOnePkgResult { root_title, pages })
}
