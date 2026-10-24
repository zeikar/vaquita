//! Opens a path that a click on terminal output named. That output is
//! untrusted, so a click must not run or install anything: the path is made
//! canonical first, so a symlink is judged by its target, and then revealed in
//! Finder instead of opened when, checked in this order, it is a regular file
//! with an execute bit; it is a Finder alias, or its Finder info cannot be
//! read; its name has an extension on BUNDLES or FILES, or a folder above it
//! one on BUNDLES; or the app macOS would open it with is on HANDLERS, or is
//! Finder for something that is not a folder. A path no app opens is revealed
//! too. Everything else opens with its default app. The lists are all the
//! guard knows.

use std::ffi::{CStr, CString};
use std::fs::Metadata;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSString, NSURL};
use serde::Serialize;

// Lowercase extensions of kinds that run or install when opened, or open a
// stored target. Bundles count on any component, which covers a file inside one.
const BUNDLES: &[&str] = &[
    "app", "appex", "xpc", "framework", "bundle", "plugin", "kext", "prefpane", "saver", "qlgenerator", "workflow", "action",
    "caction", "service", "pkg", "mpkg", "scptd",
];

// Files count on the last component only: a folder named like one, such as a
// clone of acme.sh, holds ordinary files.
const FILES: &[&str] = &[
    "command", "tool", "term", "terminal", "dist", "mobileconfig", "ipa", "jar", "jnlp", "webloc", "inetloc", "fileloc",
    "afploc", "atloc", "ftploc", "mailloc", "newsloc", "nslloc", "vncloc", "crwebloc", "url", "shortcut", "scpt",
    "applescript", "sh", "bash", "zsh", "fish", "csh", "ksh",
];

// Apps that run or install what they open, as LaunchServices reports them.
const HANDLERS: &[&str] = &[
    // Shipped with macOS:
    "com.apple.Terminal",
    "com.apple.installer",
    "com.apple.JavaLauncher",      // .jar, .jnlp
    "com.apple.AutomatorInstaller", // .workflow
    "com.apple.Automator.Automator-Application-Stub",
    "com.apple.mcx.ProfileHelper", // .mobileconfig
    "com.apple.IPAInstaller",      // .ipa
    "com.apple.keychainaccess",    // .cer, .p12, .keychain: imports a certificate or adds a keychain
    "com.apple.shortcuts",         // .wflow, .shortcut
    "com.apple.pluginIM.pluginIMRegistrator", // .inputplugin, .cin: registers an input method
    // Installed by the python.org installer:
    "org.python.PythonLauncher",
];

const FINDER: &str = "com.apple.finder";

// What handler_id reports when LaunchServices names the item itself as its
// opener, which is how a folder it treats as an application answers whatever
// the folder is called. Not a bundle identifier, so no app can claim it.
const ITSELF: &str = "(itself)";

/// What a click did, as openPath in src/lib/file-links.ts receives it; the
/// webview shows the why of a reveal in its status line.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "action", content = "why", rename_all = "lowercase")]
pub enum Action {
    Opened,
    Revealed(String),
}

/// `~` and `~/rest` under home; any other path as it is.
fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        // A rest that starts with a slash would replace home in join.
        home.join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(path)
    }
}

/// This Mac's name; None when it cannot be read.
fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most buf.len() bytes into buf.
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return None;
    }
    CStr::from_bytes_until_nul(&buf).ok()?.to_str().ok().map(str::to_string)
}

/// Whether a file URL's host is this Mac: none, localhost or its own name.
fn is_local_host(host: &str) -> bool {
    host.is_empty() || host.eq_ignore_ascii_case("localhost") || hostname().is_some_and(|h| h.eq_ignore_ascii_case(host))
}

/// The bundle identifier of the app macOS would open path with; None when no
/// app would, or that app has none; ITSELF when that app is path itself.
fn handler_id(path: &Path) -> Option<String> {
    // A blocking thread has no autorelease pool of its own.
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&url)?;
        let app_path = app.path()?.to_string();
        if std::fs::canonicalize(&app_path).is_ok_and(|a| a == path) {
            return Some(ITSELF.to_string());
        }
        Some(NSBundle::bundleWithURL(&app)?.bundleIdentifier()?.to_string())
    })
}

/// Whether path is a Finder alias: canonicalize does not resolve one, macOS
/// opens it with its target's app, and opening an archive or a disk image
/// (Archive Utility, DiskImageMounter) can leave one behind. The alias flag is
/// 0x8000 in the big-endian Finder flags at bytes 8-9 of the FinderInfo xattr.
fn is_alias(path: &Path) -> std::io::Result<bool> {
    let path = CString::new(path.as_os_str().as_bytes())?;
    let mut buf = [0u8; 32];
    // SAFETY: getxattr writes at most buf.len() bytes into buf; both names end in NUL.
    let n = unsafe { libc::getxattr(path.as_ptr(), c"com.apple.FinderInfo".as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0) };
    if n < 0 {
        let e = std::io::Error::last_os_error();
        // No Finder info, or a volume without extended attributes: no alias.
        return match e.raw_os_error() {
            Some(libc::ENOATTR | libc::ENOTSUP) => Ok(false),
            _ => Err(e),
        };
    }
    Ok(n >= 10 && buf[8] & 0x80 != 0)
}

/// The lowercase extension of path's last component, when one of lists has it.
fn listed(path: &Path, lists: &[&[&str]]) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    lists.iter().any(|l| l.contains(&ext.as_str())).then_some(ext)
}

/// Whether a click opens canonical or only reveals it, by the rule above.
fn judge(canonical: &Path, meta: &Metadata, handler: &dyn Fn(&Path) -> Option<String>) -> Action {
    if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
        return Action::Revealed("it is executable".to_string());
    }
    match is_alias(canonical) {
        Ok(false) => {}
        Ok(true) => return Action::Revealed("it is a Finder alias".to_string()),
        // A check that could not run must not let the file open.
        Err(e) => {
            eprintln!("vaquita: read Finder info of {}: {e}", canonical.display());
            return Action::Revealed("its Finder info cannot be read".to_string());
        }
    }
    if let Some(ext) = listed(canonical, &[BUNDLES, FILES]) {
        return Action::Revealed(format!("it is a .{ext}, a kind that runs or installs when opened"));
    }
    if let Some(ext) = canonical.ancestors().skip(1).find_map(|a| listed(a, &[BUNDLES])) {
        return Action::Revealed(format!("it is inside a .{ext}"));
    }
    match handler(canonical) {
        // An extension off the lists does not make a folder safe: opening an
        // application bundle launches it.
        Some(id) if id == ITSELF => Action::Revealed("it is an app".to_string()),
        Some(id) if HANDLERS.iter().any(|h| h.eq_ignore_ascii_case(&id)) => {
            Action::Revealed(format!("its default app {id} runs or installs what it opens"))
        }
        // Finder is a file's default app when the file points elsewhere, as a
        // location file does, and opening it opens the target.
        Some(id) if !meta.is_dir() && id.eq_ignore_ascii_case(FINDER) => {
            Action::Revealed("Finder opens what it points to".to_string())
        }
        Some(_) => Action::Opened,
        None => Action::Revealed("no app opens it".to_string()),
    }
}

fn io_error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "no such file".to_string(),
        _ => e.to_string(),
    }
}

/// The canonical path a file URL or a path in the output names, and what a
/// click does with it. No error names the path: the webview adds it.
fn resolve(path: &str, host: &str, home: &Path, handler: &dyn Fn(&Path) -> Option<String>) -> Result<(PathBuf, Action), String> {
    if !is_local_host(host) {
        return Err(format!("not this Mac: {host}"));
    }
    let path = expand_home(path, home);
    if !path.is_absolute() {
        return Err("not an absolute path".to_string());
    }
    let canonical = std::fs::canonicalize(&path).map_err(io_error)?;
    let meta = std::fs::metadata(&canonical).map_err(io_error)?;
    let action = judge(&canonical, &meta, handler);
    Ok((canonical, action))
}

// Async, with the work on its own thread: canonicalize can hang on a dead
// network mount, and opening waits for /usr/bin/open. The webview is not
// allowed to open paths itself, so this is the one way a click opens a file.
#[tauri::command]
pub async fn open_path(path: String, host: String) -> Result<Action, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        let (canonical, action) = resolve(&path, &host, Path::new(&home), &handler_id)?;
        // The canonical path, the one that was judged.
        let (done, failed) = match &action {
            Action::Opened => (tauri_plugin_opener::open_path(&canonical, None::<&str>), "macOS could not open it"),
            Action::Revealed(_) => (tauri_plugin_opener::reveal_item_in_dir(&canonical), "Finder could not show it"),
        };
        if let Err(e) = done {
            // The opener's message names the path, which the webview adds itself.
            eprintln!("vaquita: {failed}: {e}");
            return Err(failed.to_string());
        }
        Ok(action)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    const EDITOR: &str = "com.microsoft.VSCode";

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vaquita-open-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn file(d: &Path, name: &str, mode: u32) -> PathBuf {
        let p = d.join(name);
        std::fs::write(&p, "x").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    fn editor(_: &Path) -> Option<String> {
        Some(EDITOR.to_string())
    }

    fn resolve_with(path: &Path, handler: &dyn Fn(&Path) -> Option<String>) -> Result<(PathBuf, Action), String> {
        resolve(path.to_str().unwrap(), "", Path::new("/nonexistent"), handler)
    }

    fn act(path: &Path, handler: &dyn Fn(&Path) -> Option<String>) -> Action {
        resolve_with(path, handler).unwrap().1
    }

    fn revealed(why: &str) -> Action {
        Action::Revealed(why.to_string())
    }

    /// Gives p Finder info whose Finder flags, bytes 8-9, are flags.
    fn set_finder_flags(p: &Path, flags: [u8; 2]) {
        let mut info = [0u8; 32];
        info[8..10].copy_from_slice(&flags);
        let c = CString::new(p.as_os_str().as_bytes()).unwrap();
        // SAFETY: setxattr reads info.len() bytes from info; both names end in NUL.
        let r = unsafe { libc::setxattr(c.as_ptr(), c"com.apple.FinderInfo".as_ptr(), info.as_ptr().cast(), info.len(), 0, 0) };
        assert_eq!(r, 0, "{}", std::io::Error::last_os_error());
    }

    const KIND: &str = "a kind that runs or installs when opened";

    #[test]
    fn the_webview_gets_the_action_and_its_why() {
        assert_eq!(serde_json::to_string(&Action::Opened).unwrap(), r#"{"action":"opened"}"#);
        assert_eq!(serde_json::to_string(&revealed("w")).unwrap(), r#"{"action":"revealed","why":"w"}"#);
    }

    #[test]
    fn a_plain_file_opens() {
        assert_eq!(act(&file(&dir("plain"), "notes.txt", 0o644), &editor), Action::Opened);
    }

    #[test]
    fn an_executable_file_is_revealed() {
        assert_eq!(act(&file(&dir("exec"), "run", 0o755), &editor), revealed("it is executable"));
    }

    #[test]
    fn a_finder_alias_is_revealed() {
        let p = file(&dir("alias"), "notes.txt", 0o644);
        set_finder_flags(&p, [0x80, 0x00]);
        assert_eq!(act(&p, &editor), revealed("it is a Finder alias"));
    }

    #[test]
    fn other_finder_flags_do_not_make_an_alias() {
        let p = file(&dir("flags"), "notes.txt", 0o644);
        // Every flag but the alias one.
        set_finder_flags(&p, [0x7f, 0xff]);
        assert_eq!(act(&p, &editor), Action::Opened);
    }

    #[test]
    fn a_file_whose_finder_info_cannot_be_read_is_revealed() {
        // Without read permission getxattr fails with EACCES.
        let p = file(&dir("unreadable"), "notes.txt", 0o000);
        assert_eq!(act(&p, &editor), revealed("its Finder info cannot be read"));
    }

    #[test]
    fn a_listed_extension_is_revealed_whatever_its_case() {
        let d = dir("ext");
        assert_eq!(act(&file(&d, "run.command", 0o644), &editor), revealed(&format!("it is a .command, {KIND}")));
        assert_eq!(act(&file(&d, "notes.term", 0o644), &editor), revealed(&format!("it is a .term, {KIND}")));
        assert_eq!(act(&file(&d, "Thing.SH", 0o644), &editor), revealed(&format!("it is a .sh, {KIND}")));
    }

    #[test]
    fn a_script_off_the_list_opens_with_an_editor() {
        let d = dir("script");
        assert_eq!(act(&file(&d, "lib.rb", 0o644), &editor), Action::Opened);
        assert_eq!(act(&file(&d, "tool.py", 0o644), &editor), Action::Opened);
    }

    #[test]
    fn a_script_whose_default_app_runs_it_is_revealed() {
        let p = file(&dir("launcher"), "tool.py", 0o644);
        let why = revealed("its default app org.python.PythonLauncher runs or installs what it opens");
        assert_eq!(act(&p, &|_: &Path| Some("org.python.PythonLauncher".to_string())), why);
        let lower = revealed("its default app org.python.pythonlauncher runs or installs what it opens");
        assert_eq!(act(&p, &|_: &Path| Some("org.python.pythonlauncher".to_string())), lower);
    }

    fn handled_by(name: &str, id: &str) -> Action {
        let id = id.to_string();
        act(&file(&dir(name), "notes.txt", 0o644), &move |_: &Path| Some(id.clone()))
    }

    #[test]
    fn a_file_terminal_opens_is_revealed() {
        let why = "its default app com.apple.Terminal runs or installs what it opens";
        assert_eq!(handled_by("terminal", "com.apple.Terminal"), revealed(why));
    }

    #[test]
    fn a_file_the_ipa_installer_opens_is_revealed() {
        let why = "its default app com.apple.IPAInstaller runs or installs what it opens";
        assert_eq!(handled_by("ipa", "com.apple.IPAInstaller"), revealed(why));
    }

    #[test]
    fn a_file_keychain_access_opens_is_revealed() {
        let why = "its default app com.apple.keychainaccess runs or installs what it opens";
        assert_eq!(handled_by("keychain", "com.apple.keychainaccess"), revealed(why));
    }

    #[test]
    fn a_file_finder_opens_is_revealed_but_a_folder_opens() {
        let finder = |_: &Path| Some(FINDER.to_string());
        assert_eq!(handled_by("finder", FINDER), revealed("Finder opens what it points to"));
        assert_eq!(act(&dir("finderdir"), &finder), Action::Opened);
    }

    #[test]
    fn a_file_no_app_opens_is_revealed() {
        assert_eq!(act(&file(&dir("noapp"), "notes.txt", 0o644), &|_: &Path| None), revealed("no app opens it"));
    }

    // Asks LaunchServices only; nothing is opened. Which app owns .command
    // depends on this Mac's settings, but it is an identifier, not a path.
    #[test]
    fn launch_services_names_the_default_app() {
        let d = dir("ls");
        let command = handler_id(&file(&d, "x.command", 0o644)).unwrap();
        assert!(!command.is_empty() && !command.contains('/'), "{command}");
        assert_eq!(handler_id(&d).as_deref(), Some("com.apple.finder"));
    }

    #[test]
    fn a_folder_that_is_its_own_opener_is_revealed() {
        let p = dir("selfopen");
        assert_eq!(act(&p, &|_: &Path| Some(ITSELF.to_string())), revealed("it is an app"));
    }

    #[test]
    fn a_shortcut_or_input_method_app_is_revealed() {
        for id in ["com.apple.shortcuts", "com.apple.pluginIM.pluginIMRegistrator"] {
            let why = format!("its default app {id} runs or installs what it opens");
            assert_eq!(handled_by("apple-apps", id), revealed(&why));
        }
    }

    // An app bundle under a name no list has. Asks LaunchServices only.
    #[test]
    fn an_app_bundle_with_an_odd_name_is_never_opened() {
        let app = dir("oddapp").join("guide.d");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.vaquita.test.oddapp</string>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
"#,
        )
        .unwrap();
        std::fs::write(app.join("Contents/PkgInfo"), "APPL????").unwrap();
        let run = app.join("Contents/MacOS/run");
        std::fs::write(&run, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (_, action) = resolve_with(&app, &handler_id).unwrap();
        assert!(matches!(action, Action::Revealed(_)), "{action:?}");
    }

    #[test]
    fn a_bundle_and_a_file_inside_one_are_revealed() {
        let d = dir("bundle");
        let contents = d.join("Foo.app/Contents");
        std::fs::create_dir_all(&contents).unwrap();
        assert_eq!(act(&d.join("Foo.app"), &editor), revealed(&format!("it is a .app, {KIND}")));
        assert_eq!(act(&file(&contents, "Info.plist", 0o644), &editor), revealed("it is inside a .app"));
    }

    #[test]
    fn a_folder_named_like_a_script_holds_ordinary_files() {
        let d = dir("clone").join("acme.sh");
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(act(&file(&d, "README.md", 0o644), &editor), Action::Opened);
    }

    #[test]
    fn a_plain_directory_opens() {
        assert_eq!(act(&dir("plaindir"), &editor), Action::Opened);
    }

    #[test]
    fn a_symlink_is_judged_by_its_target() {
        let d = dir("symlink");
        let run = file(&d, "run", 0o755);
        symlink(&run, d.join("safe")).unwrap();
        let plain = d.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        symlink(&plain, d.join("Decoy.app")).unwrap();
        let safe = resolve_with(&d.join("safe"), &editor).unwrap();
        let decoy = resolve_with(&d.join("Decoy.app"), &editor).unwrap();
        assert_eq!(safe, (std::fs::canonicalize(&run).unwrap(), revealed("it is executable")));
        assert_eq!(decoy, (std::fs::canonicalize(&plain).unwrap(), Action::Opened));
    }

    #[test]
    fn a_tilde_is_home() {
        let home = Path::new("/tmp/home");
        assert_eq!(expand_home("~", home), home);
        assert_eq!(expand_home("~//x", home), home.join("x"));
    }

    #[test]
    fn a_path_under_home_is_expanded() {
        let d = dir("home");
        file(&d, "x.txt", 0o644);
        let (canonical, action) = resolve("~/x.txt", "", &d, &editor).unwrap();
        assert_eq!(canonical, std::fs::canonicalize(&d).unwrap().join("x.txt"));
        assert_eq!(action, Action::Opened);
    }

    #[test]
    fn a_relative_or_missing_path_is_an_error() {
        let d = dir("bad");
        assert_eq!(resolve("rel/x.txt", "", &d, &editor).unwrap_err(), "not an absolute path");
        assert_eq!(resolve_with(&d.join("missing.txt"), &editor).unwrap_err(), "no such file");
    }

    #[test]
    fn this_macs_hosts_are_local() {
        let p = file(&dir("host"), "notes.txt", 0o644);
        let p = p.to_str().unwrap();
        let home = Path::new("/nonexistent");
        assert_eq!(resolve(p, "localhost", home, &editor).unwrap().1, Action::Opened);
        assert_eq!(resolve(p, &hostname().unwrap(), home, &editor).unwrap().1, Action::Opened);
        assert_eq!(resolve(p, "other.example", home, &editor).unwrap_err(), "not this Mac: other.example");
    }
}
