use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

/// What endpoint.json looked like before the daemon was started. A daemon that
/// was killed rather than stopped leaves its file behind.
#[derive(PartialEq)]
pub struct Snapshot {
    pid: Option<u32>,
    mtime: Option<SystemTime>,
}

fn read_pid(path: &Path) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    u32::try_from(v.get("pid")?.as_u64()?).ok()
}

pub fn snapshot(path: &Path) -> Snapshot {
    Snapshot {
        pid: read_pid(path),
        mtime: std::fs::metadata(path).and_then(|m| m.modified()).ok(),
    }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Waits for a new endpoint.json: one that differs from `before` and names a
/// live process. Checks every `interval` until `timeout`.
pub fn wait_for_endpoint(path: &Path, before: &Snapshot, interval: Duration, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if snapshot(path) != *before && read_pid(path).is_some_and(alive) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("daemon did not write endpoint.json".to_string());
        }
        std::thread::sleep(interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_millis(10);

    fn write(path: &Path, pid: u32) {
        std::fs::write(path, format!(r#"{{"url":"ws://127.0.0.1:1/ws","token":"t","pid":{pid}}}"#)).unwrap();
    }

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("vaquita-wait-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_stale_unchanged_file_times_out() {
        let p = dir("stale").join("endpoint.json");
        write(&p, std::process::id());
        let before = snapshot(&p);
        assert!(wait_for_endpoint(&p, &before, TICK, Duration::from_millis(100)).is_err());
    }

    #[test]
    fn a_rewritten_file_with_a_live_pid_is_ready() {
        let p = dir("rewritten").join("endpoint.json");
        write(&p, 1);
        let before = snapshot(&p);
        write(&p, std::process::id());
        // Same-second rewrites keep the mtime on coarse filesystems, but the pid differs.
        assert!(wait_for_endpoint(&p, &before, TICK, Duration::from_millis(500)).is_ok());
    }

    #[test]
    fn a_new_file_after_none_is_ready() {
        let p = dir("fresh").join("endpoint.json");
        let _ = std::fs::remove_file(&p);
        let before = snapshot(&p);
        write(&p, std::process::id());
        assert!(wait_for_endpoint(&p, &before, TICK, Duration::from_millis(500)).is_ok());
    }

    #[test]
    fn a_changed_file_with_a_dead_pid_times_out() {
        let p = dir("dead").join("endpoint.json");
        write(&p, std::process::id());
        let before = snapshot(&p);
        // pid_max on macOS is 99999, so this process does not exist.
        write(&p, 4_000_000);
        assert!(wait_for_endpoint(&p, &before, TICK, Duration::from_millis(100)).is_err());
    }
}
