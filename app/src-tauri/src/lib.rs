mod home;
mod launchd;
mod notify;
mod open_path;
mod stop;
mod update;
mod wait;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

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

// Keep this hint identical to DEV_HINT in src/lib/endpoint.ts.
// `tauri dev` (any profile) never touches launchctl: the dev daemon runs from a terminal.
const DEV_HINT: &str =
    "dev run: start the daemon from a terminal: VAQUITA_HOME=~/.vaquita-dev vaquitad serve --allow-origin http://localhost:1420";

const STEP: Duration = Duration::from_millis(200);

// Async, with the blocking work on its own thread, so the polling does not stall IPC.
#[tauri::command]
async fn start_daemon() -> Result<(), String> {
    if tauri::is_dev() {
        return Err(DEV_HINT.to_string());
    }
    tauri::async_runtime::spawn_blocking(start_and_wait).await.map_err(|e| e.to_string())?
}

/// The build of the vaquitad inside the app, as `vaquitad version` prints it,
/// which a running daemon's is compared with; None in a `tauri dev` run, which
/// never manages the daemon, and in an app without one.
#[tauri::command]
async fn app_build() -> Result<Option<String>, String> {
    if tauri::is_dev() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(|| shipped_build(&app_exe()?)).await.map_err(|e| e.to_string())?
}

fn shipped_build(exe: &Path) -> Result<Option<String>, String> {
    let Some(daemon) = launchd::embedded(exe)? else {
        return Ok(None);
    };
    let out = std::process::Command::new(&daemon)
        .arg("version")
        .output()
        .map_err(|e| format!("run {} version: {e}", daemon.display()))?;
    if !out.status.success() {
        return Err(format!("{} version exited with {}", daemon.display(), out.status));
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

const NO_EMBEDDED: &str = "the app has no vaquitad inside it to start in place of the running one";

/// Whether the app can start a daemon of its own, which a restart needs
/// before it stops the running one: `start` would accept the app's location,
/// and the app has a vaquitad inside it.
fn check_restart_at(exe: &Path) -> Result<(), String> {
    launchd::embedded(exe)?.map(drop).ok_or_else(|| NO_EMBEDDED.to_string())
}

/// Asked before the app requests a shutdown over its connection, so that a
/// daemon is never stopped by an app that cannot start its own.
#[tauri::command]
fn check_restart() -> Result<(), String> {
    if tauri::is_dev() {
        return Err(DEV_HINT.to_string());
    }
    check_restart_at(&app_exe()?)
}

/// Stops the daemon the app connected to, the one with `pid` and `token`, then
/// starts this app's as start_daemon does. With `signal` the daemon is sent
/// SIGTERM; without, it has agreed to a shutdown request and is waited for.
#[tauri::command]
async fn restart_daemon(pid: u32, token: String, signal: bool) -> Result<(), String> {
    if tauri::is_dev() {
        return Err(DEV_HINT.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || restart(&app_exe()?, &home::endpoint_path(), pid, &token, signal, start_and_wait))
        .await
        .map_err(|e| e.to_string())?
}

fn restart(exe: &Path, endpoint: &Path, pid: u32, token: &str, signal: bool, start: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    check_restart_at(exe)?;
    // Closing its connections can take a client's close handshake, 5s at most.
    stop::stop(endpoint, pid, token, signal, STEP, 50 * STEP)?;
    start()
}

fn app_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("find the app's executable: {e}"))
}

fn start_and_wait() -> Result<(), String> {
    let endpoint = home::endpoint_path();
    let before = wait::snapshot(&endpoint);
    launchd::start(&launchd::RealRunner, &home::label(), &home::plist_path(), &home::lock_path(), &app_exe()?)?;
    wait::wait_for_endpoint(&endpoint, &before, STEP, 25 * STEP)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        // The webview is granted no updater:* permission: the two update
        // commands below are the only way in.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::Pending::default())
        .setup(|app| {
            notify::setup(app.handle());
            // Without the item the app still updates on its timed checks.
            if let Err(e) = update::add_menu_item(app.handle()) {
                eprintln!("vaquita: adding Check for Updates to the menu failed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            endpoint,
            start_daemon,
            app_build,
            check_restart,
            restart_daemon,
            notify::notification_permission,
            notify::notify,
            notify::take_notification_click,
            open_path::open_path,
            update::check_app_update,
            update::install_app_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stop::tests::{dir, is_running_vaquitad, stand_in, write_endpoint};

    #[test]
    fn the_shipped_build_is_what_the_vaquitad_beside_the_app_prints() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("shipped");
        std::fs::create_dir_all(d.join("app")).unwrap();
        let exe = d.join("app/vaquita");
        std::fs::write(&exe, "").unwrap();
        assert_eq!(shipped_build(&exe), Ok(None));
        let daemon = d.join("app/vaquitad");
        std::fs::write(&daemon, "#!/bin/sh\n[ \"$1\" = version ] && echo 0.1.6+3b9cdd54fa29\n").unwrap();
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(shipped_build(&exe), Ok(Some("0.1.6+3b9cdd54fa29".to_string())));
    }

    #[test]
    fn a_restart_the_app_cannot_finish_leaves_the_daemon_running() {
        let d = dir("restart");
        let mut child = stand_in(&d);
        let ep = d.join("endpoint.json");
        write_endpoint(&ep, child.id(), "t");
        let never = || -> Result<(), String> { panic!("started a daemon") };
        let translocated = Path::new("/private/var/folders/xy/abc/T/AppTranslocation/1234/d/vaquita.app/Contents/MacOS/vaquita");
        let r1 = restart(translocated, &ep, child.id(), "t", true, never);
        // An app without a vaquitad inside it; d holds the stand-in's.
        std::fs::create_dir_all(d.join("app")).unwrap();
        let exe = d.join("app/vaquita");
        std::fs::write(&exe, "").unwrap();
        let r2 = restart(&exe, &ep, child.id(), "t", true, never);
        let alive = is_running_vaquitad(&child);
        let _ = child.kill();
        child.wait().unwrap();
        assert_eq!(r1.unwrap_err(), launchd::TRANSLOCATED);
        assert_eq!(r2.unwrap_err(), NO_EMBEDDED);
        assert!(alive);
    }

    #[test]
    fn an_app_with_its_own_vaquitad_can_restart() {
        let d = dir("canrestart");
        std::fs::write(d.join("vaquita"), "").unwrap();
        std::fs::write(d.join("vaquitad"), "").unwrap();
        check_restart_at(&d.join("vaquita")).unwrap();
    }
}
