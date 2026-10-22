mod home;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Endpoint {
    url: String,
    token: String,
    pid: u32,
}

// Errors never include the file contents, which hold the token.
#[tauri::command]
fn endpoint() -> Result<Endpoint, String> {
    let path = home::endpoint_path();
    let data = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "not-running".to_string(),
        _ => format!("read {}: {}", path.display(), e),
    })?;
    // serde's message can echo values from the file, which holds the token.
    serde_json::from_slice(&data)
        .map_err(|_| format!("parse {}: invalid endpoint.json", path.display()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![endpoint])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
