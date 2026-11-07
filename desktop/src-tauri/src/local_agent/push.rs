//! C5, the desktop half (teammate plan): once the person says yes to the
//! native push prompt ([`super::prompts`]), push the edit job's own branch
//! and open its pull request. All of it runs here, as the person, outside the
//! sandbox, in the person's checkout (the grant's folder), with their own git
//! login (the credential helper or ssh-agent). The agent never sees a
//! credential.
//!
//! 1. **The remote**: `remote.pushDefault`, else `origin`, else the only one;
//!    several and none of those is refused. Its **push** URL (`git remote
//!    get-url --push`: where the commit actually goes) names the repository
//!    the pull request opens in, and the prompt shows it.
//! 2. **The push**: `git push --porcelain --no-verify --no-follow-tags
//!    --recurse-submodules=no -- <remote> <sha>:refs/heads/<b>`, with
//!    [`super::git`]'s safe config (no hooks, no fsmonitor, no signing).
//!    Exactly the commit the person was asked about, onto the job's own
//!    `dial8/…` branch: never forced, no tags, no submodules, whatever the
//!    branch moved to since. ssh-agent's socket is the one thing added to
//!    git's clean environment. That commit takes every ancestor the remote
//!    lacks along, so before asking Rust counts them ([`what_it_sends`]:
//!    the job's own, and any earlier ones from its base branch or the
//!    checkout) and the prompt says so; and a job started from a base
//!    branch is refused, unasked, when the remote has no such branch
//!    ([`check_base_on_remote`]): its local-only commits would go too, and
//!    the pull request couldn't open against it. The prompt also lists the
//!    files the job's commits change ([`changed_files`], from git, the
//!    first [`SHOWN_FILES`] and "+N more").
//! 3. **The base**: the local branch the job started from, when its start
//!    named one (`baseBranch`, checked again by [`super::git::check_base_branch`]
//!    before anything is pushed: a job whose stored name fails pushes
//!    nothing); else `refs/remotes/<remote>/HEAD`, else `git ls-remote
//!    --symref <remote> HEAD`, else unknown (gh then gets no `--base`).
//! 4. **The pull request**: `gh pr create --repo <host>/<owner>/<repo>` when
//!    `gh auth status --hostname <host>` succeeds (both run in an empty
//!    folder of their own, so nothing in a checkout steers gh); otherwise
//!    the server's `POST /api/local-agent/sessions/<id>/pull-request` with
//!    the session token, and the server opens it with the person's Dial8
//!    GitHub sign-in. The remote URL sent there never carries a
//!    `user:password@`, and neither the token nor that URL is ever logged
//!    (`Debug` redacts both).
//!
//! Turning local agents off ([`Stop`]) ends whichever step is running and
//! skips the rest. The outcome is Rust's own `pull_request` event
//! ([`PushOutcome::event`]), which the relay uploads like any other.

use crate::sidecar::NoConsole;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Notify;

use super::git::Git;
use super::protocol::truncate;

/// A push, at most (a first push of a big branch takes a while).
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(300);
/// A `git ls-remote` or a `gh` call, at most.
const NET_TIMEOUT: Duration = Duration::from_secs(60);
/// The server's pull request route, at most.
const SERVER_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest pull request URL kept.
const MAX_URL: usize = 2_048;

/// The server's route for a session's pull request (C5).
pub fn pull_request_url(origin: &str, session_id: &str) -> String {
    format!(
        "{}/api/local-agent/sessions/{session_id}/pull-request",
        origin.trim_end_matches('/')
    )
}

/// What a running edit job needs to push, besides the job itself.
#[derive(Debug, Clone)]
pub struct PushCtx {
    pub git: Git,
    /// `gh` on the person's PATH, if there is one.
    pub gh: Option<PathBuf>,
    /// The app's API origin, for the server fallback.
    pub api_origin: String,
}

/// Where the commit goes.
#[derive(Clone, PartialEq)]
pub struct Target {
    pub remote: String,
    /// `git remote get-url --push`, as configured: it may carry
    /// credentials, so it is never logged or sent as it is
    /// ([`without_credentials`]).
    pub url: String,
    /// `host/owner/repo` of [`Target::url`], when it names one.
    pub repo: Option<String>,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Target")
            .field("remote", &self.remote)
            .field("url", &without_credentials(&self.url))
            .field("repo", &self.repo)
            .finish()
    }
}

/// Ends a push early: the off switch.
#[derive(Debug, Clone, Default)]
pub struct Stop(Arc<(AtomicBool, Notify)>);

impl Stop {
    pub fn stop(&self) {
        self.0 .0.store(true, Ordering::SeqCst);
        self.0 .1.notify_waiters();
    }

    pub fn is_stopped(&self) -> bool {
        self.0 .0.load(Ordering::SeqCst)
    }

    async fn stopped(&self) {
        loop {
            let woken = self.0 .1.notified();
            if self.is_stopped() {
                return;
            }
            woken.await;
        }
    }

    /// `step`, unless the push is stopped first (`None`; the step's child
    /// process is killed as it is dropped).
    async fn or_stop<T>(&self, step: impl Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            _ = self.stopped() => None,
            out = step => Some(out),
        }
    }
}

/// Everything one push needs, fixed when the person is asked.
#[derive(Clone)]
pub struct PushPlan {
    pub ctx: PushCtx,
    /// The person's checkout.
    pub repo: PathBuf,
    pub branch: String,
    /// The commit the person was asked about: what is pushed.
    pub commit: String,
    pub target: Target,
    pub title: String,
    pub body: String,
    /// The local branch the job's branch started from, when its start named
    /// one: the pull request's base, instead of the remote's default branch.
    pub job_base: Option<String>,
    /// The job id: the server's session uuid.
    pub session_id: String,
    /// The session token, for the server fallback.
    pub token: Option<String>,
    pub stop: Stop,
}

impl std::fmt::Debug for PushPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PushPlan")
            .field("repo", &self.repo)
            .field("branch", &self.branch)
            .field("commit", &self.commit)
            .field("target", &self.target)
            .field("title", &self.title)
            .field("job_base", &self.job_base)
            .field("session_id", &self.session_id)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// A full commit id (SHA-1 or SHA-256), lowercase hex.
pub fn is_commit_id(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Gh,
    Server,
}

impl Via {
    fn as_str(self) -> &'static str {
        match self {
            Via::Gh => "gh",
            Via::Server => "server",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PushOutcome {
    pub branch: String,
    pub commit: String,
    pub remote: String,
    pub pushed: bool,
    pub base: Option<String>,
    /// The pull request's URL and who opened it, or why it isn't open.
    pub result: Result<(String, Via), String>,
    /// What ran, one line each, for the job's command log.
    pub ran: Vec<String>,
}

impl PushOutcome {
    /// Rust's `pull_request` event.
    pub fn event(&self) -> Value {
        match &self.result {
            Ok((url, via)) => json!({
                "kind": "pull_request",
                "ok": true,
                "branch": self.branch,
                "commit": self.commit,
                "remote": self.remote,
                "base": self.base,
                "url": url,
                "via": via.as_str(),
            }),
            Err(e) => json!({
                "kind": "pull_request",
                "ok": false,
                "branch": self.branch,
                "commit": self.commit,
                "remote": self.remote,
                "pushed": self.pushed,
                "error": e,
            }),
        }
    }
}

/// A branch Rust made for an edit job ([`super::git::branch_name`]), and a
/// name git and gh can't read as an option.
pub fn is_job_branch(branch: &str) -> bool {
    branch.starts_with("dial8/")
        && branch.len() <= 200
        && branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
        && !branch.contains("..")
        && !branch.ends_with('/')
        && !branch.ends_with(".lock")
}

/// What a push of the job's commit sends, as far as the remote-tracking
/// branches say (a stale one only makes the count larger).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Sends {
    /// The remote lacks these commits of the job's own branch, its commit
    /// among them: those since the commit it started from, or all of them
    /// when that isn't known.
    pub job: u64,
    /// The remote lacks these too, from before the job's branch started: its
    /// base branch's or the checkout's own. Always 0 when the start isn't
    /// known.
    pub earlier: u64,
}

/// A remote name `--remotes=<name>` takes as itself, not as a pattern (git
/// itself refuses to add a remote with these).
fn is_literal(remote: &str) -> bool {
    !remote.contains(['*', '?', '[', '\\'])
}

/// `git rev-list --count <commit> --not [<base>] --remotes=<remote>`: the
/// commits the remote lacks, all of them, and the job's own when the commit
/// it started from is known.
pub async fn what_it_sends(
    git: &Git,
    repo: &Path,
    remote: &str,
    commit: &str,
    base_commit: Option<&str>,
) -> Result<Sends, String> {
    let cant = |why: &str| format!("can't tell what the push would send ({why}), so nothing was asked or pushed");
    if !is_commit_id(commit) || base_commit.is_some_and(|b| !is_commit_id(b)) {
        return Err(cant("not a commit id"));
    }
    if !is_plain_name(remote) || !is_literal(remote) {
        return Err(cant("the remote's name"));
    }
    let remotes = format!("--remotes={remote}");
    let count = |out: Result<String, String>| -> Result<u64, String> {
        out.map_err(|e| cant(&e))?
            .trim()
            .parse::<u64>()
            .map_err(|_| cant("git rev-list"))
    };
    let all = ["rev-list", "--count", commit, "--not", &remotes];
    let total = count(git.run_with(repo, &all, &[], super::git::GIT_TIMEOUT).await)?;
    let Some(base) = base_commit else {
        return Ok(Sends { job: total, earlier: 0 });
    };
    let since = ["rev-list", "--count", commit, "--not", base, &remotes];
    let job = count(git.run_with(repo, &since, &[], super::git::GIT_TIMEOUT).await)?;
    Ok(Sends {
        job,
        earlier: total.saturating_sub(job),
    })
}

/// Files a push prompt names, at most (then "+N more").
pub const SHOWN_FILES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Added,
    Deleted,
    /// Changed in place, or its type (a file became a link).
    Modified,
}

/// The files a push's commits change, for its prompt: the first
/// [`SHOWN_FILES`], risky ones first ([`is_risky`]), each part in git's
/// order, and how many there are in all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changed {
    pub files: Vec<(String, Change)>,
    pub total: usize,
}

/// Folders and files whose contents run, or steer the person's tools, once
/// the branch is checked out, built, opened or merged: CI, hooks, package
/// scripts and lockfiles, build scripts and containers, git attributes and
/// submodules, editor and agent settings. Compared ignoring case.
const RISKY_DIRS: &[&str] = &[
    ".github",
    ".husky",
    ".githooks",
    "hooks",
    ".vscode",
    ".claude",
    ".codex",
    ".cursor",
    ".gemini",
    ".yarn",
    ".cargo",
    ".devcontainer",
];
const RISKY_NAMES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "composer.lock",
    "go.sum",
    ".npmrc",
    ".envrc",
    ".mcp.json",
    "makefile",
    ".pnpmfile.cjs",
    ".pre-commit-config.yaml",
    "build.rs",
    "dockerfile",
    ".gitattributes",
    ".gitmodules",
    "pyproject.toml",
    "setup.py",
];

/// A path a push prompt lists first: in a [`RISKY_DIRS`] folder (at any
/// depth), one of [`RISKY_NAMES`], a `.gitlab-ci*`, a `.yarnrc*`, a
/// `lefthook.yml` / `.yaml` (or `.lefthook*`, `lefthook-local*`), a
/// `Dockerfile.*` or `*.dockerfile`, a `*.sh`, or executable.
pub fn is_risky(path: &str, executable: bool) -> bool {
    let lower = path.to_ascii_lowercase();
    let mut parts: Vec<&str> = lower.split('/').collect();
    let name = parts.pop().unwrap_or_default();
    let lefthook = name.trim_start_matches('.').starts_with("lefthook")
        && (name.ends_with(".yml") || name.ends_with(".yaml"));
    executable
        || parts.iter().any(|d| RISKY_DIRS.contains(d))
        || RISKY_NAMES.contains(&name)
        || name.starts_with(".gitlab-ci")
        || name.starts_with(".yarnrc")
        || lefthook
        || name.starts_with("dockerfile.")
        || name.ends_with(".dockerfile")
        || name.ends_with(".sh")
}

/// `git diff-tree -r -z --raw --no-renames` records (`:<old> <new> <sha>
/// <sha> <status>\0<path>\0…`), or `git log`'s, one commit's after another:
/// the first `keep` files, risky first, and the count. A path in several
/// commits counts once, as its newest change says, and is risky if any made
/// it so. Executable: its new mode is 100755.
pub fn parse_raw_z(out: &str, keep: usize) -> Changed {
    let mut all: Vec<(String, Change, bool)> = Vec::new();
    let mut fields = out.split('\0');
    while let Some(field) = fields.next() {
        // Anything between records (git log's commit separators) is skipped.
        let Some(meta) = field.trim_start_matches('\n').strip_prefix(':') else {
            continue;
        };
        let Some(path) = fields.next() else {
            break;
        };
        let cols: Vec<&str> = meta.split(' ').collect();
        let [_, new_mode, _, _, status] = cols[..] else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        let how = match status.as_bytes().first() {
            Some(b'A') => Change::Added,
            Some(b'D') => Change::Deleted,
            _ => Change::Modified,
        };
        let risky = is_risky(path, new_mode == "100755");
        match all.iter_mut().find(|(p, _, _)| p == path) {
            Some(seen) => seen.2 |= risky,
            None => all.push((path.to_string(), how, risky)),
        }
    }
    let total = all.len();
    let (risky, rest): (Vec<_>, Vec<_>) = all.into_iter().partition(|(_, _, r)| *r);
    let files = risky
        .into_iter()
        .chain(rest)
        .take(keep)
        .map(|(path, how, _)| (path, how))
        .collect();
    Changed { files, total }
}

/// What the job's commits change: from the commit it started from to
/// `commit`. Tree to tree, so no work tree (a submodule's included) is looked
/// at, and a gitlink shows as a path.
///
/// When that start isn't known, every commit the push sends instead: each
/// one's own change, for every commit the push's remote ([`push_remote`])
/// lacks, as [`what_it_sends`] counts them. `commit`'s own change alone would
/// leave out the earlier ones the push takes along.
pub async fn changed_files(
    git: &Git,
    repo: &Path,
    commit: &str,
    base_commit: Option<&str>,
) -> Result<Changed, String> {
    let cant = |why: &str| format!("can't tell what the push would change ({why}), so nothing was asked or pushed");
    if !is_commit_id(commit) || base_commit.is_some_and(|b| !is_commit_id(b)) {
        return Err(cant("not a commit id"));
    }
    let out = match base_commit {
        Some(base) => {
            let args = ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-commit-id", base, commit];
            git.run_with(repo, &args, &[], super::git::GIT_TIMEOUT).await
        }
        None => {
            let remote = push_remote(git, repo).await.map_err(|e| cant(&e))?;
            if !is_literal(&remote) {
                return Err(cant("the remote's name"));
            }
            let remotes = format!("--remotes={remote}");
            // A merge shows what it brings in over its first parent: more
            // than it adds, never less.
            let args = [
                "log",
                "-z",
                "--raw",
                "--no-renames",
                "--format=",
                "--diff-merges=first-parent",
                commit,
                "--not",
                &remotes,
            ];
            git.run_with(repo, &args, &[], super::git::GIT_TIMEOUT).await
        }
    }
    .map_err(|e| cant(&e))?;
    Ok(parse_raw_z(&out, SHOWN_FILES))
}

/// The job's base branch is on the remote: `refs/remotes/<remote>/<base>`
/// exists, byte for byte (APFS would open a case variant of a loose ref).
pub async fn check_base_on_remote(git: &Git, repo: &Path, remote: &str, base: &str) -> Result<(), String> {
    let missing = || {
        format!(
            "{base} isn't on {remote}, so nothing was pushed. Push {base} first, or start the job from a branch \
             that's there."
        )
    };
    super::git::check_base_branch(base)?;
    if !is_plain_name(remote) || !is_literal(remote) {
        return Err(missing());
    }
    let full = format!("refs/remotes/{remote}/{base}");
    let listed = git
        .run_with(
            repo,
            &["for-each-ref", "--format=%(refname)", &full],
            &[],
            super::git::GIT_TIMEOUT,
        )
        .await?;
    if listed.lines().any(|l| l == full) {
        Ok(())
    } else {
        Err(missing())
    }
}

/// A remote or base branch name safe to pass as an argument.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && name.len() <= 200 && name.bytes().all(|b| b.is_ascii_graphic())
}

/// `url` without a `user:password@` (an `https://token@host/…` remote).
/// An scp-style `git@host:owner/repo` stays as it is: `git` is no secret.
pub fn without_credentials(url: &str) -> String {
    if let Some(i) = url.find("://") {
        let (scheme, rest) = url.split_at(i + 3);
        let end = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..end];
        if let Some(at) = authority.rfind('@') {
            return format!("{scheme}{}{}", &authority[at + 1..], &rest[end..]);
        }
    }
    url.to_string()
}

/// `text` with every `scheme://user:password@` cut to `scheme://`: git's
/// own errors can quote a remote URL, and they end up in an event.
pub fn scrub_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest
            .find(|c: char| c == '/' || c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>'))
            .unwrap_or(rest.len());
        if let Some(at) = rest[..end].rfind('@') {
            rest = &rest[at + 1..];
        }
    }
    out.push_str(rest);
    out
}

/// `(host, owner, repo)` of a hosted remote (`https://host/o/r.git`,
/// `ssh://git@host/o/r`, `git@host:o/r.git`); `None` for a local path.
pub fn repo_of(url: &str) -> Option<(String, String, String)> {
    let url = without_credentials(url.trim());
    let (host, path) = if let Some(i) = url.find("://") {
        let scheme = &url[..i];
        if !matches!(scheme, "https" | "http" | "ssh" | "git") {
            return None;
        }
        let rest = &url[i + 3..];
        let slash = rest.find('/')?;
        (rest[..slash].to_string(), rest[slash + 1..].to_string())
    } else {
        // scp-like: [user@]host:path, with no slash before the colon.
        let colon = url.find(':')?;
        if url[..colon].contains('/') {
            return None;
        }
        let host = url[..colon].rsplit('@').next()?.to_string();
        (host, url[colon + 1..].to_string())
    };
    let host = host.split(':').next()?.to_ascii_lowercase();
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| {
        !s.is_empty()
            && !s.starts_with(['.', '-'])
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    let host_ok = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'));
    (parts.next().is_none() && ok(owner) && ok(repo) && host_ok).then(|| (host, owner.to_string(), repo.to_string()))
}

/// The first pull request URL in gh's output.
pub fn pr_url_in(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|w| w.starts_with("https://") && w.contains("/pull/") && w.len() <= MAX_URL)
        .map(str::to_string)
}

/// `git ls-remote --symref <remote> HEAD`'s default branch.
pub fn symref_branch(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.strip_prefix("ref: refs/heads/"))
        .and_then(|rest| rest.split('\t').next())
        .map(str::to_string)
        .filter(|b| is_plain_name(b))
}

/// The remote a push goes to: `remote.pushDefault` when it names one, else
/// `origin`, else the only remote. The same for every branch of the repo, so
/// what a push sends can be worked out before [`target`] runs.
pub async fn push_remote(git: &Git, repo: &Path) -> Result<String, String> {
    let listed = git.run_with(repo, &["remote"], &[], super::git::GIT_TIMEOUT).await?;
    let remotes: Vec<&str> = listed.lines().map(str::trim).filter(|r| is_plain_name(r)).collect();
    let configured = git
        .run_with(
            repo,
            &["config", "--get", "remote.pushDefault"],
            &[],
            super::git::GIT_TIMEOUT,
        )
        .await
        .ok()
        .map(|s| s.trim().to_string());
    match configured.as_deref().filter(|r| remotes.contains(r)) {
        Some(r) => Ok(r.to_string()),
        None if remotes.contains(&"origin") => Ok("origin".to_string()),
        None => match remotes.as_slice() {
            [only] => Ok(only.to_string()),
            [] => Err("this repository has no remote to push to".into()),
            _ => Err("this repository has several remotes and none is origin; set remote.pushDefault to pick one".into()),
        },
    }
}

/// The remote the branch goes to, checked before the person is asked.
pub async fn target(git: &Git, repo: &Path, branch: &str) -> Result<Target, String> {
    if !is_job_branch(branch) {
        return Err(format!("{branch} isn't a branch Dial8 made for this job"));
    }
    git.run_with(
        repo,
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
        &[],
        super::git::GIT_TIMEOUT,
    )
    .await
    .map_err(|_| format!("the branch {branch} is gone from the repository"))?;
    let remote = push_remote(git, repo).await?;
    let url = git
        .run_with(
            repo,
            &["remote", "get-url", "--push", &remote],
            &[],
            super::git::GIT_TIMEOUT,
        )
        .await?
        .trim()
        .to_string();
    let named = repo_of(&url).map(|(host, owner, name)| format!("{host}/{owner}/{name}"));
    Ok(Target {
        remote,
        url,
        repo: named,
    })
}

/// A folder of gh's own, empty: no checkout's config can steer it.
fn gh_dir() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("dial8-gh-{}", uuid::Uuid::new_v4()));
    super::state::create_private_dir(&dir)?;
    Ok(dir)
}

/// ssh-agent's socket from the app's own environment (launchd sets it), so
/// an ssh remote works the way it does in the person's terminal.
fn ssh_agent_env() -> Vec<(&'static str, String)> {
    std::env::var("SSH_AUTH_SOCK")
        .ok()
        .filter(|s| s.starts_with('/') && !s.chars().any(char::is_control))
        .map(|s| vec![("SSH_AUTH_SOCK", s)])
        .unwrap_or_default()
}

/// Why a stopped push says so.
const STOPPED: &str = "local agents were turned off on this Mac";

/// Push, then open the pull request. Never panics, never retries.
pub async fn push_and_open(plan: PushPlan) -> PushOutcome {
    let PushPlan {
        ctx,
        repo,
        branch,
        commit,
        target,
        title,
        body,
        job_base,
        session_id,
        token,
        stop,
    } = plan;
    let mut out = PushOutcome {
        branch: branch.clone(),
        commit: commit.clone(),
        remote: target.remote.clone(),
        pushed: false,
        base: None,
        result: Err(String::new()),
        ran: Vec::new(),
    };
    if !is_commit_id(&commit) {
        out.result = Err(format!("{commit:?} isn't a commit id"));
        return out;
    }
    // Checked when the job started and stored by Rust; checked again before
    // it becomes an argument, and nothing goes out if it fails.
    if job_base.as_deref().is_some_and(|b| super::git::check_base_branch(b).is_err()) {
        out.result = Err("this job's base branch isn't a plain branch name; nothing was pushed".into());
        return out;
    }
    let ssh = ssh_agent_env();
    let env: Vec<(&str, &str)> = ssh.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let refspec = format!("{commit}:refs/heads/{branch}");
    let shown = format!("{}:refs/heads/{branch}", &commit[..7]);
    let push = stop
        .or_stop(ctx.git.run_with(
            &repo,
            &[
                "-c",
                "push.gpgSign=false",
                "push",
                "--porcelain",
                "--no-verify",
                "--no-follow-tags",
                "--recurse-submodules=no",
                "--",
                &target.remote,
                &refspec,
            ],
            &env,
            PUSH_TIMEOUT,
        ))
        .await;
    match push {
        None => {
            out.ran
                .push(format!("git push {} {shown}: stopped ({STOPPED})", target.remote));
            out.result = Err(format!("the push was stopped: {STOPPED}"));
            return out;
        }
        Some(Ok(_)) => {
            out.ran.push(format!("git push {} {shown}: ok", target.remote));
            out.pushed = true;
        }
        Some(Err(e)) => {
            let e = scrub_credentials(&e);
            out.ran.push(format!("git push {} {shown}: {e}", target.remote));
            out.result = Err(format!("the push failed: {e}"));
            return out;
        }
    }
    out.base = match job_base {
        Some(b) => Some(b),
        None => {
            let Some(base) = stop.or_stop(base_branch(&ctx.git, &repo, &target.remote, &env)).await else {
                out.result = Err(format!(
                    "the branch was pushed, but no pull request was opened: {STOPPED}"
                ));
                return out;
            };
            base
        }
    };
    let opened = stop
        .or_stop(open_pr(
            &ctx,
            &target,
            &branch,
            out.base.as_deref(),
            &title,
            &body,
            &session_id,
            token.as_deref(),
            &mut out.ran,
        ))
        .await;
    out.result = opened.unwrap_or_else(|| {
        Err(format!(
            "the branch was pushed, but no pull request was opened: {STOPPED}"
        ))
    });
    out
}

/// The pull request: gh when it is signed in for the push URL's host, else
/// the server.
#[allow(clippy::too_many_arguments)]
async fn open_pr(
    ctx: &PushCtx,
    target: &Target,
    branch: &str,
    base: Option<&str>,
    title: &str,
    body: &str,
    session_id: &str,
    token: Option<&str>,
    ran: &mut Vec<String>,
) -> Result<(String, Via), String> {
    if let (Some(gh), Some(full)) = (&ctx.gh, &target.repo) {
        let dir = gh_dir().map_err(|e| format!("can't make a folder for gh: {e}"))?;
        let host = full.split('/').next().unwrap_or_default();
        let opened = if gh_logged_in(gh, &ctx.git, &dir, host).await {
            let result = gh_pr_create(gh, &ctx.git, &dir, full, branch, base, title, body)
                .await
                .map(|url| (url, Via::Gh));
            let onto = base.map(|b| format!(" --base {b}")).unwrap_or_default();
            ran.push(match &result {
                Ok((url, _)) => format!("gh pr create --repo {full} --head {branch}{onto}: {url}"),
                Err(e) => format!("gh pr create --repo {full} --head {branch}{onto}: {e}"),
            });
            Some(result)
        } else {
            ran.push(format!("gh auth status --hostname {host}: not signed in"));
            None
        };
        let _ = std::fs::remove_dir_all(&dir);
        if let Some(result) = opened {
            return result;
        }
    }
    let remote_url = without_credentials(&target.url);
    let result = server_pr(
        &ctx.api_origin,
        session_id,
        token,
        &json!({
            "sessionId": session_id,
            "remoteUrl": remote_url,
            "branch": branch,
            "base": base,
            "title": title,
            "body": body,
        }),
    )
    .await
    .map(|url| (url, Via::Server));
    ran.push(match &result {
        Ok((url, _)) => format!("POST the pull request to Dial8 ({remote_url} {branch}): {url}"),
        Err(e) => format!("POST the pull request to Dial8 ({remote_url} {branch}): {e}"),
    });
    result
}

async fn base_branch(git: &Git, repo: &Path, remote: &str, env: &[(&str, &str)]) -> Option<String> {
    let head = format!("refs/remotes/{remote}/HEAD");
    if let Ok(short) = git
        .run_with(
            repo,
            &["symbolic-ref", "--quiet", "--short", &head],
            &[],
            super::git::GIT_TIMEOUT,
        )
        .await
    {
        let prefix = format!("{remote}/");
        if let Some(b) = short.trim().strip_prefix(&prefix).filter(|b| is_plain_name(b)) {
            return Some(b.to_string());
        }
    }
    git.run_with(repo, &["ls-remote", "--symref", remote, "HEAD"], env, NET_TIMEOUT)
        .await
        .ok()
        .and_then(|out| symref_branch(&out))
}

struct ToolOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// `gh <args>` in `dir` (an empty folder of its own), with a clean
/// environment and no prompts.
async fn gh(gh: &Path, git: &Git, dir: &Path, args: &[&str]) -> Result<ToolOutput, String> {
    let mut cmd = tokio::process::Command::new(gh);
    cmd.no_console();
    cmd.args(args)
        .current_dir(dir)
        .env_clear()
        .env("HOME", git.home())
        .env("PATH", git.tool_path())
        .env("LANG", "en_US.UTF-8")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match tokio::time::timeout(NET_TIMEOUT, cmd.output()).await {
        Err(_) => Err(format!("gh took over {NET_TIMEOUT:?}")),
        Ok(Err(e)) => Err(format!("gh couldn't run ({}): {e}", gh.display())),
        Ok(Ok(out)) => Ok(ToolOutput {
            ok: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
    }
}

async fn gh_logged_in(gh_path: &Path, git: &Git, dir: &Path, host: &str) -> bool {
    gh(gh_path, git, dir, &["auth", "status", "--hostname", host])
        .await
        .is_ok_and(|o| o.ok)
}

#[allow(clippy::too_many_arguments)]
async fn gh_pr_create(
    gh_path: &Path,
    git: &Git,
    dir: &Path,
    repo: &str,
    branch: &str,
    base: Option<&str>,
    title: &str,
    body: &str,
) -> Result<String, String> {
    // `--flag=value`, so a title or body starting with `-` stays a value.
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        format!("--repo={repo}"),
        format!("--head={branch}"),
        format!("--title={title}"),
        format!("--body={body}"),
    ];
    if let Some(base) = base {
        args.push(format!("--base={base}"));
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = gh(gh_path, git, dir, &args).await?;
    if out.ok {
        return pr_url_in(&out.stdout).ok_or_else(|| "gh opened no pull request".to_string());
    }
    // The branch has one already: that's the pull request.
    if out.stderr.contains("already exists") {
        if let Some(url) = pr_url_in(&out.stderr) {
            return Ok(url);
        }
    }
    let why = match out.stderr.trim() {
        "" => "no reason given".to_string(),
        why => truncate(why, 600),
    };
    Err(format!("gh pr create failed: {why}"))
}

/// The server fallback: it opens the pull request with the person's Dial8
/// GitHub sign-in and answers `{ url }`.
async fn server_pr(origin: &str, session_id: &str, token: Option<&str>, payload: &Value) -> Result<String, String> {
    let token = token.ok_or("gh isn't signed in, and this job has no Dial8 session to open the pull request with")?;
    if !super::is_safe_id(session_id) {
        return Err("this job's id isn't a Dial8 session".into());
    }
    let client = reqwest::Client::builder()
        .timeout(SERVER_TIMEOUT)
        .build()
        .map_err(|e| format!("can't reach Dial8: {e}"))?;
    let resp = client
        .post(pull_request_url(origin, session_id))
        .bearer_auth(token)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("can't reach Dial8: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let why = body
            .get("error")
            .and_then(Value::as_str)
            .map(|e| truncate(e, 600))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("Dial8 couldn't open the pull request: {why}"));
    }
    body.get("url")
        .and_then(Value::as_str)
        .filter(|u| u.starts_with("https://") && u.len() <= MAX_URL && !u.chars().any(char::is_whitespace))
        .map(str::to_string)
        .ok_or_else(|| "Dial8 answered without a pull request URL".to_string())
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn only_dial8_branches_are_pushed() {
        assert!(is_job_branch("dial8/site-1234abcd"));
        assert!(is_job_branch("dial8/my_app.v2-1234abcd"));
        for bad in [
            "main",
            "dial8/",
            "dial8/../main",
            "dial8/x y",
            "dial8/x:refs/heads/main",
            "dial8/x.lock",
            "-dial8/x",
            "dial8/x\n",
            "refs/heads/dial8/x",
        ] {
            assert!(!is_job_branch(bad), "{bad:?}");
        }
    }

    #[test]
    fn credentials_never_leave_the_remote_url() {
        assert_eq!(
            without_credentials("https://user:ghp_secret@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            without_credentials("https://tok@github.com/o/r"),
            "https://github.com/o/r"
        );
        assert_eq!(
            without_credentials("https://github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(without_credentials("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(
            without_credentials("ssh://git@github.com/o/r.git"),
            "ssh://github.com/o/r.git"
        );
        assert_eq!(without_credentials("/srv/repos/r.git"), "/srv/repos/r.git");
        // An @ in the path is not a password.
        assert_eq!(without_credentials("https://host/o/r@v2"), "https://host/o/r@v2");
        assert_eq!(
            scrub_credentials(
                "fatal: unable to access 'https://u:ghp_x@github.com/o/r.git/': 403; see https://a:b@x.io"
            ),
            "fatal: unable to access 'https://github.com/o/r.git/': 403; see https://x.io"
        );
        assert_eq!(
            scrub_credentials("rejected (non-fast-forward)"),
            "rejected (non-fast-forward)"
        );
        assert_eq!(
            scrub_credentials("to git@github.com:o/r.git"),
            "to git@github.com:o/r.git"
        );
    }

    #[test]
    fn hosted_remotes_name_their_repo_and_local_ones_dont() {
        let gh = |h: &str, o: &str, r: &str| Some((h.to_string(), o.to_string(), r.to_string()));
        assert_eq!(
            repo_of("https://github.com/liamadsr/dial8-website.git"),
            gh("github.com", "liamadsr", "dial8-website")
        );
        assert_eq!(repo_of("https://x:y@GitHub.com/o/r/"), gh("github.com", "o", "r"));
        assert_eq!(repo_of("git@github.com:o/r.git"), gh("github.com", "o", "r"));
        assert_eq!(repo_of("ssh://git@github.com:22/o/r.git"), gh("github.com", "o", "r"));
        assert_eq!(
            repo_of("https://ghe.corp.example/team/app"),
            gh("ghe.corp.example", "team", "app")
        );
        for local in [
            "/srv/repos/r.git",
            "../remote.git",
            "file:///srv/r.git",
            "C:/x",
            "https://github.com/o",
            "https://github.com/o/r/extra",
            "https://github.com/-o/r",
        ] {
            assert_eq!(repo_of(local), None, "{local}");
        }
    }

    #[test]
    fn urls_and_default_branches_are_read_from_output() {
        assert_eq!(
            pr_url_in("Creating pull request for dial8/x into main\n\nhttps://github.com/o/r/pull/12\n"),
            Some("https://github.com/o/r/pull/12".into())
        );
        assert_eq!(
            pr_url_in("a pull request for branch \"dial8/x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/9"),
            Some("https://github.com/o/r/pull/9".into())
        );
        assert_eq!(pr_url_in("https://github.com/o/r"), None);
        assert_eq!(
            symref_branch("ref: refs/heads/main\tHEAD\n224728b\tHEAD\n"),
            Some("main".into())
        );
        assert_eq!(symref_branch("224728b\tHEAD\n"), None);
        assert_eq!(
            pull_request_url("https://dial8.ai/", "38cb0eef-89e9-496d-bf08-0688225dbfcd"),
            "https://dial8.ai/api/local-agent/sessions/38cb0eef-89e9-496d-bf08-0688225dbfcd/pull-request"
        );
    }

    #[test]
    fn outcomes_become_pull_request_events() {
        let mut o = PushOutcome {
            branch: "dial8/x-1".into(),
            commit: "c".repeat(40),
            remote: "origin".into(),
            pushed: true,
            base: Some("main".into()),
            result: Ok(("https://github.com/o/r/pull/1".into(), Via::Gh)),
            ran: vec![],
        };
        assert_eq!(
            o.event(),
            json!({"kind":"pull_request","ok":true,"branch":"dial8/x-1","commit":"c".repeat(40),"remote":"origin",
                   "base":"main","url":"https://github.com/o/r/pull/1","via":"gh"})
        );
        o.result = Err("the push failed: rejected".into());
        o.pushed = false;
        assert_eq!(
            o.event(),
            json!({"kind":"pull_request","ok":false,"branch":"dial8/x-1","commit":"c".repeat(40),"remote":"origin",
                   "pushed":false,"error":"the push failed: rejected"})
        );
    }

    fn raw(records: &[(&str, &str, &str)]) -> String {
        let sha = "a".repeat(40);
        records
            .iter()
            .map(|(mode, status, path)| format!(":100644 {mode} {sha} {sha} {status}\0{path}\0"))
            .collect()
    }

    #[test]
    fn raw_records_become_the_changed_files() {
        let out = raw(&[
            ("100644", "M", "README.md"),
            ("100644", "A", "new dir/added.txt"),
            ("000000", "D", "gone.rs"),
            ("120000", "T", "link"),
        ]);
        assert_eq!(
            parse_raw_z(&out, 10),
            Changed {
                files: vec![
                    ("README.md".into(), Change::Modified),
                    ("new dir/added.txt".into(), Change::Added),
                    ("gone.rs".into(), Change::Deleted),
                    ("link".into(), Change::Modified),
                ],
                total: 4,
            }
        );
        let few = parse_raw_z(&out, 2);
        assert_eq!((few.files.len(), few.total), (2, 4), "only the first are kept, all are counted");
        assert_eq!(parse_raw_z("", 10), Changed::default());
        assert_eq!(parse_raw_z(":100644 100644 a a M\0", 10), Changed::default(), "half a record");
        assert_eq!(parse_raw_z("garbage\0x\0", 10), Changed::default());
    }

    #[test]
    fn risky_paths_come_first_and_the_rest_keep_gits_order() {
        let mut records: Vec<(&str, &str, &str)> = (0..12).map(|_| ("100644", "M", "")).collect();
        let names: Vec<String> = (0..12).map(|i| format!("src/f{i:02}.rs")).collect();
        for (r, n) in records.iter_mut().zip(&names) {
            r.2 = n.as_str();
        }
        records.extend([
            ("100644", "A", ".github/workflows/ci.yml"),
            ("100644", "M", "web/package.json"),
            ("100755", "A", "tools/build"),
            ("100644", "A", ".husky/pre-push"),
            ("100644", "M", ".VSCode/settings.json"),
        ]);
        let changed = parse_raw_z(&raw(&records), SHOWN_FILES);
        assert_eq!(changed.total, 17);
        let shown: Vec<&str> = changed.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            shown,
            vec![
                ".github/workflows/ci.yml",
                "web/package.json",
                "tools/build",
                ".husky/pre-push",
                ".VSCode/settings.json",
                "src/f00.rs",
                "src/f01.rs",
                "src/f02.rs",
                "src/f03.rs",
                "src/f04.rs",
            ],
            "never buried under ordinary files"
        );
        for risky in [
            ".gitlab-ci.yml",
            "ci/.gitlab-ci-deploy.yml",
            "scripts/hooks/pre-commit",
            ".githooks/post-merge",
            "Cargo.lock",
            "pnpm-lock.yaml",
            "yarn.lock",
            ".npmrc",
            ".yarnrc.yml",
            ".envrc",
            ".claude/settings.json",
            ".mcp.json",
            "Makefile",
            "install.sh",
        ] {
            assert!(is_risky(risky, false), "{risky}");
        }
        for plain in ["src/main.rs", "README.md", "docs/hooks.md", "packages.json.md", "shell.txt"] {
            assert!(!is_risky(plain, false), "{plain}");
        }
        assert!(is_risky("bin/tool", true), "anything executable");
    }

    #[test]
    fn build_scripts_containers_git_settings_and_agent_folders_are_risky() {
        for risky in [
            ".yarn/releases/yarn-4.cjs",
            ".yarn/plugins/x.cjs",
            ".pnpmfile.cjs",
            ".pre-commit-config.yaml",
            "lefthook.yml",
            "lefthook.yaml",
            ".lefthook.yml",
            "lefthook-local.yml",
            ".cargo/config.toml",
            "crates/x/build.rs",
            ".devcontainer/devcontainer.json",
            "Dockerfile",
            "docker/Dockerfile.dev",
            "web.dockerfile",
            ".codex/config.toml",
            ".cursor/rules/x.mdc",
            ".gemini/settings.json",
            ".gitattributes",
            "sub/.gitattributes",
            ".gitmodules",
            "pyproject.toml",
            "setup.py",
        ] {
            assert!(is_risky(risky, false), "{risky}");
        }
        for plain in ["src/builder.rs", "docs/dockerfile-notes.md", "lefthook.md", "setup.cfg.md", "yarn/notes.txt"] {
            assert!(!is_risky(plain, false), "{plain}");
        }
    }

    /// `git log --raw -z` over several commits: a path counts once, as its
    /// newest change says, risky if any commit made it so.
    #[test]
    fn several_commits_records_count_each_path_once() {
        let sha = "abcdef0";
        let out = format!(
            ":100644 000000 {sha} 0000000 D\0b.txt\0:000000 100755 0000000 {sha} A\0tools/run\0\n\
             :000000 100644 0000000 {sha} A\0b.txt\0:100755 100644 {sha} {sha} M\0tools/run\0\0"
        );
        let changed = parse_raw_z(&out, 10);
        assert_eq!(changed.total, 2);
        assert_eq!(
            changed.files,
            vec![("tools/run".to_string(), Change::Added), ("b.txt".to_string(), Change::Deleted)],
            "tools/run was made executable in one of them: listed first"
        );
    }

    /// `/usr/bin/git` without the person's config, for a repo in a temp dir.
    fn plain_git(home: &Path) -> Git {
        Git::from_launch(&super::super::config::LaunchConfig {
            node: "/n".into(),
            launcher: "/l".into(),
            agent_dir: "/a".into(),
            env_file: None,
            tool_path: "/usr/bin:/bin".into(),
            home: home.display().to_string(),
            model_base_url: "https://dial8.ai/api/local-agent/model".into(),
            git: "/usr/bin/git".into(),
            git_env: vec![
                ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ],
            gh: None,
            api_origin: "https://dial8.ai".into(),
        })
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A job whose start isn't known lists what every commit the push sends
    /// changes, not only its last commit's (`--root <commit>` did that).
    #[tokio::test]
    async fn an_unknown_start_lists_every_commit_the_push_sends() {
        let tmp = tempfile::tempdir().unwrap();
        let (remote, work) = (tmp.path().join("remote.git"), tmp.path().join("work"));
        std::fs::create_dir_all(&work).unwrap();
        sh(tmp.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
        sh(&work, &["init", "-q", "-b", "main"]);
        std::fs::write(work.join("README.md"), "hi").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["commit", "-qm", "one"]);
        sh(&work, &["remote", "add", "origin", remote.to_str().unwrap()]);
        sh(&work, &["push", "-q", "origin", "main"]);
        let on_remote = sh(&work, &["rev-parse", "HEAD"]);

        // Two commits the remote lacks: CI first, then an ordinary change.
        sh(&work, &["checkout", "-qb", "dial8/x-1"]);
        std::fs::create_dir_all(work.join(".github/workflows")).unwrap();
        std::fs::write(work.join(".github/workflows/ci.yml"), "on: push").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["commit", "-qm", "two"]);
        std::fs::write(work.join("notes.txt"), "n").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["commit", "-qm", "three"]);
        let head = sh(&work, &["rev-parse", "HEAD"]);

        let git = plain_git(tmp.path());
        let listed = changed_files(&git, &work, &head, None).await.unwrap();
        let paths: Vec<&str> = listed.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, [".github/workflows/ci.yml", "notes.txt"], "both commits, risky first");
        assert_eq!(listed.total, 2);
        assert_eq!(what_it_sends(&git, &work, "origin", &head, None).await.unwrap().job, 2);

        // A known start: from it, as before.
        let from_start = changed_files(&git, &work, &head, Some(&on_remote)).await.unwrap();
        assert_eq!(from_start, listed);

        // Everything already on the remote: nothing is sent, nothing listed.
        sh(&work, &["push", "-q", "origin", "dial8/x-1"]);
        assert_eq!(changed_files(&git, &work, &head, None).await.unwrap(), Changed::default());
    }

    #[test]
    fn only_full_commit_ids_are_pushed() {
        assert!(is_commit_id(&"a1".repeat(20)));
        assert!(is_commit_id(&"0f".repeat(32)));
        for bad in ["", "abc1234", &"A".repeat(40), &"g".repeat(40), &"a".repeat(41), "HEAD"] {
            assert!(!is_commit_id(bad), "{bad}");
        }
    }

    #[test]
    fn debug_output_never_carries_the_token_or_a_credentialed_url() {
        let plan = PushPlan {
            ctx: PushCtx {
                git: Git::from_launch(&super::super::config::LaunchConfig {
                    node: "/n".into(),
                    launcher: "/l".into(),
                    agent_dir: "/a".into(),
                    env_file: None,
                    tool_path: "/usr/bin:/bin".into(),
                    home: "/Users/x".into(),
                    model_base_url: "https://dial8.ai/api/local-agent/model".into(),
                    git: "/usr/bin/git".into(),
                    git_env: Vec::new(),
                    gh: None,
                    api_origin: "https://dial8.ai".into(),
                }),
                gh: None,
                api_origin: "https://dial8.ai".into(),
            },
            repo: "/r".into(),
            branch: "dial8/x-1".into(),
            commit: "c".repeat(40),
            target: Target {
                remote: "origin".into(),
                url: "https://user:ghp_s3cret@github.com/o/r.git".into(),
                repo: Some("github.com/o/r".into()),
            },
            title: "t".into(),
            body: "b".into(),
            job_base: None,
            session_id: "s".into(),
            token: Some("la1.tok-s3cret".into()),
            stop: Stop::default(),
        };
        let shown = format!("{plan:?}");
        assert!(!shown.contains("s3cret"), "{shown}");
        assert!(
            shown.contains("<redacted>") && shown.contains("https://github.com/o/r.git"),
            "{shown}"
        );
    }

    #[tokio::test]
    async fn a_base_branch_that_fails_its_check_again_pushes_nothing() {
        let plan = PushPlan {
            ctx: PushCtx {
                // A git that doesn't exist: any git call would fail loudly.
                git: Git::from_launch(&super::super::config::LaunchConfig {
                    node: "/n".into(),
                    launcher: "/l".into(),
                    agent_dir: "/a".into(),
                    env_file: None,
                    tool_path: "/usr/bin:/bin".into(),
                    home: "/Users/x".into(),
                    model_base_url: "https://dial8.ai/api/local-agent/model".into(),
                    git: "/nonexistent/git".into(),
                    git_env: Vec::new(),
                    gh: None,
                    api_origin: "https://dial8.ai".into(),
                }),
                gh: None,
                api_origin: "https://dial8.ai".into(),
            },
            repo: "/r".into(),
            branch: "dial8/x-1".into(),
            commit: "c".repeat(40),
            target: Target {
                remote: "origin".into(),
                url: "https://github.com/o/r.git".into(),
                repo: Some("github.com/o/r".into()),
            },
            title: "t".into(),
            body: "b".into(),
            job_base: Some("--upload-pack=x".into()),
            session_id: "s".into(),
            token: None,
            stop: Stop::default(),
        };
        let out = push_and_open(plan).await;
        assert_eq!(
            out.result,
            Err("this job's base branch isn't a plain branch name; nothing was pushed".to_string())
        );
        assert!(!out.pushed && out.ran.is_empty() && out.base.is_none(), "{out:?}");
    }

    #[tokio::test]
    async fn a_stop_ends_the_running_step() {
        let stop = Stop::default();
        assert_eq!(stop.or_stop(async { 7 }).await, Some(7));
        let later = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            later.stop();
        });
        let slow = stop.or_stop(tokio::time::sleep(Duration::from_secs(30))).await;
        assert_eq!(slow, None);
        assert!(stop.is_stopped());
        assert_eq!(stop.or_stop(async { 7 }).await, None, "stays stopped");
    }
}
