//! Killing a worker's processes by its FENCE, not by its process tree.
//!
//! A process inside a worker's Seatbelt profile can fork and `setsid` its
//! way out of the adapter's process group: re-parented to launchd, it
//! survives the job's stop with port 443, the keychain folder and the login
//! file, and can race the next launch or the commit. No walk of the process
//! tree finds it. Its sandbox does. Before each worker launch Rust makes two
//! empty files ([`make_markers`]) in its own fence folder,
//! `<app data>/local-agent/fence/` (0700, files 0600; beside `jobs/`, never
//! inside a job's folder, and outside everything the agent's profile lets it
//! write), and passes the folder as `LOCAL_AGENT_FENCE_DIR`. The adapter's
//! profile denies reading `<fence>/<job id>` and allows reading
//! `<fence>/<job id>.open`. A process the kernel says may not read the first
//! and may read the second is in that job's fence and nowhere else: another
//! job's fenced process or an app-sandboxed one is denied both, an unfenced
//! one allowed both, and neither is ever touched ([`should_kill`]).
//!
//! The files must exist: probed on this Mac (2026-11-13, macOS 27.2),
//! `sandbox_check` answers "denied" for a path that doesn't, for every
//! process. So a sweep due while either is missing kills nothing and says
//! so in the app log, once: that launch never had its markers.
//!
//! [`sweep`] goes through this user's processes (never this app or its
//! ancestors) and SIGKILLs every one in the job's fence, again and again
//! until a pass finds none or [`SWEEP_FOR`] runs out (a fenced process can
//! fork while it sweeps). The actor runs it for a worker job when its adapter
//! exits for any reason (a stop or a park always ends there: the adapter is
//! asked to stop, then signalled, then killed, and its exit is the sweep's
//! moment, after the agent's grace to cancel), before a worker's commit
//! (only what left the adapter's tree: the idle agent keeps its session),
//! and when the app starts, for every job that has markers (nothing runs
//! then). The markers go with the job ([`remove_markers`]), after a sweep,
//! never while a process of it could still be alive.
//!
//! The kernel's answer comes from `sandbox_check`, in libsystem_sandbox. It
//! is NOT in a public header: it is declared here by hand, as Apple's own
//! tools use it (`int sandbox_check(pid_t, const char *operation, int type,
//! ...)`, with `SANDBOX_FILTER_PATH` 1 and `SANDBOX_CHECK_NO_REPORT`
//! 0x40000000), and looked up at run time. If the symbol isn't there, the app
//! log says so once and every sweep does nothing: a stop then kills the
//! adapter's process group only, as before.
//!
//! **Windows** has no such marker and needs none: the equivalent to build
//! there puts the adapter and everything it starts in a Job Object with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and without
//! `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (nor `SILENT_BREAKAWAY_OK`), so no child
//! can leave it and closing the job's handle ends them all. That replaces
//! this sweep. Until it exists, workers are off on every system but macOS
//! (`workers::WorkerFiles::registry_if_complete`), and [`sweep`] there does
//! nothing.

use std::time::Duration;

use std::path::{Path, PathBuf};

/// How long a sweep keeps going while it still finds fenced processes.
pub const SWEEP_FOR: Duration = Duration::from_millis(1_500);
/// Between two passes of a sweep that found something.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SWEEP_PAUSE: Duration = Duration::from_millis(25);

/// A job id of the adapter's shape (`[A-Za-z0-9_-]{1,96}`): nothing else
/// goes into a marker's path.
fn is_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && job_id.len() <= 96
        && job_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The job's two marker paths in the fence folder `dir`: denied, and `.open`.
pub fn marker_paths(dir: &Path, job_id: &str) -> Option<(PathBuf, PathBuf)> {
    is_job_id(job_id).then(|| (dir.join(job_id), dir.join(format!("{job_id}.open"))))
}

/// Make the fence folder (0700) and the job's two empty markers in it
/// (0600), before a worker's launch. A link where either belongs is an error.
pub fn make_markers(dir: &Path, job_id: &str) -> std::io::Result<()> {
    let (marker, open) = marker_paths(dir, job_id).ok_or_else(|| std::io::Error::other("not a job id"))?;
    if std::fs::symlink_metadata(dir).is_ok_and(|m| !m.is_dir()) {
        return Err(std::io::Error::other(format!("{} isn't a folder", dir.display())));
    }
    super::state::create_private_dir(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    for path in [&marker, &open] {
        if std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_file()) {
            return Err(std::io::Error::other(format!("{} isn't a file", path.display())));
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            opts.mode(0o600);
            drop(opts.open(path)?);
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(not(unix))]
        drop(opts.open(path)?);
    }
    Ok(())
}

/// Remove the job's markers: only after a sweep, once nothing of the job runs.
pub fn remove_markers(dir: &Path, job_id: &str) {
    if let Some((marker, open)) = marker_paths(dir, job_id) {
        let _ = std::fs::remove_file(marker);
        let _ = std::fs::remove_file(open);
    }
}

/// The jobs with a marker (either file) in `dir`, by id.
pub fn marked_jobs(dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .map(|n| n.strip_suffix(".open").map_or(n.clone(), str::to_string))
        .filter(|id| is_job_id(id))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// What the kernel says about one read by one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Allowed,
    Denied,
    /// The check failed (the process is gone, or isn't this user's).
    Unknown,
}

/// Kill `pid`? Only when it is in the job's fence: the marker denied AND
/// its sibling allowed. Never a pid in `spared` (this app and its
/// ancestors), launchd or the kernel.
pub fn should_kill(pid: i32, spared: &[i32], marker: Access, open: Access) -> bool {
    pid > 1 && !spared.contains(&pid) && marker == Access::Denied && open == Access::Allowed
}

/// Which of the job's fenced processes a sweep takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// All of them: the adapter has exited.
    All,
    /// Those that left the running adapter's tree (pid given): before a
    /// commit, the agent itself (idle after its turn) keeps its session.
    OutsideTree(u32),
}

/// What a sweep did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Swept {
    pub killed: usize,
    /// Its last pass saw nothing in the fence. False also when it couldn't
    /// look (no markers, no `sandbox_check`, another system): then nothing
    /// may be done that needs the fence empty.
    pub clean: bool,
}

/// Kill the processes in `job_id`'s fence ([`Scope`]). Blocking (at most
/// about [`SWEEP_FOR`]).
#[cfg(target_os = "macos")]
pub fn sweep(dir: &Path, job_id: &str, scope: Scope) -> Swept {
    mac::sweep(dir, job_id, scope)
}

/// No fence to sweep here: workers run on macOS only (see the module notes).
#[cfg(not(target_os = "macos"))]
pub fn sweep(_dir: &Path, _job_id: &str, _scope: Scope) -> Swept {
    Swept::default()
}

/// How the adapter's `--return-logins` is run for one job: the launch's own
/// program, adapter and environment (the person's real HOME), in the job's
/// folder, unsandboxed. It starts no agent: it moves a login the agent's
/// CLI saved in its private home back onto the person's real login file,
/// and must only ever run once nothing of the job's fence is alive (a fenced
/// process could otherwise swap a link in between its check and its move).
#[derive(Debug, Clone, PartialEq)]
pub struct LoginReturn {
    pub program: PathBuf,
    /// `<root>/workers/acp.mjs --return-logins`.
    pub args: Vec<std::ffi::OsString>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

/// The longest `--return-logins` may take before it is killed.
pub const LOGINS_TIMEOUT: Duration = Duration::from_secs(5);

/// Run `--return-logins` (blocking, at most [`LOGINS_TIMEOUT`]). Its answer
/// goes to the app log only: a failure never fails the job, but it is never
/// silent there.
pub fn return_logins(job_id: &str, run: &LoginReturn) {
    use crate::sidecar::NoConsole;
    use std::io::Read;
    use std::process::{Command, Stdio};
    let log = |what: &str| crate::log_to_file(&format!("[local-agent:{job_id}] returning the coding agent's login: {what}"));
    let mut cmd = Command::new(&run.program);
    cmd.no_console();
    cmd.args(&run.args)
        .current_dir(&run.cwd)
        .env_clear()
        .envs(run.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return log(&format!("couldn't start it ({e})")),
    };
    let deadline = std::time::Instant::now() + LOGINS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return log(&format!("it took over {LOGINS_TIMEOUT:?} and was killed"));
            }
            Err(e) => return log(&format!("couldn't wait for it ({e})")),
        }
    };
    let mut out = String::new();
    if let Some(stdout) = child.stdout.take() {
        let _ = stdout.take(64 * 1024).read_to_string(&mut out);
    }
    let line = out.lines().find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok());
    match line {
        Some(v) if v["type"] == "logins" && status.success() => {
            let n = v["returned"].as_u64().unwrap_or(0);
            if n > 0 {
                log(&format!("{n} returned"));
            }
        }
        Some(v) if v["type"] == "fatal" => log(&format!("it failed: {}", v["message"].as_str().unwrap_or("?"))),
        _ => log(&format!("it ended {status} without an answer")),
    }
}

/// The fence's steps, swappable so tests can watch their order.
#[derive(Clone)]
pub struct Ops {
    pub sweep: std::sync::Arc<dyn Fn(&Path, &str, Scope) -> Swept + Send + Sync>,
    pub return_logins: std::sync::Arc<dyn Fn(&str, &LoginReturn) + Send + Sync>,
}

impl Default for Ops {
    fn default() -> Self {
        Ops {
            sweep: std::sync::Arc::new(sweep),
            return_logins: std::sync::Arc::new(return_logins),
        }
    }
}

/// A worker's run is over (its adapter exited, or never got going): sweep
/// everything left in its fence, then, only once the sweep found it empty,
/// return its logins. Before its folder is removed, if it is to be.
pub fn end_of_run(ops: &Ops, dir: &Path, job_id: &str, logins: Option<&LoginReturn>) -> Swept {
    let swept = (ops.sweep)(dir, job_id, Scope::All);
    match logins {
        Some(run) if swept.clean => (ops.return_logins)(job_id, run),
        Some(_) => crate::log_to_file(&format!(
            "[local-agent:{job_id}] not returning the coding agent's login: its fence couldn't be seen empty"
        )),
        None => {}
    }
    swept
}

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::HashMap;
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::OnceLock;
    use std::time::Instant;

    use super::{marker_paths, should_kill, Access, Scope, Swept, SWEEP_FOR, SWEEP_PAUSE};

    /// The app log says once that the markers aren't there (see the module notes).
    fn note_no_markers(job_id: &str) {
        static SAID: OnceLock<()> = OnceLock::new();
        SAID.get_or_init(|| {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] its fence markers are missing (its launch never had them): nothing is killed by \
                 fence, only by process group"
            ));
        });
    }

    /// `int sandbox_check(pid_t pid, const char *operation, int type, ...)`:
    /// libsystem_sandbox's, in no public header (declared here by hand).
    type SandboxCheck = unsafe extern "C" fn(libc::pid_t, *const c_char, c_int, ...) -> c_int;
    /// Its filter type for a path argument, and "don't log the denial".
    const SANDBOX_FILTER_PATH: c_int = 1;
    const SANDBOX_CHECK_NO_REPORT: c_int = 0x4000_0000;

    /// `sandbox_check`, looked up once; `None` (logged once) if it isn't there.
    fn sandbox_check() -> Option<SandboxCheck> {
        static CHECK: OnceLock<Option<SandboxCheck>> = OnceLock::new();
        *CHECK.get_or_init(|| {
            // SAFETY: dlsym with a NUL-terminated name; RTLD_DEFAULT searches
            // every loaded image (libSystem brings libsystem_sandbox).
            let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"sandbox_check".as_ptr()) };
            if sym.is_null() {
                crate::log_to_file(
                    "[local-agent] sandbox_check isn't available: a worker's processes are stopped by its process group \
                     only",
                );
                return None;
            }
            // SAFETY: the symbol is libsystem_sandbox's sandbox_check, of this signature.
            Some(unsafe { std::mem::transmute::<*mut c_void, SandboxCheck>(sym) })
        })
    }

    fn access(check: SandboxCheck, pid: i32, path: &CString) -> Access {
        // SAFETY: a valid C string operation and path; the variadic argument
        // is the path, as SANDBOX_FILTER_PATH says.
        let r = unsafe {
            check(
                pid,
                c"file-read-data".as_ptr(),
                SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT,
                path.as_ptr(),
            )
        };
        match r {
            0 => Access::Allowed,
            1 => Access::Denied,
            _ => Access::Unknown,
        }
    }

    /// Every process: pid → (parent pid, uid).
    fn processes() -> HashMap<i32, (i32, u32)> {
        let mut out = HashMap::new();
        // SAFETY: a null buffer asks for the count.
        let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return out;
        }
        let mut pids: Vec<libc::pid_t> = vec![0; n as usize + 64];
        let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as c_int;
        // SAFETY: the buffer holds `bytes` bytes.
        let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), bytes) };
        for &pid in pids.iter().take(got.max(0) as usize) {
            if pid <= 0 {
                continue;
            }
            // SAFETY: proc_bsdinfo is plain data; the kernel fills it whole or answers less.
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as c_int;
            let r = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size)
            };
            if r == size {
                out.insert(pid, (info.pbi_ppid as i32, info.pbi_uid));
            }
        }
        out
    }

    /// `pid` and its ancestors, as `procs` has them.
    fn line_of(pid: i32, procs: &HashMap<i32, (i32, u32)>) -> Vec<i32> {
        let mut line = vec![pid];
        let mut at = pid;
        while let Some(&(parent, _)) = procs.get(&at) {
            if parent <= 0 || line.contains(&parent) || line.len() > 256 {
                break;
            }
            line.push(parent);
            at = parent;
        }
        line
    }

    /// [`super::sweep`] with the markers in `dir`.
    pub(super) fn sweep(dir: &Path, job_id: &str, scope: Scope) -> Swept {
        let unseen = Swept::default();
        let Some((marker, open)) = marker_paths(dir, job_id) else {
            crate::log_to_file(&format!("[local-agent] no fence sweep for a job id of another shape: {job_id:?}"));
            return unseen;
        };
        // A path that doesn't exist reads as denied for every process:
        // recreate nothing, kill nothing.
        if !marker.is_file() || !open.is_file() {
            note_no_markers(job_id);
            return unseen;
        }
        let Some(check) = sandbox_check() else { return unseen };
        let (Ok(marker), Ok(open)) = (
            CString::new(marker.as_os_str().as_bytes()),
            CString::new(open.as_os_str().as_bytes()),
        ) else {
            return unseen;
        };
        // SAFETY: getuid never fails.
        let uid = unsafe { libc::getuid() };
        let me = std::process::id() as i32;
        let deadline = Instant::now() + SWEEP_FOR;
        let mut killed = 0;
        let clean = loop {
            let procs = processes();
            let spared = line_of(me, &procs);
            // In the fence, killed or not (a kill that fails leaves it seen).
            let mut seen = 0;
            let mut found = 0;
            for (&pid, &(_, owner)) in &procs {
                if owner != uid || spared.contains(&pid) {
                    continue;
                }
                if let Scope::OutsideTree(root) = scope {
                    if line_of(pid, &procs).contains(&(root as i32)) {
                        continue;
                    }
                }
                let m = access(check, pid, &marker);
                if m != Access::Denied {
                    continue;
                }
                if should_kill(pid, &spared, m, access(check, pid, &open)) {
                    seen += 1;
                    // SAFETY: a plain signal to a pid of this user's.
                    if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
                        found += 1;
                    }
                }
            }
            killed += found;
            if seen == 0 {
                break true;
            }
            if Instant::now() >= deadline {
                crate::log_to_file(&format!(
                    "[local-agent:{job_id}] the coding agent's fence still held processes after {SWEEP_FOR:?}"
                ));
                break false;
            }
            std::thread::sleep(SWEEP_PAUSE);
        };
        if killed > 0 {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] killed {killed} process(es) still in the coding agent's fence"
            ));
        }
        Swept { killed, clean }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_process_in_the_jobs_fence_is_killed() {
        use Access::*;
        let spared = [4242, 1];
        assert!(should_kill(777, &spared, Denied, Allowed), "in the fence");
        assert!(!should_kill(777, &spared, Denied, Denied), "app-sandboxed: denied both");
        assert!(!should_kill(777, &spared, Allowed, Allowed), "unfenced");
        assert!(!should_kill(777, &spared, Allowed, Denied));
        assert!(!should_kill(777, &spared, Unknown, Allowed));
        assert!(!should_kill(777, &spared, Denied, Unknown));
        assert!(!should_kill(4242, &spared, Denied, Allowed), "this app or an ancestor");
        assert!(!should_kill(1, &[], Denied, Allowed), "launchd");
        assert!(!should_kill(0, &[], Denied, Allowed));
    }

    #[test]
    fn the_job_id_is_checked_before_it_goes_into_a_path() {
        let dir = Path::new("/d/local-agent/fence");
        let id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
        assert_eq!(
            marker_paths(dir, id),
            Some((dir.join(id), dir.join(format!("{id}.open"))))
        );
        assert!(marker_paths(dir, "job_1").is_some());
        let long = "a".repeat(97);
        for bad in ["", "../x", "a/b", "a b", "x.open", "a\0b", long.as_str()] {
            assert_eq!(marker_paths(dir, bad), None, "{bad:?}");
            assert!(make_markers(Path::new("/nonexistent"), bad).is_err());
        }
    }

    /// Ops that record their calls, in order, with what a sweep answers.
    fn recording(clean: bool) -> (Ops, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (a, b) = (calls.clone(), calls.clone());
        let ops = Ops {
            sweep: std::sync::Arc::new(move |_: &Path, job: &str, scope: Scope| {
                a.lock().unwrap().push(format!("sweep {job} {scope:?}"));
                Swept { killed: 0, clean }
            }),
            return_logins: std::sync::Arc::new(move |job: &str, _: &LoginReturn| {
                b.lock().unwrap().push(format!("logins {job}"));
            }),
        };
        (ops, calls)
    }

    #[test]
    fn logins_are_returned_only_after_a_sweep_found_the_fence_empty() {
        let run = LoginReturn {
            program: "/bin/sh".into(),
            args: vec![],
            cwd: "/".into(),
            env: vec![],
        };
        let (ops, calls) = recording(true);
        end_of_run(&ops, Path::new("/f"), "j", Some(&run));
        assert_eq!(*calls.lock().unwrap(), ["sweep j All", "logins j"]);
        let (ops, calls) = recording(false);
        end_of_run(&ops, Path::new("/f"), "j", Some(&run));
        assert_eq!(*calls.lock().unwrap(), ["sweep j All"], "never while the fence may hold something");
        let (ops, calls) = recording(true);
        end_of_run(&ops, Path::new("/f"), "j", None);
        assert_eq!(*calls.lock().unwrap(), ["sweep j All"]);
    }

    #[cfg(unix)]
    #[test]
    fn return_logins_runs_the_adapter_in_the_job_folder_and_gives_up_in_time() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = std::fs::canonicalize(tmp.path()).unwrap();
        let script = cwd.join("acp.sh");
        // A stand-in for `acp.mjs --return-logins`: says where and with what it ran.
        std::fs::write(
            &script,
            "[ \"$1\" = --return-logins ] || exit 3\npwd -P > ran\nprintf '%s' \"$LOCAL_AGENT_FENCE_DIR\" > env\n\
             printf '{\"type\":\"logins\",\"returned\":1}\\n'\n",
        )
        .unwrap();
        let run = LoginReturn {
            program: "/bin/sh".into(),
            args: vec![script.clone().into(), "--return-logins".into()],
            cwd: cwd.clone(),
            env: vec![("LOCAL_AGENT_FENCE_DIR".into(), "/f".into())],
        };
        return_logins("j", &run);
        assert_eq!(std::fs::read_to_string(cwd.join("ran")).unwrap().trim(), cwd.display().to_string());
        assert_eq!(std::fs::read_to_string(cwd.join("env")).unwrap(), "/f", "the launch's environment, only");
        // One that hangs is killed at the timeout, not waited on for ever.
        std::fs::write(&script, "exec /bin/sleep 60\n").unwrap();
        let started = std::time::Instant::now();
        return_logins("j", &run);
        let took = started.elapsed();
        assert!(took >= LOGINS_TIMEOUT && took < LOGINS_TIMEOUT + Duration::from_secs(3), "{took:?}");
    }

    #[cfg(unix)]
    #[test]
    fn markers_are_private_empty_files_in_a_private_folder() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("local-agent/fence");
        make_markers(&dir, "job-1").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        for f in ["job-1", "job-1.open"] {
            assert_eq!(mode(&dir.join(f)), 0o600, "{f}");
            assert_eq!(std::fs::read(dir.join(f)).unwrap(), b"", "{f}");
        }
        std::fs::write(dir.join("job-1"), "x").unwrap();
        make_markers(&dir, "job-1").unwrap();
        assert_eq!(std::fs::read(dir.join("job-1")).unwrap(), b"", "made empty again");
        make_markers(&dir, "job-2").unwrap();
        std::fs::write(dir.join("stray name"), "").unwrap();
        assert_eq!(marked_jobs(&dir), ["job-1", "job-2"]);
        remove_markers(&dir, "job-1");
        assert_eq!(marked_jobs(&dir), ["job-2"]);
        // A link where a marker belongs is refused, never written through.
        let target = tmp.path().join("target");
        std::fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, dir.join("job-3.open")).unwrap();
        assert!(make_markers(&dir, "job-3").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    }

    /// A real fence, its profile mirroring the adapter's
    /// (web/agents/local-agent/workers/lib/agent-profile.ts, `agentProfile`)
    /// as far as it matters here, without running Node: `(allow default)`,
    /// signals and process details to its own sandbox only, writes denied
    /// but `/dev/null`, reads denied under the place the person's HOME would
    /// be (here the temp folder, which holds the fence folder), and then,
    /// after every read rule as there, the job's marker denied and its
    /// `.open` allowed. It runs a shell that double-forks a `sleep`
    /// (re-parented to launchd, out of the shell's tree), beside an unfenced
    /// `sleep`. The sweep kills the first and leaves the second; with a
    /// marker missing it kills nothing.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_sweep_kills_a_fenced_process_that_left_the_tree_and_nothing_else() {
        use std::process::{Command, Stdio};
        let tmp = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(tmp.path()).unwrap().join("local-agent/fence");
        let job = format!("test-{}", uuid::Uuid::new_v4());
        make_markers(&dir, &job).unwrap();
        let (marker, open) = marker_paths(&dir, &job).unwrap();
        let home = std::fs::canonicalize(tmp.path()).unwrap();
        let profile = [
            "(version 1)".to_string(),
            "(allow default)".into(),
            "(deny signal)".into(),
            "(allow signal (target same-sandbox))".into(),
            "(deny process-info*)".into(),
            "(allow process-info* (target same-sandbox))".into(),
            "(deny file-write*)".into(),
            "(allow file-write* (literal \"/dev/null\"))".into(),
            format!("(deny file-read-data (subpath \"{}\"))", home.display()),
            // The fence marker, after every read rule.
            format!("(deny file-read-data (literal \"{}\"))", marker.display()),
            format!("(allow file-read-data (literal \"{}\"))", open.display()),
        ]
        .join("\n");
        let out = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "/bin/sh", "-c", "( /bin/sleep 30 >/dev/null 2>&1 & echo $! )"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let fenced: i32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let mut plain = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let alive = |pid: i32| unsafe { libc::kill(pid, 0) } == 0;
        assert!(alive(fenced) && alive(plain.id() as i32));
        // Markers missing: nothing is told apart, nothing is recreated.
        std::fs::remove_file(&open).unwrap();
        assert_eq!(sweep(&dir, &job, Scope::All), Swept { killed: 0, clean: false }, "unseen, never clean");
        assert!(alive(fenced) && !open.exists());
        make_markers(&dir, &job).unwrap();

        let swept = sweep(&dir, &job, Scope::All);
        assert!(swept.killed >= 1 && swept.clean, "the fenced sleep was found, then none: {swept:?}");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while alive(fenced) {
            assert!(std::time::Instant::now() < deadline, "the fenced sleep survived");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(alive(plain.id() as i32), "an unfenced process is never touched");
        let other = format!("test-{}", uuid::Uuid::new_v4());
        make_markers(&dir, &other).unwrap();
        assert_eq!(sweep(&dir, &other, Scope::All), Swept { killed: 0, clean: true }, "another job's fence is empty");
        let _ = plain.kill();
        let _ = plain.wait();
    }
}
