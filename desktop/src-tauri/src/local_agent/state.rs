//! The persisted half of local agents: `<app_data>/local-agent/state.json`
//! (web l0-contract §4 "State"), the folder grants and the jobs.
//!
//! Written atomically (a temp file in the same folder, fsync, rename), so a
//! crash or a full disk mid-write leaves the previous file. A file that does
//! not parse is moved aside (`state.json.corrupt-<time>`) rather than
//! overwritten, so a bad edit never silently loses the grants.
//!
//! Event history is not persisted (optional for L0): the per-job ring lives in
//! memory ([`super::ring`]), and a resumed job streams from its stored
//! `streamIndex` onward.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bump when a stored field changes meaning.
pub const STATE_VERSION: u32 = 1;

/// What a grant lets the local agent do in its folder, and what a job runs
/// as. `edit` comes only from the native confirm `local_agent_pick_folder`
/// shows for a git repo root (plan §1, invariant 3); an edit job works in a
/// git worktree of the folder, never in the folder itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GrantMode {
    #[default]
    Read,
    Edit,
}

impl GrantMode {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantMode::Read => "read",
            GrantMode::Edit => "edit",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read" => Some(GrantMode::Read),
            "edit" => Some(GrantMode::Edit),
            _ => None,
        }
    }

    /// A job in `want` mode may run under a grant of this mode.
    pub fn allows(self, want: GrantMode) -> bool {
        self == GrantMode::Edit || want == GrantMode::Read
    }

    fn is_read(&self) -> bool {
        *self == GrantMode::Read
    }
}

/// One folder the person picked in the native folder dialog. `path` is its
/// realpath at grant time; every start and resume re-checks it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub path: String,
    /// The folder's own name, for lists (and, later, the cloud's copy).
    pub label: String,
    pub mode: GrantMode,
    pub added_at: String,
    /// The folder is the root of a git work tree (a `.git` folder or file in
    /// it). Refreshed on every `local_agent_status`; only a git root can be
    /// granted `edit`.
    #[serde(default)]
    pub is_git: bool,
}

/// A job's lifecycle. The first six come from the launcher's `status`
/// events; `interrupted` is Rust's alone: the process went away while the
/// job was live (app quit, app crash, launcher exit), and it can be resumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Starting,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl JobStatus {
    /// A status the launcher may report. Never `interrupted`.
    pub fn from_launcher(s: &str) -> Option<Self> {
        Some(match s {
            "starting" => JobStatus::Starting,
            "running" => JobStatus::Running,
            "waiting" => JobStatus::Waiting,
            "completed" => JobStatus::Completed,
            "failed" => JobStatus::Failed,
            "cancelled" => JobStatus::Cancelled,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Starting => "starting",
            JobStatus::Running => "running",
            JobStatus::Waiting => "waiting",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
            JobStatus::Interrupted => "interrupted",
        }
    }

    /// The job is (or was, when the app went away) mid-flight.
    pub fn is_active(self) -> bool {
        matches!(self, JobStatus::Starting | JobStatus::Running | JobStatus::Waiting)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    /// The grant it runs in. Never a path: the folder always comes from the
    /// grant (plan §1, invariant 3).
    pub grant_id: String,
    pub request: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_index: Option<u64>,
    pub status: JobStatus,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Read (in the grant's folder) or edit (in [`Job::worktree`]).
    #[serde(default, skip_serializing_if = "GrantMode::is_read")]
    pub mode: GrantMode,
    /// The launcher process that runs (or last ran) it: a uuid per process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Edit jobs: `~/.dial8/worktrees/<jobId>`, a worktree Rust made of the
    /// grant's repo on [`Job::branch`]. Kept after the job ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The repo's own `.git` folder (the worktree's common dir): the one
    /// extra root the launcher may read, so git in the sandbox finds objects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_dir: Option<String>,
    /// The commit the branch started from, for the diff stats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    /// The local branch [`Job::base_commit`] was the tip of, when the start
    /// named one (`baseBranch`); absent: the branch started from HEAD. Set
    /// once, when the worktree is made: a resume never resolves it again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// The last commit Rust made on the branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The pull request an allowed push opened for the branch (C5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<String>,
    /// A push the person allowed is running: saved before it starts and
    /// cleared when it ends, so a quit mid-push is reported at next launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_running: Option<PushMarker>,
    /// Its idle launcher was parked: `waiting` with no process, resumable.
    #[serde(default, skip_serializing_if = "is_false")]
    pub parked: bool,
    /// The worker it runs on instead of eve (`claude-code`, `codex`;
    /// [`super::workers`]). A string, so a newer app's never breaks the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
    /// When the person was last told it started (a banner) or said yes to
    /// it (a worker's confirm), in milliseconds since the Unix epoch
    /// ([`super::starts`]): its launches in the next
    /// [`super::starts::ANNOUNCED_FOR`], the revivals their own messages
    /// cause, are neither counted nor told again; later ones are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announced_at: Option<u64>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A job counted against the hour's cap ([`super::starts`]), once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartStamp {
    pub job_id: String,
    /// When, in milliseconds since the Unix epoch: wall clock, so the hour
    /// runs on across a relaunch and sleep.
    pub at: u64,
}

/// What a running push was sending, and where.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushMarker {
    pub branch: String,
    pub commit: String,
    pub remote: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateFile {
    #[serde(default = "current_version")]
    pub version: u32,
    /// This Mac's stable id for the server's device registry, made once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default)]
    pub grants: Vec<Grant>,
    #[serde(default)]
    pub jobs: Vec<Job>,
    /// The person turned local agents off on this Mac, from the tray's
    /// switch (plan §1, invariant 6): nothing starts, resumes or is shared
    /// until they turn them back on there.
    #[serde(default, skip_serializing_if = "is_false")]
    pub off: bool,
    /// The jobs started in the last hour ([`super::starts`]), kept here so a
    /// relaunch (which the page can ask for) never empties the hour.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub starts: Vec<StartStamp>,
}

fn current_version() -> u32 {
    STATE_VERSION
}

impl Default for StateFile {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            device_id: None,
            grants: Vec::new(),
            jobs: Vec::new(),
            off: false,
            starts: Vec::new(),
        }
    }
}

impl Job {
    /// A job with nothing but its identity, request and status.
    pub fn new(id: &str, grant_id: &str, request: &str, status: JobStatus, created_at: &str) -> Job {
        Job {
            id: id.to_string(),
            grant_id: grant_id.to_string(),
            request: request.to_string(),
            session_id: None,
            stream_index: None,
            status,
            created_at: created_at.to_string(),
            ended_at: None,
            mode: GrantMode::Read,
            run_id: None,
            worktree: None,
            branch: None,
            git_dir: None,
            base_commit: None,
            base_branch: None,
            commit: None,
            pull_request: None,
            push_running: None,
            parked: false,
            worker: None,
            announced_at: None,
        }
    }
}

/// Now, as stored in `addedAt` / `createdAt` / `endedAt`.
pub fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl StateFile {
    /// Read the state. Missing → empty. A file that can't be read or doesn't
    /// parse is moved aside (`state.json.corrupt-<time>`) and the state starts
    /// empty, so the next save never overwrites the grants it held. `Err` when
    /// it couldn't even be moved: the caller must not save over it.
    pub fn load(path: &Path) -> Result<StateFile, String> {
        let why = match std::fs::read(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(StateFile::default()),
            Err(e) => format!("can't be read ({e})"),
            Ok(bytes) => match serde_json::from_slice::<StateFile>(&bytes) {
                Ok(s) => return Ok(s),
                Err(e) => format!("does not parse ({e})"),
            },
        };
        let aside = corrupt_name(path);
        match std::fs::rename(path, &aside) {
            Ok(()) => {
                crate::log_to_file(&format!(
                    "[local-agent] {} {why}; moved it to {} and starting empty",
                    path.display(),
                    aside.display()
                ));
                Ok(StateFile::default())
            }
            Err(e) => Err(format!("{} {why} and can't be moved aside ({e})", path.display())),
        }
    }

    /// Write the state atomically, owner-only (it holds request text).
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| std::io::Error::other("state path has no parent"))?;
        create_private_dir(dir)?;
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        let tmp = path.with_file_name(name);
        let data = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(&data)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, path)
    }

    /// At launch: every job the last run left live has no process any more.
    /// A parked job had none already: it stays `waiting`. Returns how many
    /// were marked.
    pub fn mark_interrupted(&mut self, now: &str) -> usize {
        let mut n = 0;
        let left_live = |j: &&mut Job| j.status.is_active() && !(j.parked && j.status == JobStatus::Waiting);
        for job in self.jobs.iter_mut().filter(left_live) {
            job.status = JobStatus::Interrupted;
            job.ended_at = Some(now.to_string());
            n += 1;
        }
        n
    }

    pub fn job(&self, id: &str) -> Option<&Job> {
        self.jobs.iter().find(|j| j.id == id)
    }

    pub fn job_mut(&mut self, id: &str) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|j| j.id == id)
    }

    pub fn grant(&self, id: &str) -> Option<&Grant> {
        self.grants.iter().find(|g| g.id == id)
    }
}

fn corrupt_name(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".corrupt-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S")));
    path.with_file_name(name)
}

/// `mkdir -p` with owner-only permissions on the folders it creates.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn job(id: &str, status: JobStatus) -> Job {
        Job {
            session_id: Some("s".into()),
            stream_index: Some(3),
            ..Job::new(id, "g1", "list the files", status, "2026-10-20T00:00:00.000Z")
        }
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/state.json");
        let mut s = StateFile::default();
        s.grants.push(Grant {
            id: "g1".into(),
            path: "/Users/x/code/site".into(),
            label: "site".into(),
            mode: GrantMode::Read,
            added_at: "2026-10-20T00:00:00.000Z".into(),
            is_git: false,
        });
        s.jobs.push(job("j1", JobStatus::Waiting));
        s.save(&path).unwrap();
        assert_eq!(StateFile::load(&path).unwrap(), s);
        assert!(
            !dir.path().join("nested/state.json.tmp").exists(),
            "the temp file is renamed away"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("\"grantId\"") && text.contains("\"addedAt\"") && text.contains("\"waiting\""),
            "{text}"
        );
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            StateFile::load(&dir.path().join("state.json")).unwrap(),
            StateFile::default()
        );
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(StateFile::load(&path).unwrap(), StateFile::default());
        assert!(!path.exists());
        let aside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("state.json.corrupt-"))
            .collect();
        assert_eq!(aside.len(), 1, "{aside:?}");
    }

    #[cfg(unix)]
    fn chmod(p: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// The grants the unreadable file held survive in the moved-aside copy,
    /// and a save afterwards writes a new file instead of over them.
    #[test]
    #[cfg(unix)]
    fn an_unreadable_file_is_moved_aside_before_anything_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut s = StateFile::default();
        s.jobs.push(job("kept", JobStatus::Cancelled));
        s.save(&path).unwrap();
        chmod(&path, 0o000);
        assert_eq!(StateFile::load(&path).unwrap(), StateFile::default());
        assert!(!path.exists(), "moved, not left to be overwritten");
        let aside = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("state.json.corrupt-"))
            .expect("moved aside");
        chmod(&aside, 0o600);
        assert_eq!(StateFile::load(&aside).unwrap().jobs[0].id, "kept");
    }

    #[test]
    #[cfg(unix)]
    fn an_unreadable_file_that_cant_be_moved_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("locked");
        std::fs::create_dir(&sub).unwrap();
        let path = sub.join("state.json");
        StateFile::default().save(&path).unwrap();
        chmod(&path, 0o000);
        chmod(&sub, 0o500);
        let err = StateFile::load(&path).unwrap_err();
        chmod(&sub, 0o700);
        chmod(&path, 0o600);
        assert!(
            err.contains("can't be read") && err.contains("can't be moved aside"),
            "{err}"
        );
        assert!(path.exists());
    }

    #[test]
    fn launch_marks_live_jobs_interrupted_and_leaves_ended_ones() {
        let mut s = StateFile::default();
        for (id, st) in [
            ("a", JobStatus::Starting),
            ("b", JobStatus::Running),
            ("c", JobStatus::Waiting),
            ("d", JobStatus::Completed),
            ("e", JobStatus::Failed),
            ("f", JobStatus::Cancelled),
            ("g", JobStatus::Interrupted),
        ] {
            s.jobs.push(job(id, st));
        }
        s.jobs.push(Job {
            parked: true,
            ..job("parked", JobStatus::Waiting)
        });
        assert_eq!(s.mark_interrupted("NOW"), 3);
        let by_id = |id: &str| s.job(id).unwrap().clone();
        for id in ["a", "b", "c"] {
            assert_eq!(by_id(id).status, JobStatus::Interrupted, "{id}");
            assert_eq!(by_id(id).ended_at.as_deref(), Some("NOW"));
            assert_eq!(
                by_id(id).session_id.as_deref(),
                Some("s"),
                "the session survives, for resume"
            );
        }
        assert_eq!(by_id("d").status, JobStatus::Completed);
        assert_eq!(by_id("e").status, JobStatus::Failed);
        assert_eq!(by_id("f").status, JobStatus::Cancelled);
        assert_eq!(by_id("g").ended_at, None, "already interrupted: untouched");
        assert_eq!(by_id("parked").status, JobStatus::Waiting, "parked: no process to lose");
        assert_eq!(s.mark_interrupted("LATER"), 0, "idempotent");
    }

    #[test]
    fn launcher_statuses_never_include_interrupted() {
        for s in ["starting", "running", "waiting", "completed", "failed", "cancelled"] {
            assert_eq!(JobStatus::from_launcher(s).unwrap().as_str(), s);
        }
        assert_eq!(JobStatus::from_launcher("interrupted"), None);
        assert_eq!(JobStatus::from_launcher("RUNNING"), None);
    }

    #[test]
    fn old_files_without_optional_fields_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            r#"{"jobs":[{"id":"j","grantId":"g","request":"r","status":"running","createdAt":"t"}]}"#,
        )
        .unwrap();
        let s = StateFile::load(&path).unwrap();
        assert_eq!(s.version, STATE_VERSION);
        assert!(s.grants.is_empty());
        assert_eq!(s.jobs[0].session_id, None);
        assert_eq!(s.jobs[0].stream_index, None);
        assert_eq!(s.jobs[0].mode, GrantMode::Read, "L0 jobs were all read");
        assert_eq!(s.device_id, None);
    }

    #[test]
    fn l0_grants_load_as_read_and_edit_jobs_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            r#"{"version":1,"grants":[{"id":"g","path":"/p","label":"p","mode":"read","addedAt":"t"}],"jobs":[]}"#,
        )
        .unwrap();
        let mut s = StateFile::load(&path).unwrap();
        assert_eq!(s.grants[0].mode, GrantMode::Read);
        assert!(!s.grants[0].is_git);
        s.device_id = Some("dev-1".into());
        s.grants[0].mode = GrantMode::Edit;
        s.jobs.push(Job {
            mode: GrantMode::Edit,
            run_id: Some("run-1".into()),
            worktree: Some("/Users/x/.dial8/worktrees/j".into()),
            branch: Some("dial8/site-12345678".into()),
            git_dir: Some("/Users/x/code/site/.git".into()),
            base_commit: Some("abc".into()),
            base_branch: Some("release/2.0".into()),
            commit: Some("def".into()),
            ..job("j", JobStatus::Waiting)
        });
        s.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        for key in [
            "\"deviceId\"",
            "\"runId\"",
            "\"gitDir\"",
            "\"baseCommit\"",
            "\"baseBranch\"",
            "\"isGit\"",
            "\"edit\"",
        ] {
            assert!(text.contains(key), "{key} in {text}");
        }
        assert_eq!(StateFile::load(&path).unwrap(), s);
    }

    #[test]
    fn modes_parse_and_order() {
        assert_eq!(GrantMode::parse("read"), Some(GrantMode::Read));
        assert_eq!(GrantMode::parse("edit"), Some(GrantMode::Edit));
        assert_eq!(GrantMode::parse("write"), None);
        assert_eq!(GrantMode::parse("Edit"), None);
        assert!(GrantMode::Edit.allows(GrantMode::Edit));
        assert!(GrantMode::Edit.allows(GrantMode::Read));
        assert!(GrantMode::Read.allows(GrantMode::Read));
        assert!(!GrantMode::Read.allows(GrantMode::Edit), "never more than the grant");
    }
}
