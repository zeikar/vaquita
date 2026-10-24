use std::path::Path;
use std::time::{Duration, Instant};

const DAEMON: &str = "vaquitad";

pub const CHANGED: &str = "another daemon has started since the app connected; not stopping it";

/// The kernel's name for pid: its executable's file name when it started, cut
/// to 16 bytes; None once it has exited, even before it is reaped. Unlike
/// proc_pidpath it survives the file being deleted, as an old daemon's is when
/// its app is replaced.
fn process_name(pid: u32) -> Option<String> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut buf = [0u8; 64];
    // SAFETY: proc_name writes at most buf.len() bytes into buf.
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let n = usize::try_from(n).ok().filter(|&n| n > 0 && n <= buf.len())?;
    Some(String::from_utf8_lossy(&buf[..n]).into_owned())
}

/// The pid and token endpoint.json names; None when it is missing or unreadable.
fn read_endpoint(path: &Path) -> Option<(u32, String)> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let pid = u32::try_from(v.get("pid")?.as_u64()?).ok()?;
    Some((pid, v.get("token")?.as_str()?.to_string()))
}

/// Stops the daemon the app connected to, which endpoint.json named with
/// `pid` and `token` then, and waits, checking every `interval` until
/// `timeout`, for it to exit, which frees its instance lock for the next one.
/// With `signal` it is sent SIGTERM; without, it has agreed to a shutdown
/// request and is only waited for. Nothing is signalled unless endpoint.json
/// still names that daemon and its process is a vaquitad: another daemon may
/// have replaced it, and its pid may have been reused since.
pub fn stop(endpoint: &Path, pid: u32, token: &str, signal: bool, interval: Duration, timeout: Duration) -> Result<(), String> {
    match read_endpoint(endpoint) {
        Some((p, t)) if p == pid && t == token => {}
        Some(_) => return Err(CHANGED.to_string()),
        // A daemon that agreed to stop removes its file on the way out.
        None if !signal => {}
        None => return Err(format!("no daemon endpoint in {}", endpoint.display())),
    }
    if signal {
        if process_name(pid).as_deref() != Some(DAEMON) {
            return Err(format!("process {pid} is not vaquitad; not stopping it"));
        }
        // SAFETY: kill has no memory preconditions.
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
            return Err(format!("stop vaquitad (pid {pid}): {}", std::io::Error::last_os_error()));
        }
    }
    let deadline = Instant::now() + timeout;
    while process_name(pid).as_deref() == Some(DAEMON) {
        if Instant::now() >= deadline {
            return Err(format!("vaquitad (pid {pid}) did not stop"));
        }
        std::thread::sleep(interval);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::Child;

    const TICK: Duration = Duration::from_millis(10);

    pub(crate) fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vaquita-stop-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    pub(crate) fn write_endpoint(path: &Path, pid: u32, token: &str) {
        std::fs::write(path, format!(r#"{{"url":"ws://127.0.0.1:1/ws","token":"{token}","pid":{pid}}}"#)).unwrap();
    }

    // The daemon stand_in runs: this test binary, run under the name
    // vaquitad. A no-op in a normal run.
    #[test]
    #[ignore]
    fn stand_in_daemon() {
        if std::env::var_os("VAQUITA_STAND_IN").is_some() {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    /// A process named vaquitad, started from a link in dir.
    pub(crate) fn stand_in(dir: &Path) -> Child {
        let bin = dir.join("vaquitad");
        let _ = std::fs::remove_file(&bin);
        let exe = std::env::current_exe().unwrap();
        std::fs::hard_link(&exe, &bin).or_else(|_| std::fs::copy(&exe, &bin).map(drop)).unwrap();
        std::process::Command::new(&bin)
            .args(["--exact", "stop::tests::stand_in_daemon", "--ignored"])
            .env("VAQUITA_STAND_IN", "1")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }

    pub(crate) fn is_running_vaquitad(child: &Child) -> bool {
        process_name(child.id()).as_deref() == Some(DAEMON)
    }

    fn end(mut child: Child) -> std::process::ExitStatus {
        let _ = child.kill();
        child.wait().unwrap()
    }

    #[test]
    fn a_process_is_named_by_its_executable() {
        let exe = std::env::current_exe().unwrap();
        let file = exe.file_name().unwrap().to_string_lossy();
        let name = process_name(std::process::id()).unwrap();
        assert!(!name.is_empty() && file.starts_with(&name), "{name:?} for {file:?}");
        // pid_max on macOS is 99999.
        assert_eq!(process_name(4_000_000), None);
    }

    #[test]
    fn an_exited_process_has_no_name_before_it_is_reaped() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_name(pid).is_some() && Instant::now() < deadline {
            std::thread::sleep(TICK);
        }
        assert_eq!(process_name(pid), None);
        // SAFETY: signal 0 only checks that the process exists.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0, "reaped already");
        child.wait().unwrap();
    }

    #[test]
    fn a_pid_that_is_not_vaquitad_is_not_signalled() {
        let p = dir("other").join("endpoint.json");
        // This test process: a SIGTERM would end the run.
        write_endpoint(&p, std::process::id(), "t");
        let err = stop(&p, std::process::id(), "t", true, TICK, TICK).unwrap_err();
        assert!(err.contains("is not vaquitad"), "{err}");
    }

    #[test]
    fn a_daemon_other_than_the_one_connected_to_is_not_signalled() {
        let d = dir("changed");
        let child = stand_in(&d);
        let p = d.join("endpoint.json");
        write_endpoint(&p, child.id(), "new");
        let other_token = stop(&p, child.id(), "old", true, TICK, TICK);
        let other_pid = stop(&p, 4_000_000, "new", true, TICK, TICK);
        let other_waited = stop(&p, child.id(), "old", false, TICK, TICK);
        let alive = is_running_vaquitad(&child);
        end(child);
        assert_eq!(other_token.unwrap_err(), CHANGED);
        assert_eq!(other_pid.unwrap_err(), CHANGED);
        assert_eq!(other_waited.unwrap_err(), CHANGED);
        assert!(alive);
    }

    #[test]
    fn a_running_vaquitad_is_stopped() {
        let d = dir("running");
        let mut child = stand_in(&d);
        let p = d.join("endpoint.json");
        write_endpoint(&p, child.id(), "t");
        let stopped = stop(&p, child.id(), "t", true, TICK, Duration::from_secs(5));
        if stopped.is_err() {
            let _ = child.kill();
        }
        let status = child.wait().unwrap();
        stopped.unwrap();
        assert_eq!(status.signal(), Some(libc::SIGTERM));
    }

    #[test]
    fn a_daemon_that_agreed_to_stop_is_waited_for_and_not_signalled() {
        let d = dir("agreed");
        let mut child = stand_in(&d);
        let p = d.join("endpoint.json");
        // It removed its endpoint file on the way out; here it is killed
        // later, so a SIGTERM from stop would be what ended it.
        let _ = std::fs::remove_file(&p);
        let pid = child.id();
        let killer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            // SAFETY: kill has no memory preconditions; pid is the child's.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        });
        let stopped = stop(&p, pid, "t", false, TICK, Duration::from_secs(5));
        killer.join().unwrap();
        let status = child.wait().unwrap();
        stopped.unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    #[test]
    fn a_missing_endpoint_is_an_error_when_signalling() {
        let p = dir("missing").join("endpoint.json");
        let _ = std::fs::remove_file(&p);
        assert!(stop(&p, 1, "t", true, TICK, TICK).unwrap_err().starts_with("no daemon endpoint"));
    }
}
