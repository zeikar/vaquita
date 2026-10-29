//! A release build aborts on a panic and its binary carries no symbols, so a
//! crash report shows only addresses. The panic's message and location
//! (`file.rs:line:col`, kept even in a stripped binary) are appended to
//! `app-panic.log` in the vaquita home, beside the daemon's log, before the
//! default hook runs and the process aborts.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::home;

pub fn install() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write(&home::home().join("app-panic.log"), &line(info));
        default(info);
    }));
}

fn line(info: &std::panic::PanicHookInfo) -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(no message)".to_string());
    let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
    format!("{secs} vaquita {} thread {thread} at {location}: {message}\n", env!("CARGO_PKG_VERSION"))
}

// Best effort: a hook that failed here would hide the panic it records.
fn write(path: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_appended_to_the_log() {
        let dir = crate::open_path::tests::dir("panic-log");
        let path = dir.join("app-panic.log");
        write(&path, "one\n");
        write(&path, "two\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
    }

    #[test]
    fn the_line_names_the_message_and_where_it_was() {
        let got = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let seen = got.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| *seen.lock().unwrap() = line(info)));
        let _ = std::panic::catch_unwind(|| panic!("boom {}", 7));
        std::panic::set_hook(previous);
        let got = got.lock().unwrap().clone();
        assert!(got.contains("panic_log.rs:"), "{got}");
        assert!(got.ends_with(": boom 7\n"), "{got}");
    }
}
