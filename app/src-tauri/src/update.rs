//! Updates of the app itself, driven from here rather than by the webview: the
//! update a check finds stays in Rust until it is installed, so the webview
//! only ever learns a version and never passes a URL or a release to install.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

/// The update the last check that got an answer found, which
/// install_app_update installs.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// All the webview needs of an update: it builds the release page link from
/// the version.
#[derive(Serialize)]
pub struct AppUpdate {
    version: String,
}

// Without a timeout the request never gives up, and the next check is
// scheduled only once this one ends.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

// The whole download must finish within it, so a stalled one fails instead of
// leaving the bar on "Updating…" for good.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// The id of the app menu's Check for Updates… item, which menu.rs adds.
pub const CHECK_MENU_ID: &str = "check-for-updates";

/// The event that item sends the webview, which runs the check, so the bar
/// and the status line show what it finds.
pub const CHECK_EVENT: &str = "check-app-update";

/// Whether this build checks for updates at all: a `tauri dev` run and a
/// local `tauri build` never do, so a Check for Updates… item would only ever
/// say there is nothing new.
pub fn has_feed(app: &AppHandle) -> bool {
    !tauri::is_dev() && !matches!(app.updater_builder().build(), Err(Error::EmptyEndpoints))
}

fn failed(e: Error) -> String {
    // A release build has no devtools to read the webview's warning in.
    eprintln!("vaquita: checking for an app update failed: {e}");
    e.to_string()
}

/// The version of a newer release, if there is one; None in a `tauri dev`
/// run, which has no bundle to swap, as app_build in lib.rs.
#[tauri::command]
pub async fn check_app_update(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<AppUpdate>, String> {
    if tauri::is_dev() {
        return Ok(None);
    }
    let updater = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
        Ok(updater) => updater,
        // Only a release build is given an endpoint; tauri.conf.json names
        // none, so a local `tauri build` never checks, and that is no update.
        Err(Error::EmptyEndpoints) => return Ok(None),
        Err(e) => return Err(failed(e)),
    };
    let found = updater.check().await.map_err(failed)?;
    let version = found.as_ref().map(|u| AppUpdate { version: u.version.clone() });
    *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = found;
    Ok(version)
}

/// Downloads and installs the update the last check found, then relaunches
/// the app. A failed install leaves it pending, so a retry installs it again.
/// Async, so it runs off the main thread: where /Applications is not writable
/// the plugin asks for an admin password on the main thread and waits for it.
#[tauri::command]
pub async fn install_app_update(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    // A copy, so the lock is not held through the download.
    let mut update = pending.0.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("no update is pending; check again")?;
    // An update from check has no timeout of its own.
    update.timeout = Some(INSTALL_TIMEOUT);
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    relaunch_when_gone(&app)?;
    app.exit(0);
    Ok(())
}

/// Opens the bundle again once this process has ended. AppHandle::restart
/// runs `open -n` while this process still runs, and the Dock shows that
/// second instance in a tile of its own beside the one kept in the Dock. The
/// new bundle is at the same path, and open keeps this process's environment,
/// so a VAQUITA_HOME run stays in its home.
fn relaunch_when_gone(app: &AppHandle) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use tauri::Manager;

    let exe = tauri::process::current_binary(&app.env()).map_err(|e| e.to_string())?;
    // vaquita.app/Contents/MacOS/vaquita
    let bundle = exe.ancestors().nth(3).filter(|b| b.extension().is_some_and(|e| e == "app")).ok_or("the app is not in a bundle")?;
    Command::new("/bin/sh")
        .args(["-c", r#"while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open "$2""#, "relaunch"])
        .arg(std::process::id().to_string())
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Out of this process's group, so nothing sent to the app reaches it.
        .process_group(0)
        .spawn()
        .map_err(|e| format!("relaunch: {e}"))?;
    Ok(())
}
