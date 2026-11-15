//! Keeping the runner and everything it starts (FFmpeg, Chrome and Chrome's
//! helpers) on a leash.
//!
//! macOS: the runner leads a process group of its own (`process_group(0)`).
//! The runner starts FFmpeg and Chrome DETACHED, in groups of their own (its
//! own cancel stops them by group: studio-worker src/child.ts, and Remotion
//! launches Chrome detached), so killing the runner's group alone would
//! leave them. So the app also keeps a list of the runner's descendants
//! ([`Tree::refresh`], every two seconds and before any kill), each with its
//! start time, and a kill reaches each one still alive with the same start
//! time (never a reused pid), by its group when it leads one. A stop is
//! SIGTERM to the runner first (it stops its children and tells the Studio),
//! then SIGKILL to the lot. The runner itself is signalled only while it is
//! still the process that was started (its pid and start time, recorded at
//! spawn), never a pid reused after it was reaped.
//!
//! If the app itself dies, a few lines given to Node ahead of the runner
//! (`--import`, [`WATCHDOG`]) see the runner's parent change. They list the
//! runner's descendants then (`/bin/ps`: pid, parent, group, start time),
//! while the tree is still whole, and send the runner SIGTERM (its own stop:
//! children stopped, the Studio told). Whatever of that list is still alive
//! with the same start time is then SIGKILLed, by group when it leads one:
//! when the runner exits (an `exit` hook, synchronous), or after 15 s at the
//! latest, together with the runner's own group. The runner's own stop is
//! relied on first because it tells the Studio; the list is the fallback for
//! FFmpeg and Chrome, which sit in groups of their own.
//!
//! Windows: a Job Object with kill-on-close holds the runner, assigned
//! before the runner is handed its token (it starts nothing before that),
//! and everything it starts is in the job too. A stop ends the job
//! (TerminateJobObject); the app dying closes the job's last handle, which
//! ends it too. Windows has no gentler signal to give a windowless Node, so a
//! stop there is immediate.

/// Run by the runner's Node before the runner (macOS): when the runner's
/// parent (the app) changes, the app is gone; the runner gets SIGTERM (its
/// own stop: children stopped, the Studio told), and 15 s later the group a
/// SIGKILL.
pub const WATCHDOG: &str = concat!(
    "data:text/javascript,",
    "const g=process.getBuiltinModule('node:child_process');const p=process.ppid;",
    "const ps=()=>{try{return g.execFileSync('/bin/ps',['-A','-o','pid=,ppid=,pgid=,lstart='],{encoding:'utf8'})",
    ".split('\\n').map(l=>l.trim().split(/\\s+/)).filter(a=>a.length>4)",
    ".map(a=>({pid:+a[0],ppid:+a[1],pgid:+a[2],start:a.slice(3).join(' ')}))}catch{return[]}};",
    "const below=()=>{const all=ps();const out=[];const q=[process.pid];while(q.length){const x=q.pop();",
    "for(const r of all)if(r.ppid===x&&r.pid!==process.pid){out.push(r);q.push(r.pid)}}return out};",
    "let seen=[];let done=false;const end=()=>{if(done)return;done=true;const now=new Map(ps().map(r=>[r.pid,r.start]));",
    "for(const r of seen)if(now.get(r.pid)===r.start){try{process.kill(r.pgid===r.pid?-r.pid:r.pid,'SIGKILL')}catch{}}};",
    "const t=setInterval(()=>{if(process.ppid===p)return;clearInterval(t);seen=below();process.once('exit',end);",
    "try{process.kill(process.pid,'SIGTERM')}catch{}",
    "setTimeout(()=>{end();try{process.kill(-process.pid,'SIGKILL')}catch{}process.exit(2)},15000)},1000);t.unref();",
);

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::HashMap;

    /// A process as it was seen: its group and its start time.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Seen {
        pub pid: i32,
        pub pgid: i32,
        pub start: (u64, u64),
    }

    fn info(pid: i32) -> Option<libc::proc_bsdinfo> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: a buffer of the struct's own size for PROC_PIDTBSDINFO.
        let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        (n == size).then_some(info)
    }

    pub fn seen(pid: i32) -> Option<Seen> {
        let i = info(pid)?;
        Some(Seen { pid, pgid: i.pbi_pgid as i32, start: (i.pbi_start_tvsec, i.pbi_start_tvusec) })
    }

    fn children(pid: i32) -> Vec<i32> {
        let mut buf = vec![0i32; 1024];
        // SAFETY: a buffer of `buf.len()` pids, its size in bytes.
        let n = unsafe { libc::proc_listchildpids(pid, buf.as_mut_ptr().cast(), (buf.len() * 4) as i32) };
        if n <= 0 {
            return Vec::new();
        }
        // It answers a count of pids (or, on some versions, bytes): whichever, within the buffer.
        let count = (n as usize).min(buf.len());
        buf.truncate(count);
        buf.into_iter().filter(|p| *p > 1).collect()
    }

    /// Every descendant of `root` now, with its start time.
    pub fn descendants(root: i32) -> Vec<Seen> {
        let mut out = Vec::new();
        let mut todo = vec![root];
        while let Some(p) = todo.pop() {
            for c in children(p) {
                if out.len() > 4096 {
                    return out;
                }
                if let Some(s) = seen(c) {
                    out.push(s);
                    todo.push(c);
                }
            }
        }
        out
    }

    /// SIGKILL each one still alive as it was seen: its group when it leads
    /// one (never the app's own group), else itself.
    pub fn kill_seen(known: &HashMap<i32, Seen>) {
        // SAFETY: getpgrp has no failure mode.
        let mine = unsafe { libc::getpgrp() };
        for s in known.values() {
            if seen(s.pid) != Some(*s) {
                continue;
            }
            // SAFETY: signals only; the identity was just checked.
            unsafe {
                if s.pgid == s.pid && s.pgid > 1 && s.pgid != mine {
                    libc::killpg(s.pgid, libc::SIGKILL);
                } else {
                    libc::kill(s.pid, libc::SIGKILL);
                }
            }
        }
    }
}

/// The runner's process tree, as far as it has been seen.
pub struct Tree {
    pub pid: u32,
    /// The runner as it was at spawn (pid and start time).
    #[cfg(target_os = "macos")]
    root: Option<mac::Seen>,
    #[cfg(target_os = "macos")]
    known: std::sync::Mutex<std::collections::HashMap<i32, mac::Seen>>,
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl Tree {
    #[cfg(not(windows))]
    pub fn new(pid: u32) -> Self {
        Self {
            pid,
            #[cfg(target_os = "macos")]
            root: mac::seen(pid as i32),
            #[cfg(target_os = "macos")]
            known: Default::default(),
        }
    }

    /// The runner is still the process started (not a pid reused since).
    #[cfg(target_os = "macos")]
    fn root_alive(&self) -> bool {
        self.root.is_some() && mac::seen(self.pid as i32) == self.root
    }

    #[cfg(windows)]
    pub fn new(pid: u32, job: Option<job::Job>) -> Self {
        Self { pid, job }
    }

    /// Note the runner's descendants as they are now (macOS).
    pub fn refresh(&self) {
        #[cfg(target_os = "macos")]
        {
            // Another process's children are never ours.
            if !self.root_alive() {
                return;
            }
            let now = mac::descendants(self.pid as i32);
            let mut known = self.known.lock().unwrap();
            for s in now {
                known.insert(s.pid, s);
            }
        }
    }

    /// Ask the runner to stop (macOS: SIGTERM to its group; it stops what it
    /// started). Windows: the job ends now.
    pub fn terminate(&self) {
        #[cfg(target_os = "macos")]
        {
            self.refresh();
            if self.root_alive() {
                // SAFETY: a signal to the runner's own group (it leads it, checked just now).
                unsafe {
                    libc::killpg(self.pid as i32, libc::SIGTERM);
                }
            }
        }
        #[cfg(windows)]
        self.kill();
    }

    /// End the runner and every descendant ever seen still alive.
    pub fn kill(&self) {
        #[cfg(target_os = "macos")]
        {
            self.refresh();
            if self.root_alive() {
                // SAFETY: the runner's own group (checked just now); then each seen descendant checked by start time.
                unsafe {
                    libc::killpg(self.pid as i32, libc::SIGKILL);
                }
            }
            mac::kill_seen(&self.known.lock().unwrap());
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }

    /// After the runner exited: whatever it left running goes.
    pub fn sweep(&self) {
        #[cfg(target_os = "macos")]
        mac::kill_seen(&self.known.lock().unwrap());
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }
}

#[cfg(windows)]
pub mod job {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A Job Object that ends every process in it when its last handle
    /// closes (this one: dropped, or the app gone).
    pub struct Job(isize);

    // SAFETY: a kernel handle, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> std::io::Result<Self> {
            // SAFETY: no security attributes, no name; the handle is owned here.
            let handle = unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }.map_err(std::io::Error::other)?;
            let job = Job(handle.0 as isize);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            // SAFETY: the struct and its own size, for its class.
            unsafe {
                SetInformationJobObject(
                    job.handle(),
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(std::io::Error::other)?;
            Ok(job)
        }

        fn handle(&self) -> HANDLE {
            HANDLE(self.0 as *mut std::ffi::c_void)
        }

        /// Put a process (by its raw handle) in the job.
        pub fn assign(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
            // SAFETY: both handles are live for the call.
            unsafe { AssignProcessToJobObject(self.handle(), HANDLE(process)) }.map_err(std::io::Error::other)
        }

        pub fn terminate(&self) {
            // SAFETY: ends the job's processes; an empty job is fine.
            let _ = unsafe { TerminateJobObject(self.handle(), 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closes the handle this owns; kill-on-close ends what is left.
            let _ = unsafe { CloseHandle(self.handle()) };
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A shell that starts a detached grandchild in a group of its own (as
    /// the runner starts FFmpeg): killing the shell's group alone would
    /// leave it; the tree's kill does not.
    #[test]
    fn a_kill_reaches_detached_descendants() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            // perl's setpgrp: a new group, like Node's `detached`.
            .arg("/usr/bin/perl -e 'setpgrp(0,0); sleep 30' & sleep 30")
            .process_group(0)
            .spawn()
            .unwrap();
        let tree = Tree::new(child.id());
        let mut grandchild = None;
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(50));
            tree.refresh();
            let known = tree.known.lock().unwrap();
            grandchild = known.values().find(|s| s.pgid == s.pid && s.pid != child.id() as i32).copied();
            if grandchild.is_some() {
                break;
            }
        }
        let g = grandchild.expect("the detached grandchild was seen");
        tree.kill();
        let _ = child.wait();
        for _ in 0..50 {
            if mac::seen(g.pid) != Some(g) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_ne!(mac::seen(g.pid), Some(g), "the detached grandchild is gone");
    }

    #[test]
    fn the_watchdog_is_one_data_url() {
        assert!(WATCHDOG.starts_with("data:text/javascript,"));
        assert!(!WATCHDOG.contains('\n') && !WATCHDOG.contains('#') && !WATCHDOG.contains('%'));
    }

    #[test]
    fn a_reaped_runner_is_not_signalled() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let tree = Tree::new(child.id());
        let _ = child.wait();
        assert!(!tree.root_alive(), "its pid may be anyone's now");
        // Nothing to signal, and no panic.
        tree.terminate();
        tree.kill();
    }

    /// The app dies (its stand-in, a shell, is SIGKILLed): the watchdog in the
    /// runner's Node stops a detached grandchild too, even one that ignores
    /// SIGTERM. Needs `node` on PATH; skipped without it.
    #[test]
    fn the_watchdog_cleans_up_after_the_app() {
        let Some(node) = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("node")).find(|n| n.is_file())) else {
            eprintln!("no node on PATH: skipped");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("grandchild.pid");
        let runner = dir.path().join("runner.cjs");
        std::fs::write(
            &runner,
            format!(
                "const {{spawn}}=require('node:child_process');const c=spawn('/usr/bin/perl',['-e','$SIG{{TERM}}=\"IGNORE\";sleep 60'],{{detached:true,stdio:'ignore'}});require('fs').writeFileSync({:?},String(c.pid));process.once('SIGTERM',()=>process.exit(2));setInterval(()=>{{}},1000)",
                pidfile.to_string_lossy()
            ),
        )
        .unwrap();
        let mut app = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("\"$0\" --import \"$1\" \"$2\" & sleep 60")
            .arg(&node)
            .arg(WATCHDOG)
            .arg(&runner)
            .spawn()
            .unwrap();
        let mut grandchild = None;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(50));
            if let Some(pid) = std::fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
                grandchild = mac::seen(pid);
                break;
            }
        }
        let g = grandchild.expect("the runner started its grandchild");
        // The app dies.
        let _ = app.kill();
        let _ = app.wait();
        let mut gone = false;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(100));
            if mac::seen(g.pid) != Some(g) {
                gone = true;
                break;
            }
        }
        if !gone {
            // SAFETY: clean up our own test process.
            unsafe { libc::kill(g.pid, libc::SIGKILL) };
        }
        assert!(gone, "the detached grandchild outlived the app");
    }
}
