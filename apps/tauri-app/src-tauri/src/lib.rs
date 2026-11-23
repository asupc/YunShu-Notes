mod office_sync;
mod onepkg;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            office_sync::open_office_node,
            onepkg::parse_onepkg_file
        ])
        .run(tauri::generate_context!())
        .expect("启动云树笔记桌面端时发生异常");
}
