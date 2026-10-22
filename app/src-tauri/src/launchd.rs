use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const RUN_TIMEOUT: Duration = Duration::from_secs(10);

/// One `launchctl` invocation: whether it succeeded, and its stderr.
pub trait Runner {
    fn run(&self, args: &[&str]) -> Result<(bool, String), String>;
}

pub struct RealRunner;

impl Runner for RealRunner {
    fn run(&self, args: &[&str]) -> Result<(bool, String), String> {
        let mut child = Command::new("launchctl")
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("launchctl: {e}"))?;
        // launchctl writes little, so the stderr pipe cannot fill while we poll.
        let deadline = Instant::now() + RUN_TIMEOUT;
        let status = loop {
            if let Some(st) = child.try_wait().map_err(|e| format!("launchctl: {e}"))? {
                break st;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("launchctl {} timed out", args.first().copied().unwrap_or("")));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let out = child.wait_with_output().map_err(|e| format!("launchctl: {e}"))?;
        Ok((status.success(), String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

/// Starts the daemon's LaunchAgent: kickstart when the job is loaded, else
/// bootstrap from the plist, else tell the user to install it.
pub fn start(r: &dyn Runner, label: &str, plist: &Path, plist_exists: bool) -> Result<(), String> {
    // SAFETY: getuid has no preconditions and cannot fail.
    let target = format!("gui/{}", unsafe { libc::getuid() });
    let service = format!("{target}/{label}");
    let (loaded, _) = r.run(&["print", &service])?;
    let (ok, stderr) = if loaded {
        r.run(&["kickstart", &service])?
    } else if plist_exists {
        r.run(&["bootstrap", &target, &plist.to_string_lossy()])?
    } else {
        return Err("LaunchAgent not installed: run `vaquitad install` first".to_string());
    };
    if ok {
        Ok(())
    } else {
        Err(format!("launchctl failed: {stderr}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        loaded: bool,
        fail_with: Option<&'static str>,
    }

    impl Fake {
        fn new(loaded: bool, fail_with: Option<&'static str>) -> Self {
            Fake { calls: RefCell::new(vec![]), loaded, fail_with }
        }
    }

    impl Runner for Fake {
        fn run(&self, args: &[&str]) -> Result<(bool, String), String> {
            self.calls.borrow_mut().push(args.iter().map(|a| a.to_string()).collect());
            if args[0] == "print" {
                return Ok((self.loaded, String::new()));
            }
            match self.fail_with {
                Some(e) => Ok((false, e.to_string())),
                None => Ok((true, String::new())),
            }
        }
    }

    fn uid() -> u32 {
        unsafe { libc::getuid() }
    }

    #[test]
    fn loaded_job_is_kickstarted() {
        let f = Fake::new(true, None);
        start(&f, "lbl", Path::new("/p/lbl.plist"), true).unwrap();
        let svc = format!("gui/{}/lbl", uid());
        assert_eq!(*f.calls.borrow(), vec![vec!["print".to_string(), svc.clone()], vec!["kickstart".to_string(), svc]]);
    }

    #[test]
    fn unloaded_job_with_a_plist_is_bootstrapped() {
        let f = Fake::new(false, None);
        start(&f, "lbl", Path::new("/p/lbl.plist"), true).unwrap();
        let target = format!("gui/{}", uid());
        assert_eq!(
            *f.calls.borrow(),
            vec![
                vec!["print".to_string(), format!("{target}/lbl")],
                vec!["bootstrap".to_string(), target, "/p/lbl.plist".to_string()],
            ]
        );
    }

    #[test]
    fn no_job_and_no_plist_is_an_error_after_print() {
        let f = Fake::new(false, None);
        let err = start(&f, "lbl", Path::new("/p/lbl.plist"), false).unwrap_err();
        assert!(err.contains("vaquitad install"));
        assert_eq!(f.calls.borrow().len(), 1);
    }

    #[test]
    fn a_failing_bootstrap_returns_its_stderr() {
        let f = Fake::new(false, Some("boom"));
        let err = start(&f, "lbl", Path::new("/p/lbl.plist"), true).unwrap_err();
        assert!(err.contains("boom"));
    }

    #[test]
    fn a_failing_kickstart_returns_its_stderr() {
        let f = Fake::new(true, Some("nope"));
        assert!(start(&f, "lbl", Path::new("/p/lbl.plist"), true).unwrap_err().contains("nope"));
    }
}
