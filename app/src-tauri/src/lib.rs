mod home;
mod launchd;
mod wait;

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

// Async, with the blocking work on its own thread, so the polling does not stall IPC.
#[tauri::command]
async fn start_daemon() -> Result<(), String> {
    // Keep this hint identical to DEV_HINT in src/lib/endpoint.ts.
    // `tauri dev` (any profile) never touches launchctl: the dev daemon runs from a terminal.
    if tauri::is_dev() {
        return Err("dev run: start the daemon from a terminal: VAQUITA_HOME=~/.vaquita-dev vaquitad serve --allow-origin http://localhost:1420".to_string());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let exe = std::env::current_exe().map_err(|e| format!("find the app's executable: {e}"))?;
        let endpoint = home::endpoint_path();
        let before = wait::snapshot(&endpoint);
        launchd::start(&launchd::RealRunner, &home::label(), &home::plist_path(), &home::lock_path(), &exe)?;
        let step = std::time::Duration::from_millis(200);
        wait::wait_for_endpoint(&endpoint, &before, step, 25 * step)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![endpoint, start_daemon])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
