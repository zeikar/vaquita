use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const RUN_TIMEOUT: Duration = Duration::from_secs(10);
const UNLOAD_TIMEOUT: Duration = Duration::from_secs(2);

const TRANSLOCATED: &str =
    "vaquita is running from a temporary location: move vaquita.app to Applications and open it again";
const NOT_INSTALLED: &str = "LaunchAgent not installed: run `vaquitad install --bootstrap`";

/// What one command run produced.
pub struct Outcome {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `launchctl`, `plutil` and the embedded `vaquitad`.
pub trait Runner {
    fn run(&self, program: &str, args: &[&str]) -> Result<Outcome, String>;
}

pub struct RealRunner;

impl Runner for RealRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<Outcome, String> {
        let mut child = Command::new(program)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{program}: {e}"))?;
        // These commands write little, so neither pipe can fill while we poll.
        let deadline = Instant::now() + RUN_TIMEOUT;
        let status = loop {
            if let Some(st) = child.try_wait().map_err(|e| format!("{program}: {e}"))? {
                break st;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} {} timed out", args.first().copied().unwrap_or("")));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let out = child.wait_with_output().map_err(|e| format!("{program}: {e}"))?;
        Ok(Outcome {
            ok: status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}

/// Starts the daemon's LaunchAgent: kickstart when the job is loaded, else
/// bootstrap from the plist, first writing it with the `vaquitad` beside `exe`.
/// A loaded job whose program is gone, with no daemon running, is replaced.
pub fn start(r: &dyn Runner, label: &str, plist: &Path, lock: &Path, exe: &Path) -> Result<(), String> {
    // Gatekeeper runs a quarantined app from a randomized copy that goes away
    // when it quits; a LaunchAgent pointing into it would break.
    if exe.to_string_lossy().contains("/AppTranslocation/") {
        return Err(TRANSLOCATED.to_string());
    }
    // The app may have been launched through a symlink to its executable.
    let exe = std::fs::canonicalize(exe).map_err(|e| format!("resolve {}: {e}", exe.display()))?;
    let embedded = exe.parent().map(|d| d.join("vaquitad")).filter(|p| p.exists());
    // SAFETY: getuid has no preconditions and cannot fail.
    let target = format!("gui/{}", unsafe { libc::getuid() });
    let service = format!("{target}/{label}");
    let bootstrap = || launchctl(r, &["bootstrap", &target, &plist.to_string_lossy()]);

    if r.run("launchctl", &["print", &service])?.ok {
        // Neither launchd nor the program's file tells whether a daemon runs:
        // launchd may accept a kickstart of a missing program (the spawn then
        // fails), and a running daemon outlives its binary being moved. The
        // daemon's instance lock does, so only an unheld one allows a bootout.
        return match &embedded {
            Some(emb) if program(r, plist)?.is_some_and(|p| !p.exists()) && !lock_held(lock) => {
                launchctl(r, &["bootout", &service])?;
                wait_unloaded(r, &service)?;
                install(r, emb)?;
                bootstrap()
            }
            _ => launchctl(r, &["kickstart", &service]),
        };
    }
    match &embedded {
        // Rewritten every time, so the plist follows the app's binary and template.
        Some(emb) => install(r, emb)?,
        None if !plist.exists() => return Err(NOT_INSTALLED.to_string()),
        None => {}
    }
    bootstrap()
}

fn launchctl(r: &dyn Runner, args: &[&str]) -> Result<(), String> {
    let out = r.run("launchctl", args)?;
    if out.ok {
        Ok(())
    } else {
        Err(format!("launchctl {} failed: {}", args[0], out.stderr))
    }
}

// bootout returns before launchd has removed the job, and a bootstrap in that
// window fails with "5: Input/output error". After the bound, bootstrap reports.
fn wait_unloaded(r: &dyn Runner, service: &str) -> Result<(), String> {
    let deadline = Instant::now() + UNLOAD_TIMEOUT;
    while r.run("launchctl", &["print", service])?.ok && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// Whether a daemon holds the instance lock (Go's flock). A missing file means
/// none does; any other failure counts as held, so a running daemon is kept.
fn lock_held(lock: &Path) -> bool {
    match std::fs::File::open(lock) {
        // Dropping the file releases a lock taken here.
        Ok(f) => f.try_lock().is_err(),
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// The program the plist runs; None when the plist is missing or names none.
fn program(r: &dyn Runner, plist: &Path) -> Result<Option<PathBuf>, String> {
    if !plist.exists() {
        return Ok(None);
    }
    let out = r.run("plutil", &["-extract", "ProgramArguments.0", "raw", "-o", "-", &plist.to_string_lossy()])?;
    Ok(out.ok.then(|| PathBuf::from(out.stdout.strip_suffix('\n').unwrap_or(&out.stdout))))
}

// Runs with the app's environment, so it writes the plist for the same home.
fn install(r: &dyn Runner, vaquitad: &Path) -> Result<(), String> {
    let out = r.run(&vaquitad.to_string_lossy(), &["install"])?;
    if out.ok {
        Ok(())
    } else {
        Err(format!("vaquitad install failed: {}", out.stderr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::os::fd::AsRawFd;

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        loaded: Cell<bool>,
        // How many prints after the bootout still find the job.
        linger: Cell<u32>,
        kickstart_fails: bool,
        // What the plist runs, as plutil prints it; None makes plutil fail.
        program: Option<PathBuf>,
        install_fails_with: Option<&'static str>,
    }

    impl Runner for Fake {
        fn run(&self, program: &str, args: &[&str]) -> Result<Outcome, String> {
            let mut call = vec![program.to_string()];
            call.extend(args.iter().map(|a| a.to_string()));
            self.calls.borrow_mut().push(call);
            let ran = |ok: bool, stdout: String, stderr: &str| Ok(Outcome { ok, stdout, stderr: stderr.to_string() });
            match (program, args[0]) {
                ("launchctl", "print") => {
                    let linger = self.linger.get();
                    if !self.loaded.get() && linger > 0 {
                        self.linger.set(linger - 1);
                        return ran(true, String::new(), "");
                    }
                    ran(self.loaded.get(), String::new(), "")
                }
                ("launchctl", "kickstart") => ran(!self.kickstart_fails, String::new(), "kick failed"),
                ("launchctl", "bootout") => {
                    self.loaded.set(false);
                    ran(true, String::new(), "")
                }
                ("launchctl", _) => ran(true, String::new(), ""),
                ("plutil", _) => match &self.program {
                    Some(p) => ran(true, format!("{}\n", p.display()), ""),
                    None => ran(false, String::new(), "no value"),
                },
                (_, "install") => ran(self.install_fails_with.is_none(), String::new(), self.install_fails_with.unwrap_or("")),
                _ => panic!("unexpected command {program}"),
            }
        }
    }

    impl Fake {
        fn loaded() -> Self {
            Fake { loaded: Cell::new(true), ..Fake::default() }
        }

        // The launchctl or vaquitad subcommand of each call, or "plutil".
        fn steps(&self) -> Vec<String> {
            self.calls.borrow().iter().map(|c| if c[0] == "plutil" { c[0].clone() } else { c[1].clone() }).collect()
        }
    }

    // A fake app bundle and home in a temp dir, removed on drop.
    struct Bundle {
        dir: PathBuf,
        exe: PathBuf,
        embedded: PathBuf,
        plist: PathBuf,
        lock: PathBuf,
    }

    impl Drop for Bundle {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn bundle(name: &str, with_daemon: bool, with_plist: bool) -> Bundle {
        let dir = std::env::temp_dir().join(format!("vaquita-launchd-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let macos = dir.join("vaquita.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        // temp_dir sits behind the /var -> /private/var symlink, and start
        // resolves the exe.
        let dir = std::fs::canonicalize(&dir).unwrap();
        let macos = dir.join("vaquita.app/Contents/MacOS");
        std::fs::write(macos.join("vaquita"), "").unwrap();
        if with_daemon {
            std::fs::write(macos.join("vaquitad"), "").unwrap();
        }
        let plist = dir.join("lbl.plist");
        if with_plist {
            std::fs::write(&plist, "").unwrap();
        }
        Bundle { exe: macos.join("vaquita"), embedded: macos.join("vaquitad"), plist, lock: dir.join("vaquitad.lock"), dir }
    }

    impl Bundle {
        fn start(&self, f: &dyn Runner) -> Result<(), String> {
            start(f, "lbl", &self.plist, &self.lock, &self.exe)
        }
    }

    fn target() -> String {
        format!("gui/{}", unsafe { libc::getuid() })
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_translocated_app_is_refused_before_any_call() {
        let f = Fake::default();
        let exe = Path::new("/private/var/folders/xy/abc/T/AppTranslocation/1234/d/vaquita.app/Contents/MacOS/vaquita");
        assert_eq!(start(&f, "lbl", Path::new("/p/lbl.plist"), Path::new("/p/vaquitad.lock"), exe).unwrap_err(), TRANSLOCATED);
        assert!(f.calls.borrow().is_empty());
    }

    #[test]
    fn a_loaded_job_whose_program_exists_is_kickstarted() {
        let b = bundle("kick", true, true);
        let f = Fake { program: Some(b.embedded.clone()), ..Fake::loaded() };
        b.start(&f).unwrap();
        let svc = format!("{}/lbl", target());
        assert_eq!(f.steps(), ["print", "plutil", "kickstart"]);
        assert_eq!(f.calls.borrow()[2], strs(&["launchctl", "kickstart", &svc]));
    }

    #[test]
    fn a_failing_kickstart_returns_its_stderr() {
        let b = bundle("kickfail", true, true);
        let f = Fake { kickstart_fails: true, program: Some(b.embedded.clone()), ..Fake::loaded() };
        assert_eq!(b.start(&f).unwrap_err(), "launchctl kickstart failed: kick failed");
    }

    #[test]
    fn a_job_whose_program_is_gone_is_kept_while_the_lock_is_held() {
        let b = bundle("held", true, true);
        let f = Fake { program: Some(b.dir.join("old/vaquitad")), ..Fake::loaded() };
        // Held the way the Go daemon holds it.
        let held = std::fs::File::create(&b.lock).unwrap();
        assert_eq!(unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0);
        b.start(&f).unwrap();
        assert_eq!(f.steps(), ["print", "plutil", "kickstart"]);
    }

    #[test]
    fn a_job_whose_program_is_gone_is_replaced_when_the_lock_is_free() {
        let b = bundle("free", true, true);
        // A daemon that died leaves its lock file behind.
        std::fs::write(&b.lock, "").unwrap();
        let f = Fake { program: Some(b.dir.join("old/vaquitad")), linger: Cell::new(2), ..Fake::loaded() };
        b.start(&f).unwrap();
        let (t, plist) = (target(), b.plist.to_string_lossy().to_string());
        let svc = format!("{t}/lbl");
        assert_eq!(
            *f.calls.borrow(),
            vec![
                strs(&["launchctl", "print", &svc]),
                strs(&["plutil", "-extract", "ProgramArguments.0", "raw", "-o", "-", &plist]),
                strs(&["launchctl", "bootout", &svc]),
                strs(&["launchctl", "print", &svc]),
                strs(&["launchctl", "print", &svc]),
                strs(&["launchctl", "print", &svc]),
                strs(&[&b.embedded.to_string_lossy(), "install"]),
                strs(&["launchctl", "bootstrap", &t, &plist]),
            ]
        );
    }

    #[test]
    fn an_unloaded_job_without_a_plist_is_installed_then_bootstrapped() {
        let b = bundle("noplist", true, false);
        let f = Fake::default();
        b.start(&f).unwrap();
        assert_eq!(f.steps(), ["print", "install", "bootstrap"]);
    }

    #[test]
    fn an_unloaded_job_with_a_plist_is_reinstalled_then_bootstrapped() {
        let b = bundle("plist", true, true);
        let f = Fake::default();
        b.start(&f).unwrap();
        assert_eq!(f.steps(), ["print", "install", "bootstrap"]);
    }

    #[test]
    fn an_app_launched_through_a_symlink_installs_its_own_binary() {
        let b = bundle("symlink", true, false);
        let link = b.dir.join("vaquita-link");
        std::os::unix::fs::symlink(&b.exe, &link).unwrap();
        let f = Fake::default();
        start(&f, "lbl", &b.plist, &b.lock, &link).unwrap();
        assert_eq!(f.calls.borrow()[1], strs(&[&b.embedded.to_string_lossy(), "install"]));
    }

    #[test]
    fn a_failing_install_returns_its_stderr_and_skips_bootstrap() {
        let b = bundle("installfail", true, false);
        let f = Fake { install_fails_with: Some("refusing to install"), ..Fake::default() };
        let err = b.start(&f).unwrap_err();
        assert!(err.contains("refusing to install"), "{err}");
        assert_eq!(f.steps(), ["print", "install"]);
    }

    #[test]
    fn without_an_embedded_binary_an_existing_plist_is_bootstrapped() {
        let b = bundle("nodaemon", false, true);
        let f = Fake::default();
        b.start(&f).unwrap();
        assert_eq!(f.steps(), ["print", "bootstrap"]);
    }

    #[test]
    fn without_an_embedded_binary_or_a_plist_install_is_suggested() {
        let b = bundle("nothing", false, false);
        let f = Fake::default();
        assert_eq!(b.start(&f).unwrap_err(), NOT_INSTALLED);
        assert_eq!(f.steps(), ["print"]);
    }

    #[test]
    fn a_failing_bootstrap_returns_its_stderr() {
        struct Failing;
        impl Runner for Failing {
            fn run(&self, _: &str, args: &[&str]) -> Result<Outcome, String> {
                Ok(Outcome { ok: false, stdout: String::new(), stderr: format!("{} boom", args[0]) })
            }
        }
        let b = bundle("bootfail", false, true);
        assert_eq!(b.start(&Failing).unwrap_err(), "launchctl bootstrap failed: bootstrap boom");
    }
}
