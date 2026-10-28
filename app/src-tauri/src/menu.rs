//! The menu bar: Tauri's default one, with Check for Updates… in a build that
//! has a feed, and the items that drive the file tabs.
//!
//! Close and the tab shortcuts are menu items. WKWebView hands a key with a
//! modifier to the page first and to the menu only when the page lets it
//! through, so they work wherever the app's key handlers pass them on (the
//! terminal's included). The default menu has Close Window with ⌘W under both File and
//! Window; both go and our Close takes File's place, so ⌘W is only ever ours,
//! and the webview closes the window itself when ⌘W lands on the terminal tab.
//!
//! The tab keys are ⌘⇧[ and ⌘⇧], not ⌃Tab: AppKit binds ⌃Tab to the window's
//! key-view loop, which WKWebView runs and counts as handled whenever the page
//! does not cancel the key, so a menu item on ⌃Tab never fires. The page takes
//! ⌃Tab itself (App.svelte).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};

use crate::update;

const CLOSE_ID: &str = "tab-close";
const TERMINAL_ID: &str = "tab-terminal";
const PREV_ID: &str = "tab-prev";
const NEXT_ID: &str = "tab-next";

const CLOSE_KEY: &str = "CmdOrCtrl+W";

/// Above Toggle Full Screen, the default View's only item: id, title, key.
const VIEW_ITEMS: [(&str, &str, &str); 3] = [
    (TERMINAL_ID, "Show Terminal", "CmdOrCtrl+1"),
    (PREV_ID, "Previous Tab", "CmdOrCtrl+Shift+["),
    (NEXT_ID, "Next Tab", "CmdOrCtrl+Shift+]"),
];

/// The title macOS gives PredefinedMenuItem::close_window.
const CLOSE_WINDOW: &str = "Close Window";

/// What the webview's `tab` event says to do for a menu item.
fn tab_action(id: &str) -> Option<&'static str> {
    match id {
        CLOSE_ID => Some("close"),
        TERMINAL_ID => Some("terminal"),
        PREV_ID => Some("prev"),
        NEXT_ID => Some("next"),
        _ => None,
    }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let submenus: Vec<Submenu<Wry>> = menu.items()?.iter().filter_map(|m| m.as_submenu().cloned()).collect();
    // The app's own submenu comes first, with About at its top.
    if update::has_feed(app)
        && let Some(app_menu) = submenus.first()
    {
        let item = MenuItem::with_id(app, update::CHECK_MENU_ID, "Check for Updates…", true, None::<&str>)?;
        app_menu.insert(&item, 1)?;
    }
    take_close(app, &submenus)?;
    match find(&submenus, "View")? {
        Some(view) => {
            for (i, (id, title, key)) in VIEW_ITEMS.into_iter().enumerate() {
                view.insert(&MenuItem::with_id(app, id, title, true, Some(key))?, i)?;
            }
            view.insert(&PredefinedMenuItem::separator(app)?, VIEW_ITEMS.len())?;
        }
        None => eprintln!("vaquita: the default menu has no View; the tab shortcuts are left out"),
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        let sent = if id == update::CHECK_MENU_ID {
            app.emit_to("main", update::CHECK_EVENT, ()).map_err(|e| format!("asking for an update check failed: {e}"))
        } else if let Some(action) = tab_action(id) {
            app.emit_to("main", "tab", action).map_err(|e| format!("sending {action} to the tabs failed: {e}"))
        } else {
            return;
        };
        if let Err(e) = sent {
            eprintln!("vaquita: {e}");
        }
    });
    Ok(())
}

/// Replaces File's Close Window with our Close and removes any other. Only
/// with a Close Window in File, so a Tauri whose default menu changed keeps
/// the window's ⌘W rather than losing Close altogether.
fn take_close(app: &AppHandle, submenus: &[Submenu<Wry>]) -> tauri::Result<()> {
    let mut found = Vec::new();
    for submenu in submenus {
        let mut at = Vec::new();
        for (i, item) in submenu.items()?.iter().enumerate() {
            if let Some(p) = item.as_predefined_menuitem()
                && p.text()? == CLOSE_WINDOW
            {
                at.push(i);
            }
        }
        if !at.is_empty() {
            found.push((submenu, submenu.text()? == "File", at));
        }
    }
    if !found.iter().any(|(_, file, _)| *file) {
        eprintln!("vaquita: the default menu has no File ▸ Close Window; ⌘W keeps closing the window");
        return Ok(());
    }
    for (submenu, file, at) in found {
        // From the end, so the earlier positions still hold.
        for &i in at.iter().rev() {
            submenu.remove_at(i)?;
        }
        if file {
            submenu.insert(&MenuItem::with_id(app, CLOSE_ID, "Close", true, Some(CLOSE_KEY))?, at[0])?;
        } else {
            tidy_separators(submenu)?;
        }
    }
    Ok(())
}

/// Removes the separators a removal left at an end of the submenu or beside
/// another, as Window's does once its Close Window, the last item, is gone.
fn tidy_separators(submenu: &Submenu<Wry>) -> tauri::Result<()> {
    let mut seps = Vec::new();
    for item in submenu.items()? {
        // A predefined item with no title is a separator; the type is not exposed.
        seps.push(item.as_predefined_menuitem().map(|p| p.text()).transpose()?.is_some_and(|t| t.is_empty()));
    }
    let mut drop = Vec::new();
    // The start counts as a separator, so a leading one goes too.
    let mut after_sep = true;
    for (i, &sep) in seps.iter().enumerate() {
        if sep && after_sep {
            drop.push(i);
        } else {
            after_sep = sep;
        }
    }
    // Ending after a separator means the last item kept is one.
    if after_sep && let Some(last) = (0..seps.len()).rev().find(|i| !drop.contains(i)) {
        drop.push(last);
    }
    drop.sort_unstable();
    for &i in drop.iter().rev() {
        submenu.remove_at(i)?;
    }
    Ok(())
}

fn find(submenus: &[Submenu<Wry>], title: &str) -> tauri::Result<Option<Submenu<Wry>>> {
    for submenu in submenus {
        if submenu.text()? == title {
            return Ok(Some(submenu.clone()));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tauri drops an accelerator it cannot parse without a word, which would
    // leave the item with no key at all.
    #[test]
    fn every_menu_key_parses_to_the_key_it_names() {
        use muda::accelerator::{Accelerator, Code, Modifiers};
        let keys: Vec<&str> = VIEW_ITEMS.iter().map(|(_, _, key)| *key).chain([CLOSE_KEY]).collect();
        let want = [
            (Modifiers::META, Code::Digit1),
            (Modifiers::META | Modifiers::SHIFT, Code::BracketLeft),
            (Modifiers::META | Modifiers::SHIFT, Code::BracketRight),
            (Modifiers::META, Code::KeyW),
        ];
        assert_eq!(keys.len(), want.len());
        for (key, (mods, code)) in keys.into_iter().zip(want) {
            let parsed = key.parse::<Accelerator>().unwrap_or_else(|e| panic!("{key}: {e}"));
            assert_eq!((parsed.modifiers(), parsed.key()), (mods, code), "{key}");
        }
    }
}
