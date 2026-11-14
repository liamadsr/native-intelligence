//! One launcher process per job (l0-contract §1, §4 "Supervisor").
//!
//! [`spawn`] starts `<node> <launcher>` with the clean environment the caller
//! built ([`super::config::launcher_env`]), cwd = the job folder, in a process
//! group of its own, and starts four tasks:
//! - the **writer** owns stdin and writes the queued lines (bounded, 64). A
//!   stop jumps the queue: it writes `{"type":"stop"}` and closes stdin, and
//!   by protocol the launcher cancels its turn and exits, on either one;
//! - the **reader** parses stdout lines ([`super::protocol`]) and forwards
//!   them to the actor, awaiting the bounded channel, so a flood backs up into
//!   the launcher's pipe rather than into memory;
//! - stderr goes line by line to the app log as `[local-agent:<jobId>] ...`;
//! - the **owner** is the only task that holds the `Child`. It awaits
//!   `wait()` (no `try_wait` polling) and runs the kill ladder in the same
//!   loop, so a signal can never reach a reaped (and reused) pid. After the
//!   exit it kills whatever is left in the launcher's group (an eve server it
//!   failed to stop is an orphan by then), waits for the reader to drain, and
//!   only then reports the exit, so a final `fatal` or `status` line always
//!   reaches the actor before the exit does.
//!
//! The kill ladder (borrowed from the removed claude_session.rs, minus its
//! 250 ms `try_wait` poll): stop → `term_after` → SIGTERM to the group →
//! `kill_after` → SIGKILL to the group. `kill_on_drop` stays as the last
//! resort for the direct child.
//!
//! Sandboxed commands are not in this group: the agent's sandbox provider
//! spawns each detached in a group of its own and kills it on abort.

use crate::sidecar::NoConsole;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::protocol::{
    parse_line, read_capped_line, stop_line, truncate, CappedLine, Inbound, LineError, MAX_LINE_BYTES,
};

/// Lines queued toward the launcher's stdin (contract §4: bounded, 64).
pub const STDIN_CAPACITY: usize = 64;
/// Longest stderr line read, and the part of it logged.
const MAX_STDERR_LINE: usize = 64 * 1024;
const MAX_LOGGED: usize = 2_000;
/// How long the owner waits for stdout to drain after the exit.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

pub struct SpawnSpec {
    pub job_id: String,
    /// Which process of this job (a resume is a new one); stale messages are
    /// dropped by it.
    pub gen: u64,
    pub program: PathBuf,
    pub args: Vec<PathBuf>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// `wait()` itself failed.
    pub error: Option<String>,
}

impl ExitInfo {
    pub fn clean(&self) -> bool {
        self.code == Some(0)
    }

    pub fn describe(&self) -> String {
        match (self.code, self.signal, &self.error) {
            (_, _, Some(e)) => format!("could not be waited for: {e}"),
            (Some(c), _, _) => format!("exited with code {c}"),
            (None, Some(s), _) => format!("killed by signal {s}"),
            (None, None, None) => "exited".into(),
        }
    }
}

#[derive(Debug)]
pub enum JobEvent {
    Line(Inbound),
    Exited(ExitInfo),
    /// The actor's own timer: stop waiting for a resumed launcher's session.
    ConfirmTimeout,
    /// An edit job's commit finished (the actor's own task; it may arrive
    /// after the run that asked for it exited).
    Committed {
        run_id: String,
        result: Result<super::git::CommitInfo, String>,
    },
    /// A prompt was checked off the actor (a push's remote, a fence's
    /// realpath): ask the person now, or refuse.
    PromptReady {
        run_id: String,
        id: String,
        result: Result<(super::prompts::NativePrompt, super::Action), String>,
    },
    /// A prompt's deadline passed: answered no, if it is still open.
    PromptExpired {
        run_id: String,
        id: String,
    },
    /// The person answered a native prompt (false: no, or it closed).
    PromptAnswered {
        run_id: String,
        id: String,
        allow: bool,
    },
    /// An allowed push and its pull request finished.
    Pushed {
        run_id: String,
        outcome: Box<super::push::PushOutcome>,
    },
    /// A coding agent's workspace tool call was answered (the actor's own
    /// task, [`super::workspace_tools`]): `line` goes to its stdin if the
    /// call is still waiting in the same run.
    ToolAnswered {
        id: String,
        line: String,
    },
}

#[derive(Debug)]
pub struct JobMsg {
    pub job_id: String,
    pub gen: u64,
    pub event: JobEvent,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Signal {
    Term,
    Kill,
}

enum Ctl {
    /// Start (or shorten) the ladder: SIGTERM after `term_after`, SIGKILL
    /// after `kill_after`, both from now.
    Escalate {
        term_after: Duration,
        kill_after: Duration,
    },
    KillNow,
}

/// The actor's handle on a running launcher. Dropping it closes stdin.
pub struct Handle {
    /// The launcher's pid, which leads its process group.
    pub pid: u32,
    lines: mpsc::Sender<String>,
    stop: Option<oneshot::Sender<()>>,
    ctl: mpsc::UnboundedSender<Ctl>,
}

impl Handle {
    /// Queue one protocol line (no newline).
    pub fn send_line(&self, line: String) -> Result<(), TrySendError<String>> {
        self.lines.try_send(line)
    }

    /// Write `stop` ahead of anything queued, then close stdin. Once.
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
    }

    pub fn escalate(&self, term_after: Duration, kill_after: Duration) {
        let _ = self.ctl.send(Ctl::Escalate { term_after, kill_after });
    }

    pub fn kill_now(&self) {
        let _ = self.ctl.send(Ctl::KillNow);
    }
}

/// Signal the process group led by `pid` (the launcher's: it was spawned
/// with `process_group(0)`). Errors (ESRCH: nobody left) are ignored.
pub fn signal_group(pid: u32, sig: Signal) {
    #[cfg(target_os = "macos")]
    {
        let s = match sig {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        // SAFETY: killpg only sends a signal; a stale pgid fails with ESRCH.
        unsafe {
            libc::killpg(pid as libc::pid_t, s);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (pid, sig);
}

/// Start the launcher and its tasks. Messages go to `to_actor`.
pub fn spawn(spec: SpawnSpec, to_actor: mpsc::Sender<JobMsg>) -> std::io::Result<Handle> {
    let mut cmd = Command::new(&spec.program);
    cmd.no_console();
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| std::io::Error::other("the launcher has no pid"))?;
    let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| std::io::Error::other("no stderr"))?;

    let (lines_tx, lines_rx) = mpsc::channel(STDIN_CAPACITY);
    let (stop_tx, stop_rx) = oneshot::channel();
    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();

    tokio::spawn(write_stdin(spec.job_id.clone(), stdin, lines_rx, stop_rx));
    tokio::spawn(log_stderr(spec.job_id.clone(), stderr));
    let reader = tokio::spawn(read_stdout(spec.job_id.clone(), spec.gen, stdout, to_actor.clone()));
    tokio::spawn(own(spec.job_id.clone(), spec.gen, child, pid, ctl_rx, reader, to_actor));

    crate::log_to_file(&format!(
        "[local-agent:{}] spawned {} {} (pid {}, run {})",
        spec.job_id,
        spec.program.display(),
        spec.args
            .iter()
            .map(|a| a.display().to_string())
            .collect::<Vec<_>>()
            .join(" "),
        pid,
        spec.gen
    ));
    Ok(Handle {
        pid,
        lines: lines_tx,
        stop: Some(stop_tx),
        ctl: ctl_tx,
    })
}

async fn write_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

async fn write_stdin(
    job_id: String,
    mut stdin: ChildStdin,
    mut lines: mpsc::Receiver<String>,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            biased;
            asked = &mut stop => {
                // Err: the handle went away without a stop; just close.
                if asked.is_ok() {
                    if let Err(e) = write_line(&mut stdin, &stop_line()).await {
                        crate::log_to_file(&format!("[local-agent:{job_id}] writing stop failed: {e}"));
                    }
                }
                break;
            }
            line = lines.recv() => match line {
                Some(line) => {
                    if let Err(e) = write_line(&mut stdin, &line).await {
                        crate::log_to_file(&format!("[local-agent:{job_id}] stdin write failed: {e}"));
                        break;
                    }
                }
                None => break,
            },
        }
    }
    // EOF: by protocol the launcher cancels any turn and exits within 3 s.
    let _ = stdin.shutdown().await;
}

async fn read_stdout(job_id: String, gen: u64, stdout: ChildStdout, to_actor: mpsc::Sender<JobMsg>) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        // A coding agent's `tool_call` may be up to 1 MB; every other line
        // keeps [`MAX_LINE_BYTES`], as before.
        match read_capped_line(&mut reader, &mut buf, super::workspace_tools::CALL_LINE_MAX).await {
            Ok(CappedLine::Line(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let parsed = parse_line(&line);
                if line.len() > MAX_LINE_BYTES
                    && !matches!(parsed, Ok(Inbound::ToolCall(_)) | Ok(Inbound::BadToolCall(_)))
                {
                    crate::log_to_file(&format!("[local-agent:{job_id}] skipped a {}-byte stdout line", line.len()));
                    continue;
                }
                match parsed {
                    Ok(msg) => {
                        let msg = JobMsg {
                            job_id: job_id.clone(),
                            gen,
                            event: JobEvent::Line(msg),
                        };
                        if to_actor.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Err(LineError::Unknown(ty)) => {
                        crate::log_to_file(&format!("[local-agent:{job_id}] ignoring launcher message {ty:?}"));
                    }
                    Err(LineError::Invalid(field)) => {
                        crate::log_to_file(&format!(
                            "[local-agent:{job_id}] ignoring launcher message with a bad {field}"
                        ));
                    }
                    Err(LineError::Malformed) => {
                        crate::log_to_file(&format!(
                            "[local-agent:{job_id}] ignoring non-protocol stdout: {}",
                            truncate(&line, 200)
                        ));
                    }
                }
            }
            Ok(CappedLine::TooLong(n)) => {
                crate::log_to_file(&format!("[local-agent:{job_id}] skipped a {n}-byte stdout line"));
            }
            Ok(CappedLine::Eof) => break,
            Err(e) => {
                crate::log_to_file(&format!("[local-agent:{job_id}] stdout read failed: {e}"));
                break;
            }
        }
    }
}

async fn log_stderr(job_id: String, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        match read_capped_line(&mut reader, &mut buf, MAX_STDERR_LINE).await {
            Ok(CappedLine::Line(line)) if line.trim().is_empty() => {}
            Ok(CappedLine::Line(line)) => {
                crate::log_to_file(&format!("[local-agent:{job_id}] {}", truncate(&line, MAX_LOGGED)));
            }
            Ok(CappedLine::TooLong(n)) => {
                crate::log_to_file(&format!("[local-agent:{job_id}] (a {n}-byte stderr line, not logged)"));
            }
            Ok(CappedLine::Eof) | Err(_) => break,
        }
    }
}

fn kill(child: &mut Child, pid: u32, sig: Signal) {
    if cfg!(target_os = "macos") {
        signal_group(pid, sig);
    } else {
        let _ = child.start_kill();
    }
}

async fn own(
    job_id: String,
    gen: u64,
    mut child: Child,
    pid: u32,
    mut ctl: mpsc::UnboundedReceiver<Ctl>,
    reader: JoinHandle<()>,
    to_actor: mpsc::Sender<JobMsg>,
) {
    let mut term_at: Option<Instant> = None;
    let mut kill_at: Option<Instant> = None;
    let mut ctl_open = true;
    let status = loop {
        let next = match (term_at, kill_at) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        tokio::select! {
            status = child.wait() => break status,
            c = ctl.recv(), if ctl_open => match c {
                Some(Ctl::Escalate { term_after, kill_after }) => {
                    let now = Instant::now();
                    let (t, k) = (now + term_after, now + kill_after);
                    term_at = Some(term_at.map_or(t, |old| old.min(t)));
                    kill_at = Some(kill_at.map_or(k, |old| old.min(k)));
                }
                Some(Ctl::KillNow) => {
                    crate::log_to_file(&format!("[local-agent:{job_id}] killing run {gen}"));
                    kill(&mut child, pid, Signal::Kill);
                    term_at = None;
                    kill_at = None;
                }
                // The actor let go (it gave up at app exit): keep reaping.
                None => ctl_open = false,
            },
            _ = tokio::time::sleep_until(next.unwrap_or_else(Instant::now)), if next.is_some() => {
                let now = Instant::now();
                if kill_at.is_some_and(|t| t <= now) {
                    crate::log_to_file(&format!("[local-agent:{job_id}] still running after stop: SIGKILL"));
                    kill(&mut child, pid, Signal::Kill);
                    term_at = None;
                    kill_at = None;
                } else if term_at.is_some_and(|t| t <= now) {
                    crate::log_to_file(&format!("[local-agent:{job_id}] still running after stop: SIGTERM"));
                    kill(&mut child, pid, Signal::Term);
                    term_at = None;
                }
            }
        }
    };
    // Whatever is left in the launcher's group is an orphan now.
    signal_group(pid, Signal::Kill);
    if tokio::time::timeout(DRAIN_TIMEOUT, reader).await.is_err() {
        crate::log_to_file(&format!(
            "[local-agent:{job_id}] stdout still open {DRAIN_TIMEOUT:?} after exit"
        ));
    }
    let info = match status {
        Ok(s) => {
            #[cfg(unix)]
            let signal = std::os::unix::process::ExitStatusExt::signal(&s);
            #[cfg(not(unix))]
            let signal = None;
            ExitInfo {
                code: s.code(),
                signal,
                error: None,
            }
        }
        Err(e) => ExitInfo {
            code: None,
            signal: None,
            error: Some(e.to_string()),
        },
    };
    crate::log_to_file(&format!("[local-agent:{job_id}] run {gen} {}", info.describe()));
    let _ = to_actor
        .send(JobMsg {
            job_id,
            gen,
            event: JobEvent::Exited(info),
        })
        .await;
}
