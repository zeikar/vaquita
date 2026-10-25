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
    // Not exit(): the new bundle is at the same path, and the relaunch keeps
    // this process's environment, so a VAQUITA_HOME run stays in its home.
    app.restart()
}
