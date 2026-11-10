//! Every command a job runs, kept on the Mac (plan §1, invariant 6: "a
//! local log records every command run"): `<app_data>/local-agent/logs/
//! <jobId>.log`, one per job, across all its launcher runs.
//!
//! - **Append-only**: opened with `O_APPEND` and never truncated, rewritten
//!   or rotated by the app. It lives outside every job folder, so neither a
//!   launcher (its folder is `jobs/<jobId>/`) nor a sandboxed command (the
//!   app data is a protected folder) writes it.
//! - **Owner-only**: the folder is 0700 and the file 0600. It holds commands
//!   and paths, never a token (the launcher's env isn't logged).
//! - **One line an entry**, timestamped: `<UTC time>  <who>  <what>`, where
//!   who is `agent` (its tool calls and their results), `dial8` (what Rust ran
//!   for the job: the worktree, commits, the push, `gh`, the server's pull
//!   request), `ask` / `you` (native prompts and the person's answers), or
//!   `job` (runs starting and ending). Control characters are escaped, so an
//!   entry is always one line.
//! - **Bounded**: past [`MAX_LOG_BYTES`] one last line says so and later
//!   entries are dropped, so a runaway agent can't fill the disk.

use std::io::Write;
use std::path::PathBuf;

use super::state::{create_private_dir, now_stamp};

/// One job's log, at most.
pub const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
/// One entry's text, at most, in bytes (tool input is already cut to 2 KB
/// by the launcher).
const MAX_ENTRY: usize = 8 * 1024;
/// No entry starts past this; the room left takes the last one (at most
/// [`MAX_ENTRY`] and its prefix) and the [`FULL`] line.
const FULL_AT: u64 = MAX_LOG_BYTES - 16 * 1024;
const FULL: &str = "the log is full; later commands are not recorded";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    Agent,
    /// The app itself. Written to the log as `dial8`, the word logs already hold.
    App,
    Ask,
    You,
    Job,
}

impl Who {
    fn as_str(self) -> &'static str {
        match self {
            Who::Agent => "agent",
            Who::App => "dial8",
            Who::Ask => "ask",
            Who::You => "you",
            Who::Job => "job",
        }
    }
}

/// One log line, newline included.
pub fn entry_line(at: &str, who: Who, what: &str) -> String {
    let mut text = String::with_capacity(what.len().min(MAX_ENTRY));
    for c in what.chars() {
        if text.len() >= MAX_ENTRY {
            text.push('\u{2026}');
            break;
        }
        match c {
            '\n' => text.push_str("\\n"),
            '\r' => text.push_str("\\r"),
            '\t' => text.push_str("\\t"),
            c if c.is_control() => text.push_str(&format!("\\u{{{:04x}}}", c as u32)),
            c => text.push(c),
        }
    }
    format!("{at}  {:<5}  {text}\n", who.as_str())
}

pub struct CommandLog {
    dir: PathBuf,
}

impl CommandLog {
    /// `dir`: `<app_data>/local-agent/logs`.
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn path(&self, job_id: &str) -> PathBuf {
        self.dir.join(format!("{job_id}.log"))
    }

    /// Append one entry to the job's log. Failures go to the app log; they
    /// never stop the job.
    pub fn append(&self, job_id: &str, who: Who, what: &str) {
        if !super::is_safe_id(job_id) {
            return;
        }
        if let Err(e) = self.write(job_id, &entry_line(&now_stamp(), who, what)) {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] the command log couldn't be written: {e}"
            ));
        }
    }

    fn write(&self, job_id: &str, line: &str) -> std::io::Result<()> {
        create_private_dir(&self.dir)?;
        let mut opts = std::fs::OpenOptions::new();
        opts.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(self.path(job_id))?;
        let len = f.metadata()?.len();
        if len >= FULL_AT {
            return Ok(());
        }
        // The entry that reaches the limit is the last, and says so.
        let mut out = line.to_string();
        if len + line.len() as u64 >= FULL_AT {
            out.push_str(&entry_line(&now_stamp(), Who::Job, FULL));
        }
        f.write_all(out.as_bytes())
    }
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn entries_are_one_timestamped_line_each() {
        assert_eq!(
            entry_line("2026-10-21T10:00:00.000Z", Who::Agent, r#"bash {"command":"ls -la"}"#),
            "2026-10-21T10:00:00.000Z  agent  bash {\"command\":\"ls -la\"}\n"
        );
        let odd = entry_line("T", Who::You, "a\nb\rc\td\u{0007}e");
        assert_eq!(odd, "T  you    a\\nb\\rc\\td\\u{0007}e\n");
        let long = entry_line("T", Who::App, &"x".repeat(MAX_ENTRY * 2));
        assert!(long.len() < MAX_ENTRY + 64 && long.ends_with("\u{2026}\n"));
    }

    #[test]
    fn the_log_is_appended_owner_only_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let log = CommandLog::new(dir.path().join("logs"));
        let id = "38cb0eef-89e9-496d-bf08-0688225dbfcd";
        log.append(id, Who::Job, "run 1 started");
        log.append(id, Who::Agent, "bash {\"command\":\"pwd\"}");
        // A second log (a relaunched app) appends to the same file.
        let again = CommandLog::new(dir.path().join("logs"));
        again.append(id, Who::Job, "run 2 started");
        let text = std::fs::read_to_string(log.path(id)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "{text}");
        assert!(lines[0].ends_with("job    run 1 started"));
        assert!(lines[1].contains("agent  bash"));
        assert!(lines[2].ends_with("run 2 started"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&log.path(id)), 0o600);
            assert_eq!(mode(&dir.path().join("logs")), 0o700);
        }
        // Never a path out of the logs folder.
        log.append("../escape", Who::Job, "x");
        assert!(!dir.path().join("escape.log").exists());

        // Full: one last line, then nothing.
        let f = std::fs::OpenOptions::new().append(true).open(log.path(id)).unwrap();
        f.set_len(FULL_AT - 100).unwrap();
        log.append(id, Who::Agent, &"y".repeat(MAX_ENTRY * 3));
        log.append(id, Who::Agent, "after");
        let size = std::fs::metadata(log.path(id)).unwrap().len();
        assert!(size <= MAX_LOG_BYTES, "{size}");
        let tail = std::fs::read(log.path(id)).unwrap();
        let tail = String::from_utf8_lossy(&tail[tail.len() - 300..]).into_owned();
        assert!(
            tail.ends_with(&format!("{FULL}\n")) && !tail.contains("after"),
            "{tail}"
        );
    }
}
