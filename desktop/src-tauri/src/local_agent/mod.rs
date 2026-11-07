//! Local agents: our own eve agent running on the person's Mac, in one
//! folder they granted, driven by Rust over stdio (dial8-website
//! docs/plans/local-agents.md; the L0 contract's §1 protocol and §4 desktop,
//! and the L1 contract's section C).
//!
//! A standalone service, deliberately NOT a Local Module: those speak binary
//! protocol-v1 frames to download-verified sidecars, while the launcher here
//! is `node launcher.mjs` (the agent bundled in the app, on a pinned Node
//! downloaded on first use: [`runtime`]; [`config`] has dev.json's
//! alternative) speaking JSON lines. It reuses the modules' pieces
//! instead: stderr → `log_to_file`, `kill_on_drop`, the reap shape, and the
//! TTS service's wiring (`app.manage`, one actor task on Tauri's runtime,
//! shutdown at exit).
//!
//! The invariants this file keeps (plan §1):
//! - **Grants come only from the native folder dialog** Rust draws
//!   ([`commands::local_agent_pick_folder`], no path argument); the webview
//!   runs code our server sends, so it may ask for the picker and nothing
//!   more. [`folder`] refuses folders that are far too wide. A grant's mode
//!   comes only from the native confirm the picker shows for a git repo root
//!   ("Allow changes" / "Read only"); any other folder is read-only.
//! - **Jobs name a grant id, never a path.** Start and resume take the folder
//!   from the grant and re-check it (fresh realpath, same rules) every time.
//!   A job runs in at most its grant's mode.
//! - **Edit jobs never touch the person's checkout** ([`git`]): Rust makes a
//!   worktree under `~/.dial8/worktrees/<jobId>` on a new `dial8/…` branch,
//!   the launcher's folder is that worktree, and when the agent finishes,
//!   Rust commits there with hooks off. Nothing is pushed unless the person
//!   says yes to the native push prompt, and then only that branch
//!   ([`push`]).
//! - **An edit job's base is a local branch Rust checks** (environments plan
//!   §5): a start may name one (`baseBranch`), and Rust resolves only
//!   `refs/heads/<name>` to a sha ([`git::Git::resolve_base`]); the new
//!   worktree starts from that sha. Only a new edit job's worktree uses it:
//!   a read job drops it, and a job Rust has a record of keeps its worktree
//!   and its base without resolving the name again (rebuilt from the commit
//!   it started from if the person deleted both the worktree and the
//!   branch). The push prompt names it, the pull request goes to it rather
//!   than the remote's default branch, and a push is refused unasked when
//!   the remote has no such branch.
//! - **A push prompt says what the push sends** ([`push::what_it_sends`]):
//!   the commit, and any earlier commits the remote lacks (from the base
//!   branch or the checkout), since a push takes them all along.
//! - **Questions are asked natively** ([`prompts`], teammate C3): the
//!   launcher's `prompt` lines (a push; one more path to read, as fence
//!   grants are read-only) become a system alert Rust draws, never the
//!   webview, and each is answered exactly once with
//!   `prompt_answer`. Refused without asking: anything while local agents
//!   are off or the job is stopping, a second question while one is open,
//!   and anything its kind's checks refuse. Deny is the alert's default
//!   button, and just before the launcher's deadline (`timeoutMs`, else 5
//!   minutes) the alert closes and the answer is no; a later click never
//!   acts. A push asked while `finish`'s commit is pending commits as soon
//!   as no other tool call of the turn is running (the push tool itself
//!   waits on the answer, so the turn can't end).
//! - **No launch is silent or unbounded** ([`starts`], security review
//!   2026-10-31 P1-1): every start and resume comes from the webview, so
//!   none is the person's click. A job's first launch puts up a native
//!   banner (the folder, and that a cloud agent or a loop started it), at
//!   most [`starts::MAX_REMOTE_STARTS_PER_HOUR`] jobs start in any hour
//!   (kept in state.json), and a worker's launches run only after the
//!   person's yes in a native confirm, start and resume alike, each yes
//!   lasting an hour.
//! - **The model URL is Rust's**: built from the app's own API origin
//!   ([`config::model_base_url`]); the webview passes only the server's
//!   per-session token.
//! - **The launcher's environment is built from scratch** (`env_clear`;
//!   [`config::launcher_env`]): nothing of the app's own env reaches it.
//! - **Jobs survive a webview reload**: nothing here hooks `on_page_load` or
//!   a webview's `Destroyed`. A reloaded page rebuilds from
//!   `local_agent_events` (the per-job [`ring`]).
//! - **Nothing outlives the app**: at exit (`ExitRequested`, and `Exit`,
//!   the only event a Cmd+Q produces) every job gets `stop` and stdin EOF;
//!   the launcher's own shutdown takes ~2.0 s at most, and at 2.6 s whatever
//!   is left is killed (its whole process group); all are marked and SAVED
//!   `interrupted` (resumable), inside 3 s. A job a crash left live is
//!   marked `interrupted` at the next launch.
//!
//! Commands ([`commands`]; args camelCase on the web side, Tauri's default):
//! - `local_agent_device` → `{ deviceId, name, platform, appVersion }`;
//! - `local_agent_status` → grants `{ id, path, label, mode, isGit, addedAt }`
//!   and jobs (with `mode`, `runId`, `branch`, `commit`), and `baseBranch:
//!   true` (this app takes a start's `baseBranch`);
//! - `local_agent_pick_folder` → the grant or null;
//!   `local_agent_remove_grant { grantId }`;
//! - `local_agent_start { grantId, request, jobId?, mode?, modelToken?,
//!   resume?: { eveSessionId, streamIndex }, worker?, localModel?,
//!   baseBranch? }` → `{ jobId, runId }` (`worker`, `localModel`:
//!   [`workers`]; `baseBranch`: a local branch for a new edit job to start
//!   from, [`git`]);
//! - `local_agent_resume { jobId, modelToken? }` → `{ jobId, runId }`;
//! - `local_agent_set_model_token { jobId, modelToken }`;
//! - `local_agent_send { jobId, text, policy: "steer"|"queue" }`,
//!   `local_agent_stop { jobId }`;
//! - `local_agent_events { jobId, sinceSeq } → [{ seq, runId, event }]`
//!   (exclusive: `seq > sinceSeq`; `sinceSeq: 0` is the whole ring).
//!
//! Event `local-agent://event` `{ jobId, seq, runId, event }`: `event` is the
//! launcher's `NormalizedEvent` as it sent it; an edit job's
//! `{ kind: "branch", branch, commit, filesChanged, insertions, deletions }`
//! after each commit (Rust's own, next `seq`); a native prompt's `{ kind:
//! "prompt", id, prompt: "push" | "fence", state: "asking" | "allowed" |
//! "denied" | "refused" | "expired", why? }` (so the chat can say it is waiting for
//! the person on their Mac; `why`, not `reason`, which marks an exit); after an allowed push, `{ kind: "pull_request",
//! ok, branch, remote, … }` ([`push::PushOutcome::event`]); or, when the
//! process exits,
//! `{ kind: "status", status, reason }` (the `reason` marks a process exit):
//! - after `local_agent_stop`: `cancelled` (the session is kept: resumable);
//! - the app quit: `interrupted`;
//! - the process went away on its own mid-job: `interrupted` (`failed` if it
//!   never reported a session, so there is nothing to resume); after a
//!   `fatal` line: `failed` with its message; after the job had ended
//!   (`completed`, say): that status again.
//!
//! Resume works on any job without a process that has a `sessionId`
//! (`cancelled`, `interrupted`, `completed`, `waiting`, `failed`). It answers
//! once the new launcher reports its session (or after 20 s, still starting),
//! and fails with a clear error when the launcher can't take the job's lock
//! because a leftover launcher still runs it (the job keeps its old status).
//! At most [`MAX_RUNNING`] launchers run (or are being prepared) at once.
//!
//! **Parking.** `finish` ends a turn, not the session, so an idle launcher
//! (`waiting`, no turn open, no commit pending) would hold a slot and ~400 MB
//! for ever. Two things park it: a start or resume that finds all slots taken
//! parks the least recently active idle job (a running one never), and any
//! job idle for [`Timing::idle_park_after`] (10 minutes) is parked. Parking
//! is a stop that keeps the job `waiting` with its session: its exit event is
//! `{ kind: "status", status: "waiting", reason: "parked" }`, and
//! `local_agent_status` shows it as `{ status: "waiting", live: false,
//! parked: true, sessionId, streamIndex }`. A resume (or a start under its
//! id) brings it back on the same session; a relaunch of the app leaves it
//! `waiting`, not `interrupted`. While a parked launcher shuts down (≤ 2 s)
//! it no longer counts toward the cap.
//!
//! **The command log** (plan §1, invariant 6): every tool call the agent
//! makes and everything Rust runs for a job (its worktree, commits, the push,
//! `gh`, the server's pull request), every prompt and answer, and each run's
//! start and end, appended with a timestamp to an owner-only file per job
//! ([`cmdlog`]).
//!
//! **The tray and the off switch** (plan §1, invariant 6). The actor
//! publishes a [`TrayView`] whenever it changes: the jobs with a launcher
//! (and starts being prepared), and whether local agents are off. The tray
//! draws it once a folder is shared: "Working in <folder>" with a Stop per
//! job, and a "Local Agents" check item; while a turn runs, the menu bar
//! title says so too (plan §5). Turning it off is native only (no
//! command; the webview runs code our server sends): it stops every job
//! (`cancelled`, resumable), refuses starts, resumes and new folders, and
//! `local_agent_status` says `available: false` with [`OFF`], so the
//! relay stops heartbeating and the server sees the Mac as offline. It is
//! kept in state.json. Nothing is published once the app is quitting: the
//! menu is drawn on the main thread, which quitting holds.
//!
//! Threads: the command handlers (they also run git for a new edit job's
//! worktree, so a big checkout never holds the actor up); one actor task
//! ([`Actor`]) that owns the state, the rings and the job handles (no
//! locks); four tasks per running launcher ([`supervisor`]); one task per
//! commit. Channels: commands → actor (`Cmd`, unbounded); launchers and
//! commits → actor (`JobMsg`, bounded: backpressure into the pipe).

mod cmdlog;
pub mod commands;
mod config;
mod device;
mod folder;
mod git;
mod prompts;
mod protocol;
mod push;
mod ring;
mod runtime;
mod starts;
mod state;
mod supervisor;
// End-to-end against POSIX sh stand-ins; the local agent is macOS-only so far.
#[cfg(all(test, unix))]
mod tests;
pub(crate) mod workers;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot, OnceCell};
use tokio::time::Instant;

use cmdlog::{CommandLog, Who};
use config::{LaunchConfig, LaunchEnv, Resolver};
pub use device::DeviceInfo;
use git::{CommitInfo, Git, Worktree};
use prompts::{Access, FenceAsk, FenceRules, NativePrompt, PushAsk};
use protocol::{prompt_answer_line, resume_line, send_line, start_line, token_line, Inbound, Policy, PromptKind};
use push::{PushCtx, PushOutcome, PushPlan};
use ring::{Entry, Ring, RING_CAP};
pub use runtime::RuntimeStatus;
use runtime::{Runtime, RuntimeSpec};
use starts::StartWindow;
use state::{create_private_dir, now_stamp, Grant, GrantMode, Job, JobStatus, PushMarker, StateFile};
use supervisor::{ExitInfo, Handle, JobEvent, JobMsg, SpawnSpec};

pub const EVENT: &str = "local-agent://event";
/// Launchers running at once (contract §4).
pub const MAX_RUNNING: usize = 3;
/// Longest request or message, in bytes.
const MAX_TEXT_BYTES: usize = 16 * 1024;
/// Longest model relay token, in bytes (l1-contract C3).
const MAX_TOKEN_BYTES: usize = 2 * 1024;
/// Shortest one: the launcher's own `MODEL_TOKEN` rule, so a token Rust
/// accepts is never silently dropped there.
const MIN_TOKEN_BYTES: usize = 16;
/// A start or resume without a model relay token, where one is required.
const NEEDS_TOKEN: &str = "local agents need a session from Dial8";
/// Everything refused while the person has local agents turned off.
pub const OFF: &str = "local agents are turned off on this Mac (Local Agents, in Dial8's menu bar menu, turns them back on)";
/// Longest eve session id `resume` may name.
const MAX_SESSION_ID: usize = 256;
/// Largest single event kept and emitted. The launcher truncates tool input
/// to 2 KB and output to 4 KB, so this only catches a broken launcher.
const MAX_EVENT_BYTES: usize = 64 * 1024;
/// Rings kept for jobs without a process (each up to [`RING_CAP`] events).
const MAX_RINGS: usize = 20;
/// Launcher messages queued toward the actor.
const JOB_MSG_CAPACITY: usize = 1024;
/// Everything `ExitRequested` waits for, at most.
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    pub job_id: String,
    pub seq: u64,
    /// The launcher process the event belongs to (l1-contract C6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub event: Value,
}

/// Where events go: the webviews in the app, a recorder in tests.
pub(crate) trait Host: Send + Sync + 'static {
    fn emit(&self, payload: &EventPayload);
    /// What the tray shows changed.
    fn tray(&self, _view: &TrayView) {}
    /// Ask the person, natively (invariant 5), for at most `timeout` (then
    /// the alert closes). `answer` gets true only for the allow button;
    /// dropping it is a no.
    fn ask(&self, prompt: &NativePrompt, timeout: Duration, answer: oneshot::Sender<bool>);
    /// Tell the person, natively, what needs no answer: a launch a cloud
    /// agent or a loop started, the hour's cap reached ([`starts`]).
    fn notify(&self, _title: &str, _body: &str) {}
}

struct AppHost {
    app: AppHandle,
    /// The one thread that draws the tray's views, in order.
    tray: std::sync::mpsc::Sender<TrayView>,
}

impl AppHost {
    fn new(app: AppHandle) -> Self {
        let drawer = app.clone();
        let tray = latest_worker("dial8-local-agent-tray", move |view| {
            crate::tray::set_local_agents(&drawer, view)
        });
        AppHost { app, tray }
    }
}

impl Host for AppHost {
    fn emit(&self, payload: &EventPayload) {
        let _ = self.app.emit(EVENT, payload);
    }

    /// Off the actor (drawing a menu waits on the main thread), and on one
    /// thread, so views are drawn in the order published: a stale "Working
    /// in X" never lands after a newer view.
    fn tray(&self, view: &TrayView) {
        let _ = self.tray.send(view.clone());
    }

    /// `CFUserNotificationDisplayAlert` ([`prompts::show_alert`]): drawn by
    /// macOS, not the webview, on a thread of its own. It closes itself a
    /// little after `timeout`, so the actor's own deadline answers first.
    fn ask(&self, prompt: &NativePrompt, timeout: Duration, answer: oneshot::Sender<bool>) {
        let p = prompt.clone();
        std::thread::spawn(move || {
            let _ = answer.send(prompts::show_alert(&p, timeout + Duration::from_secs(2)));
        });
    }

    /// A banner in Notification Center, in Rust's words
    /// ([`crate::notifications::show_native`]).
    fn notify(&self, title: &str, body: &str) {
        let id = format!("{}{}", crate::notifications::NATIVE_ID_PREFIX, uuid::Uuid::new_v4());
        let (title, body) = (title.to_string(), body.to_string());
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::notifications::show_native(&id, &title, &body).await {
                crate::log_to_file(&format!("[local-agent] the banner \u{201C}{title}\u{201D} didn't go up: {e}"));
            }
        });
    }
}

/// A thread that runs `apply` on what is sent to it, in order, skipping to
/// the newest when several are waiting.
pub(crate) fn latest_worker<T: Send + 'static>(
    name: &str,
    mut apply: impl FnMut(T) + Send + 'static,
) -> std::sync::mpsc::Sender<T> {
    let (tx, rx) = std::sync::mpsc::channel::<T>();
    let spawned = std::thread::Builder::new().name(name.to_string()).spawn(move || {
        while let Ok(mut latest) = rx.recv() {
            while let Ok(newer) = rx.try_recv() {
                latest = newer;
            }
            apply(latest);
        }
    });
    if let Err(e) = spawned {
        crate::log_to_file(&format!("[local-agent] the {name} thread didn't start: {e}"));
    }
    tx
}

/// The tray's local agents section (plan §5, "On the Mac").
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrayView {
    /// Draw it: a folder is shared, or local agents are off (so the switch
    /// can turn them back on).
    pub shown: bool,
    pub off: bool,
    /// Jobs with a launcher, and starts being prepared; by folder.
    pub jobs: Vec<TrayJob>,
    /// Local Agents → Model and → Coding Agents ([`workers`]).
    pub l4: workers::L4View,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayJob {
    pub id: String,
    /// The grant's folder name.
    pub label: String,
    pub state: TrayJobState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayJobState {
    /// Starting, or a turn is running.
    Working,
    /// Its turn ended; the launcher waits for a message.
    Waiting,
    /// A native prompt for it is open: it waits for the person.
    Asking,
    /// Asked to stop.
    Stopping,
}

#[derive(Debug, Clone)]
pub(crate) struct Timing {
    /// After `local_agent_stop`: SIGTERM the group this long after `stop`…
    pub stop_term_after: Duration,
    /// …and SIGKILL it this long after.
    pub stop_kill_after: Duration,
    /// At app exit: SIGKILL every group still alive this long after `stop`
    /// (after the launcher's own ~2.0 s EOF shutdown budget)…
    pub exit_kill_after: Duration,
    /// …and stop waiting for their exits this long after (inside 3 s).
    pub exit_give_up_after: Duration,
    /// `local_agent_resume` answers when the launcher reports its session, or
    /// at the latest after this long (it is still starting; events follow).
    pub resume_confirm_after: Duration,
    /// Park a launcher idle this long (no turn, no commit, no message).
    pub idle_park_after: Duration,
    /// How often idle launchers are looked for.
    pub idle_check_every: Duration,
    /// How long a prompt stays open when the launcher names no `timeoutMs`
    /// (the launcher's own default); then it is answered no.
    pub prompt_timeout: Duration,
    /// How long a worker's confirm waits for the person ([`starts`]); then
    /// the launch is refused. The server's claim lives on the Mac's
    /// heartbeat meanwhile (the job is reported live).
    pub worker_confirm: Duration,
    /// How long a yes lets a worker run, follow-up messages and all; then
    /// it is parked, and resuming it asks again.
    pub worker_yes_for: Duration,
    /// After a no (or no answer), how long a folder's workers aren't asked
    /// about again.
    pub worker_backoff: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            // The launcher cancels its turn and exits on stop; EOF alone
            // makes it exit within 3 s.
            stop_term_after: Duration::from_secs(5),
            stop_kill_after: Duration::from_secs(7),
            exit_kill_after: Duration::from_millis(2_600),
            exit_give_up_after: Duration::from_millis(2_900),
            resume_confirm_after: Duration::from_secs(20),
            idle_park_after: Duration::from_secs(10 * 60),
            idle_check_every: Duration::from_secs(30),
            prompt_timeout: Duration::from_secs(5 * 60),
            worker_confirm: Duration::from_secs(2 * 60),
            worker_yes_for: Duration::from_secs(60 * 60),
            worker_backoff: Duration::from_secs(10 * 60),
        }
    }
}

pub(crate) struct Paths {
    /// `<app_data>/local-agent`: state.json, dev.json, jobs/<jobId>/,
    /// runtime/<version>/.
    pub root: PathBuf,
    /// Per-job TMPDIRs, outside HOME (the agent's Seatbelt profile denies
    /// reads under HOME) and canonical (Seatbelt matches realpaths).
    pub tmp_root: PathBuf,
    /// HOME, canonical.
    pub home: PathBuf,
    /// Never granted, nor anything inside or above them ([`folder`]).
    pub protected: Vec<PathBuf>,
}

fn canonical_or(p: PathBuf) -> PathBuf {
    std::fs::canonicalize(&p).unwrap_or(p)
}

impl Paths {
    /// `identifier`: the bundle id (`ai.dial8.desktop`).
    fn for_app(data_dir: &Path, identifier: &str) -> Paths {
        let home = dirs::home_dir()
            .map(canonical_or)
            .unwrap_or_else(|| PathBuf::from("/var/empty"));
        let tmp_root = canonical_or(std::env::temp_dir()).join("dial8-local-agent");
        let library = home.join("Library");
        let protected = vec![
            // state.json, dev.json and every job's eve session.
            canonical_or(data_dir.to_path_buf()),
            // The webviews' cookies and localStorage: the Dial8 session. The
            // bundled app keys them by bundle id, a bare dev binary by name.
            library.join("WebKit").join(identifier),
            library.join("WebKit/dial8-desktop"),
            library.join("Caches").join(identifier),
            tmp_root.clone(),
        ];
        Paths {
            root: data_dir.join("local-agent"),
            tmp_root,
            home,
            protected,
        }
    }

    fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    /// The pinned Node's versions ([`runtime`]).
    fn runtime_root(&self) -> PathBuf {
        self.root.join("runtime")
    }

    fn job_dir(&self, id: &str) -> PathBuf {
        self.root.join("jobs").join(id)
    }

    fn job_tmp(&self, id: &str) -> PathBuf {
        self.tmp_root.join(id)
    }

    /// Where edit jobs' worktrees live: `~/.dial8/worktrees/<jobId>`.
    fn worktrees(&self) -> PathBuf {
        self.home.join(".dial8").join("worktrees")
    }

    /// The jobs' command logs ([`cmdlog`]).
    fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
}

/// Ids this module minted (uuid v4); anything else never becomes a path.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A job id the server chose (its session uuid): a uuid in its canonical,
/// lowercase hyphenated form, so it is also a safe folder name.
fn check_job_id(id: &str) -> Result<String, String> {
    match uuid::Uuid::parse_str(id) {
        Ok(u) if u.to_string() == id => Ok(id.to_string()),
        _ => Err("jobId must be a lowercase uuid".into()),
    }
}

/// An opaque model relay token: [`MIN_TOKEN_BYTES`] to [`MAX_TOKEN_BYTES`]
/// printable ASCII characters, no spaces (the launcher's rule; one env value
/// and one JSON string).
fn check_token(token: &str) -> Result<String, String> {
    if token.len() < MIN_TOKEN_BYTES || token.len() > MAX_TOKEN_BYTES {
        return Err(format!(
            "modelToken must be {MIN_TOKEN_BYTES} to {MAX_TOKEN_BYTES} printable ASCII characters"
        ));
    }
    if !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("modelToken must be printable ASCII".into());
    }
    Ok(token.to_string())
}

/// `local_agent_resume`'s `message`: what the resume is for (the relay
/// revives a parked job to deliver one). Rust sends it itself, once the
/// launcher reports its session, so a worker's confirm shows exactly the
/// message that runs ([`starts`]).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeMessage {
    pub text: String,
    pub policy: String,
}

/// `local_agent_start`'s `resume`: the server's record of the job's eve
/// session, used only when Rust has no record of its own.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeArgs {
    pub eve_session_id: String,
    pub stream_index: u64,
}

/// `local_agent_start`'s arguments as the page sent them.
#[derive(Debug, Clone, Default)]
pub struct StartArgs {
    pub grant_id: String,
    pub request: String,
    pub job_id: Option<String>,
    pub mode: Option<String>,
    pub model_token: Option<String>,
    pub resume: Option<ResumeArgs>,
    /// `claude-code` or `codex` ([`workers`]); absent: eve.
    pub worker: Option<String>,
    /// The model mode the server recorded for the session (`localModel`):
    /// a job keeps it ([`workers`]); absent: whatever this Mac uses now.
    pub local_model: Option<bool>,
    /// The local branch a new edit job's worktree starts from
    /// (`baseBranch`); absent: HEAD. Checked and resolved only when a
    /// worktree is made for it ([`git::Git::resolve_base`]): a read job, or
    /// a job with a worktree already, drops it.
    pub base_branch: Option<String>,
}

/// [`StartArgs`], checked.
#[derive(Debug, Clone)]
struct Checked {
    grant_id: String,
    request: String,
    job_id: Option<String>,
    mode: Option<GrantMode>,
    token: Option<String>,
    resume: Option<ResumeArgs>,
    worker: Option<workers::Worker>,
    local_model: Option<bool>,
    /// As sent: checked only if a worktree is made for it ([`Actor::plan_start`]).
    base_branch: Option<String>,
}

impl StartArgs {
    fn check(self) -> Result<Checked, String> {
        let job_id = self.job_id.as_deref().map(check_job_id).transpose()?;
        let mode = match self.mode.as_deref() {
            None => None,
            Some(m) => Some(GrantMode::parse(m).ok_or("mode must be \"read\" or \"edit\"")?),
        };
        let token = self.model_token.as_deref().map(check_token).transpose()?;
        if let Some(r) = &self.resume {
            let id = &r.eve_session_id;
            if id.is_empty() || id.len() > MAX_SESSION_ID || id.chars().any(|c| c.is_control()) {
                return Err("resume.eveSessionId is not a session id".into());
            }
        }
        Ok(Checked {
            grant_id: self.grant_id,
            request: check_text(self.request, "request")?,
            job_id,
            mode,
            token,
            resume: self.resume,
            worker: self.worker.as_deref().map(workers::Worker::parse).transpose()?,
            local_model: self.local_model,
            base_branch: self.base_branch,
        })
    }
}

/// One `local_agent_status` job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: String,
    pub grant_id: String,
    pub request: String,
    pub mode: GrantMode,
    pub status: JobStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_index: Option<u64>,
    /// A launcher process is running for it right now, or one is being got
    /// ready (its worktree, or its worker's confirm): the relay keeps the
    /// server's lease on it meanwhile.
    pub live: bool,
    /// The worker it runs on (`claude-code`, `codex`): its launches wait on
    /// the person's confirm, so the relay runs them off its drain.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
    /// Its worker's confirm is up on this Mac: another worker's launch would
    /// be refused for now ([`starts::ONE_CONFIRM`]), so the relay waits.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub asking: bool,
    /// `waiting` with no process: parked while idle; resume brings it back.
    pub parked: bool,
    /// The last event `seq` in its ring (0: none this app run).
    pub last_seq: u64,
    /// The launcher process running it now, or the last one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Edit jobs: the branch, and the last commit Rust made on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The pull request an allowed push opened for its branch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_dir: Option<String>,
    /// `<agentDir>/.output/server/index.mjs` exists.
    pub built: bool,
    pub grants: Vec<Grant>,
    pub jobs: Vec<JobSummary>,
    /// Packaged mode: the pinned Node, downloaded on first use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeStatus>,
    /// L4: this Mac's model choice is local and the bundle runs it
    /// ([`workers`]). Never which model. The server narrows its tools for it.
    pub local_model: bool,
    /// E3: `local_agent_start` takes `baseBranch`. Always true here; an
    /// older app sends no field, so the web shows its base-branch field only
    /// for a Mac that has it (and an older one keeps branching from HEAD).
    pub base_branch: bool,
}

/// What `local_agent_start` and `local_agent_resume` answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub job_id: String,
    /// The launcher process now running the job (l1-contract C6).
    pub run_id: String,
}

struct Snapshot {
    grants: Vec<Grant>,
    jobs: Vec<JobSummary>,
    off: bool,
}

type Reply<T> = oneshot::Sender<Result<T, String>>;

/// The actor's answer to a start, before anything is launched.
enum Plan {
    /// Already running: the start is a no-op (a retried claim, a reload).
    Live(StartResult),
    Launch(LaunchPlan),
}

struct LaunchPlan {
    job_id: String,
    mode: GrantMode,
    /// Edit jobs: what the handler needs to make (or find) the worktree.
    edit: Option<EditPlan>,
    /// A worker's confirm, up ([`starts`]): the handler waits for it before
    /// making anything for the job.
    confirm: Option<Confirm>,
    /// What the person answered it, filled in by the handler.
    answer: Option<Answer>,
}

/// A worker launch's native confirm, up: the person's answer to come.
struct Confirm {
    worker: workers::Worker,
    answer: oneshot::Receiver<bool>,
    wait: Duration,
}

/// A confirm's outcome: yes, or why not and who decided (the command log
/// says "you" for a no, "dial8" when nobody answered).
type Answer = Result<(), (Who, String)>;

impl Confirm {
    /// The person's yes, or why not: a no, the alert gone without one, or
    /// no answer within its wait.
    async fn answered(self) -> Answer {
        match tokio::time::timeout(self.wait, self.answer).await {
            Ok(Ok(true)) => Ok(()),
            Ok(_) => Err((Who::You, starts::denied(self.worker))),
            Err(_) => Err((Who::Dial8, starts::unanswered(self.worker, self.wait))),
        }
    }
}

/// How a launch was let in ([`starts`]): only the answer to a native
/// confirm, which no page can give, is the person's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Admit {
    /// Nobody on this Mac was asked: the person is told it started.
    Told { resumed: bool },
    /// Told (or confirmed) before, in this run of the app or an earlier one:
    /// a revival, told nothing new.
    Announced,
    /// The person said yes to its confirm (a worker's).
    Confirmed,
}

struct EditPlan {
    /// The grant's folder (a git repo root).
    repo: PathBuf,
    /// `~/.dial8/worktrees`.
    root: PathBuf,
    branch: String,
    /// Where a new branch starts, if one has to be made: a new job's base
    /// branch (checked by [`git::check_base_branch`]) or HEAD, or the
    /// commit a job with a record started from.
    base: git::Base,
}

/// An edit job's worktree, ready.
struct Prepared {
    worktree: Worktree,
    git_dir: PathBuf,
}

/// A start between its plan and its launch.
struct Preparing {
    grant_id: String,
    /// `local_agent_stop` came meanwhile: don't launch.
    stopped: bool,
    /// Its worker's confirm is up ([`starts`]); one at a time.
    confirming: bool,
    /// For `local_agent_status`, which reports it live meanwhile (a new job
    /// has no record yet).
    request: String,
    mode: GrantMode,
    worker: Option<workers::Worker>,
    created_at: String,
}

/// What a running edit job needs for its commits and its push.
#[derive(Clone)]
struct EditCtx {
    git: Git,
    worktree: PathBuf,
    git_dir: PathBuf,
    base: Option<String>,
    gh: Option<PathBuf>,
    api_origin: String,
}

impl EditCtx {
    fn new(launch: &LaunchConfig, worktree: PathBuf, git_dir: PathBuf, base: Option<String>) -> Self {
        EditCtx {
            git: Git::from_launch(launch),
            worktree,
            git_dir,
            base,
            gh: launch.gh.clone(),
            api_origin: launch.api_origin.clone(),
        }
    }
}

enum Cmd {
    Snapshot {
        reply: oneshot::Sender<Snapshot>,
    },
    DeviceId {
        reply: Reply<String>,
    },
    /// The picked folder's realpath, if it may be granted, and whether it
    /// is a git repo root (then the picker asks about edits).
    CheckPick {
        picked: PathBuf,
        reply: Reply<(PathBuf, bool)>,
    },
    AddGrant {
        picked: PathBuf,
        mode: GrantMode,
        reply: Reply<Grant>,
    },
    RemoveGrant {
        grant_id: String,
        reply: Reply<()>,
    },
    PlanStart {
        args: Checked,
        reply: Reply<Plan>,
    },
    Launch {
        args: Checked,
        plan: LaunchPlan,
        prepared: Result<Option<Prepared>, String>,
        launch: LaunchConfig,
        reply: Reply<StartResult>,
    },
    SetToken {
        job_id: String,
        token: String,
        reply: Reply<()>,
    },
    Send {
        job_id: String,
        text: String,
        policy: Policy,
        reply: Reply<()>,
    },
    Stop {
        job_id: String,
        reply: Reply<()>,
    },
    /// Before a resume: the hour's cap, and a worker's confirm put up (with
    /// the message it would run).
    PlanResume {
        job_id: String,
        message: Option<String>,
        reply: Reply<Option<Confirm>>,
    },
    Resume {
        job_id: String,
        launch: LaunchConfig,
        token: Option<String>,
        /// The answer to its confirm, when it had one.
        answer: Option<Answer>,
        /// Sent once the launcher reports its session ([`ResumeMessage`]).
        message: Option<(String, Policy)>,
        reply: Reply<StartResult>,
    },
    Events {
        job_id: String,
        since: u64,
        reply: Reply<Vec<Entry>>,
    },
    /// The tray's switch.
    SetOff {
        off: bool,
        reply: Reply<()>,
    },
    /// The model choice and what was found on this Mac ([`workers`]).
    Workers(workers::Cmd),
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

pub struct LocalAgentService {
    cmds: mpsc::UnboundedSender<Cmd>,
    resolver: Arc<Resolver>,
    /// Starts and resumes must carry the server's model relay token: every
    /// build but a debug one, where the dev page starts jobs on the dev env
    /// file's gateway key instead.
    pub(crate) require_model_token: bool,
    /// A folder dialog is open (one at a time).
    picking: AtomicBool,
    /// [`LocalAgentService::shutdown`] ran: a second exit event returns at once.
    shut_down: AtomicBool,
    /// The Mac's name, asked once per app run.
    name: OnceCell<String>,
}

/// Clears [`LocalAgentService::picking`] when the picker call ends.
pub(crate) struct PickGuard<'a>(&'a AtomicBool);

impl Drop for PickGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl LocalAgentService {
    /// Create the service and start its actor on Tauri's runtime. On macOS
    /// it touches state.json (and a debug build reads dev.json); elsewhere
    /// every command reports `available: false`.
    pub fn spawn(app: AppHandle) -> Self {
        let enabled = cfg!(target_os = "macos");
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("dial8"));
        let identifier = app.config().identifier.clone();
        let paths = Paths::for_app(&data_dir, &identifier);
        // Contents/Resources/local-agent in the bundle (dev.sh stages it next
        // to the dev binary). Canonical: the agent's Seatbelt profile matches
        // realpaths.
        let bundle_dir = app
            .path()
            .resource_dir()
            .ok()
            .map(|d| canonical_or(d.join("local-agent")));
        let runtime = Arc::new(Runtime::new(
            RuntimeSpec::pinned(),
            paths.runtime_root(),
            runtime::http_client(),
        ));
        let resolver = Arc::new(Resolver::new(
            enabled,
            paths.root.join("dev.json"),
            paths.home.clone(),
            bundle_dir,
            runtime,
        ));
        let (service, actor) = Self::with_host(
            Arc::new(AppHost::new(app)),
            paths,
            Timing::default(),
            resolver.clone(),
            enabled,
        );
        tauri::async_runtime::spawn(actor.run());
        // The tray's Model and Coding Agents submenus follow this Mac ([`workers`]).
        if enabled {
            tauri::async_runtime::spawn(workers::watch(service.cmds.clone(), resolver.clone()));
        }
        // The login shell probe takes seconds: run it now, not on first start.
        if resolver.has_dev_config() {
            tauri::async_runtime::spawn(async move { resolver.warm().await });
        } else if resolver.packaged_ready() {
            // Someone who already shared a folder gets the runtime (and the
            // probe) ready now; nobody else downloads anything.
            let cmds = service.cmds.clone();
            tauri::async_runtime::spawn(async move {
                let (tx, rx) = oneshot::channel();
                if cmds.send(Cmd::Snapshot { reply: tx }).is_err() {
                    return;
                }
                if rx.await.is_ok_and(|snap| !snap.grants.is_empty()) {
                    prewarm(&resolver);
                }
            });
        }
        service
    }

    pub(crate) fn with_host(
        host: Arc<dyn Host>,
        paths: Paths,
        timing: Timing,
        resolver: Arc<Resolver>,
        enabled: bool,
    ) -> (Self, Actor) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (job_tx, job_rx) = mpsc::channel(JOB_MSG_CAPACITY);
        let log = CommandLog::new(paths.logs());
        let actor = Actor {
            host,
            paths,
            timing,
            enabled,
            state: StateFile::default(),
            live: HashMap::new(),
            preparing: HashMap::new(),
            committing: HashSet::new(),
            pushes: HashMap::new(),
            log,
            tokens: HashMap::new(),
            rings: HashMap::new(),
            cmds: rx,
            job_rx,
            job_tx,
            next_gen: 0,
            evicted_seq: HashMap::new(),
            max_rings: MAX_RINGS,
            writable: true,
            closing: false,
            shutdown: None,
            last_tray: None,
            l4: workers::L4::default(),
            starts: StartWindow::new(starts::MAX_REMOTE_STARTS_PER_HOUR, starts::START_WINDOW),
            refused_workers: HashMap::new(),
        };
        (
            Self {
                cmds: tx,
                resolver,
                require_model_token: !cfg!(debug_assertions),
                picking: AtomicBool::new(false),
                shut_down: AtomicBool::new(false),
                name: OnceCell::new(),
            },
            actor,
        )
    }

    async fn ask<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        self.cmds
            .send(make(tx))
            .map_err(|_| "local agents have stopped".to_string())?;
        rx.await.map_err(|_| "local agents have stopped".to_string())
    }

    pub async fn status(&self) -> Result<StatusReport, String> {
        let r = self.resolver.resolve(false).await;
        let snap = self.ask(|reply| Cmd::Snapshot { reply }).await?;
        let local_model = self.uses_local_model(r.agent_dir.as_deref()).await;
        Ok(StatusReport {
            available: r.available() && !snap.off,
            reason: if snap.off { Some(OFF.into()) } else { r.reason },
            node: r.node.map(|p| p.display().to_string()),
            agent_dir: r.agent_dir.map(|p| p.display().to_string()),
            built: r.built,
            grants: snap.grants,
            jobs: snap.jobs,
            // After the resolve, which checked the binary: `ready` is current.
            runtime: r.packaged.then(|| self.resolver.runtime().status()),
            local_model,
            base_branch: true,
        })
    }

    /// A folder was just shared: in packaged mode, get the runtime and the
    /// login shell probe ready in the background for its first start.
    pub(crate) fn prewarm(&self) {
        if self.resolver.packaged_ready() {
            prewarm(&self.resolver);
        }
    }

    /// `Err("unavailable: …")` unless the setup checks out.
    pub async fn ensure_available(&self) -> Result<(), String> {
        match self.resolver.resolve(false).await.reason {
            None => Ok(()),
            Some(why) => Err(format!("unavailable: {why}")),
        }
    }

    /// This Mac for the server's device registry.
    pub async fn device(&self, app_version: String) -> Result<DeviceInfo, String> {
        let device_id = self.ask(|reply| Cmd::DeviceId { reply }).await??;
        let name = self.name.get_or_init(device::computer_name).await.clone();
        Ok(DeviceInfo {
            device_id,
            name,
            platform: std::env::consts::OS.to_string(),
            app_version,
        })
    }

    async fn launch_config(&self) -> Result<LaunchConfig, String> {
        let r = self.resolver.resolve(true).await;
        if let Some(why) = r.reason {
            return Err(format!("unavailable: {why}"));
        }
        if !r.built {
            return Err("the local agent isn't built yet (run the web repo's local-agent build)".into());
        }
        r.launch.ok_or_else(|| "unavailable".to_string())
    }

    /// Claim the folder picker; `None` while another is open.
    pub(crate) fn begin_pick(&self) -> Option<PickGuard<'_>> {
        self.picking
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| PickGuard(&self.picking))
    }

    /// Whether the folder the person picked may be granted: its realpath,
    /// and whether it is a git repo root.
    pub(crate) async fn check_pick(&self, picked: PathBuf) -> Result<(PathBuf, bool), String> {
        self.ask(|reply| Cmd::CheckPick { picked, reply }).await?
    }

    /// Turn the folder the person picked into a grant (or update the
    /// existing one's mode). `mode` is what they answered in the native
    /// confirm; a folder that isn't a git repo root is always read-only.
    pub(crate) async fn add_grant(&self, picked: PathBuf, mode: GrantMode) -> Result<Grant, String> {
        self.ask(|reply| Cmd::AddGrant { picked, mode, reply }).await?
    }

    pub async fn remove_grant(&self, grant_id: String) -> Result<(), String> {
        self.ask(|reply| Cmd::RemoveGrant { grant_id, reply }).await?
    }

    /// Refused before anything is resolved (or downloaded) for it.
    fn check_has_token(&self, token: Option<&String>) -> Result<(), String> {
        if self.require_model_token && token.is_none() {
            return Err(NEEDS_TOKEN.into());
        }
        Ok(())
    }

    pub async fn start(&self, args: StartArgs) -> Result<StartResult, String> {
        self.check_has_token(args.model_token.as_ref())?;
        let launch = self.launch_config().await?;
        self.start_with(args, launch).await
    }

    /// Plan in the actor, make an edit job's worktree here (git can take
    /// seconds on a big repo), then launch in the actor.
    pub(crate) async fn start_with(&self, args: StartArgs, launch: LaunchConfig) -> Result<StartResult, String> {
        let args = args.check()?;
        // L4: the model and worker it runs on, refused here when they can't be.
        let run = self.check_start(&args, &launch).await?;
        let mut plan = match self
            .ask(|reply| Cmd::PlanStart {
                args: args.clone(),
                reply,
            })
            .await??
        {
            Plan::Live(running) => return Ok(running),
            Plan::Launch(plan) => plan,
        };
        self.stash_run(&plan.job_id, run);
        // A worker runs only after the person's yes on this Mac, and nothing
        // is made for it before ([`starts`]).
        if let Some(confirm) = plan.confirm.take() {
            plan.answer = Some(confirm.answered().await);
        }
        let prepared = match (&plan.edit, &plan.answer) {
            (Some(edit), None | Some(Ok(()))) => prepare_edit(&Git::from_launch(&launch), edit, &plan.job_id)
                .await
                .map(Some),
            _ => Ok(None),
        };
        self.ask(|reply| Cmd::Launch {
            args,
            plan,
            prepared,
            launch,
            reply,
        })
        .await?
    }

    /// A fresh model relay token for a job: written to its launcher's stdin
    /// if it runs, and kept (in memory only) for its next launch.
    pub async fn set_model_token(&self, job_id: String, model_token: String) -> Result<(), String> {
        let token = check_token(&model_token)?;
        self.ask(|reply| Cmd::SetToken { job_id, token, reply }).await?
    }

    pub async fn send(&self, job_id: String, text: String, policy: String) -> Result<(), String> {
        let policy = Policy::parse(&policy).ok_or_else(|| "policy must be \"steer\" or \"queue\"".to_string())?;
        self.ask(|reply| Cmd::Send {
            job_id,
            text,
            policy,
            reply,
        })
        .await?
    }

    pub async fn stop(&self, job_id: String) -> Result<(), String> {
        self.ask(|reply| Cmd::Stop { job_id, reply }).await?
    }

    /// `local_model`: the model mode the server recorded for the session
    /// ([`StartArgs::local_model`]); `message`, the one the resume is for
    /// ([`ResumeMessage`]).
    pub async fn resume(
        &self,
        job_id: String,
        model_token: Option<String>,
        local_model: Option<bool>,
        message: Option<ResumeMessage>,
    ) -> Result<StartResult, String> {
        self.check_has_token(model_token.as_ref())?;
        let launch = self.launch_config().await?;
        self.resume_as(job_id, model_token, local_model, message, launch).await
    }

    /// A resume without the server's recorded mode (the tests' rigs).
    #[cfg(test)]
    pub(crate) async fn resume_with(
        &self,
        job_id: String,
        model_token: Option<String>,
        launch: LaunchConfig,
    ) -> Result<StartResult, String> {
        self.resume_as(job_id, model_token, None, None, launch).await
    }

    pub(crate) async fn resume_as(
        &self,
        job_id: String,
        model_token: Option<String>,
        local_model: Option<bool>,
        message: Option<ResumeMessage>,
        launch: LaunchConfig,
    ) -> Result<StartResult, String> {
        let token = model_token.as_deref().map(check_token).transpose()?;
        let message = match message {
            None => None,
            Some(m) => Some((
                check_text(m.text, "message")?,
                Policy::parse(&m.policy).ok_or_else(|| "policy must be \"steer\" or \"queue\"".to_string())?,
            )),
        };
        // L4: as for a start ([`workers`]).
        self.check_resume(&job_id, local_model, &launch).await?;
        // The hour's cap, and a worker's yes, as for a start ([`starts`]).
        let confirm = self
            .ask(|reply| Cmd::PlanResume {
                job_id: job_id.clone(),
                message: message.as_ref().map(|(text, _)| text.clone()),
                reply,
            })
            .await??;
        let answer = match confirm {
            Some(confirm) => Some(confirm.answered().await),
            None => None,
        };
        self.ask(|reply| Cmd::Resume {
            job_id,
            launch,
            token,
            answer,
            message,
            reply,
        })
        .await?
    }

    pub async fn events(&self, job_id: String, since: u64) -> Result<Vec<Entry>, String> {
        self.ask(|reply| Cmd::Events { job_id, since, reply }).await?
    }

    /// The tray's switch: off stops every job and refuses new ones; on
    /// gets the runtime ready again for someone with a folder shared.
    pub(crate) async fn set_off(&self, off: bool) -> Result<(), String> {
        self.ask(|reply| Cmd::SetOff { off, reply }).await??;
        if !off {
            self.prewarm();
        }
        Ok(())
    }

    /// App exit: stop every job, kill what's left, mark them `interrupted`
    /// and save; bounded to [`EXIT_TIMEOUT`]. Once: both exit events call it
    /// (a tray Quit raises `ExitRequested` and then `Exit`; Cmd+Q only
    /// `Exit`), and the second returns at once.
    pub async fn shutdown(&self) {
        if self.shut_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let (tx, rx) = oneshot::channel();
        if self.cmds.send(Cmd::Shutdown { reply: tx }).is_err() {
            return;
        }
        if tokio::time::timeout(EXIT_TIMEOUT, rx).await.is_err() {
            crate::log_to_file("[local-agent] shutdown timed out");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopKind {
    /// `local_agent_stop`.
    User,
    /// `ExitRequested`.
    AppExit,
    /// Idle, and its slot or memory is wanted: the job stays `waiting`.
    Park,
}

/// Download the runtime and run the login shell probe, in the background.
fn prewarm(resolver: &Arc<Resolver>) {
    resolver.runtime().prewarm();
    let resolver = resolver.clone();
    tauri::async_runtime::spawn(async move { resolver.warm().await });
}

/// The reason on a parked job's exit event.
pub const PARKED: &str = "parked";
/// A message sent to a waiting job counts as an open turn for this long,
/// until the launcher reports the turn's status.
const AWAIT_TURN_GRACE: Duration = Duration::from_secs(120);

/// The least recently active of the idle launchers (id, idle since).
pub(crate) fn oldest_idle<'a>(idle: impl IntoIterator<Item = (&'a str, Instant)>) -> Option<String> {
    idle.into_iter()
        .min_by_key(|(_, since)| *since)
        .map(|(id, _)| id.to_string())
}

/// The idle launchers idle for `after` or longer at `now`.
pub(crate) fn idle_too_long<'a>(
    idle: impl IntoIterator<Item = (&'a str, Instant)>,
    now: Instant,
    after: Duration,
) -> Vec<String> {
    idle.into_iter()
        .filter(|(_, since)| now.saturating_duration_since(*since) >= after)
        .map(|(id, _)| id.to_string())
        .collect()
}

/// A job's final status and the reason when its process exits.
/// `has_session`: the launcher reported a session (so it can be resumed).
pub(crate) fn exit_outcome(
    current: JobStatus,
    stop: Option<StopKind>,
    info: &ExitInfo,
    fatal: Option<&str>,
    has_session: bool,
) -> (JobStatus, String) {
    match stop {
        Some(StopKind::AppExit) => (JobStatus::Interrupted, "the app quit".into()),
        Some(StopKind::Park) if has_session => (JobStatus::Waiting, PARKED.into()),
        Some(StopKind::Park) => (JobStatus::Failed, "parked before it started a session".into()),
        Some(StopKind::User) if info.clean() => (JobStatus::Cancelled, "stopped".into()),
        Some(StopKind::User) => (
            JobStatus::Cancelled,
            format!("stopped (the launcher {})", info.describe()),
        ),
        None => match fatal {
            Some(msg) => (JobStatus::Failed, msg.to_string()),
            // Nothing to resume: it never got as far as a session.
            None if current.is_active() && !has_session => (
                JobStatus::Failed,
                format!("the launcher {} before it started a session", info.describe()),
            ),
            None if current.is_active() => (JobStatus::Interrupted, format!("the launcher {}", info.describe())),
            None => (current, format!("the launcher {}", info.describe())),
        },
    }
}

/// Make (or find) an edit job's worktree. Runs in the command handler.
async fn prepare_edit(git: &Git, edit: &EditPlan, job_id: &str) -> Result<Prepared, String> {
    let git_dir = git.repo_git_dir(&edit.repo).await?;
    let worktree = git
        .ensure_worktree(
            &edit.repo,
            &git_dir,
            &edit.root,
            job_id,
            &edit.branch,
            &edit.base,
        )
        .await?;
    Ok(Prepared { worktree, git_dir })
}

fn check_text(text: String, what: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err(format!("the {what} is empty"));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!("the {what} is too long (over {} KB)", MAX_TEXT_BYTES / 1024));
    }
    if text.contains('\0') {
        return Err(format!("the {what} contains a NUL character"));
    }
    Ok(text)
}

struct Live {
    gen: u64,
    /// This process's uuid (l1-contract C6).
    run_id: String,
    handle: Handle,
    stop: Option<StopKind>,
    fatal: Option<String>,
    /// A resume not yet confirmed by the launcher's `session` line.
    resume: Option<PendingResume>,
    /// Edit jobs: where commits go.
    edit: Option<EditCtx>,
    /// The agent called `finish` (its summary): commit when its turn ends.
    pending_commit: Option<String>,
    /// The launcher last said anything, or was sent a message.
    last_active: Instant,
    /// A message went to it and no status has come back yet.
    awaiting_turn_since: Option<Instant>,
    /// The launcher's open `prompt`: one at a time.
    prompt: Option<OpenPrompt>,
    /// Paths the person opened to this run with a fence prompt. Memory only,
    /// never a grant: a resume starts without them.
    fence_allowed: Vec<(PathBuf, Access)>,
    /// Prompt ids this run already answered: a repeat is dropped.
    answered: HashSet<String>,
    /// Where Rust runs programs from outside the sandbox, for this run: no
    /// fence ever opens them for writing ([`never_write`]).
    never_write: Arc<Vec<PathBuf>>,
    /// The agent's tool calls of this turn that haven't returned (by
    /// callId): a push commits early only once the asking one is the last.
    tools_running: HashSet<String>,
    /// Git as Rust runs it for this run (it lists the person's git config
    /// for a fence write).
    git: Git,
    /// L4: the worker this run is ([`workers`]): never sent the session
    /// token, and its fence is never widened.
    worker: Option<workers::Worker>,
    /// A worker's yes lasts until then ([`Timing::worker_yes_for`]); then it
    /// is parked, mid-turn or not.
    yes_until: Option<Instant>,
}

/// A `prompt` the launcher waits on.
struct OpenPrompt {
    id: String,
    /// `push`, `fence`.
    kind: &'static str,
    stage: PromptStage,
    /// Answered no at this point if still open (a little before `timeout`).
    deadline: Instant,
    /// How long the launcher waits, from its `timeoutMs`.
    timeout: Duration,
}

enum PromptStage {
    /// A push asked for before `finish`'s commit landed: asked after it.
    AwaitingCommit(PushAsk),
    /// Rust is reading the repo (its remote) before it asks.
    Preparing,
    /// The native prompt is up.
    Asking(Action),
}

/// What a yes does.
#[derive(Debug)]
pub(crate) enum Action {
    Push(Box<PushPlan>),
    Fence { path: PathBuf, access: Access },
}

/// Prompt ids remembered per run, at most (then forgotten all at once).
const MAX_ANSWERED: usize = 1_024;
/// A fence path's realpath check, at most (a hung network volume).
const FENCE_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
/// A push the app quit in the middle of.
const QUIT_DURING_PUSH: &str = "Dial8 quit during the push; it may not have reached the remote, and no pull request \
                                was opened from here. Ask again to push";

/// "5 min", "30 s", "300 ms".
fn human(d: Duration) -> String {
    if d >= Duration::from_secs(60) && d.as_secs().is_multiple_of(60) {
        format!("{} min", d.as_secs() / 60)
    } else if d >= Duration::from_secs(1) {
        format!("{} s", d.as_secs())
    } else {
        format!("{} ms", d.as_millis())
    }
}

/// Where Rust runs programs from outside the sandbox for a launch: the tool
/// PATH's folders, git, gh, ssh, the login shell, node and its install, the
/// launcher, the agent's folder, and the app itself.
fn never_write(launch: &LaunchConfig) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = launch
        .tool_path
        .split(':')
        .filter(|d| d.starts_with('/'))
        .map(PathBuf::from)
        .collect();
    out.push(launch.git.clone());
    out.extend(launch.gh.clone());
    out.extend(config::find_tool(&launch.tool_path, "ssh"));
    out.push(PathBuf::from("/usr/bin/ssh"));
    out.extend(std::env::var_os("SHELL").map(PathBuf::from));
    out.push(launch.node.clone());
    // The whole Node install (`…/node/bin/node` → `…/node`), not only the
    // binary; never HOME or above (a `~/bin/node` would close all of HOME).
    let install = launch.node.parent().and_then(Path::parent);
    out.extend(
        install
            .filter(|root| !Path::new(&launch.home).starts_with(root))
            .map(Path::to_path_buf),
    );
    out.push(launch.launcher.clone());
    out.push(PathBuf::from(&launch.agent_dir));
    if let Ok(exe) = std::env::current_exe() {
        let app = exe
            .ancestors()
            .find(|a| a.extension().is_some_and(|e| e == "app"))
            .map(Path::to_path_buf);
        out.push(app.unwrap_or_else(|| exe.parent().map_or(exe.clone(), Path::to_path_buf)));
    }
    out
}

/// The `prompt` event the page and the server see.
fn prompt_event(id: &str, kind: &str, state: &str, why: Option<&str>) -> Value {
    let mut ev = json!({ "kind": "prompt", "id": id, "prompt": kind, "state": state });
    if let Some(why) = why {
        ev["why"] = Value::String(why.to_string());
    }
    ev
}

struct PendingResume {
    /// `local_agent_resume`'s answer, until it is given.
    reply: Option<Reply<StartResult>>,
    /// The job's status before the resume, put back if another launcher
    /// still holds the job.
    prior: JobStatus,
    /// The message the resume is for ([`ResumeMessage`]): sent when the
    /// resume is answered `Ok`, where the relay would have sent it.
    message: Option<(String, Policy)>,
}

/// The launcher's `fatal` when another launcher holds `<jobdir>/.launcher.lock`.
const LOCK_FATAL: &str = "job already running";
const LOCK_ERROR: &str = "this job is still running in another launcher (left over from an earlier run of the app); \
                          wait for it to finish, or end that process, then resume again";

struct Shutdown {
    replies: Vec<oneshot::Sender<()>>,
    kill_at: Instant,
    give_up_at: Instant,
    killed: bool,
}

/// Owns everything: the persisted state, the running launchers, the rings.
pub(crate) struct Actor {
    host: Arc<dyn Host>,
    paths: Paths,
    timing: Timing,
    enabled: bool,
    state: StateFile,
    live: HashMap<String, Live>,
    /// Starts between their plan and their launch (an edit job's worktree
    /// is being made). They count toward [`MAX_RUNNING`].
    preparing: HashMap<String, Preparing>,
    /// Jobs whose commit is running; exit waits for them.
    committing: HashSet<String>,
    /// Jobs whose allowed push (and pull request) is running, and how to
    /// stop it (the off switch).
    pushes: HashMap<String, push::Stop>,
    /// Every job's command log.
    log: CommandLog,
    /// Each job's latest model relay token, for its next launch. Memory only:
    /// never written to state.json.
    tokens: HashMap<String, String>,
    rings: HashMap<String, Ring>,
    cmds: mpsc::UnboundedReceiver<Cmd>,
    job_rx: mpsc::Receiver<JobMsg>,
    job_tx: mpsc::Sender<JobMsg>,
    next_gen: u64,
    /// The last `seq` of each job whose ring was dropped, so a resumed job
    /// carries on counting and `seq` never repeats within an app run.
    evicted_seq: HashMap<String, u64>,
    max_rings: usize,
    /// False when state.json could be neither read nor moved aside: nothing
    /// is saved over it this run.
    writable: bool,
    /// The app is quitting: no new launches.
    closing: bool,
    shutdown: Option<Shutdown>,
    /// What the tray was last told.
    last_tray: Option<TrayView>,
    /// The model choice, the workers' yes and what Rust found ([`workers`]).
    l4: workers::L4,
    /// The cap over the jobs started in the last hour ([`starts`]; their
    /// stamps are in state.json).
    starts: StartWindow,
    /// Folders (by grant id) whose worker's confirm was answered no, or not
    /// at all, and when: not asked about again for [`Timing::worker_backoff`].
    refused_workers: HashMap<String, Instant>,
}

impl Actor {
    pub(crate) async fn run(mut self) {
        if self.enabled {
            self.load();
        }
        self.publish_tray();
        let mut cmds_open = true;
        let mut idle_tick = tokio::time::interval(self.timing.idle_check_every);
        idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let deadline = self
                .shutdown
                .as_ref()
                .map(|s| if s.killed { s.give_up_at } else { s.kill_at });
            tokio::select! {
                cmd = self.cmds.recv(), if cmds_open => match cmd {
                    Some(cmd) => self.on_cmd(cmd),
                    None => cmds_open = false,
                },
                Some(msg) = self.job_rx.recv() => self.on_job(msg),
                _ = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                    self.on_shutdown_deadline();
                }
                _ = idle_tick.tick(), if !self.live.is_empty() && !self.closing => {
                    let now = Instant::now();
                    self.park_idle(now);
                    self.park_expired_yes(now);
                }
            }
            self.finish_shutdown_if_done();
            self.publish_tray();
            if !cmds_open && self.live.is_empty() {
                break;
            }
        }
    }

    fn tray_view(&self) -> TrayView {
        let label = |grant_id: &str| {
            self.state
                .grant(grant_id)
                .map(|g| g.label.clone())
                .unwrap_or_else(|| "a folder".into())
        };
        let mut jobs: Vec<TrayJob> = self
            .live
            .iter()
            // Parking keeps the job waiting, quietly.
            .filter(|(_, live)| live.stop != Some(StopKind::Park))
            .filter_map(|(id, live)| {
                let job = self.state.job(id)?;
                let asking = matches!(
                    live.prompt,
                    Some(OpenPrompt {
                        stage: PromptStage::Asking(_),
                        ..
                    })
                );
                let state = if live.stop.is_some() {
                    TrayJobState::Stopping
                } else if asking {
                    TrayJobState::Asking
                } else if job.status == JobStatus::Waiting {
                    TrayJobState::Waiting
                } else {
                    TrayJobState::Working
                };
                Some(TrayJob {
                    id: id.clone(),
                    label: label(&job.grant_id),
                    state,
                })
            })
            .collect();
        jobs.extend(self.preparing.iter().filter(|(_, p)| !p.stopped).map(|(id, p)| TrayJob {
            id: id.clone(),
            label: label(&p.grant_id),
            // A worker's confirm is up: it waits for the person.
            state: if p.confirming {
                TrayJobState::Asking
            } else {
                TrayJobState::Working
            },
        }));
        jobs.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
        TrayView {
            shown: self.enabled && (self.state.off || !self.state.grants.is_empty()),
            off: self.state.off,
            jobs,
            l4: self.l4_view(),
        }
    }

    /// Tell the tray, when what it shows changed. Never while quitting.
    fn publish_tray(&mut self) {
        if self.closing {
            return;
        }
        let view = self.tray_view();
        if self.last_tray.as_ref() != Some(&view) {
            self.host.tray(&view);
            self.last_tray = Some(view);
        }
    }

    /// The tray's switch. Off: every job is stopped as if by the person
    /// (`cancelled`, its session kept) and nothing new starts.
    fn set_off(&mut self, off: bool) -> Result<(), String> {
        if !self.enabled {
            return Err("unavailable in this build".into());
        }
        if self.state.off == off {
            return Ok(());
        }
        self.state.off = off;
        self.save();
        if !off {
            crate::log_to_file("[local-agent] turned on on this Mac");
            return Ok(());
        }
        crate::log_to_file(&format!(
            "[local-agent] turned off on this Mac; stopping {} job(s)",
            self.live.len() + self.preparing.len()
        ));
        for p in self.preparing.values_mut() {
            p.stopped = true;
        }
        // A push the person allowed stops too: whichever step runs ends, and
        // no pull request is opened.
        for (id, stop) in &self.pushes {
            crate::log_to_file(&format!("[local-agent:{id}] stopping its push"));
            stop.stop();
        }
        let ids: Vec<String> = self.live.keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
        Ok(())
    }

    /// Read state.json and mark what the last run left live as interrupted.
    fn load(&mut self) {
        self.state = match StateFile::load(&self.paths.state_file()) {
            Ok(state) => state,
            Err(e) => {
                crate::log_to_file(&format!("[local-agent] {e}; not saving over it this run"));
                self.writable = false;
                StateFile::default()
            }
        };
        let n = self.state.mark_interrupted(&now_stamp());
        // The hour's starts survive the relaunch; older ones go.
        let counted = self.state.starts.len();
        self.starts.prune(&mut self.state.starts, starts::now_ms());
        if n > 0 {
            crate::log_to_file(&format!(
                "[local-agent] {n} job(s) left running by the last run marked interrupted"
            ));
        }
        if n > 0 || self.state.starts.len() != counted {
            self.save();
        }
        self.report_interrupted_pushes();
        self.load_l4();
    }

    fn save(&self) {
        if !self.enabled || !self.writable {
            return;
        }
        if let Err(e) = self.state.save(&self.paths.state_file()) {
            crate::log_to_file(&format!("[local-agent] saving state failed: {e}"));
        }
    }

    fn on_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Snapshot { reply } => {
                let _ = reply.send(self.snapshot());
            }
            Cmd::DeviceId { reply } => {
                let _ = reply.send(self.device_id());
            }
            Cmd::CheckPick { picked, reply } => {
                let _ = reply.send(self.check_pick(&picked));
            }
            Cmd::AddGrant { picked, mode, reply } => {
                let _ = reply.send(self.add_grant(&picked, mode));
            }
            Cmd::RemoveGrant { grant_id, reply } => {
                let _ = reply.send(self.remove_grant(&grant_id));
            }
            Cmd::PlanStart { args, reply } => {
                let _ = reply.send(self.plan_start(&args));
            }
            Cmd::Launch {
                args,
                plan,
                prepared,
                launch,
                reply,
            } => {
                let _ = reply.send(self.launch_start(&args, plan, prepared, &launch));
            }
            Cmd::SetToken { job_id, token, reply } => {
                let _ = reply.send(self.set_token(&job_id, token));
            }
            Cmd::Send {
                job_id,
                text,
                policy,
                reply,
            } => {
                let _ = reply.send(self.send(&job_id, text, policy));
            }
            Cmd::Stop { job_id, reply } => {
                let _ = reply.send(self.stop(&job_id));
            }
            Cmd::PlanResume { job_id, message, reply } => {
                let _ = reply.send(self.plan_resume(&job_id, message.as_deref()));
            }
            Cmd::Resume {
                job_id,
                launch,
                token,
                answer,
                message,
                reply,
            } => match self.resume(&job_id, &launch, token, answer) {
                Ok((prior, run_id)) => self.await_resume(&job_id, prior, run_id, message, reply),
                Err(e) => {
                    let _ = reply.send(Err(e));
                }
            },
            Cmd::Events { job_id, since, reply } => {
                let _ = reply.send(self.events(&job_id, since));
            }
            Cmd::SetOff { off, reply } => {
                let _ = reply.send(self.set_off(off));
            }
            Cmd::Workers(cmd) => self.on_workers(cmd),
            Cmd::Shutdown { reply } => self.begin_shutdown(reply),
        }
    }

    fn device_id(&mut self) -> Result<String, String> {
        if !self.enabled {
            return Err("unavailable in this build".into());
        }
        if let Some(id) = &self.state.device_id {
            return Ok(id.clone());
        }
        let id = uuid::Uuid::new_v4().to_string();
        crate::log_to_file(&format!("[local-agent] this Mac's device id is {id}"));
        self.state.device_id = Some(id.clone());
        self.save();
        Ok(id)
    }

    fn snapshot(&self) -> Snapshot {
        // Being got ready (a worktree, a worker's confirm) counts as live: the
        // relay keeps the server's lease on it meanwhile.
        let readying = |id: &str| self.preparing.get(id).is_some_and(|p| !p.stopped);
        let asking = |id: &str| self.preparing.get(id).is_some_and(|p| p.confirming && !p.stopped);
        let mut jobs: Vec<JobSummary> = self
            .state
            .jobs
            .iter()
            .map(|j| JobSummary {
                id: j.id.clone(),
                grant_id: j.grant_id.clone(),
                request: j.request.clone(),
                mode: j.mode,
                status: j.status,
                created_at: j.created_at.clone(),
                ended_at: j.ended_at.clone(),
                session_id: j.session_id.clone(),
                stream_index: j.stream_index,
                live: self.live.contains_key(&j.id) || readying(&j.id),
                worker: j.worker.clone(),
                asking: asking(&j.id),
                parked: j.parked && !self.live.contains_key(&j.id),
                last_seq: self
                    .rings
                    .get(&j.id)
                    .map(Ring::last_seq)
                    .or_else(|| self.evicted_seq.get(&j.id).copied())
                    .unwrap_or(0),
                run_id: self
                    .live
                    .get(&j.id)
                    .map(|l| l.run_id.clone())
                    .or_else(|| j.run_id.clone()),
                branch: j.branch.clone(),
                commit: j.commit.clone(),
                pull_request: j.pull_request.clone(),
            })
            .collect();
        // A new job has no record until it launches.
        let mut new: Vec<JobSummary> = self
            .preparing
            .iter()
            .filter(|(id, p)| !p.stopped && self.state.job(id).is_none())
            .map(|(id, p)| JobSummary {
                id: id.clone(),
                grant_id: p.grant_id.clone(),
                request: p.request.clone(),
                mode: p.mode,
                status: JobStatus::Starting,
                created_at: p.created_at.clone(),
                ended_at: None,
                session_id: None,
                stream_index: None,
                live: true,
                worker: p.worker.map(|w| w.as_str().to_string()),
                asking: p.confirming,
                parked: false,
                last_seq: self.evicted_seq.get(id).copied().unwrap_or(0),
                run_id: None,
                branch: None,
                commit: None,
                pull_request: None,
            })
            .collect();
        new.sort_by(|a, b| a.id.cmp(&b.id));
        jobs.extend(new);
        // isGit as the folder is now (a stat per grant).
        let grants = self
            .state
            .grants
            .iter()
            .map(|g| Grant {
                is_git: folder::is_git_root(Path::new(&g.path)),
                ..g.clone()
            })
            .collect();
        Snapshot {
            grants,
            jobs,
            off: self.state.off,
        }
    }

    fn check_pick(&self, picked: &Path) -> Result<(PathBuf, bool), String> {
        if !self.enabled {
            return Err("unavailable in this build".into());
        }
        if self.state.off {
            return Err(OFF.into());
        }
        let real = folder::canonical_dir(picked)?;
        folder::check_folder(&real, &self.paths.home, &self.paths.protected)?;
        let is_git = folder::is_git_root(&real);
        Ok((real, is_git))
    }

    fn add_grant(&mut self, picked: &Path, mode: GrantMode) -> Result<Grant, String> {
        let (real, is_git) = self.check_pick(picked)?;
        let path = real
            .to_str()
            .ok_or("that folder's path is not valid UTF-8")?
            .to_string();
        // Only a git repo root can take edits (they go on a worktree of it).
        let mode = if is_git { mode } else { GrantMode::Read };
        if let Some(existing) = self.state.grants.iter_mut().find(|g| g.path == path) {
            existing.is_git = is_git;
            if existing.mode != mode {
                crate::log_to_file(&format!(
                    "[local-agent] {} is now {} ({})",
                    existing.path,
                    mode.as_str(),
                    existing.id
                ));
                existing.mode = mode;
                let grant = existing.clone();
                self.save();
                return Ok(grant);
            }
            return Ok(existing.clone());
        }
        let grant = Grant {
            id: uuid::Uuid::new_v4().to_string(),
            label: folder::label_of(&real),
            path,
            mode,
            added_at: now_stamp(),
            is_git,
        };
        crate::log_to_file(&format!(
            "[local-agent] granted {} ({}) as {}",
            grant.path,
            grant.mode.as_str(),
            grant.id
        ));
        self.state.grants.push(grant.clone());
        self.save();
        Ok(grant)
    }

    fn remove_grant(&mut self, grant_id: &str) -> Result<(), String> {
        if self.state.grant(grant_id).is_none() {
            return Err("unknown folder".into());
        }
        let in_use = self
            .live
            .keys()
            .any(|id| self.state.job(id).is_some_and(|j| j.grant_id == grant_id))
            || self.preparing.values().any(|p| p.grant_id == grant_id);
        if in_use {
            return Err("a local agent is running in this folder; stop it first".into());
        }
        self.state.grants.retain(|g| g.id != grant_id);
        crate::log_to_file(&format!("[local-agent] removed grant {grant_id}"));
        self.save();
        Ok(())
    }

    /// The grant's folder as it is now: same realpath, still allowed.
    fn recheck_grant(&self, grant: &Grant) -> Result<String, String> {
        let real = folder::canonical_dir(Path::new(&grant.path)).map_err(|e| format!("{}: {e}", grant.path))?;
        if real.to_str() != Some(grant.path.as_str()) {
            return Err(format!(
                "{} now resolves to {}; remove it and add the folder again",
                grant.path,
                real.display()
            ));
        }
        folder::check_folder(&real, &self.paths.home, &self.paths.protected)?;
        Ok(grant.path.clone())
    }

    fn can_launch(&self) -> Result<(), String> {
        if !self.enabled {
            return Err("unavailable in this build".into());
        }
        if self.state.off {
            return Err(OFF.into());
        }
        if self.closing {
            return Err("Dial8 is quitting".into());
        }
        Ok(())
    }

    /// Launchers holding a slot: running ones (a parked one shutting down
    /// doesn't) and starts being prepared.
    fn slots_taken(&self) -> usize {
        self.live.values().filter(|l| l.stop != Some(StopKind::Park)).count() + self.preparing.len()
    }

    /// When the job is idle (`waiting`, no turn open, no commit pending, not
    /// stopping or resuming), since when.
    fn idle_since(&self, id: &str, live: &Live, now: Instant) -> Option<Instant> {
        let job = self.state.job(id)?;
        let awaiting = live
            .awaiting_turn_since
            .is_some_and(|t| now.saturating_duration_since(t) < AWAIT_TURN_GRACE);
        let idle = job.status == JobStatus::Waiting
            && job.session_id.is_some()
            && live.stop.is_none()
            && live.resume.is_none()
            && live.pending_commit.is_none()
            && !self.committing.contains(id)
            && live.prompt.is_none()
            && !self.pushes.contains_key(id)
            && !awaiting;
        idle.then_some(live.last_active)
    }

    fn idle_jobs(&self, now: Instant, except: &str) -> Vec<(&str, Instant)> {
        self.live
            .iter()
            .filter(|(id, _)| id.as_str() != except)
            .filter_map(|(id, live)| self.idle_since(id, live, now).map(|t| (id.as_str(), t)))
            .collect()
    }

    /// A slot for `job_id`: free already, or freed by parking the least
    /// recently active idle job. Never a running one.
    fn make_room(&mut self, job_id: &str) -> Result<(), String> {
        if self.slots_taken() < MAX_RUNNING {
            return Ok(());
        }
        let victim = oldest_idle(self.idle_jobs(Instant::now(), job_id));
        match victim {
            Some(victim) => {
                self.park(&victim, "another local agent needs its slot");
                Ok(())
            }
            None => Err(format!(
                "{MAX_RUNNING} local agents are already running; stop one first"
            )),
        }
    }

    /// Park every job idle for [`Timing::idle_park_after`].
    fn park_idle(&mut self, now: Instant) {
        let idle = idle_too_long(self.idle_jobs(now, ""), now, self.timing.idle_park_after);
        for id in idle {
            self.park(&id, "idle");
        }
    }

    /// Park every worker whose yes has run out ([`Timing::worker_yes_for`]),
    /// mid-turn or not: its next message has to resume it, and that asks
    /// the person again.
    fn park_expired_yes(&mut self, now: Instant) {
        let expired: Vec<String> = self
            .live
            .iter()
            .filter(|(_, l)| l.stop.is_none() && l.yes_until.is_some_and(|t| now >= t))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.park(&id, "its yes on this Mac ran out");
        }
    }

    /// Stop an idle launcher, keeping its job `waiting` and resumable.
    fn park(&mut self, job_id: &str, why: &str) {
        let Some(live) = self.live.get_mut(job_id) else { return };
        if live.stop.is_some() {
            return;
        }
        crate::log_to_file(&format!("[local-agent:{job_id}] parking ({why})"));
        self.log.append(job_id, Who::Job, &format!("parked ({why})"));
        live.stop = Some(StopKind::Park);
        live.handle.stop();
        live.handle
            .escalate(self.timing.stop_term_after, self.timing.stop_kill_after);
    }

    /// Check a start against the grant and the job's own record, and reserve
    /// its slot; an edit job's worktree is made next, outside the actor.
    fn plan_start(&mut self, args: &Checked) -> Result<Plan, String> {
        let job_id = args.job_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let existing = self.state.job(&job_id).cloned();
        if let Some(job) = &existing {
            if job.grant_id != args.grant_id {
                return Err("this job runs in another folder".into());
            }
            if args.mode.is_some_and(|m| m != job.mode) {
                return Err(format!("this job runs in {} mode", job.mode.as_str()));
            }
            workers::check_same_worker(job.worker.as_deref(), args.worker)?;
        }
        if let Some(live) = self.live.get(&job_id) {
            if live.stop.is_some() {
                return Err("this job is stopping; try again once it has stopped".into());
            }
            // A retried claim minted a new token: the running launcher gets it
            // (a worker never does: it uses its vendor's model).
            if let Some(token) = args.token.as_ref().filter(|_| live.worker.is_none()) {
                let _ = live.handle.send_line(token_line(token));
            }
            let running = StartResult {
                job_id: job_id.clone(),
                run_id: live.run_id.clone(),
            };
            if let Some(token) = &args.token {
                self.tokens.insert(job_id, token.clone());
            }
            return Ok(Plan::Live(running));
        }
        if self.preparing.contains_key(&job_id) {
            return Err("this job is already starting".into());
        }
        self.can_launch()?;
        let grant = self.state.grant(&args.grant_id).cloned().ok_or("unknown folder")?;
        let folder = self.recheck_grant(&grant)?;
        let mode = existing.as_ref().map(|j| j.mode).or(args.mode).unwrap_or_default();
        if !grant.mode.allows(mode) {
            return Err("this folder was shared read-only; pick it again and allow changes to edit it".into());
        }
        let edit = match mode {
            GrantMode::Read => None,
            GrantMode::Edit => {
                if !folder::is_git_root(Path::new(&folder)) {
                    return Err("edits need the folder to be a git repository's root".into());
                }
                let branch = existing
                    .as_ref()
                    .and_then(|j| j.branch.clone())
                    .unwrap_or_else(|| git::branch_name(&grant.label, &job_id));
                // Only a new job's worktree starts from the base it names. A
                // job Rust has a record of keeps the worktree it has, and if
                // that and its branch are both gone, starts again from its
                // own base commit, never a name resolved again.
                let base = match &existing {
                    Some(j) => match j.base_commit.as_deref().filter(|c| push::is_commit_id(c)) {
                        Some(c) => git::Base::Commit(c.to_string()),
                        None => git::Base::Head,
                    },
                    None => match &args.base_branch {
                        Some(name) => {
                            git::check_base_branch(name)?;
                            git::Base::Branch(name.clone())
                        }
                        None => git::Base::Head,
                    },
                };
                Some(EditPlan {
                    repo: PathBuf::from(&folder),
                    root: self.paths.worktrees(),
                    branch,
                    base,
                })
            }
        };
        // The job's worker, the one it keeps or the one this start names.
        let worker = args.worker.or_else(|| {
            existing
                .as_ref()
                .and_then(|j| j.worker.as_deref())
                .and_then(|w| workers::Worker::parse(w).ok())
        });
        if worker.is_some() {
            self.check_can_ask(&grant.id)?;
        }
        // A job the person was told of lately isn't counted again.
        let now = starts::now_ms();
        let announced = starts::still_announced(existing.as_ref().and_then(|j| j.announced_at), now);
        if !announced {
            self.check_starts(&job_id, now)?;
        }
        self.make_room(&job_id)?;
        if !announced {
            self.count_start(&job_id, now);
        }
        let request = existing.as_ref().map_or(args.request.as_str(), |j| j.request.as_str());
        let confirm = worker.map(|w| {
            let launch = match existing.as_ref().is_some_and(|j| j.session_id.is_some()) || args.resume.is_some() {
                true => prompts::WorkerLaunch::Resume { message: None },
                false => prompts::WorkerLaunch::Start,
            };
            self.confirm_worker(&job_id, w, &grant, request, launch)
        });
        self.preparing.insert(
            job_id.clone(),
            Preparing {
                grant_id: grant.id.clone(),
                stopped: false,
                confirming: confirm.is_some(),
                request: request.to_string(),
                mode,
                worker,
                created_at: existing.as_ref().map_or_else(now_stamp, |j| j.created_at.clone()),
            },
        );
        Ok(Plan::Launch(LaunchPlan {
            job_id,
            mode,
            edit,
            confirm,
            answer: None,
        }))
    }

    /// A worker's confirm may go up for a launch in `grant_id` now
    /// ([`starts`]): none is up already, and the person didn't just say no
    /// (or not answer) to one there.
    fn check_can_ask(&mut self, grant_id: &str) -> Result<(), String> {
        if self.preparing.values().any(|p| p.confirming) {
            return Err(starts::ONE_CONFIRM.into());
        }
        let backoff = self.timing.worker_backoff;
        self.refused_workers.retain(|_, at| at.elapsed() < backoff);
        match self.refused_workers.get(grant_id) {
            Some(at) => Err(starts::backed_off(backoff.saturating_sub(at.elapsed()))),
            None => Ok(()),
        }
    }

    /// Count `job_id` against the hour's cap ([`starts`]), in state.json at
    /// once, so a launch that fails later still counted.
    fn count_start(&mut self, job_id: &str, now: u64) {
        StartWindow::record(&mut self.state.starts, job_id, now);
        self.save();
    }

    /// Room in the hour's cap at `now` for `job_id` ([`starts`]); the first
    /// refusal since it filled tells the person.
    fn check_starts(&mut self, job_id: &str, now: u64) -> Result<(), String> {
        let Err(wait) = self.starts.check(&mut self.state.starts, job_id, now) else {
            return Ok(());
        };
        let max = self.starts.max();
        if self.starts.tell() {
            crate::log_to_file(&format!(
                "[local-agent] {max} launches in the last hour: refusing more until the hour is up"
            ));
            let (title, body) = starts::cap_notice(max);
            self.host.notify(&title, &body);
        }
        Err(starts::cap_refusal(max, wait))
    }

    /// Put up a worker's native confirm for a launch of `job_id` in `grant`
    /// ([`starts`]); the person's answer comes on the [`Confirm`].
    fn confirm_worker(
        &self,
        job_id: &str,
        worker: workers::Worker,
        grant: &Grant,
        request: &str,
        launch: prompts::WorkerLaunch<'_>,
    ) -> Confirm {
        let wait = self.timing.worker_confirm;
        let prompt = prompts::worker_prompt(
            worker,
            &grant.label,
            &grant.path,
            request,
            launch,
            self.timing.worker_yes_for,
            wait,
        );
        crate::log_to_file(&format!("[local-agent:{job_id}] asking: {}", prompt.title));
        self.log
            .append(job_id, Who::Ask, &format!("{}: {}", worker.as_str(), prompt.title));
        let (tx, answer) = oneshot::channel();
        self.host.ask(&prompt, wait, tx);
        Confirm { worker, answer, wait }
    }

    /// What a launch's confirm said, in the command log; a no (or no
    /// answer) holds off `grant_id`'s next confirm. `None`: it had none, and
    /// the person is told it started, unless they were told before.
    fn admit(&mut self, job_id: &str, grant_id: &str, answer: Option<Answer>, resumed: bool) -> Result<Admit, String> {
        let announced = starts::still_announced(self.state.job(job_id).and_then(|j| j.announced_at), starts::now_ms());
        match answer {
            None if announced => Ok(Admit::Announced),
            None => Ok(Admit::Told { resumed }),
            Some(Ok(())) => {
                self.log.append(job_id, Who::You, "allowed the coding agent to run");
                Ok(Admit::Confirmed)
            }
            Some(Err((who, why))) => {
                crate::log_to_file(&format!("[local-agent:{job_id}] {why}"));
                self.log.append(job_id, who, &why);
                self.refused_workers.insert(grant_id.to_string(), Instant::now());
                Err(why)
            }
        }
    }

    /// The banner for a launch nobody on this Mac confirmed ([`starts`]).
    fn tell_started(&self, job_id: &str, mode: GrantMode, resumed: bool) {
        let label = self
            .state
            .job(job_id)
            .and_then(|j| self.state.grant(&j.grant_id))
            .map_or("a folder", |g| g.label.as_str());
        let (title, body) = starts::started_notice(label, mode, resumed);
        self.host.notify(&title, &body);
    }

    /// Launch a planned start: a new job, or one Rust already has a record
    /// of (resumed from its own session), or one only the server remembers
    /// (resumed from `resume`).
    fn launch_start(
        &mut self,
        args: &Checked,
        mut plan: LaunchPlan,
        prepared: Result<Option<Prepared>, String>,
        launch: &LaunchConfig,
    ) -> Result<StartResult, String> {
        let job_id = plan.job_id.clone();
        let stopped = self.preparing.remove(&job_id).is_some_and(|p| p.stopped);
        let resumed = self.state.job(&job_id).is_some_and(|j| j.session_id.is_some()) || args.resume.is_some();
        let admit = self.admit(&job_id, &args.grant_id, plan.answer.take(), resumed)?;
        let prepared = prepared?;
        if stopped {
            return Err("stopped before it started".into());
        }
        if self.closing {
            return Err("Dial8 is quitting".into());
        }
        let grant = self.state.grant(&args.grant_id).cloned().ok_or("unknown folder")?;
        let grant_folder = self.recheck_grant(&grant)?;
        if !grant.mode.allows(plan.mode) {
            return Err("this folder was shared read-only; pick it again and allow changes to edit it".into());
        }
        let (folder, edit) = match (plan.mode, &prepared) {
            (GrantMode::Read, _) => (grant_folder, None),
            (GrantMode::Edit, Some(p)) => (self.recheck_worktree(&p.worktree.dir)?, Some(p)),
            (GrantMode::Edit, None) => return Err("an edit job needs its worktree".into()),
        };
        let existing = self.state.job(&job_id).cloned();
        let first = match &existing {
            Some(Job {
                session_id: Some(session),
                stream_index,
                ..
            }) => resume_line(session, stream_index.unwrap_or(0)),
            _ => match &args.resume {
                Some(r) => resume_line(&r.eve_session_id, r.stream_index),
                // A job Rust has a record of runs its own request, never one
                // the page sends again.
                None => start_line(existing.as_ref().map_or(&args.request, |j| &j.request)),
            },
        };
        let is_new = existing.is_none();
        if is_new {
            let mut job = Job::new(&job_id, &grant.id, &args.request, JobStatus::Starting, &now_stamp());
            job.mode = plan.mode;
            job.worker = args.worker.map(|w| w.as_str().to_string());
            if let Some(r) = &args.resume {
                job.session_id = Some(r.eve_session_id.clone());
                job.stream_index = Some(r.stream_index);
            }
            self.state.jobs.push(job);
        }
        if let (Some(job), Some(p)) = (self.state.job_mut(&job_id), edit) {
            job.worktree = Some(folder.clone());
            job.branch = Some(p.worktree.branch.clone());
            job.git_dir = Some(p.git_dir.display().to_string());
            if job.base_commit.is_none() {
                job.base_commit = p.worktree.base.clone();
                job.base_branch = p.worktree.base_branch.clone();
            }
        }
        if let Some(token) = &args.token {
            self.tokens.insert(job_id.clone(), token.clone());
        }
        if let Some(p) = edit.filter(|p| p.worktree.base.is_some()) {
            let sha = p.worktree.base.as_deref().unwrap_or("HEAD");
            // The base branch the job keeps with that commit (a rebuilt
            // worktree's too).
            let name = self
                .state
                .job(&job_id)
                .filter(|j| j.base_commit.as_deref() == Some(sha))
                .and_then(|j| j.base_branch.clone());
            let from = match name {
                Some(name) => format!("{name} at {sha}"),
                None => sha.to_string(),
            };
            self.log.append(
                &job_id,
                Who::Dial8,
                &format!(
                    "git worktree add {} -b {} (from {from})",
                    p.worktree.dir.display(),
                    p.worktree.branch,
                ),
            );
        }
        let edit_ctx = edit.map(|p| {
            let base = self.state.job(&job_id).and_then(|j| j.base_commit.clone());
            EditCtx::new(launch, p.worktree.dir.clone(), p.git_dir.clone(), base)
        });
        match self.launch(&job_id, &folder, plan.mode, launch, first, edit_ctx, admit) {
            Ok(run_id) => {
                if let Some(j) = self.state.job_mut(&job_id) {
                    j.status = JobStatus::Starting;
                    j.ended_at = None;
                }
                self.save();
                Ok(StartResult { job_id, run_id })
            }
            Err(e) => {
                if is_new {
                    self.state.jobs.retain(|j| j.id != job_id);
                    let _ = std::fs::remove_dir(self.paths.job_dir(&job_id));
                    let _ = std::fs::remove_dir(self.paths.job_tmp(&job_id));
                }
                self.save();
                Err(e)
            }
        }
    }

    /// An edit job's worktree as it is now: a realpath that may be shared
    /// (inside HOME, not Dial8's data).
    fn recheck_worktree(&self, dir: &Path) -> Result<String, String> {
        let real = folder::canonical_dir(dir).map_err(|e| format!("the job's worktree: {e}"))?;
        if !real.starts_with(self.paths.worktrees()) {
            return Err(format!("{} is not one of Dial8's worktrees", real.display()));
        }
        folder::check_folder(&real, &self.paths.home, &self.paths.protected)?;
        real.to_str()
            .map(str::to_string)
            .ok_or_else(|| "the worktree's path is not valid UTF-8".to_string())
    }

    fn set_token(&mut self, job_id: &str, token: String) -> Result<(), String> {
        if self.state.job(job_id).is_none() && !self.preparing.contains_key(job_id) {
            return Err("unknown job".into());
        }
        if let Some(live) = self.live.get(job_id) {
            // A worker never gets the session token ([`workers`]).
            if live.stop.is_none() && live.worker.is_none() {
                live.handle.send_line(token_line(&token)).map_err(|e| match e {
                    TrySendError::Full(_) => "the agent isn't taking messages right now; try again".to_string(),
                    TrySendError::Closed(_) => "this job isn't running".to_string(),
                })?;
            }
        }
        self.tokens.insert(job_id.to_string(), token);
        Ok(())
    }

    /// A job a resume may launch, and its grant: not running or starting,
    /// with a session, in a folder still shared.
    fn resumable(&self, job_id: &str) -> Result<(Job, Grant), String> {
        let job = self.state.job(job_id).cloned().ok_or("unknown job")?;
        if self.live.contains_key(job_id) {
            return Err("this job is already running".into());
        }
        if self.preparing.contains_key(job_id) {
            return Err("this job is already starting".into());
        }
        self.can_launch()?;
        if job.session_id.is_none() {
            return Err("this job never started a session; start a new one".into());
        }
        let grant = self
            .state
            .grant(&job.grant_id)
            .cloned()
            .ok_or("its folder is no longer shared; add it again and start a new job")?;
        Ok((job, grant))
    }

    /// Before a resume launches ([`starts`]): it counts against the hour's
    /// cap, and a worker's puts its confirm up, holding a slot meanwhile.
    fn plan_resume(&mut self, job_id: &str, message: Option<&str>) -> Result<Option<Confirm>, String> {
        let (job, grant) = self.resumable(job_id)?;
        let worker = job.worker.as_deref().and_then(|w| workers::Worker::parse(w).ok());
        if worker.is_some() {
            self.check_can_ask(&grant.id)?;
        }
        // A revival of a job the person was told of lately is neither counted nor told.
        let now = starts::now_ms();
        let announced = starts::still_announced(job.announced_at, now);
        if !announced {
            self.check_starts(job_id, now)?;
        }
        if worker.is_some() {
            self.make_room(job_id)?;
        }
        if !announced {
            self.count_start(job_id, now);
        }
        let Some(worker) = worker else {
            return Ok(None);
        };
        let confirm = self.confirm_worker(
            job_id,
            worker,
            &grant,
            &job.request,
            prompts::WorkerLaunch::Resume { message },
        );
        self.preparing.insert(
            job_id.to_string(),
            Preparing {
                grant_id: grant.id,
                stopped: false,
                confirming: true,
                request: job.request.clone(),
                mode: job.mode,
                worker: Some(worker),
                created_at: job.created_at.clone(),
            },
        );
        Ok(Some(confirm))
    }

    /// Respawn with `resume`; returns the job's status before it and the new
    /// run's id. `answer`: what the person said to its confirm, when it had
    /// one ([`Actor::plan_resume`]).
    fn resume(
        &mut self,
        job_id: &str,
        launch: &LaunchConfig,
        token: Option<String>,
        answer: Option<Answer>,
    ) -> Result<(JobStatus, String), String> {
        // The slot its confirm held; a stop or the off switch meanwhile wins.
        let held = answer.is_some().then(|| self.preparing.remove(job_id)).flatten();
        let grant_id = self.state.job(job_id).map(|j| j.grant_id.clone()).unwrap_or_default();
        let admit = self.admit(job_id, &grant_id, answer, true)?;
        if admit == Admit::Confirmed && !held.is_some_and(|p| !p.stopped) {
            return Err("stopped before it started".into());
        }
        let (job, grant) = self.resumable(job_id)?;
        let session_id = job.session_id.clone().ok_or("this job never started a session")?;
        let grant_folder = self.recheck_grant(&grant)?;
        if !grant.mode.allows(job.mode) {
            return Err("its folder is now shared read-only; start a new job to read it".into());
        }
        let (folder, edit) = match job.mode {
            GrantMode::Read => (grant_folder, None),
            GrantMode::Edit => {
                let (Some(worktree), Some(git_dir)) = (&job.worktree, &job.git_dir) else {
                    return Err("this edit job has no worktree; start a new one".into());
                };
                git::check_worktree(Path::new(worktree), Path::new(git_dir))?;
                let folder = self.recheck_worktree(Path::new(worktree))?;
                let ctx = EditCtx::new(
                    launch,
                    PathBuf::from(&folder),
                    PathBuf::from(git_dir),
                    job.base_commit.clone(),
                );
                (folder, Some(ctx))
            }
        };
        if !self.paths.job_dir(job_id).is_dir() {
            return Err("this job's data is gone".into());
        }
        self.make_room(job_id)?;
        if let Some(token) = token {
            self.tokens.insert(job_id.to_string(), token);
        }
        let run_id = self.launch(
            job_id,
            &folder,
            job.mode,
            launch,
            resume_line(&session_id, job.stream_index.unwrap_or(0)),
            edit,
            admit,
        )?;
        if let Some(j) = self.state.job_mut(job_id) {
            j.status = JobStatus::Starting;
            j.ended_at = None;
        }
        self.save();
        Ok((job.status, run_id))
    }

    /// Hold `local_agent_resume`'s answer until the launcher reports its
    /// session (`Ok`), fails (`Err`, e.g. [`LOCK_ERROR`]), or
    /// [`Timing::resume_confirm_after`] passes (`Ok`: still starting).
    fn await_resume(
        &mut self,
        job_id: &str,
        prior: JobStatus,
        run_id: String,
        message: Option<(String, Policy)>,
        reply: Reply<StartResult>,
    ) {
        let Some(live) = self.live.get_mut(job_id) else {
            let _ = reply.send(Ok(StartResult {
                job_id: job_id.to_string(),
                run_id,
            }));
            return;
        };
        live.resume = Some(PendingResume {
            reply: Some(reply),
            prior,
            message,
        });
        let (tx, gen, id, after) = (
            self.job_tx.clone(),
            live.gen,
            job_id.to_string(),
            self.timing.resume_confirm_after,
        );
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            let _ = tx
                .send(JobMsg {
                    job_id: id,
                    gen,
                    event: JobEvent::ConfirmTimeout,
                })
                .await;
        });
    }

    /// The resumed launcher is past its start: send the message it was
    /// resumed for, and answer the resume `Ok`.
    fn confirm_resume(&mut self, job_id: &str) {
        let Some(live) = self.live.get_mut(job_id) else { return };
        if let Some(pending) = live.resume.take() {
            let mut answer = Ok(StartResult {
                job_id: job_id.to_string(),
                run_id: live.run_id.clone(),
            });
            if let Some((text, policy)) = pending.message {
                match live.handle.send_line(send_line(&text, policy)) {
                    Ok(()) => {
                        let now = Instant::now();
                        live.last_active = now;
                        live.awaiting_turn_since = Some(now);
                    }
                    Err(_) => answer = Err("resumed, but its message couldn't be sent; send it again".to_string()),
                }
            }
            if let Some(reply) = pending.reply {
                let _ = reply.send(answer);
            }
        }
    }

    /// Spawn the launcher for `job_id` in its job folder and queue `first`;
    /// returns the new run's id. `folder` is what the agent works in: the
    /// grant's folder, or an edit job's worktree. `admit`: how it was let
    /// in ([`starts`]); a worker never runs without the person's yes, and a
    /// launch nobody confirmed puts up its banner.
    #[allow(clippy::too_many_arguments)]
    fn launch(
        &mut self,
        job_id: &str,
        folder: &str,
        mode: GrantMode,
        launch: &LaunchConfig,
        first: String,
        edit: Option<EditCtx>,
        admit: Admit,
    ) -> Result<String, String> {
        if !is_safe_id(job_id) {
            return Err("bad job id".into());
        }
        // L4: the model and worker the handler checked, re-checked now.
        let run = self.run_spec(job_id)?;
        if run.worker.is_some() && admit != Admit::Confirmed {
            return Err(starts::NOT_CONFIRMED.into());
        }
        let extra_read = match &edit {
            Some(e) => Some(
                e.git_dir
                    .to_str()
                    .ok_or("the repo's git folder is not valid UTF-8")?
                    .to_string(),
            ),
            None => None,
        };
        let dir = self.paths.job_dir(job_id);
        create_private_dir(&dir).map_err(|e| format!("can't create the job folder: {e}"))?;
        let tmp = self.paths.job_tmp(job_id);
        create_private_dir(&tmp).map_err(|e| format!("can't create the job's temp folder: {e}"))?;
        let tmp = canonical_or(tmp);
        let tmp = tmp.to_str().ok_or("the temp folder's path is not valid UTF-8")?;
        self.next_gen += 1;
        let gen = self.next_gen;
        let run_id = uuid::Uuid::new_v4().to_string();
        let env = config::launcher_env(
            launch,
            LaunchEnv {
                job_id,
                folder,
                mode: mode.as_str(),
                tmpdir: tmp,
                model_token: self.tokens.get(job_id).map(String::as_str),
                extra_read: extra_read.as_deref(),
                run: Some(&run),
            },
        );
        let spec = SpawnSpec {
            job_id: job_id.to_string(),
            gen,
            program: launch.node.clone(),
            args: vec![run.entry(launch)],
            cwd: dir,
            env,
        };
        let handle =
            supervisor::spawn(spec, self.job_tx.clone()).map_err(|e| format!("could not start the launcher: {e}"))?;
        if handle.send_line(first).is_err() {
            handle.kill_now();
            return Err("the launcher closed its input at once".into());
        }
        crate::log_to_file(&format!(
            "[local-agent:{job_id}] run {run_id} ({}, {})",
            mode.as_str(),
            run.describe(self.tokens.contains_key(job_id))
        ));
        self.live.insert(
            job_id.to_string(),
            Live {
                gen,
                run_id: run_id.clone(),
                handle,
                stop: None,
                fatal: None,
                resume: None,
                edit,
                pending_commit: None,
                last_active: Instant::now(),
                awaiting_turn_since: None,
                prompt: None,
                fence_allowed: Vec::new(),
                answered: HashSet::new(),
                tools_running: HashSet::new(),
                never_write: Arc::new(never_write(launch)),
                git: Git::from_launch(launch),
                worker: run.worker.as_ref().map(|w| w.worker),
                yes_until: (admit == Admit::Confirmed).then(|| Instant::now() + self.timing.worker_yes_for),
            },
        );
        if let Some(job) = self.state.job_mut(job_id) {
            job.run_id = Some(run_id.clone());
            job.parked = false;
            // Told or confirmed now: its revivals for a day are told nothing. A
            // revival leaves the stamp as it was.
            if admit != Admit::Announced {
                job.announced_at = Some(starts::now_ms());
            }
        }
        self.log.append(
            job_id,
            Who::Job,
            &format!(
                "run {run_id} started ({}, {}) in {folder}",
                mode.as_str(),
                run.describe(self.tokens.contains_key(job_id))
            ),
        );
        self.ensure_ring(job_id);
        if let Admit::Told { resumed } = admit {
            self.tell_started(job_id, mode, resumed);
        }
        Ok(run_id)
    }

    fn send(&mut self, job_id: &str, text: String, policy: Policy) -> Result<(), String> {
        // A worker's yes covers its follow-ups for so long: then it is parked,
        // and the relay's retry resumes it, which asks the person again.
        let expired = self
            .live
            .get(job_id)
            .is_some_and(|l| l.stop.is_none() && l.yes_until.is_some_and(|t| Instant::now() >= t));
        if expired {
            self.park(job_id, "its yes on this Mac ran out");
            return Err(starts::YES_RAN_OUT.into());
        }
        let Some(live) = self.live.get_mut(job_id) else {
            return Err(if self.state.job(job_id).is_some() {
                "this job isn't running; resume it first".into()
            } else {
                "unknown job".into()
            });
        };
        if live.stop.is_some() {
            return Err("this job is stopping".into());
        }
        let text = check_text(text, "message")?;
        live.handle.send_line(send_line(&text, policy)).map_err(|e| match e {
            TrySendError::Full(_) => "the agent isn't taking messages right now; try again".to_string(),
            TrySendError::Closed(_) => "this job isn't running".to_string(),
        })?;
        // A turn is coming: not idle, so never parked under the message.
        let now = Instant::now();
        live.last_active = now;
        live.awaiting_turn_since = Some(now);
        Ok(())
    }

    fn stop(&mut self, job_id: &str) -> Result<(), String> {
        if let Some(p) = self.preparing.get_mut(job_id) {
            p.stopped = true;
            return Ok(());
        }
        if self.state.job(job_id).is_none() {
            return Err("unknown job".into());
        }
        if let Some(live) = self.live.get_mut(job_id) {
            if live.stop.is_none() {
                crate::log_to_file(&format!("[local-agent:{job_id}] stop requested"));
                self.log.append(job_id, Who::Job, "stop requested");
                live.stop = Some(StopKind::User);
                live.handle.stop();
                live.handle
                    .escalate(self.timing.stop_term_after, self.timing.stop_kill_after);
            }
        }
        Ok(())
    }

    fn events(&self, job_id: &str, since: u64) -> Result<Vec<Entry>, String> {
        if self.state.job(job_id).is_none() {
            return Err("unknown job".into());
        }
        Ok(self.rings.get(job_id).map(|r| r.since(since)).unwrap_or_default())
    }

    fn on_job(&mut self, msg: JobMsg) {
        let JobMsg { job_id, gen, event } = msg;
        // These may arrive after their run exited: not gated on the live run.
        let event = match event {
            JobEvent::Committed { run_id, result } => return self.on_committed(&job_id, run_id, result),
            JobEvent::PromptReady { run_id, id, result } => return self.on_prompt_ready(&job_id, &run_id, &id, result),
            JobEvent::PromptExpired { run_id, id } => return self.on_prompt_expired(&job_id, &run_id, &id),
            JobEvent::PromptAnswered { run_id, id, allow } => {
                return self.on_prompt_answered(&job_id, &run_id, &id, allow)
            }
            JobEvent::Pushed { run_id, outcome } => return self.on_pushed(&job_id, run_id, *outcome),
            other => other,
        };
        match self.live.get_mut(&job_id) {
            Some(live) if live.gen == gen => {
                if matches!(event, JobEvent::Line(_)) {
                    live.last_active = Instant::now();
                }
            }
            _ => return, // a run that already ended (or another app run's)
        }
        match event {
            JobEvent::Line(Inbound::Ready {
                port,
                eve_version,
                worker,
            }) => {
                // A worker's adapter names itself and its CLI's version.
                let what = match worker {
                    Some((name, version)) => format!("{name} {}", version.as_deref().unwrap_or("?")),
                    None => format!("eve {}", eve_version.as_deref().unwrap_or("?")),
                };
                crate::log_to_file(&format!("[local-agent:{job_id}] ready on 127.0.0.1:{port} ({what})"));
            }
            JobEvent::Line(Inbound::Session {
                session_id,
                stream_index,
            }) => {
                // L4: a worker's session id must be one its CLI can take ([`workers`]).
                if !self.accepts_session(&job_id, &session_id) {
                    return;
                }
                if let Some(job) = self.state.job_mut(&job_id) {
                    job.session_id = Some(session_id);
                    job.stream_index = Some(stream_index);
                }
                self.save();
                self.confirm_resume(&job_id);
            }
            JobEvent::Line(Inbound::Cursor { stream_index }) => {
                let changed = match self.state.job_mut(&job_id) {
                    Some(job) if job.stream_index != Some(stream_index) => {
                        job.stream_index = Some(stream_index);
                        true
                    }
                    _ => false,
                };
                if changed {
                    self.save();
                }
            }
            JobEvent::Line(Inbound::Fatal { message }) => {
                crate::log_to_file(&format!("[local-agent:{job_id}] fatal: {message}"));
                if let Some(live) = self.live.get_mut(&job_id) {
                    let reply = live.resume.as_mut().and_then(|p| p.reply.take());
                    if let Some(reply) = reply {
                        let _ = reply.send(Err(if message.contains(LOCK_FATAL) {
                            LOCK_ERROR.to_string()
                        } else {
                            format!("the job didn't resume: {message}")
                        }));
                    }
                    live.fatal = Some(message);
                }
            }
            JobEvent::Line(Inbound::Event(event)) => self.on_event(&job_id, event),
            JobEvent::Line(Inbound::Prompt { id, kind, detail }) => self.on_prompt(&job_id, id, kind, &detail),
            JobEvent::ConfirmTimeout => self.confirm_resume(&job_id),
            JobEvent::Exited(info) => self.on_exit(&job_id, &info),
            JobEvent::Committed { .. }
            | JobEvent::PromptReady { .. }
            | JobEvent::PromptExpired { .. }
            | JobEvent::PromptAnswered { .. }
            | JobEvent::Pushed { .. } => unreachable!("handled above"),
        }
    }

    fn on_event(&mut self, job_id: &str, event: Value) {
        let kind = event["kind"].as_str().unwrap_or_default().to_string();
        // Logged and tracked even when the event is too big to keep.
        if kind == "tool" || kind == "tool_result" {
            self.log_tool(job_id, &kind, &event);
            self.track_tool(job_id, &kind, &event);
        }
        let size = event.to_string().len();
        if size > MAX_EVENT_BYTES {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] dropped a {size}-byte {:?} event",
                event["kind"]
            ));
            return;
        }
        if kind == "status" {
            if let Some(live) = self.live.get_mut(job_id) {
                live.awaiting_turn_since = None;
                if live.stop == Some(StopKind::Park) {
                    // Its `cancelled` on the way out is not the job's: it stays waiting.
                    return;
                }
            }
        }
        // The turn is over (the agent is waiting, or the job ended): any
        // commit `finish` asked for can run now, with every edit of the turn
        // done, including tool calls that ran alongside `finish`.
        let mut turn_over = false;
        if kind == "status" {
            let status = event
                .get("status")
                .and_then(Value::as_str)
                .and_then(JobStatus::from_launcher);
            turn_over = status.is_some_and(|s| !matches!(s, JobStatus::Starting | JobStatus::Running));
            let changed = match (status, self.state.job_mut(job_id)) {
                (Some(status), Some(job)) if job.status != status => {
                    job.status = status;
                    job.ended_at = if status.is_active() { None } else { Some(now_stamp()) };
                    true
                }
                _ => false,
            };
            if changed {
                self.save();
            }
        }
        if kind == "finish" {
            if let Some(live) = self.live.get_mut(job_id).filter(|l| l.edit.is_some()) {
                let summary = event.get("summary").and_then(Value::as_str).unwrap_or_default();
                live.pending_commit = Some(summary.to_string());
            }
        }
        let run_id = self.live.get(job_id).map(|l| l.run_id.clone());
        self.push_event(job_id, event, run_id);
        if turn_over {
            if let Some(live) = self.live.get_mut(job_id) {
                live.tools_running.clear();
            }
            self.kick_commit(job_id);
        }
    }

    /// Start the commit `finish` asked for, if any (its run is live).
    fn kick_commit(&mut self, job_id: &str) {
        let Some(live) = self.live.get_mut(job_id) else { return };
        let (Some(summary), Some(edit)) = (live.pending_commit.take(), live.edit.clone()) else {
            return;
        };
        let (gen, run_id) = (live.gen, live.run_id.clone());
        self.spawn_commit(job_id, gen, run_id, edit, summary);
    }

    /// Commit in the worktree on a task of its own; the result comes back as
    /// [`JobEvent::Committed`].
    fn spawn_commit(&mut self, job_id: &str, gen: u64, run_id: String, edit: EditCtx, summary: String) {
        crate::log_to_file(&format!(
            "[local-agent:{job_id}] committing in {}",
            edit.worktree.display()
        ));
        self.committing.insert(job_id.to_string());
        let (tx, id) = (self.job_tx.clone(), job_id.to_string());
        tokio::spawn(async move {
            let result = edit
                .git
                .commit(&edit.worktree, &edit.git_dir, edit.base.as_deref(), &summary)
                .await;
            let _ = tx
                .send(JobMsg {
                    job_id: id,
                    gen,
                    event: JobEvent::Committed { run_id, result },
                })
                .await;
        });
    }

    /// A commit finished: record it and tell the page (Rust's own `branch`
    /// event, with the next `seq`).
    fn on_committed(&mut self, job_id: &str, run_id: String, result: Result<CommitInfo, String>) {
        self.committing.remove(job_id);
        let event = match result {
            Ok(info) => {
                crate::log_to_file(&format!(
                    "[local-agent:{job_id}] committed {} on {} ({} files)",
                    info.commit, info.branch, info.files_changed
                ));
                if let Some(job) = self.state.job_mut(job_id) {
                    job.commit = Some(info.commit.clone());
                    job.branch = Some(info.branch.clone());
                }
                self.save();
                self.log.append(
                    job_id,
                    Who::Dial8,
                    &format!(
                        "git commit on {}: {} ({} files changed)",
                        info.branch, info.commit, info.files_changed
                    ),
                );
                json!({
                    "kind": "branch",
                    "branch": info.branch,
                    "commit": info.commit,
                    "filesChanged": info.files_changed,
                    "insertions": info.insertions,
                    "deletions": info.deletions,
                })
            }
            Err(e) => {
                crate::log_to_file(&format!("[local-agent:{job_id}] commit failed: {e}"));
                self.log.append(job_id, Who::Dial8, &format!("git commit: {e}"));
                json!({ "kind": "error", "message": format!("the changes couldn't be committed: {e}") })
            }
        };
        let committed = event["kind"] == "branch";
        self.push_event(job_id, event, Some(run_id));
        self.after_commit(job_id, committed);
    }

    fn on_exit(&mut self, job_id: &str, info: &ExitInfo) {
        let Some(mut live) = self.live.remove(job_id) else {
            return;
        };
        let (current, has_session) = self
            .state
            .job(job_id)
            .map_or((JobStatus::Failed, false), |j| (j.status, j.session_id.is_some()));
        let (mut status, mut reason) = exit_outcome(current, live.stop, info, live.fatal.as_deref(), has_session);
        // A resume that never got as far as its session.
        if let Some(pending) = live.resume.take() {
            if live.fatal.as_deref().is_some_and(|f| f.contains(LOCK_FATAL)) {
                // Another launcher still runs this job: it is not failed.
                status = pending.prior;
                reason = LOCK_ERROR.to_string();
            }
            if let Some(reply) = pending.reply {
                let _ = reply.send(Err(format!("the job didn't resume: {reason}")));
            }
        }
        let parked = live.stop == Some(StopKind::Park) && status == JobStatus::Waiting;
        self.log.append(
            job_id,
            Who::Job,
            &format!("run {} ended: {} ({reason})", live.run_id, status.as_str()),
        );
        if let Some(open) = live.prompt.take() {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] its {} prompt {} was never answered: the launcher exited",
                open.kind, open.id
            ));
            self.log.append(
                job_id,
                Who::Ask,
                &format!(
                    "{} {}: the launcher ended before an answer; nothing done",
                    open.kind, open.id
                ),
            );
        }
        if let Some(job) = self.state.job_mut(job_id) {
            job.status = status;
            job.parked = parked;
            job.ended_at = if parked { None } else { Some(now_stamp()) };
        }
        self.save();
        self.push_event(
            job_id,
            json!({ "kind": "status", "status": status.as_str(), "reason": reason }),
            Some(live.run_id.clone()),
        );
        // `finish` was called, but the turn never reported its end.
        if let (Some(summary), Some(edit)) = (live.pending_commit.take(), live.edit.take()) {
            self.spawn_commit(job_id, live.gen, live.run_id.clone(), edit, summary);
        }
    }

    /// An agent's tool call or its result, in the command log.
    fn log_tool(&self, job_id: &str, kind: &str, event: &Value) {
        let name = event["name"].as_str().unwrap_or("?");
        let what = if kind == "tool" {
            let input = match &event["input"] {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            format!("{name} {input}")
        } else {
            format!("{name} {}", if event["ok"] == true { "ok" } else { "failed" })
        };
        self.log.append(job_id, Who::Agent, &what);
    }

    // ─── prompts (C3) and the push (C5) ──────────────────────────────────

    /// A launcher's `prompt`: checked, then asked natively or refused. Each
    /// id is answered once: a repeat of one still open or already answered
    /// is dropped, not answered again.
    fn on_prompt(&mut self, job_id: &str, id: String, kind: PromptKind, detail: &Value) {
        let Some(live) = self.live.get(job_id) else { return };
        let label = match &kind {
            PromptKind::Push => "push",
            PromptKind::Fence => "fence",
            PromptKind::Other(_) => "other",
        };
        if live.answered.contains(&id) || live.prompt.as_ref().is_some_and(|p| p.id == id) {
            crate::log_to_file(&format!("[local-agent:{job_id}] ignoring a repeat of prompt {id}"));
            self.log.append(
                job_id,
                Who::Dial8,
                &format!("{label} {id} asked again; ignored (each prompt is answered once)"),
            );
            return;
        }
        let refused = if self.state.off {
            Some(OFF.to_string())
        } else if self.closing || live.stop.is_some() {
            Some("the job is stopping".to_string())
        } else if live.prompt.is_some() {
            Some("another question from this job is still open on the Mac".to_string())
        } else if matches!(kind, PromptKind::Fence) && live.worker.is_some() {
            // L4: nothing on the Mac could hold a coding agent to a wider fence.
            Some(workers::NO_WIDER_FENCE.to_string())
        } else {
            None
        };
        if let Some(why) = refused {
            return self.settle_prompt(job_id, &id, label, false, "refused", Some(&why), Who::Dial8);
        }
        let timeout = prompts::prompt_timeout(detail, self.timing.prompt_timeout);
        let result = match kind {
            PromptKind::Push => self.on_push_prompt(job_id, &id, detail, timeout),
            PromptKind::Fence => self.on_fence_prompt(job_id, &id, detail, timeout),
            PromptKind::Other(k) => Err(format!("this version of Dial8 can't ask about {k:?}")),
        };
        if let Err(why) = result {
            self.drop_prompt(job_id, &id);
            self.settle_prompt(job_id, &id, label, false, "refused", Some(&why), Who::Dial8);
        }
    }

    /// Answer a prompt: the `prompt_answer` line (if its run still runs),
    /// the `prompt` event, and both logs, under `who` decided.
    #[allow(clippy::too_many_arguments)]
    fn settle_prompt(
        &mut self,
        job_id: &str,
        id: &str,
        kind: &str,
        allow: bool,
        state: &str,
        why: Option<&str>,
        who: Who,
    ) {
        let run_id = self.live.get_mut(job_id).map(|live| {
            if let Err(e) = live.handle.send_line(prompt_answer_line(id, allow)) {
                crate::log_to_file(&format!(
                    "[local-agent:{job_id}] the answer to {id} wasn't delivered: {e}"
                ));
            }
            if live.answered.len() >= MAX_ANSWERED {
                live.answered.clear();
            }
            live.answered.insert(id.to_string());
            live.run_id.clone()
        });
        let why = why.map(|r| format!(": {r}")).unwrap_or_default();
        crate::log_to_file(&format!("[local-agent:{job_id}] {kind} prompt {id} {state}{why}"));
        self.log.append(job_id, who, &format!("{kind} {id} {state}{why}"));
        let why = (!why.is_empty()).then(|| why[2..].to_string());
        self.push_event(job_id, prompt_event(id, kind, state, why.as_deref()), run_id);
    }

    /// Hold the job's one prompt slot for `id`, and answer it no just before
    /// the launcher's `wait` runs out ([`JobEvent::PromptExpired`]) if it is
    /// still open then, whatever stage it is in.
    fn open_prompt(&mut self, job_id: &str, id: &str, kind: &'static str, stage: PromptStage, wait: Duration) {
        let Some(live) = self.live.get_mut(job_id) else { return };
        // A little before the launcher's own deadline, which counts from
        // when it wrote the line ([`prompts::answer_within`]).
        let timeout = prompts::answer_within(wait);
        live.prompt = Some(OpenPrompt {
            id: id.to_string(),
            kind,
            stage,
            deadline: Instant::now() + timeout,
            timeout: wait,
        });
        let (tx, gen, run_id, job_id, id) = (
            self.job_tx.clone(),
            live.gen,
            live.run_id.clone(),
            job_id.to_string(),
            id.to_string(),
        );
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let _ = tx
                .send(JobMsg {
                    job_id,
                    gen,
                    event: JobEvent::PromptExpired { run_id, id },
                })
                .await;
        });
    }

    /// Forget the job's open prompt `id`, if it is the open one.
    fn drop_prompt(&mut self, job_id: &str, id: &str) -> Option<OpenPrompt> {
        let live = self.live.get_mut(job_id)?;
        if live.prompt.as_ref().is_some_and(|p| p.id == id) {
            live.prompt.take()
        } else {
            None
        }
    }

    /// The job's open prompt is `id`, from run `run_id`.
    fn is_open(&self, job_id: &str, run_id: &str, id: &str) -> bool {
        self.live
            .get(job_id)
            .is_some_and(|l| l.run_id == run_id && l.prompt.as_ref().is_some_and(|p| p.id == id))
    }

    /// Why a question can't go to the person now, if it can't.
    fn cant_ask(&self, job_id: &str) -> Option<String> {
        if self.state.off {
            return Some(OFF.to_string());
        }
        match self.live.get(job_id) {
            Some(live) if live.stop.is_none() && !self.closing => None,
            _ => Some("the job is stopping".to_string()),
        }
    }

    fn on_push_prompt(&mut self, job_id: &str, id: &str, detail: &Value, timeout: Duration) -> Result<(), String> {
        let ask = PushAsk::parse(detail)?;
        let job = self.state.job(job_id).ok_or("unknown job")?;
        let not_edit = "only an edit job's branch can be pushed";
        if job.mode != GrantMode::Edit {
            return Err(not_edit.into());
        }
        let branch = job.branch.clone().ok_or("this job has no branch to push")?;
        if !push::is_job_branch(&branch) {
            return Err(format!("{branch} isn't a branch Dial8 made"));
        }
        if self.pushes.contains_key(job_id) {
            return Err("this job's branch is being pushed already".into());
        }
        let has_commit = job.commit.is_some();
        let commit_running = self.committing.contains(job_id);
        let live = self.live.get(job_id).ok_or("this job isn't running")?;
        if live.edit.is_none() {
            return Err(not_edit.into());
        }
        let commit_pending = live.pending_commit.is_some();
        if commit_running || commit_pending {
            crate::log_to_file(&format!("[local-agent:{job_id}] push prompt {id} waits for the commit"));
            self.open_prompt(job_id, id, "push", PromptStage::AwaitingCommit(ask), timeout);
            self.commit_for_push(job_id);
            return Ok(());
        }
        if !has_commit {
            return Err("nothing has been committed on this job's branch yet".into());
        }
        self.open_prompt(job_id, id, "push", PromptStage::Preparing, timeout);
        self.prepare_push(job_id, ask)
    }

    /// A push waits on `finish`'s commit, and the push tool waits on the
    /// answer, so the turn can't end: commit now instead, once every other
    /// tool call of the turn has returned (the asking one is the last in
    /// flight). With more still running, it waits for them, or for the
    /// turn's end, as before.
    fn commit_for_push(&mut self, job_id: &str) {
        if self.committing.contains(job_id) {
            return;
        }
        let Some(live) = self.live.get(job_id) else { return };
        let waiting = matches!(
            live.prompt,
            Some(OpenPrompt {
                stage: PromptStage::AwaitingCommit(_),
                ..
            })
        );
        if !waiting || live.pending_commit.is_none() {
            return;
        }
        if live.tools_running.len() > 1 {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] the push's commit waits for {} tool call(s)",
                live.tools_running.len() - 1
            ));
            return;
        }
        self.kick_commit(job_id);
    }

    /// The agent's tool calls in flight: a call starts with its `tool`
    /// event and ends with its `tool_result`.
    fn track_tool(&mut self, job_id: &str, kind: &str, event: &Value) {
        let Some(live) = self.live.get_mut(job_id) else { return };
        let call = event["callId"].as_str().map(str::to_string);
        if kind == "tool" {
            // No id to match its result: it counts until the turn ends.
            live.tools_running
                .insert(call.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
            return;
        }
        if let Some(call) = call {
            if live.tools_running.remove(&call) {
                self.commit_for_push(job_id);
            }
        }
    }

    /// A commit landed (or failed): a push waiting for it is asked now.
    fn after_commit(&mut self, job_id: &str, committed: bool) {
        let more_coming = self.committing.contains(job_id);
        let Some(live) = self.live.get_mut(job_id) else { return };
        let more_coming = more_coming || live.pending_commit.is_some();
        let Some(open) = live.prompt.as_mut() else { return };
        if !matches!(open.stage, PromptStage::AwaitingCommit(_)) || more_coming {
            return;
        }
        let PromptStage::AwaitingCommit(ask) = std::mem::replace(&mut open.stage, PromptStage::Preparing) else {
            return;
        };
        let id = open.id.clone();
        let refused = if !committed {
            Some("the changes couldn't be committed".to_string())
        } else {
            self.cant_ask(job_id)
        };
        let refused = match refused {
            Some(why) => Some(why),
            None => self.prepare_push(job_id, ask).err(),
        };
        if let Some(why) = refused {
            self.drop_prompt(job_id, &id);
            self.settle_prompt(job_id, &id, "push", false, "refused", Some(&why), Who::Dial8);
        }
    }

    /// Find the remote (git, off the actor), then ask about exactly the
    /// commit on the branch now.
    fn prepare_push(&mut self, job_id: &str, ask: PushAsk) -> Result<(), String> {
        let job = self.state.job(job_id).cloned().ok_or("unknown job")?;
        let grant = self
            .state
            .grant(&job.grant_id)
            .cloned()
            .ok_or("its folder is no longer shared")?;
        let repo = PathBuf::from(self.recheck_grant(&grant)?);
        let branch = job.branch.clone().ok_or("this job has no branch to push")?;
        let commit = job
            .commit
            .clone()
            .filter(|c| push::is_commit_id(c))
            .ok_or("nothing has been committed on this job's branch yet")?;
        let base = job.base_branch.clone();
        let base_commit = job.base_commit.clone().filter(|c| push::is_commit_id(c));
        let live = self.live.get(job_id).ok_or("this job isn't running")?;
        let edit = live.edit.clone().ok_or("only an edit job's branch can be pushed")?;
        let id = live.prompt.as_ref().map(|p| p.id.clone()).ok_or("no open prompt")?;
        let (tx, gen, run_id, job_id) = (self.job_tx.clone(), live.gen, live.run_id.clone(), job_id.to_string());
        tokio::spawn(async move {
            // Where it goes, and everything it would send: a job from a base
            // branch the remote doesn't have is refused before anyone is asked.
            let checked = async {
                let target = push::target(&edit.git, &repo, &branch).await?;
                if let Some(b) = &base {
                    push::check_base_on_remote(&edit.git, &repo, &target.remote, b).await?;
                }
                let sends =
                    push::what_it_sends(&edit.git, &repo, &target.remote, &commit, base_commit.as_deref()).await?;
                // The files it changes, as git has them: the prompt lists them.
                let files = push::changed_files(&edit.git, &repo, &commit, base_commit.as_deref()).await?;
                Ok::<_, String>((target, sends, files))
            };
            let result = checked.await.map(|(target, sends, files)| {
                let prompt = prompts::push_prompt(
                    &prompts::PushWhere {
                        branch: &branch,
                        commit: &commit,
                        remote: &target.remote,
                        repo: target.repo.as_deref(),
                        label: &grant.label,
                        base: base.as_deref(),
                        sends,
                        files: &files,
                    },
                    &ask,
                );
                let plan = PushPlan {
                    ctx: PushCtx {
                        git: edit.git,
                        gh: edit.gh,
                        api_origin: edit.api_origin,
                    },
                    repo,
                    branch,
                    commit,
                    target,
                    title: ask.title,
                    body: ask.body,
                    job_base: base,
                    session_id: job_id.clone(),
                    token: None,
                    stop: push::Stop::default(),
                };
                (prompt, Action::Push(Box::new(plan)))
            });
            let _ = tx
                .send(JobMsg {
                    job_id,
                    gen,
                    event: JobEvent::PromptReady { run_id, id, result },
                })
                .await;
        });
        Ok(())
    }

    /// A fence request: its realpath is checked off the actor (a slow or
    /// hung volume never holds it up), then asked.
    fn on_fence_prompt(&mut self, job_id: &str, id: &str, detail: &Value, timeout: Duration) -> Result<(), String> {
        let ask = FenceAsk::parse(detail)?;
        // C3: fence grants are read-only. Refused before anything is checked
        // or shown; an edit job writes only in its own worktree.
        if ask.access == Access::Write {
            return Err(prompts::FENCE_READ_ONLY.into());
        }
        let job = self.state.job(job_id).ok_or("unknown job")?;
        let grant = self
            .state
            .grant(&job.grant_id)
            .cloned()
            .ok_or("its folder is no longer shared")?;
        let live = self.live.get(job_id).ok_or("this job isn't running")?;
        let (never_write, git) = (live.never_write.clone(), live.git.clone());
        let (home, protected) = (self.paths.home.clone(), self.paths.protected.clone());
        self.open_prompt(job_id, id, "fence", PromptStage::Preparing, timeout);
        let live = self.live.get(job_id).ok_or("this job isn't running")?;
        let (tx, gen, run_id, job_id, id) = (
            self.job_tx.clone(),
            live.gen,
            live.run_id.clone(),
            job_id.to_string(),
            id.to_string(),
        );
        tokio::spawn(async move {
            let own = PathBuf::from(&grant.path);
            // A write must not reach anything git reads or runs as the person
            // (their config files, its includes, the programs it names).
            // Writes are refused above; this keeps the write rules whole as
            // defense in depth.
            let mut never_write = never_write.as_ref().clone();
            if ask.access == Access::Write {
                let listed = git
                    .run_with(
                        &own,
                        &["config", "--list", "--show-origin", "--show-scope", "-z"],
                        &[],
                        FENCE_CHECK_TIMEOUT,
                    )
                    .await;
                match listed {
                    Ok(out) => never_write.extend(prompts::git_config_paths(&out, &own, &home)),
                    Err(e) => {
                        let result = Err(format!("git's config couldn't be read to check the path: {e}"));
                        let _ = tx
                            .send(JobMsg {
                                job_id,
                                gen,
                                event: JobEvent::PromptReady { run_id, id, result },
                            })
                            .await;
                        return;
                    }
                }
            }
            let check = tokio::task::spawn_blocking(move || {
                let rules = FenceRules {
                    home: &home,
                    protected: &protected,
                    own: &own,
                    never_write: &never_write,
                };
                let real = prompts::check_fence(&ask, &rules)?;
                let prompt = prompts::fence_prompt(&real, &grant.label, ask.reason.as_deref());
                Ok((
                    prompt,
                    Action::Fence {
                        path: real,
                        access: ask.access,
                    },
                ))
            });
            let result = match tokio::time::timeout(FENCE_CHECK_TIMEOUT, check).await {
                Ok(Ok(result)) => result,
                Ok(Err(e)) => Err(format!("the path couldn't be checked: {e}")),
                Err(_) => Err(format!("the path took over {FENCE_CHECK_TIMEOUT:?} to check")),
            };
            let _ = tx
                .send(JobMsg {
                    job_id,
                    gen,
                    event: JobEvent::PromptReady { run_id, id, result },
                })
                .await;
        });
        Ok(())
    }

    /// A prompt was checked: ask the person, or refuse. A fence path this
    /// run already has (as wide) is allowed without asking again.
    fn on_prompt_ready(
        &mut self,
        job_id: &str,
        run_id: &str,
        id: &str,
        result: Result<(NativePrompt, Action), String>,
    ) {
        let preparing = self.is_open(job_id, run_id, id)
            && self.live.get(job_id).is_some_and(|l| {
                matches!(
                    l.prompt,
                    Some(OpenPrompt {
                        stage: PromptStage::Preparing,
                        ..
                    })
                )
            });
        if !preparing {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] prompt {id} closed while it was checked; dropped"
            ));
            return;
        }
        let kind = self
            .live
            .get(job_id)
            .and_then(|l| l.prompt.as_ref())
            .map_or("push", |p| p.kind);
        let result = match self.cant_ask(job_id) {
            Some(why) => Err(why),
            None => result,
        };
        match result {
            Err(why) => {
                self.drop_prompt(job_id, id);
                self.settle_prompt(job_id, id, kind, false, "refused", Some(&why), Who::Dial8);
            }
            Ok((prompt, Action::Fence { path, access })) => {
                let already = self.live.get(job_id).is_some_and(|l| {
                    l.fence_allowed
                        .iter()
                        .any(|(p, a)| path.starts_with(p) && a.covers(access))
                });
                if already {
                    let why = format!(
                        "{} {} was already allowed for this run",
                        access.as_str(),
                        path.display()
                    );
                    self.drop_prompt(job_id, id);
                    self.settle_prompt(job_id, id, kind, true, "allowed", Some(&why), Who::Dial8);
                } else {
                    self.ask_person(job_id, prompt, Action::Fence { path, access });
                }
            }
            Ok((prompt, action)) => self.ask_person(job_id, prompt, action),
        }
    }

    /// Show the native prompt for the job's open prompt, for what is left of
    /// its deadline; the answer comes back as [`JobEvent::PromptAnswered`].
    fn ask_person(&mut self, job_id: &str, prompt: NativePrompt, action: Action) {
        let Some(live) = self.live.get_mut(job_id) else { return };
        let Some(open) = live.prompt.as_mut() else { return };
        open.stage = PromptStage::Asking(action);
        let left = open.deadline.saturating_duration_since(Instant::now());
        let (id, kind, gen, run_id) = (open.id.clone(), open.kind, live.gen, live.run_id.clone());
        if left.is_zero() {
            // Its expiry is on the way.
            return;
        }
        crate::log_to_file(&format!("[local-agent:{job_id}] asking: {}", prompt.title));
        self.log
            .append(job_id, Who::Ask, &format!("{kind} {id}: {}", prompt.title));
        self.push_event(job_id, prompt_event(&id, kind, "asking", None), Some(run_id.clone()));
        let (answer, answered) = oneshot::channel();
        self.host.ask(&prompt, left, answer);
        let (tx, job_id) = (self.job_tx.clone(), job_id.to_string());
        tokio::spawn(async move {
            let allow = answered.await.unwrap_or(false);
            let _ = tx
                .send(JobMsg {
                    job_id,
                    gen,
                    event: JobEvent::PromptAnswered { run_id, id, allow },
                })
                .await;
        });
    }

    /// The person answered. A yes counts only while the prompt is open, the
    /// job still runs and local agents are on; a late answer never acts.
    fn on_prompt_answered(&mut self, job_id: &str, run_id: &str, id: &str, allow: bool) {
        let asking = self.is_open(job_id, run_id, id)
            && self.live.get(job_id).is_some_and(|l| {
                matches!(
                    l.prompt,
                    Some(OpenPrompt {
                        stage: PromptStage::Asking(_),
                        ..
                    })
                )
            });
        if !asking {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] prompt {id} answered after it closed; nothing done"
            ));
            let yes = if allow { "yes" } else { "no" };
            self.log.append(
                job_id,
                Who::You,
                &format!("{id} answered {yes} after it closed; nothing done"),
            );
            return;
        }
        let blocked = self.cant_ask(job_id);
        let open = self.drop_prompt(job_id, id).expect("checked");
        let PromptStage::Asking(action) = open.stage else {
            return;
        };
        let allow = allow && blocked.is_none();
        if let (true, Action::Fence { path, access }) = (allow, &action) {
            if let Some(live) = self.live.get_mut(job_id) {
                live.fence_allowed.push((path.clone(), *access));
            }
        }
        let state = if allow { "allowed" } else { "denied" };
        self.settle_prompt(job_id, id, open.kind, allow, state, blocked.as_deref(), Who::You);
        if let (true, Action::Push(plan)) = (allow, action) {
            self.spawn_push(job_id, run_id, *plan);
        }
    }

    /// Nobody answered in time: no, once; the alert has closed itself.
    fn on_prompt_expired(&mut self, job_id: &str, run_id: &str, id: &str) {
        if !self.is_open(job_id, run_id, id) {
            return;
        }
        let Some(open) = self.drop_prompt(job_id, id) else {
            return;
        };
        let why = format!("nobody answered within {}", human(open.timeout));
        self.settle_prompt(job_id, id, open.kind, false, "expired", Some(&why), Who::Dial8);
    }

    /// Push and open the pull request on a task of its own; the outcome
    /// comes back as [`JobEvent::Pushed`]. Marked on disk first, so a quit
    /// meanwhile is reported at the next launch.
    fn spawn_push(&mut self, job_id: &str, run_id: &str, mut plan: PushPlan) {
        // The session token as it is now (the relay refreshes it).
        plan.token = self.tokens.get(job_id).cloned();
        let stop = push::Stop::default();
        plan.stop = stop.clone();
        crate::log_to_file(&format!(
            "[local-agent:{job_id}] pushing {} ({}) to {}",
            plan.branch,
            &plan.commit[..7],
            plan.target.remote
        ));
        self.log.append(
            job_id,
            Who::Dial8,
            &format!(
                "pushing {} ({}) to {} as you, from {}",
                plan.branch,
                &plan.commit[..7],
                plan.target.remote,
                plan.repo.display()
            ),
        );
        if let Some(job) = self.state.job_mut(job_id) {
            job.push_running = Some(PushMarker {
                branch: plan.branch.clone(),
                commit: plan.commit.clone(),
                remote: plan.target.remote.clone(),
            });
        }
        self.save();
        self.pushes.insert(job_id.to_string(), stop);
        let gen = self.live.get(job_id).map_or(0, |l| l.gen);
        let (tx, job_id, run_id) = (self.job_tx.clone(), job_id.to_string(), run_id.to_string());
        tokio::spawn(async move {
            let outcome = push::push_and_open(plan).await;
            let _ = tx
                .send(JobMsg {
                    job_id,
                    gen,
                    event: JobEvent::Pushed {
                        run_id,
                        outcome: Box::new(outcome),
                    },
                })
                .await;
        });
    }

    /// The push and its pull request are done: record and report them.
    fn on_pushed(&mut self, job_id: &str, run_id: String, outcome: PushOutcome) {
        self.pushes.remove(job_id);
        for line in &outcome.ran {
            self.log.append(job_id, Who::Dial8, line);
        }
        if let Some(job) = self.state.job_mut(job_id) {
            job.push_running = None;
            if let Ok((url, _)) = &outcome.result {
                job.pull_request = Some(url.clone());
            }
        }
        self.save();
        match &outcome.result {
            Ok((url, _)) => crate::log_to_file(&format!("[local-agent:{job_id}] pull request {url}")),
            Err(e) => crate::log_to_file(&format!("[local-agent:{job_id}] push or pull request failed: {e}")),
        }
        self.push_event(job_id, outcome.event(), Some(run_id));
    }

    /// At launch: a push the last run was in the middle of when it quit.
    /// Reported as failed (it may or may not have reached the remote).
    fn report_interrupted_pushes(&mut self) {
        let mut cut: Vec<(String, Option<String>, PushMarker)> = Vec::new();
        for job in &mut self.state.jobs {
            if let Some(marker) = job.push_running.take() {
                cut.push((job.id.clone(), job.run_id.clone(), marker));
            }
        }
        if cut.is_empty() {
            return;
        }
        self.save();
        for (job_id, run_id, m) in cut {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] Dial8 quit while pushing {}; reported as failed",
                m.branch
            ));
            self.log.append(
                &job_id,
                Who::Dial8,
                &format!(
                    "{QUIT_DURING_PUSH} ({} {} to {})",
                    m.branch,
                    &m.commit[..7.min(m.commit.len())],
                    m.remote
                ),
            );
            self.push_event(
                &job_id,
                json!({
                    "kind": "pull_request",
                    "ok": false,
                    "branch": m.branch,
                    "commit": m.commit,
                    "remote": m.remote,
                    "pushed": Value::Null,
                    "error": QUIT_DURING_PUSH,
                }),
                run_id,
            );
        }
    }

    fn push_event(&mut self, job_id: &str, event: Value, run_id: Option<String>) {
        let entry = self.ensure_ring(job_id).push(event, run_id);
        self.host.emit(&EventPayload {
            job_id: job_id.to_string(),
            seq: entry.seq,
            run_id: entry.run_id,
            event: entry.event,
        });
    }

    fn ensure_ring(&mut self, job_id: &str) -> &mut Ring {
        if !self.rings.contains_key(job_id) {
            // Make room: drop the rings of the oldest jobs without a process.
            while self.rings.len() >= self.max_rings {
                let victim = self
                    .rings
                    .keys()
                    .filter(|id| !self.live.contains_key(*id))
                    .min_by_key(|id| self.state.job(id).map(|j| j.created_at.clone()).unwrap_or_default())
                    .cloned();
                match victim {
                    Some(v) => {
                        if let Some(ring) = self.rings.remove(&v) {
                            self.evicted_seq.insert(v, ring.last_seq());
                        }
                    }
                    None => break,
                }
            }
            let first = self.evicted_seq.remove(job_id).map_or(1, |last| last + 1);
            self.rings
                .insert(job_id.to_string(), Ring::starting_at(RING_CAP, first));
        }
        self.rings.get_mut(job_id).expect("ring just ensured")
    }

    fn begin_shutdown(&mut self, reply: oneshot::Sender<()>) {
        self.closing = true;
        if let Some(sd) = &mut self.shutdown {
            sd.replies.push(reply);
            return;
        }
        if self.live.is_empty() && self.committing.is_empty() {
            let _ = reply.send(());
            return;
        }
        crate::log_to_file(&format!(
            "[local-agent] app quitting: stopping {} job(s), {} commit(s) and {} push(es) running",
            self.live.len(),
            self.committing.len(),
            self.pushes.len()
        ));
        for live in self.live.values_mut() {
            if live.stop.is_none() {
                live.stop = Some(StopKind::AppExit);
            }
            live.handle.stop();
        }
        let now = Instant::now();
        self.shutdown = Some(Shutdown {
            replies: vec![reply],
            kill_at: now + self.timing.exit_kill_after,
            give_up_at: now + self.timing.exit_give_up_after,
            killed: false,
        });
    }

    fn on_shutdown_deadline(&mut self) {
        let Some(sd) = self.shutdown.as_mut() else { return };
        if !sd.killed {
            sd.killed = true;
            crate::log_to_file(&format!(
                "[local-agent] {} job(s) still running at quit: killing",
                self.live.len()
            ));
            for live in self.live.values() {
                live.handle.kill_now();
            }
            return;
        }
        // Their exits never arrived in time: record them as ended anyway.
        if !self.committing.is_empty() {
            crate::log_to_file(&format!(
                "[local-agent] {} commit(s) unfinished at quit; the changes stay in the worktree",
                self.committing.len()
            ));
            self.committing.clear();
        }
        let now = now_stamp();
        for (id, live) in self.live.drain() {
            if let Some(job) = self.state.job_mut(&id) {
                match live.stop {
                    Some(StopKind::User) => job.status = JobStatus::Cancelled,
                    Some(StopKind::Park) if job.session_id.is_some() => {
                        job.status = JobStatus::Waiting;
                        job.parked = true;
                        continue;
                    }
                    _ => job.status = JobStatus::Interrupted,
                }
                job.ended_at = Some(now.clone());
            }
        }
    }

    fn finish_shutdown_if_done(&mut self) {
        if self.shutdown.is_some() && self.live.is_empty() && self.committing.is_empty() {
            let sd = self.shutdown.take().expect("checked");
            self.save();
            crate::log_to_file("[local-agent] every job stopped");
            for reply in sd.replies {
                let _ = reply.send(());
            }
        }
    }
}
