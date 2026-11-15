//! Edit jobs' git (l1-contract C5): the worktree a job edits in, and the
//! commit when it finishes. Rust runs all of it, as the person, outside the
//! sandbox; the local agent itself can't commit (its fence denies writes to
//! the worktree's `.git` file and makes the repo's `.git` folder read-only).
//!
//! - **The worktree**: `git -C <repo> worktree add -b dial8/<slug>-<jobShort>
//!   ~/.dial8/worktrees/<jobId> <sha>`, where the sha is HEAD's, or the tip
//!   of the local branch the start named as its base (`baseBranch`,
//!   [`Git::resolve_base`]). A separate checkout on a new branch: the
//!   person's own checkout, its files and its branch are never touched. Kept
//!   after the job ends.
//! - **The base branch** is a name the server sent, so it is hostile until
//!   checked (environments plan §5): the web's own pattern
//!   ([`check_base_branch`]), then `git check-ref-format --branch`, then a
//!   lookup of exactly `refs/heads/<name>`, a local branch of its own (not a
//!   symbolic ref, byte for byte, pointing at a commit). Never a tag, a
//!   remote-tracking branch, `@{-1}`, `HEAD~n`, a sha typed as the name, a
//!   case variant APFS would match, or anything git could read as an
//!   option. Only the sha it resolves to reaches `git worktree add`, and only
//!   when a new branch is made: a job whose `dial8/…` branch exists checks
//!   that out again, and a job whose worktree and branch are both gone is
//!   rebuilt from the commit it started from ([`Base::Commit`]).
//! - **The commit**, after the turn in which the agent called `finish`:
//!   `git add -A` and `git commit --allow-empty -m <the summary's first line>`
//!   in the worktree, on its branch. eve's own files (`.eve/`, at any
//!   depth: staged tool-result media, for one) are never committed
//!   ([`NOT_COMMITTED`]); they stay in the worktree. Pushed only when the
//!   person says yes to the native push prompt ([`super::push`]).
//!
//! Every git call runs with a clean environment (HOME, the toolchain PATH,
//! no prompts) and with config that keeps the repo's own code out of it:
//! `core.hooksPath=/dev/null` (no hooks: the commit holds changes a model
//! made), no fsmonitor daemon, and no commit signing (an automatic local
//! commit must not block on a signing prompt; the person can re-sign it).
//! Before committing, the worktree's link to the repo is re-read from the
//! file system ([`check_worktree`]), so a worktree that no longer points at
//! the repo it was made from is never committed in.
//!
//! **No repository of the agent's making** (security review 2026-10-31,
//! P1-2). The agent can write a `sub/.git` of its own in its worktree, whose
//! config (a filter driver, say) a git run by Rust would run as the person,
//! outside the sandbox, the moment it looked inside `sub`. So:
//! - the commit is refused, before git sees the changes, when a `.git` of
//!   any case, kind or depth is there below the worktree's own
//!   ([`nested_gits`]), unless git ignores its folder (a tool's checkout in
//!   SwiftPM's `.build` or `.terraform`: never staged, never looked inside;
//!   [`Git::unignored_nested`]);
//! - status and diff never look inside a submodule
//!   (`--ignore-submodules=all`, and `diff.ignoreSubmodules=all`:
//!   [`NO_SUBMODULES`]);
//! - `git add` looks inside every submodule the index has whatever the
//!   config says, so it skips them all (`:(exclude,literal)<path>`: the
//!   repo's own submodules, never checked out in a worktree), and a
//!   submodule it staged anyway (a repository that appeared after the check)
//!   is unstaged and the commit refused ([`new_gitlinks`]).
//!
//! `SAFE_CONFIG` stays as it is: the `-c` config reaches a nested git through
//! `GIT_CONFIG_PARAMETERS`, but a filter the nested repo defines is no name
//! it can turn off.

use crate::sidecar::NoConsole;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use super::config::LaunchConfig;
use super::folder;
use super::protocol::truncate;

/// Any one git call, at most (a checkout of a big repo takes seconds).
pub const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// The commit subject's length, at most, in characters.
const SUBJECT_MAX: usize = 72;
pub(super) const DEFAULT_SUBJECT: &str = "Changes from Native Intelligence's local agent";
/// Used only when the person has no git identity configured.
const FALLBACK_NAME: &str = "Native Intelligence local agent";
const FALLBACK_EMAIL: &str = "local-agent@dial8.ai";
/// A base branch's name, at most, in characters (the web's limit).
pub const MAX_BASE_BRANCH: usize = 100;
/// Why a base branch name is refused before git looks it up
/// ([`check_base_branch`], `git check-ref-format`). It doesn't repeat the
/// name, which the server sent and which failed the check; once a name
/// passes, a refusal names it ([`Git::resolve_base`]).
pub const BAD_BASE_BRANCH: &str = "The base branch must be the plain name of a local branch: up to 100 \
                                   letters, digits, dots, dashes, underscores and slashes";

/// What Rust will commit for an agent, at most. A prompt-injected agent can
/// write files of any size in its worktree; past these the commit is skipped
/// (the changes stay in the worktree) rather than fed to `git add`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Budget {
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_files: usize,
}

pub const COMMIT_BUDGET: Budget = Budget {
    max_file_bytes: 50 * 1024 * 1024,
    max_total_bytes: 200 * 1024 * 1024,
    max_files: 20_000,
};

/// Why the changed files (path, bytes on disk; 0 for a deletion) are over
/// the budget, if they are.
pub fn over_budget(changed: &[(String, u64)], budget: &Budget) -> Option<String> {
    if changed.len() > budget.max_files {
        return Some(format!(
            "{} changed files (the limit is {})",
            changed.len(),
            budget.max_files
        ));
    }
    if let Some((path, size)) = changed.iter().find(|(_, size)| *size > budget.max_file_bytes) {
        return Some(format!(
            "{path} is {} MB (the limit is {} MB a file)",
            size / (1024 * 1024),
            budget.max_file_bytes / (1024 * 1024)
        ));
    }
    let total: u64 = changed.iter().map(|(_, size)| *size).sum();
    if total > budget.max_total_bytes {
        return Some(format!(
            "the changes total {} MB (the limit is {} MB)",
            total / (1024 * 1024),
            budget.max_total_bytes / (1024 * 1024)
        ));
    }
    None
}

/// `git status --porcelain=v1 -z --no-renames` records → their paths.
pub fn parse_status_z(out: &str) -> Vec<String> {
    out.split('\0')
        .filter(|r| r.len() > 3)
        .map(|r| r[3..].to_string())
        .collect()
}

/// The pathspec of what a commit takes: everything but eve's own `.eve/`
/// folders, at the top or anywhere below.
pub const NOT_COMMITTED: &[&str] = &["--", ".", ":(exclude).eve", ":(exclude,glob)**/.eve/**"];

/// Config on every call, ahead of the subcommand.
const SAFE_CONFIG: &[&str] = &[
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    // No automatic gc or maintenance after a commit: several jobs work in
    // one repository at once, each in its own worktree, and a repack or a
    // `pack-refs` started by one job's commit would take locks (packed-refs,
    // the object store) another job's git needs at that moment.
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
];

/// `git worktree add` tries, when the repository's lock files are taken
/// (another job's git in the same repository at that moment).
const WORKTREE_ADD_TRIES: u32 = 4;

/// A git failure that another git process in the same repository caused
/// (a `.lock` file it held): worth trying again shortly.
fn is_lock_contention(err: &str) -> bool {
    err.contains(".lock") || err.contains("could not lock") || err.contains("cannot lock")
        // Another git's worktree half made: `worktree add` reads every
        // worktree's entry, and one being written has no `commondir` yet.
        || (err.contains("failed to read") && err.contains("/worktrees/"))
}

/// One worktree made at a time per repository, in this app (by its git
/// folder): two jobs started at the same moment in one repository never run
/// `worktree prune` / `worktree add` side by side (an `add` reads every
/// other worktree's entry, and fails on one another `add` is still
/// writing), and the second sees the first's branch whole.
fn repo_lock(git_dir: &Path) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};
    static LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let key = std::fs::canonicalize(git_dir).unwrap_or_else(|_| git_dir.to_path_buf());
    let mut locks = LOCKS.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner());
    locks.retain(|_, l| l.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

/// Ahead of a status or a diff in the worktree, with
/// [`IGNORE_SUBMODULES`] after it: never a look inside a submodule.
pub const NO_SUBMODULES: &[&str] = &["-c", "diff.ignoreSubmodules=all"];
pub const IGNORE_SUBMODULES: &str = "--ignore-submodules=all";

/// Repositories inside a worktree checked, at most; past that the commit is
/// refused.
pub const MAX_NESTED: usize = 256;

/// Every `.git` below `worktree` other than its own link file at the top,
/// relative to it, up to `max + 1` of them: repositories of the agent's
/// making, or a tool's in a folder git ignores (SwiftPM's `.build`,
/// `.terraform`), [`Git::unignored_nested`] tells which. Any case (APFS
/// opens `.GIT` as `.git`), a file, folder or symlink, at any depth;
/// symlinks are never followed. A folder that can't be read fails the check.
pub fn nested_gits(worktree: &Path, max: usize) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    let mut dirs = vec![worktree.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
            let name = entry.file_name();
            if name.as_encoded_bytes().eq_ignore_ascii_case(b".git") {
                if dir == worktree && name == ".git" {
                    continue;
                }
                let path = entry.path();
                found.push(path.strip_prefix(worktree).map_or(path.clone(), Path::to_path_buf));
                if found.len() > max {
                    return Ok(found);
                }
                continue;
            }
            let kind = entry
                .file_type()
                .map_err(|e| format!("{}: {e}", entry.path().display()))?;
            if kind.is_dir() {
                dirs.push(entry.path());
            }
        }
    }
    Ok(found)
}

/// The configs the person's own tools run commands from with no further
/// prompt, as the Node fence names them (`AUTO_RUN_CONFIGS`, `AUTO_RUN_FILES`
/// and `AUTO_RUN_IN_FOLDER` in web/agents/local-agent/lib/seatbelt.ts, whose
/// kernel rules keep a worker from writing them). Kept in step by
/// `auto_run_configs_match_the_node_fence` below, which reads that file.
/// Single files by name, at any depth:
const AUTO_RUN_FILES: &[&str] = &[
    ".mcp.json",
    ".pre-commit-config.yaml",
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".npmrc",
    ".pnpmfile.cjs",
    ".yarnrc.yml",
    ".yarnrc",
];
/// One file in a folder, the folder pinned too:
const AUTO_RUN_IN_FOLDER: &[(&str, &str)] = &[(".codex", "config.toml"), (".cursor", "mcp.json"), (".gemini", "settings.json")];

/// `s` case-folded the way APFS matches names, near enough: upper, then
/// lower, so `ſ` (long s) becomes `s` and the Kelvin sign `k`, which a plain
/// lowercase leaves (`ſ`) or gets (`K`) only in part. Over-folding refuses
/// more, never less.
fn fold(s: &str) -> String {
    s.chars().flat_map(char::to_uppercase).flat_map(char::to_lowercase).collect()
}

/// `rel` (a path in the worktree), in any letter case, is one of the
/// auto-run configs at any depth: the Node fence's `isAutoRunConfig`, rule
/// for rule (`.claude` itself, its settings and its hooks; `.vscode` itself,
/// its tasks and MCP config; all of `.husky`; `.yarn` itself, its releases
/// and plugins; [`AUTO_RUN_IN_FOLDER`]; [`AUTO_RUN_FILES`]).
pub fn is_auto_run_config(rel: &str) -> bool {
    let lower = fold(rel);
    let c: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();
    c.iter().enumerate().any(|(i, name)| {
        let rest = &c[i + 1..];
        match *name {
            ".claude" => {
                rest.is_empty()
                    || rest[0] == "hooks"
                    || (rest.len() == 1 && (rest[0] == "settings.json" || rest[0] == "settings.local.json"))
            }
            ".vscode" => rest.is_empty() || (rest.len() == 1 && (rest[0] == "tasks.json" || rest[0] == "mcp.json")),
            ".husky" => true,
            ".yarn" => rest.is_empty() || rest[0] == "releases" || rest[0] == "plugins",
            name => match AUTO_RUN_IN_FOLDER.iter().find(|(dir, _)| *dir == name) {
                Some((_, file)) => rest.is_empty() || (rest.len() == 1 && rest[0] == *file),
                None => rest.is_empty() && AUTO_RUN_FILES.contains(&name),
            },
        }
    })
}

/// A path a worker job's commit refuses: the same three name rules the
/// fence holds a worker's edits to (`NAMES_AT_ANY_DEPTH` in seatbelt.ts),
/// checked again when Rust commits, in case the kernel's were got around:
/// anything in a `.git` (any case, at any depth), anything in an `.app`
/// bundle, and the auto-run configs ([`is_auto_run_config`]).
pub fn worker_commit_refuses(rel: &str) -> bool {
    let lower = fold(rel);
    lower
        .split('/')
        .any(|part| part == ".git" || part.ends_with(".app"))
        || is_auto_run_config(rel)
}

/// `git diff-index --cached --raw -z` records → the paths the commit would
/// add or change (everything but a deletion).
pub fn staged_written(out: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut fields = out.split('\0');
    while let (Some(meta), Some(path)) = (fields.next(), fields.next()) {
        let Some(meta) = meta.strip_prefix(':') else { continue };
        let status = meta.rsplit(' ').next().unwrap_or_default();
        if !status.starts_with('D') && !path.is_empty() {
            found.push(path.to_string());
        }
    }
    found
}

/// Paths named in a sentence for the person: the first few, and how many more.
fn some_paths(paths: &[String]) -> String {
    const SHOWN: usize = 5;
    let mut out = paths.iter().take(SHOWN).cloned().collect::<Vec<_>>().join(", ");
    if paths.len() > SHOWN {
        out.push_str(&format!(" and {} more", paths.len() - SHOWN));
    }
    out
}

/// `git ls-files --stage -z` records → the submodules' paths (mode 160000).
pub fn parse_gitlinks_z(out: &str) -> Vec<String> {
    out.split('\0')
        .filter_map(|r| r.split_once('\t'))
        .filter(|(meta, _)| meta.starts_with("160000 "))
        .map(|(_, path)| path.to_string())
        .collect()
}

/// `git diff-index --cached --raw -z` records (`:<old> <new> <sha> <sha>
/// <status>\0<path>\0`) → the paths the index makes a submodule (new mode
/// 160000): added, or moved to another commit.
pub fn new_gitlinks(out: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut fields = out.split('\0');
    while let (Some(meta), Some(path)) = (fields.next(), fields.next()) {
        let mode = meta.strip_prefix(':').and_then(|m| m.split(' ').nth(1));
        if mode == Some("160000") && !path.is_empty() {
            found.push(path.to_string());
        }
    }
    found
}

#[derive(Debug, Clone)]
pub struct Git {
    program: PathBuf,
    home: String,
    path: String,
    extra_env: Vec<(String, String)>,
}

/// A job's changes, for the page (`local_agent_diff`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDiff {
    /// The commit the job started from.
    pub base: String,
    /// Its worktree's HEAD now (the diff also holds what isn't committed).
    pub head: String,
    /// A limit was reached: files left out, or a patch left empty.
    pub truncated: bool,
    pub files: Vec<DiffFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// `added`, `modified`, `deleted` or `renamed`.
    pub status: &'static str,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    /// A unified diff of the file; empty for a binary or secret file, or
    /// past a limit.
    pub patch: String,
}

/// Files a diff lists, at most.
pub const DIFF_MAX_FILES: usize = 300;
/// One file's patch, at most (bytes); past it the patch is left empty.
pub const DIFF_MAX_FILE_PATCH: usize = 200 * 1024;
/// All patches together, at most (bytes).
pub const DIFF_MAX_TOTAL: usize = 2 * 1024 * 1024;
/// One file list git gives a diff (changed, counted, untracked), at most
/// (bytes): past it, the files after are left out.
pub const DIFF_MAX_LIST: usize = 4 * 1024 * 1024;
/// A whole diff's time: past it, the answer is what was read so far.
pub const DIFF_DEADLINE: Duration = Duration::from_secs(20);

/// What [`Git::run_capped`] read.
#[derive(Debug)]
pub struct Capped {
    /// Git's output, at most the limit asked for.
    pub out: String,
    /// There was more: git was killed past the limit.
    pub cut: bool,
    /// The deadline came first: git was killed.
    pub timed_out: bool,
    /// Bytes taken from git's pipe (a little past the limit at most).
    pub bytes_read: usize,
}

impl Capped {
    /// Whole records of a `-z` list: a partial last one, when cut, dropped.
    fn records(&self) -> &str {
        if self.cut || self.timed_out {
            self.out.rfind('\0').map_or("", |i| &self.out[..=i])
        } else {
            &self.out
        }
    }
}

/// Ahead of every diff call, on top of [`SAFE_CONFIG`]: no external diff
/// program, no network transport of any kind (a submodule's `ext::` URL
/// included), plain paths and no colour.
const DIFF_CONFIG: &[&str] = &[
    "-c",
    "diff.external=",
    "-c",
    "protocol.allow=never",
    "-c",
    "core.quotePath=false",
    "-c",
    "color.ui=false",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.relative=false",
];

/// A file name the fence refuses to read in a job's folder (the Node
/// fence's `isSecretFileName` in web/agents/local-agent/lib/seatbelt.ts,
/// rule for rule): such a file is listed by name only, never its contents.
pub fn is_secret_file_name(name: &str) -> bool {
    const NAMES: &[&str] = &[
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        "id_ecdsa_sk",
        "id_ed25519_sk",
        ".envrc",
        ".dev.vars",
        "credentials.json",
        "local.settings.json",
    ];
    const EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "tfvars", "tfvars.json", "tfstate", "tfstate.backup"];
    const PLACEHOLDERS: &[&str] = &["example", "sample", "template"];
    let n = name.to_lowercase();
    if n == ".env" || n.starts_with(".env.") {
        return !PLACEHOLDERS.iter().any(|p| n.ends_with(&format!(".{p}")));
    }
    if n.starts_with("service-account") && n.ends_with(".json") {
        return true;
    }
    NAMES.contains(&n.as_str()) || EXTENSIONS.iter().any(|e| n.ends_with(&format!(".{e}")))
}

/// `git diff --name-status -z` records → (status, path, old path).
fn parse_name_status_z(out: &str) -> Vec<(&'static str, String, Option<String>)> {
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    let mut found = Vec::new();
    while let Some(code) = fields.next() {
        let status = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('R') => "renamed",
            _ => "modified",
        };
        if status == "renamed" {
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else { break };
            found.push((status, new.to_string(), Some(old.to_string())));
        } else {
            let Some(path) = fields.next() else { break };
            found.push((status, path.to_string(), None));
        }
    }
    found
}

/// `git diff --numstat -z` records → path → (additions, deletions, binary).
/// A rename's record is `<a>\t<d>\t\0<old>\0<new>\0`.
fn parse_numstat_z(out: &str) -> std::collections::HashMap<String, (u64, u64, bool)> {
    let mut map = std::collections::HashMap::new();
    let mut fields = out.split('\0');
    while let Some(rec) = fields.next() {
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let binary = a == "-" && d == "-";
        let counts = (a.parse().unwrap_or(0), d.parse().unwrap_or(0), binary);
        if path.is_empty() {
            let _old = fields.next();
            if let Some(new) = fields.next() {
                map.insert(new.to_string(), counts);
            }
        } else {
            map.insert(path.to_string(), counts);
        }
    }
    map
}

/// A new, untracked file as a unified diff, read without following a link
/// (a link's patch is its target, as git shows one). `None`: binary.
fn untracked_patch(worktree: &Path, rel: &str) -> Result<Option<(String, u64)>, String> {
    let path = worktree.join(rel);
    let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("{rel}: {e}"))?;
    let bytes = if meta.file_type().is_symlink() {
        std::fs::read_link(&path)
            .map_err(|e| format!("{rel}: {e}"))?
            .to_string_lossy()
            .into_owned()
            .into_bytes()
    } else if meta.is_file() {
        // Never through a link in the path itself: the file must be where
        // the worktree says.
        let real = std::fs::canonicalize(&path).map_err(|e| format!("{rel}: {e}"))?;
        let root = std::fs::canonicalize(worktree).map_err(|e| format!("{e}"))?;
        if !real.starts_with(&root) || real != root.join(rel) {
            return Err(format!("{rel} is reached through a link"));
        }
        let mut f = std::fs::File::open(&real).map_err(|e| format!("{rel}: {e}"))?;
        let mut buf = Vec::new();
        use std::io::Read;
        (&mut f)
            .take((DIFF_MAX_FILE_PATCH + 1) as u64)
            .read_to_end(&mut buf)
            .map_err(|e| format!("{rel}: {e}"))?;
        buf
    } else {
        return Ok(None);
    };
    if bytes.iter().take(8000).any(|b| *b == 0) || std::str::from_utf8(&bytes).is_err() {
        return Ok(None);
    }
    let text = String::from_utf8(bytes).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let mut patch = format!("diff --git a/{rel} b/{rel}\nnew file\n--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n", lines.len());
    for l in &lines {
        patch.push('+');
        patch.push_str(l);
        patch.push('\n');
    }
    if !text.is_empty() && !text.ends_with('\n') {
        patch.push_str("\\ No newline at end of file\n");
    }
    Ok(Some((patch, lines.len() as u64)))
}

/// What [`Git::worktree_work`] found in a worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeWork {
    /// Files changed or untracked (ignored ones aside).
    pub changed: usize,
    pub head: String,
    /// Its branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Commits on HEAD that no other branch, remote-tracking branch or tag has.
    pub unique_commits: u64,
    /// Another local branch has all of HEAD.
    pub merged: bool,
}

/// What tidying a worktree did, or why it kept it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tidy {
    /// Moved, whole (ignored files too), to the person's Trash, at `to`;
    /// its branch deleted too when another local branch has all of it.
    Trashed { to: PathBuf, branch_deleted: bool },
    /// Kept where it is: why.
    Kept(String),
}

/// Tidy a worktree only when that loses nothing: nothing uncommitted or
/// untracked, and every commit on it is somewhere else. `Ok(delete_branch)`:
/// its branch goes too only when another local branch has all of it
/// (merged); otherwise the branch stays, with its commits. `Err(why kept)`.
pub fn tidy_decision(work: &WorktreeWork) -> Result<bool, String> {
    if work.changed > 0 {
        return Err(format!("{} uncommitted file(s)", work.changed));
    }
    if work.unique_commits > 0 {
        return Err(format!("{} commit(s) that exist nowhere else", work.unique_commits));
    }
    Ok(work.merged && work.branch.is_some())
}

/// Where a tidied worktree goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trash {
    /// The person's Trash, through the system's own call ([`system_trash`]).
    System,
    /// A folder standing in for it (tests: [`move_to_trash`]).
    Folder(PathBuf),
}

/// `dir` to the person's Trash through the system's own call, as Finder
/// does: on macOS `NSFileManager`'s `trashItemAtURL:resultingItemURL:error:`
/// (the Trash of `dir`'s own volume, no special access, and a "Put Back"
/// record). Where it went. On any failure it stays where it is.
///
/// Windows (not built yet: local agents are macOS-only): the Recycle Bin
/// through the shell's file operation API (`IFileOperation::DeleteItem`
/// with `FOFX_RECYCLEONDELETE`, or `SHFileOperationW` with
/// `FOF_ALLOWUNDO`), which likewise keeps a "Restore" record.
#[cfg(target_os = "macos")]
pub fn system_trash(dir: &Path) -> Result<PathBuf, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let path = dir.to_str().ok_or("the folder's path is not valid UTF-8")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let mut resulting = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        .map_err(|e| format!("it couldn't be moved to the Trash ({})", e.localizedDescription()))?;
    Ok(resulting
        .and_then(|u| u.path())
        .map_or_else(|| PathBuf::from("the Trash"), |p| PathBuf::from(p.to_string())))
}

/// No Trash call here yet (see the macOS one's note on Windows).
#[cfg(not(target_os = "macos"))]
pub fn system_trash(_dir: &Path) -> Result<PathBuf, String> {
    Err("there's no Trash call on this system yet".into())
}

/// [`system_trash`] under a readable name: renamed beside itself first
/// (`name`, `name 2`…), then trashed; renamed back if the Trash refuses it,
/// so on any failure it is where it was.
fn system_trash_named(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let parent = dir.parent().ok_or("a worktree at the root")?;
    let named = move_to_trash(dir, parent, name)?;
    // Logged first: a quit before the Trash call leaves it renamed, and the
    // next tidy finds it ([`recover_stranded`]).
    crate::log_to_file(&format!(
        "[local-agent] renamed the worktree {} to {} to move it to the Trash",
        dir.display(),
        named.display()
    ));
    system_trash(&named).inspect_err(|_| {
        if std::fs::rename(&named, dir).is_err() {
            crate::log_to_file(&format!(
                "[local-agent] a worktree that couldn't go to the Trash stays at {}",
                named.display()
            ));
        }
    })
}

/// A git link file's target as written (`gitdir: X`, or a bare path), not
/// resolved: it may name something that no longer exists.
fn raw_link(file: &Path, prefix: Option<&str>) -> Option<PathBuf> {
    let meta = std::fs::symlink_metadata(file).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let text = std::fs::read_to_string(file).ok()?;
    let text = text.trim();
    let target = match prefix {
        Some(pre) => text.strip_prefix(pre)?.trim(),
        None => text,
    };
    let p = PathBuf::from(target);
    p.is_absolute().then_some(p)
}

/// A tidy cut short between its rename beside the worktree and the Trash
/// call (a quit): each folder in `root` whose git entry
/// (`<repo>/.git/worktrees/<id>`) is named for another folder of `root` is
/// stranded. Renamed back when that entry still names `<root>/<id>` and
/// nothing is there; sent on to the Trash when its entry is gone. What was
/// done, logged.
pub fn recover_stranded(root: &Path, trash: &Trash) -> Vec<String> {
    let mut done = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return done };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Some(admin) = raw_link(&dir.join(".git"), Some("gitdir:")) else { continue };
        let Some(id) = admin.file_name().map(|n| n.to_os_string()) else { continue };
        if Some(id.as_os_str()) == dir.file_name()
            || admin.parent().and_then(Path::file_name).and_then(|n| n.to_str()) != Some("worktrees")
        {
            continue;
        }
        let original = root.join(&id);
        let what = if admin.is_dir() {
            if raw_link(&admin.join("gitdir"), None).as_deref() != Some(original.join(".git").as_path())
                || std::fs::symlink_metadata(&original).is_ok()
            {
                continue;
            }
            match std::fs::rename(&dir, &original) {
                Ok(()) => format!("put the worktree {} back as {}", dir.display(), original.display()),
                Err(e) => format!("couldn't put the worktree {} back ({e})", dir.display()),
            }
        } else {
            let moved = match trash {
                Trash::System => system_trash(&dir),
                Trash::Folder(f) => {
                    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("worktree").to_string();
                    move_to_trash(&dir, f, &name)
                }
            };
            match moved {
                Ok(to) => format!("finished moving the worktree {} to the Trash as {}", dir.display(), to.display()),
                Err(e) => format!("the worktree {} stays ({e})", dir.display()),
            }
        };
        crate::log_to_file(&format!("[local-agent] {what}"));
        done.push(what);
    }
    done
}

/// Move `dir` into the folder `trash` (a rename on its volume, nothing
/// copied or deleted) as `name`, or `name 2`, `name 3`…; where it went.
/// Never across volumes: then it stays where it is.
pub fn move_to_trash(dir: &Path, trash: &Path, name: &str) -> Result<PathBuf, String> {
    if !std::fs::symlink_metadata(trash).is_ok_and(|m| m.is_dir()) {
        return Err(format!("there's no Trash folder at {}", trash.display()));
    }
    let clean: String = name
        .chars()
        .map(|c| if c == '/' || c == ':' || c.is_control() { '-' } else { c })
        .collect();
    for n in 1..1000 {
        let to = trash.join(if n == 1 { clean.clone() } else { format!("{clean} {n}") });
        if std::fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        return std::fs::rename(dir, &to)
            .map(|()| to)
            .map_err(|e| format!("it couldn't be moved to the Trash ({e})"));
    }
    Err("the Trash already holds too many folders of that name".into())
}

/// The repository a worktree belongs to, from its link files alone (no
/// git): its `.git` folder and its work tree (the folder holding `.git`).
/// Only a worktree that still checks out ([`check_worktree`]).
pub fn worktree_repo(dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let dir = std::fs::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let admin = read_link_file(&dir.join(".git"), &dir, Some("gitdir:"))?;
    let git_dir = admin
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| format!("{} is not a linked worktree", dir.display()))?
        .to_path_buf();
    if git_dir.file_name().and_then(|n| n.to_str()) != Some(".git") {
        return Err(format!("{} belongs to a repository without a .git folder", dir.display()));
    }
    check_worktree(&dir, &git_dir)?;
    let repo = git_dir.parent().ok_or("a .git folder at the root")?.to_path_buf();
    Ok((git_dir, repo))
}

/// A job's worktree, as made or found.
#[derive(Debug, Clone, PartialEq)]
pub struct Worktree {
    /// Canonical.
    pub dir: PathBuf,
    pub branch: String,
    /// The commit it started from; `None` for a worktree found already made.
    pub base: Option<String>,
    /// The local branch that commit is the tip of, when the start named one
    /// (`baseBranch`); `None` for HEAD, a rebuilt worktree
    /// ([`Base::Commit`]: the job keeps the name it has), or a worktree found
    /// or checked out again.
    pub base_branch: Option<String>,
}

/// Where a new worktree's branch starts, when one has to be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Base {
    /// HEAD's commit.
    Head,
    /// The tip of this local branch ([`Git::resolve_base`]): a new job's
    /// `baseBranch`.
    Branch(String),
    /// This commit, verified again: the one a job Rust has a record of
    /// started from, when its worktree and its branch are both gone.
    Commit(String),
}

/// What a commit made, for the `branch` event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub branch: String,
    pub commit: String,
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
}

/// `dial8/<slug of the label>-<first 8 of the job id>`.
pub fn branch_name(label: &str, job_id: &str) -> String {
    let short: String = job_id.chars().filter(char::is_ascii_alphanumeric).take(8).collect();
    format!("dial8/{}-{}", folder::slug(label), short.to_ascii_lowercase())
}

/// A new job's branch when [`branch_name`]'s is taken: 8 more characters of
/// the job id. `None` when the id has no more.
pub fn fresh_branch(branch: &str, job_id: &str) -> Option<String> {
    let more: String = job_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .skip(8)
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    (!more.is_empty()).then(|| format!("{branch}{more}"))
}

/// A base branch name the server sent (`baseBranch`), checked as the web
/// checks it before storing it: `^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`, with
/// no `..`, `//` or `@{`, and not ending in `.lock`, `/` or `.`. So it can
/// never be an option (`-x`, `--upload-pack=…`), a revision expression
/// (`HEAD~1`, `@{-1}`, `a..b`) or a name git won't make a branch of. `HEAD`
/// and `@` are barred here too, so the check doesn't hang on which git
/// refuses them.
pub fn check_base_branch(name: &str) -> Result<(), String> {
    let plain = name != "HEAD"
        && name != "@"
        && name.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && name.len() <= MAX_BASE_BRANCH
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name.ends_with(".lock")
        && !name.ends_with('/')
        && !name.ends_with('.');
    if plain {
        Ok(())
    } else {
        Err(BAD_BASE_BRANCH.into())
    }
}

/// The summary's first non-empty line, at most [`SUBJECT_MAX`] characters,
/// then made inert ([`super::pr_text`]: the agent wrote it, and it is
/// published under the person's name without being shown to them, so it
/// closes no issue and pings nobody; that can add a few characters).
pub fn commit_subject(summary: &str) -> String {
    let Some(line) = summary.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return DEFAULT_SUBJECT.into();
    };
    let line: String = line.chars().filter(|c| !c.is_control()).collect();
    let cut = if line.chars().count() <= SUBJECT_MAX {
        line
    } else {
        let mut cut: String = line.chars().take(SUBJECT_MAX - 1).collect();
        cut = cut.trim_end().to_string();
        cut.push('…');
        cut
    };
    let inert = super::pr_text::make_inert(&cut, None, super::pr_text::Kind::Commit).text;
    match inert.trim() {
        "" => DEFAULT_SUBJECT.into(),
        s => s.to_string(),
    }
}

/// Sum `git diff --numstat` lines: (files, insertions, deletions). Binary
/// files (`-\t-\tpath`) count as files with no lines.
pub fn parse_numstat(out: &str) -> (u64, u64, u64) {
    let mut totals = (0, 0, 0);
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        let mut cols = line.split('\t');
        let ins = cols.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        let del = cols.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        totals.0 += 1;
        totals.1 += ins;
        totals.2 += del;
    }
    totals
}

/// `p` resolved against `base` when relative, then canonical.
fn resolve(base: &Path, p: &str) -> Result<PathBuf, String> {
    let p = Path::new(p.trim());
    let joined = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    std::fs::canonicalize(&joined).map_err(|e| format!("{}: {e}", joined.display()))
}

/// Read a `gitdir: <path>` link file (a worktree's `.git`, or the repo's
/// `worktrees/<id>/gitdir`, which holds a bare path) relative to `base`.
fn read_link_file(file: &Path, base: &Path, prefix: Option<&str>) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(file).map_err(|e| format!("{}: {e}", file.display()))?;
    if !meta.is_file() || meta.len() > 4096 {
        return Err(format!("{} is not a git link file", file.display()));
    }
    let text = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let text = text.trim();
    let target = match prefix {
        Some(pre) => text
            .strip_prefix(pre)
            .ok_or_else(|| format!("{} is not a git link file", file.display()))?,
        None => text,
    };
    resolve(base, target)
}

/// The worktree at `dir` still belongs to the repo whose `.git` folder is
/// `git_dir`: its `.git` file points into `<git_dir>/worktrees/`, and that
/// entry points back at it. File system only (no git), so the actor can run
/// it inline on every resume.
pub fn check_worktree(dir: &Path, git_dir: &Path) -> Result<(), String> {
    let gone = |why: String| Err(format!("this job's worktree is not usable ({why}); start a new job"));
    let dir = match std::fs::canonicalize(dir) {
        Ok(d) => d,
        Err(e) => return gone(format!("{}: {e}", dir.display())),
    };
    let git_dir = match std::fs::canonicalize(git_dir) {
        Ok(d) => d,
        Err(e) => return gone(format!("{}: {e}", git_dir.display())),
    };
    let admin = match read_link_file(&dir.join(".git"), &dir, Some("gitdir:")) {
        Ok(a) => a,
        Err(e) => return gone(e),
    };
    if admin.parent() != Some(git_dir.join("worktrees").as_path()) {
        return gone(format!("it points at {}", admin.display()));
    }
    match read_link_file(&admin.join("gitdir"), &admin, None) {
        Ok(back) if back == dir.join(".git") => Ok(()),
        Ok(back) => gone(format!("the repo lists it as {}", back.display())),
        Err(e) => gone(e),
    }
}

impl Git {
    /// A git for work outside any launch (tidying worktrees at app start):
    /// the person's PATH and HOME, as a launch would have them.
    pub fn plain(home: &str, path: &str) -> Git {
        Git {
            program: super::config::find_git(path),
            home: home.to_string(),
            path: path.to_string(),
            extra_env: Vec::new(),
        }
    }

    pub fn from_launch(l: &LaunchConfig) -> Git {
        Git {
            program: l.git.clone(),
            home: l.home.clone(),
            path: l.tool_path.clone(),
            extra_env: l.git_env.clone(),
        }
    }

    pub fn home(&self) -> &str {
        &self.home
    }

    pub fn tool_path(&self) -> &str {
        &self.path
    }

    /// `git -C <dir> <SAFE_CONFIG> <args>`; its stdout, or why it failed.
    async fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        self.run_with(dir, args, &[], GIT_TIMEOUT).await
    }

    /// `git -C <dir> <SAFE_CONFIG> <args>` with only the environment it needs.
    fn command(&self, dir: &Path, args: &[&str], env: &[(&str, &str)]) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.program);
        cmd.no_console();
        cmd.arg("-C")
            .arg(dir)
            .args(SAFE_CONFIG)
            .args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", &self.path)
            .env("LANG", "en_US.UTF-8")
            .env("GIT_TERMINAL_PROMPT", "0")
            .envs(self.extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    }

    /// [`Git::run_with`] that never holds more than `limit` bytes of git's
    /// output: past it, or at `deadline`, git is killed and what was read
    /// so far is the answer ([`Capped::cut`], [`Capped::timed_out`]).
    pub(super) async fn run_capped(
        &self,
        dir: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        limit: usize,
        deadline: tokio::time::Instant,
    ) -> Result<Capped, String> {
        use tokio::io::AsyncReadExt;
        let what = args
            .iter()
            .find(|a| !a.starts_with('-') && !a.contains('='))
            .copied()
            .unwrap_or("git")
            .to_string();
        let mut child = self
            .command(dir, args, env)
            .spawn()
            .map_err(|e| format!("git couldn't run ({}): {e}", self.program.display()))?;
        let mut stdout = child.stdout.take().ok_or("git's output couldn't be read")?;
        // Its errors, a little of them; the rest drained so git never blocks.
        let stderr = child.stderr.take().map(|mut err| {
            tokio::spawn(async move {
                let mut kept = Vec::new();
                let _ = (&mut err).take(4096).read_to_end(&mut kept).await;
                let _ = tokio::io::copy(&mut err, &mut tokio::io::sink()).await;
                kept
            })
        });
        let mut out = Vec::new();
        let mut bytes_read = 0usize;
        let mut cut = false;
        let reading = async {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                let want = (limit + 1 - out.len()).min(buf.len());
                let n = stdout.read(&mut buf[..want]).await?;
                if n == 0 {
                    return Ok::<_, std::io::Error>(());
                }
                bytes_read += n;
                out.extend_from_slice(&buf[..n]);
                if out.len() > limit {
                    out.truncate(limit);
                    cut = true;
                    return Ok(());
                }
            }
        };
        let read = tokio::time::timeout_at(deadline, reading).await;
        let mut timed_out = read.is_err();
        if let Ok(Err(e)) = read {
            let _ = child.start_kill();
            return Err(format!("git {what}'s output couldn't be read: {e}"));
        }
        let status = if cut || timed_out {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
            None
        } else {
            match tokio::time::timeout_at(deadline, child.wait()).await {
                Ok(Ok(status)) => Some(status),
                Ok(Err(e)) => return Err(format!("git {what} failed: {e}")),
                Err(_) => {
                    timed_out = true;
                    let _ = child.start_kill();
                    None
                }
            }
        };
        if let Some(status) = status.filter(|s| !s.success()) {
            let kept = match stderr {
                Some(task) => task.await.unwrap_or_default(),
                None => Vec::new(),
            };
            let stderr = String::from_utf8_lossy(&kept);
            let stderr = stderr.trim();
            return Err(if stderr.is_empty() {
                format!("git {what} failed ({status})")
            } else {
                format!("git {what} failed: {}", truncate(stderr, 600))
            });
        }
        Ok(Capped {
            out: String::from_utf8_lossy(&out).into_owned(),
            cut,
            timed_out,
            bytes_read,
        })
    }

    /// [`Git::run`] with more environment (a push's ssh-agent socket) and
    /// its own time limit.
    pub(super) async fn run_with(
        &self,
        dir: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<String, String> {
        let mut cmd = self.command(dir, args, env);
        let what = args
            .iter()
            .find(|a| !a.starts_with('-') && !a.contains('='))
            .copied()
            .unwrap_or("git");
        let out = match tokio::time::timeout(timeout, cmd.output()).await {
            Err(_) => return Err(format!("git {what} took over {timeout:?}")),
            Ok(Err(e)) => return Err(format!("git couldn't run ({}): {e}", self.program.display())),
            Ok(Ok(out)) => out,
        };
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stderr = stderr.trim();
        Err(if stderr.is_empty() {
            format!("git {what} failed ({})", out.status)
        } else {
            format!("git {what} failed: {}", truncate(stderr, 600))
        })
    }

    /// The repo's own `.git` folder, canonical. `repo` must be the root of
    /// its work tree, and the folder must be named `.git` (the launcher takes
    /// exactly one extra read-only root, and only a `.git` folder).
    pub async fn repo_git_dir(&self, repo: &Path) -> Result<PathBuf, String> {
        let repo = std::fs::canonicalize(repo).map_err(|e| format!("{}: {e}", repo.display()))?;
        let top = self.run(&repo, &["rev-parse", "--show-toplevel"]).await?;
        if resolve(&repo, &top)? != repo {
            return Err(format!("{} is not the root of its git repository", repo.display()));
        }
        let common = self.run(&repo, &["rev-parse", "--git-common-dir"]).await?;
        let common = resolve(&repo, &common)?;
        if common.file_name().and_then(|n| n.to_str()) != Some(".git") || !common.is_dir() {
            return Err(format!(
                "edits need a regular git checkout; this one keeps its git data in {}",
                common.display()
            ));
        }
        Ok(common)
    }

    /// The commit the local branch `name` points at, as a full sha: `name`
    /// checked ([`check_base_branch`]) and by `git check-ref-format
    /// --branch`, then looked up as exactly `refs/heads/<name>`.
    ///
    /// Rust builds that full ref; the bare name never reaches git as a
    /// revision (`rev-parse` would guess, and take a tag
    /// `refs/tags/refs/heads/<name>` when the branch doesn't exist).
    /// `for-each-ref` lists the ref as it is stored, and exactly one line
    /// must be it, byte for byte (on APFS a loose `refs/heads/main` file
    /// also opens as `Main`), not a symbolic ref (`refs/heads/x` pointing at
    /// `refs/remotes/origin/secret`), and pointing at a commit.
    pub async fn resolve_base(&self, repo: &Path, name: &str) -> Result<String, String> {
        check_base_branch(name)?;
        // `check-ref-format` takes no `--`. The name can't be read as an
        // option: it starts with a letter or a digit.
        let checked = self
            .run(repo, &["check-ref-format", "--branch", name])
            .await
            .map_err(|_| BAD_BASE_BRANCH.to_string())?;
        if checked.trim_end() != name {
            return Err(BAD_BASE_BRANCH.into());
        }
        let label = folder::label_of(repo);
        let full = format!("refs/heads/{name}");
        let listed = self
            .run(
                repo,
                &[
                    "for-each-ref",
                    "--format=%(objectname)%00%(objecttype)%00%(symref)%00%(refname)",
                    &full,
                ],
            )
            .await?;
        let ours: Vec<Vec<&str>> = listed
            .lines()
            .map(|l| l.split('\0').collect::<Vec<_>>())
            .filter(|f| f.len() == 4 && f[3] == full)
            .collect();
        match ours.as_slice() {
            [] => Err(format!("There's no branch {name} in {label}")),
            [f] if f[2].is_empty() && f[1] == "commit" && super::push::is_commit_id(f[0]) => Ok(f[0].to_string()),
            _ => Err(format!(
                "The branch {name} in {label} isn't a plain branch: it points at another ref, or at something \
                 that isn't a commit"
            )),
        }
    }

    /// `sha` is a commit this repository still has: the start of a rebuilt
    /// worktree ([`Base::Commit`]).
    async fn verify_commit(&self, repo: &Path, sha: &str) -> Result<String, String> {
        let gone = "this job's worktree and branch are gone, and so is the commit it started from; start a new job";
        if !super::push::is_commit_id(sha) {
            return Err(gone.into());
        }
        let found = self
            .run(repo, &["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")])
            .await
            .map_err(|_| gone.to_string())?;
        if found.trim() != sha {
            return Err(gone.into());
        }
        Ok(sha.to_string())
    }

    /// The job's worktree under `root` (`~/.dial8/worktrees`): the one made
    /// earlier for this job if it is still linked to the repo, else `branch`
    /// checked out again if it exists, else a new `branch` made from `base`.
    /// `base` is resolved only then, when a new branch is made.
    /// `fresh`: a job Rust has no record of. A branch of its name that
    /// another job's live worktree has checked out (two job ids starting
    /// with the same 8 characters) is never shared: the new job's name gets
    /// more of its id ([`fresh_branch`]). A branch of its name nobody has
    /// checked out is taken as the job's own, as before (its record lost).
    /// Several jobs can be started at once in one repository: this app makes
    /// their worktrees one at a time ([`repo_lock`]), and a `worktree add`
    /// that meets another git's lock (the person's own git) is tried again
    /// ([`WORKTREE_ADD_TRIES`]);
    /// `git worktree add` marks a worktree it is making as locked
    /// ("initializing"), so a `worktree prune` meanwhile leaves it alone.
    #[allow(clippy::too_many_arguments)]
    pub async fn ensure_worktree(
        &self,
        repo: &Path,
        git_dir: &Path,
        root: &Path,
        job_id: &str,
        branch: &str,
        base: &Base,
        fresh: bool,
    ) -> Result<Worktree, String> {
        super::state::create_private_dir(root).map_err(|e| format!("can't create {}: {e}", root.display()))?;
        let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
        let dir = root.join(job_id);
        if dir.exists() {
            check_worktree(&dir, git_dir)?;
            let branch = self.run(&dir, &["symbolic-ref", "--short", "HEAD"]).await?;
            return Ok(Worktree {
                dir,
                branch: branch.trim().to_string(),
                base: None,
                base_branch: None,
            });
        }
        let dir_str = dir.to_str().ok_or("the worktree path is not valid UTF-8")?;
        let lock = repo_lock(git_dir);
        let _made_alone = lock.lock().await;
        let branch_exists = |name: String| async move {
            self.run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")])
                .await
                .is_ok()
        };
        let longer = fresh.then(|| fresh_branch(branch, job_id)).flatten();
        let mut branch = branch;
        // Twice at most: a new job's name taken meanwhile by another job's
        // live worktree moves it to its longer name once.
        for _ in 0..2 {
            if branch_exists(branch.to_string()).await {
                // Its worktree was deleted (or the job's record lost): drop the
                // stale entry, check it out again.
                let _ = self.run(repo, &["worktree", "prune"]).await;
                match self.worktree_add(repo, &["worktree", "add", "--quiet", dir_str, branch]).await {
                    Ok(_) => {
                        check_worktree(&dir, git_dir)?;
                        return Ok(Worktree {
                            dir,
                            branch: branch.to_string(),
                            base: None,
                            base_branch: None,
                        });
                    }
                    // Another live job's worktree has it (two job ids that
                    // start alike): a new job never shares it.
                    Err(e) if e.contains("already checked out") || e.contains("already used by worktree") => {
                        match longer.as_deref().filter(|l| *l != branch) {
                            Some(l) => {
                                branch = l;
                                continue;
                            }
                            None => return Err(e),
                        }
                    }
                    Err(e) => return Err(e),
                }
            }
            let (start, base_branch) = match base {
                Base::Head => {
                    let head = self
                        .run(repo, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
                        .await
                        .map_err(|_| "the repository has no commits yet; commit something first".to_string())?;
                    (head.trim().to_string(), None)
                }
                Base::Branch(name) => (self.resolve_base(repo, name).await?, Some(name.clone())),
                Base::Commit(sha) => (self.verify_commit(repo, sha).await?, None),
            };
            match self
                .worktree_add(repo, &["worktree", "add", "--quiet", "-b", branch, dir_str, &start])
                .await
            {
                Ok(_) => {
                    check_worktree(&dir, git_dir)?;
                    return Ok(Worktree {
                        dir,
                        branch: branch.to_string(),
                        base: Some(start),
                        base_branch,
                    });
                }
                // Made meanwhile by another job's git: look again.
                Err(e) if e.contains("already exists") && !dir.exists() => continue,
                Err(e) => return Err(e),
            }
        }
        Err(format!("couldn't make a worktree on {branch}: other jobs took its name; start the job again"))
    }

    /// A job's changes since `base` (the commit it started from), committed
    /// and not, untracked files included ([`JobDiff`]). Read-only: no
    /// optional locks (the index is never written), no external diff or
    /// textconv, never inside a submodule, the limits of [`DIFF_MAX_FILES`],
    /// [`DIFF_MAX_FILE_PATCH`] and [`DIFF_MAX_TOTAL`]; a secret file
    /// ([`is_secret_file_name`]) by name only. Safe while the agent runs.
    pub async fn job_diff(&self, worktree: &Path, base: &str) -> Result<JobDiff, String> {
        let deadline = tokio::time::Instant::now() + DIFF_DEADLINE;
        self.job_diff_by(worktree, base, deadline).await.map(|(diff, _)| diff)
    }

    /// [`Git::job_diff`] by `deadline`, and how many bytes it took from git
    /// in all (its tests hold that to the limits). Every git output is read
    /// to a hard limit (git is killed past it): a patch is asked for only
    /// when its counted lines could fit, and then read to at most what is
    /// left of the limits.
    pub(super) async fn job_diff_by(
        &self,
        worktree: &Path,
        base: &str,
        deadline: tokio::time::Instant,
    ) -> Result<(JobDiff, usize), String> {
        if !base.chars().all(|c| c.is_ascii_hexdigit()) || base.len() < 7 {
            return Err("this job's starting commit isn't known".into());
        }
        let ro = [("GIT_OPTIONAL_LOCKS", "0")];
        let read = std::sync::atomic::AtomicUsize::new(0);
        let run = |args: Vec<String>, limit: usize| {
            let read = &read;
            async move {
                let mut all: Vec<&str> = DIFF_CONFIG.to_vec();
                all.extend(args.iter().map(String::as_str));
                let c = self.run_capped(worktree, &all, &ro, limit, deadline).await?;
                read.fetch_add(c.bytes_read, std::sync::atomic::Ordering::Relaxed);
                Ok::<_, String>(c)
            }
        };
        let diff = |extra: &[&str]| {
            let mut a: Vec<String> = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", IGNORE_SUBMODULES]
                .iter()
                .map(|s| s.to_string())
                .collect();
            a.extend(extra.iter().map(|s| s.to_string()));
            a
        };
        // A commit id: whole, or no answer.
        let commit = |c: Capped, what: &str| {
            let id = c.out.trim().to_string();
            if c.cut || c.timed_out || id.is_empty() {
                Err(format!("git couldn't name {what} in time"))
            } else {
                Ok(id)
            }
        };
        let rev = |r: String| vec!["rev-parse".into(), "--verify".into(), r];
        let head = commit(run(rev("HEAD^{commit}".into()), 256).await?, "the job's commit")?;
        let base_sha = commit(run(rev(format!("{base}^{{commit}}")), 256).await?, "its starting commit")?;
        let names = run(diff(&["--name-status", "-z", &base_sha]), DIFF_MAX_LIST).await?;
        let mut truncated = names.cut || names.timed_out;
        let counted = run(diff(&["--numstat", "-z", &base_sha]), DIFF_MAX_LIST).await?;
        truncated |= counted.cut || counted.timed_out;
        let stats = parse_numstat_z(counted.records());
        let mut entries = parse_name_status_z(names.records());
        let untracked = run(
            vec!["ls-files".into(), "--others".into(), "--exclude-standard".into(), "-z".into()],
            DIFF_MAX_LIST,
        )
        .await?;
        truncated |= untracked.cut || untracked.timed_out;
        for path in untracked.records().split('\0').filter(|p| !p.is_empty()) {
            entries.push(("added", path.to_string(), None));
        }
        entries.sort_by(|a, b| a.1.cmp(&b.1));
        entries.dedup_by(|a, b| a.1 == b.1);
        truncated |= entries.len() > DIFF_MAX_FILES;
        entries.truncate(DIFF_MAX_FILES);
        let mut total = 0usize;
        let mut files = Vec::with_capacity(entries.len());
        let names_set: std::collections::HashSet<String> =
            parse_name_status_z(names.records()).into_iter().map(|(_, p, _)| p).collect();
        for (status, path, old_path) in entries {
            let name = Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or(&path).to_string();
            let secret = is_secret_file_name(&name)
                || old_path.as_deref().is_some_and(|o| is_secret_file_name(Path::new(o).file_name().and_then(|n| n.to_str()).unwrap_or(o)));
            let (mut additions, mut deletions, mut binary) = stats.get(&path).copied().unwrap_or((0, 0, false));
            let mut patch = String::new();
            // What may still be read for this file's patch.
            let room = DIFF_MAX_FILE_PATCH.min(DIFF_MAX_TOTAL - total);
            let late = tokio::time::Instant::now() >= deadline;
            if secret {
                additions = 0;
                deletions = 0;
            } else if late {
                truncated = true;
            } else if names_set.contains(&path) {
                // Each counted line is two bytes of patch at least: past the
                // room, it isn't asked for.
                let too_long = (additions + deletions).saturating_mul(2) > room as u64;
                if too_long {
                    truncated = true;
                } else if !binary {
                    let mut args = diff(&[&base_sha, "--"]);
                    args.push(format!(":(literal){path}"));
                    if let Some(o) = &old_path {
                        args.push(format!(":(literal){o}"));
                    }
                    match run(args, room).await {
                        Ok(c) if c.cut || c.timed_out => truncated = true,
                        Ok(c) => patch = c.out,
                        Err(_) => {}
                    }
                }
            } else {
                match untracked_patch(worktree, &path) {
                    Ok(Some((p, lines))) => {
                        additions = lines;
                        patch = p;
                    }
                    Ok(None) => binary = true,
                    Err(_) => {}
                }
            }
            if patch.len() > room {
                truncated = true;
                patch.clear();
            }
            total += patch.len();
            files.push(DiffFile {
                path,
                old_path,
                status,
                additions,
                deletions,
                binary,
                patch,
            });
        }
        let diff = JobDiff {
            base: base_sha,
            head,
            truncated,
            files,
        };
        Ok((diff, read.load(std::sync::atomic::Ordering::Relaxed)))
    }

    /// `git worktree add …`, tried again while another git in the same
    /// repository holds a lock it needs.
    async fn worktree_add(&self, repo: &Path, args: &[&str]) -> Result<String, String> {
        let mut tries = 0;
        loop {
            tries += 1;
            match self.run(repo, args).await {
                Err(e) if tries < WORKTREE_ADD_TRIES && is_lock_contention(&e) => {
                    tokio::time::sleep(Duration::from_millis(150 * u64::from(tries))).await;
                }
                other => return other,
            }
        }
    }

    /// What a worktree holds that removing it could lose ([`Tidy`]). Git
    /// runs in the worktree as for a commit (the safe config, no look inside
    /// a submodule).
    pub async fn worktree_work(&self, worktree: &Path) -> Result<WorktreeWork, String> {
        let mut status = NO_SUBMODULES.to_vec();
        status.extend([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            IGNORE_SUBMODULES,
        ]);
        let changed = parse_status_z(&self.run(worktree, &status).await?);
        let head = self.run(worktree, &["rev-parse", "--verify", "HEAD^{commit}"]).await?.trim().to_string();
        let branch = self
            .run(worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .ok()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty());
        // Commits on HEAD that no other ref has: the branch's own (excluded
        // by name), the person's other branches, remote-tracking branches
        // (a push) and tags.
        let not_in = |refs: &'static [&'static str]| {
            let mut args = vec!["rev-list".to_string(), "--count".into(), head.clone(), "--not".into()];
            for r in refs {
                if let Some(b) = &branch {
                    args.push(format!("--exclude={b}"));
                }
                args.push((*r).to_string());
            }
            args
        };
        let count = |args: Vec<String>| async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            self.run(worktree, &args)
                .await
                .and_then(|n| n.trim().parse::<u64>().map_err(|e| format!("rev-list: {e}")))
        };
        // A detached HEAD has no branch to keep its commits: a
        // remote-tracking ref alone (gone at the next `fetch --prune`)
        // doesn't count for it.
        let elsewhere = match branch {
            Some(_) => count(not_in(&["--branches", "--remotes", "--tags"])).await?,
            None => count(not_in(&["--branches", "--tags"])).await?,
        };
        let unmerged = count(not_in(&["--branches"])).await?;
        Ok(WorktreeWork {
            changed: changed.len(),
            head,
            branch,
            unique_commits: elsewhere,
            merged: unmerged == 0,
        })
    }

    /// Tidy a job's worktree when that loses nothing ([`tidy_decision`]):
    /// never deleted, but moved whole to `trash` (ignored files and all, as
    /// `<repo>-<branch>-<date>`), so the person can put it back; then git's
    /// entry for that worktree alone goes, and the branch only when another
    /// local branch has all of it and it still points where it was checked.
    pub async fn tidy_worktree(&self, repo: &Path, worktree: &Path, trash: &Trash) -> Result<Tidy, String> {
        let work = self.worktree_work(worktree).await?;
        let delete_branch = match tidy_decision(&work) {
            Ok(d) => d,
            Err(why) => return Ok(Tidy::Kept(why)),
        };
        let admin = read_link_file(&worktree.join(".git"), worktree, Some("gitdir:"))?;
        // A submodule the person set up in it keeps its git data in the
        // entry (`modules/`), which would go with it; a locked worktree is
        // one the person asked git to leave be.
        if admin.join("modules").exists() {
            return Ok(Tidy::Kept("it holds a submodule's own git data".into()));
        }
        if admin.join("locked").exists() {
            return Ok(Tidy::Kept("it is locked (git worktree lock)".into()));
        }
        // What git's entry names, read while the folder is still there.
        let named = read_link_file(&admin.join("gitdir"), &admin, None).ok();
        let repo_name = repo.file_name().and_then(|n| n.to_str()).unwrap_or("repo");
        let name = format!(
            "{repo_name}-{}-{}",
            work.branch.as_deref().unwrap_or("detached"),
            chrono::Local::now().format("%Y-%m-%d")
        );
        let moved = match trash {
            Trash::Folder(folder) => move_to_trash(worktree, folder, &name),
            Trash::System => system_trash_named(worktree, &name),
        };
        let to = match moved {
            Ok(to) => to,
            Err(why) => return Ok(Tidy::Kept(why)),
        };
        // Git's own entry for it, and only that one: it named the folder
        // that was there (`<admin>/gitdir`).
        if named.as_deref() == Some(worktree.join(".git").as_path())
            && admin.parent().and_then(Path::file_name).and_then(|n| n.to_str()) == Some("worktrees")
        {
            let _ = std::fs::remove_dir_all(&admin);
        }
        let mut branch_deleted = false;
        if let (true, Some(b)) = (delete_branch, &work.branch) {
            let r = format!("refs/heads/{b}");
            branch_deleted = self.run(repo, &["update-ref", "-d", &r, &work.head]).await.is_ok();
        }
        Ok(Tidy::Trashed { to, branch_deleted })
    }

    /// `Err` when what `git add -A` would stage is over `budget`. Sizes come
    /// from the file system (`symlink_metadata`: a link counts as itself),
    /// for the files git reports changed or untracked (ignored ones are left
    /// out, as `add -A` leaves them).
    pub async fn check_budget(&self, worktree: &Path, budget: &Budget) -> Result<(), String> {
        let mut args = NO_SUBMODULES.to_vec();
        args.extend([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            IGNORE_SUBMODULES,
        ]);
        args.extend(NOT_COMMITTED);
        let out = self.run(worktree, &args).await?;
        let changed: Vec<(String, u64)> = parse_status_z(&out)
            .into_iter()
            .map(|path| {
                let size = std::fs::symlink_metadata(worktree.join(&path))
                    .map(|m| if m.is_file() { m.len() } else { 0 })
                    .unwrap_or(0);
                (path, size)
            })
            .collect();
        match over_budget(&changed, budget) {
            None => Ok(()),
            Some(why) => Err(format!(
                "the changes are too large to commit ({why}); nothing was committed, and they stay in {}",
                worktree.display()
            )),
        }
    }

    /// Git ignores the folder `dir` (relative to `worktree`): `git
    /// check-ignore`, with [`SAFE_CONFIG`]. Neither `add` nor `status`
    /// goes into an ignored folder, so a repository there is never staged or
    /// looked inside. Anything but a clear yes (the top, a name that isn't
    /// UTF-8, git failing) is no.
    async fn ignores(&self, worktree: &Path, dir: &Path) -> bool {
        let Some(dir) = dir.to_str().filter(|d| !d.is_empty()) else {
            return false;
        };
        let dir = format!("{dir}/");
        self.run(worktree, &["check-ignore", "-q", "--", &dir]).await.is_ok()
    }

    /// The first `.git` below the worktree's own whose folder git doesn't
    /// ignore ([`nested_gits`], [`Git::ignores`]): a repository git would
    /// stage, or look inside. Too many to check is an `Err`.
    pub async fn unignored_nested(&self, worktree: &Path) -> Result<Option<PathBuf>, String> {
        let dir = worktree.to_path_buf();
        let found = tokio::task::spawn_blocking(move || nested_gits(&dir, MAX_NESTED))
            .await
            .map_err(|e| e.to_string())??;
        if found.len() > MAX_NESTED {
            return Err(format!("it holds over {MAX_NESTED} git repositories"));
        }
        for git in found {
            let parent = git.parent().unwrap_or(Path::new(""));
            if !self.ignores(worktree, parent).await {
                return Ok(Some(git));
            }
        }
        Ok(None)
    }

    /// `git add -A` of what a commit takes, never looking inside a submodule:
    /// `add` does for each one the index has, whatever the config says, so
    /// each is left out by path. A submodule it staged anyway (a repository
    /// that appeared since [`Git::unignored_nested`] looked) is unstaged, and `Err`.
    /// Answers what is staged against HEAD (`diff-index --cached --raw -z`).
    pub async fn stage(&self, worktree: &Path) -> Result<String, String> {
        let listed = self.run(worktree, &["ls-files", "--stage", "-z"]).await?;
        let skip: Vec<String> = parse_gitlinks_z(&listed)
            .iter()
            .map(|p| format!(":(exclude,literal){p}"))
            .collect();
        let mut add = vec!["add", "-A"];
        add.extend(NOT_COMMITTED);
        add.extend(skip.iter().map(String::as_str));
        self.run(worktree, &add).await?;
        // Index against HEAD only: no work tree, a submodule's included.
        let staged = self
            .run(
                worktree,
                &[
                    "diff-index",
                    "--cached",
                    "--raw",
                    "-z",
                    "--no-renames",
                    "--ignore-submodules=dirty",
                    "HEAD",
                ],
            )
            .await?;
        let gitlinks = new_gitlinks(&staged);
        if gitlinks.is_empty() {
            return Ok(staged);
        }
        let paths: Vec<String> = gitlinks.iter().map(|p| format!(":(literal){p}")).collect();
        let mut reset = vec!["reset", "-q", "HEAD", "--"];
        reset.extend(paths.iter().map(String::as_str));
        let _ = self.run(worktree, &reset).await;
        Err(format!(
            "the changes would add a git submodule ({}), and Native Intelligence never commits one; nothing was committed, and \
             the changes stay in {}",
            gitlinks.join(", "),
            worktree.display()
        ))
    }

    /// Commit everything in the worktree on its branch. `worker`: a coding
    /// agent's job, whose commit is refused (nothing committed, the index put
    /// back, the worktree left as it is) when it would add or change a path
    /// [`worker_commit_refuses`].
    pub async fn commit(
        &self,
        worktree: &Path,
        git_dir: &Path,
        base: Option<&str>,
        summary: &str,
        worker: bool,
    ) -> Result<CommitInfo, String> {
        check_worktree(worktree, git_dir)?;
        let kept = |why: String| {
            format!(
                "{why}; nothing was committed, and the changes stay in {}",
                worktree.display()
            )
        };
        // Before status or add: a repository of the agent's own.
        let nested = self
            .unignored_nested(worktree)
            .await
            .map_err(|e| kept(format!("the worktree couldn't be checked for a git repository of its own ({e})")))?;
        if let Some(nested) = nested {
            return Err(kept(format!(
                "the changes hold a git repository of their own ({}), and Native Intelligence never commits one",
                nested.display()
            )));
        }
        self.check_budget(worktree, &COMMIT_BUDGET).await?;
        let staged = self.stage(worktree).await?;
        if worker {
            let refused: Vec<String> = staged_written(&staged)
                .into_iter()
                .filter(|p| worker_commit_refuses(p))
                .collect();
            if !refused.is_empty() {
                // The index back to HEAD; the files stay as they are.
                let _ = self.run(worktree, &["reset", "-q"]).await;
                return Err(kept(format!(
                    "the coding agent's changes hold files that run by themselves or belong inside a git repository ({}), \
                     and Native Intelligence never commits those for a coding agent",
                    some_paths(&refused)
                )));
            }
        }
        let subject = commit_subject(summary);
        let configured = |v: Result<String, String>| v.is_ok_and(|s| !s.trim().is_empty());
        let has_identity = configured(self.run(worktree, &["config", "user.name"]).await)
            && configured(self.run(worktree, &["config", "user.email"]).await);
        let name = format!("user.name={FALLBACK_NAME}");
        let email = format!("user.email={FALLBACK_EMAIL}");
        let mut args: Vec<&str> = Vec::new();
        if !has_identity {
            args.extend(["-c", &name, "-c", &email]);
        }
        args.extend(["commit", "--quiet", "--allow-empty", "-m", &subject]);
        self.run(worktree, &args).await?;
        let commit = self.run(worktree, &["rev-parse", "HEAD"]).await?.trim().to_string();
        let branch = self
            .run(worktree, &["symbolic-ref", "--short", "HEAD"])
            .await?
            .trim()
            .to_string();
        let from = base.map(str::to_string).unwrap_or_else(|| format!("{commit}~1"));
        let mut diff = NO_SUBMODULES.to_vec();
        diff.extend([
            "diff",
            "--numstat",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            IGNORE_SUBMODULES,
            from.as_str(),
            commit.as_str(),
        ]);
        let stats = self
            .run(worktree, &diff)
            .await
            .map(|out| parse_numstat(&out))
            .unwrap_or((0, 0, 0));
        Ok(CommitInfo {
            branch,
            commit,
            files_changed: stats.0,
            insertions: stats.1,
            deletions: stats.2,
        })
    }
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Every git Rust runs carries the config that keeps the repo's code
    /// out and never starts an automatic gc or maintenance.
    #[cfg(unix)]
    #[tokio::test]
    async fn every_git_call_carries_the_safe_config() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let out = dir.path().join("args");
        std::fs::write(bin.join("git"), format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", out.display())).unwrap();
        std::fs::set_permissions(bin.join("git"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let g = Git::plain(dir.path().to_str().unwrap(), bin.to_str().unwrap());
        g.run(dir.path(), &["status"]).await.unwrap();
        let args = std::fs::read_to_string(&out).unwrap();
        let args: Vec<&str> = args.lines().collect();
        for want in ["core.hooksPath=/dev/null", "core.fsmonitor=false", "commit.gpgSign=false", "gc.auto=0", "maintenance.auto=false"] {
            let at = args.iter().position(|a| *a == want).unwrap_or_else(|| panic!("{want} not in {args:?}"));
            assert_eq!(args[at - 1], "-c");
            assert!(at < args.iter().position(|a| *a == "status").unwrap(), "ahead of the subcommand");
        }
    }

    #[test]
    fn a_workers_commit_refuses_what_the_fence_keeps_out() {
        for refused in [
            ".claude",
            ".claude/settings.json",
            "app/.Claude/Settings.Local.json",
            ".claude/hooks/x/y.sh",
            ".mcp.json",
            "pkg/.mcp.json",
            ".codex/config.toml",
            ".cursor/mcp.json",
            ".gemini/settings.json",
            ".vscode/tasks.json",
            "web/.vscode/mcp.json",
            ".husky/pre-commit",
            ".husky/_/h",
            ".pre-commit-config.yaml",
            "lefthook.yml",
            "LEFTHOOK.yaml",
            ".lefthook.yml",
            ".npmrc",
            ".pnpmfile.cjs",
            ".yarnrc.yml",
            ".yarnrc",
            ".yarn/releases/yarn.cjs",
            ".yarn/plugins/p.cjs",
            // Inside a repository, or an app bundle, at any depth.
            "vendor/x/.git/config",
            "vendor/x/.GIT/hooks/post-checkout",
            "Tool.app/Contents/MacOS/tool",
            "dist/Helper.APP/x",
            ".app",
            // Folded as APFS matches names: the Kelvin sign is a k, `ſ` an s.
            ".hus\u{212A}y/pre-commit",
            ".hu\u{17F}ky/pre-commit",
            ".mcp.j\u{17F}on",
            ".claude/\u{17F}ettings.local.json",
        ] {
            assert!(worker_commit_refuses(refused), "{refused}");
        }
        for fine in [
            "README.md",
            ".claude/commands/x.md",
            ".claude/agents/a.md",
            ".vscode/settings.json",
            ".cursor/rules/r.mdc",
            ".codex/prompts/p.md",
            ".yarn/cache/x.zip",
            "docs/hooks/guide.md",
            "src/app.ts",
            "x.application",
            ".gitignore",
            ".github/workflows/ci.yml",
            "package.json",
        ] {
            assert!(!worker_commit_refuses(fine), "{fine}");
        }
    }

    #[test]
    fn staged_records_name_what_a_commit_writes() {
        let out = ":000000 100644 0000 aaaa A\0new.txt\0:100644 100644 bbbb cccc M\0dir/changed.md\0\
                   :100644 000000 dddd 0000 D\0gone.txt\0:100644 120000 eeee ffff T\0link\0";
        assert_eq!(staged_written(out), ["new.txt", "dir/changed.md", "link"]);
        assert!(staged_written("").is_empty());
    }

    /// The auto-run names here and the Node fence's must not drift: read
    /// seatbelt.ts (in this repository, beside the desktop) and check both.
    #[test]
    fn auto_run_configs_match_the_node_fence() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/agents/local-agent/lib/seatbelt.ts");
        let Ok(ts) = std::fs::read_to_string(&path) else {
            eprintln!("skipped: no {}", path.display());
            return;
        };
        let strings_in = |start: &str, end: &str| -> Vec<String> {
            let at = ts.find(start).unwrap_or_else(|| panic!("{start} not in seatbelt.ts"));
            let block = &ts[at + start.len()..];
            let block = &block[..block.find(end).unwrap_or_else(|| panic!("{start}: no {end}"))];
            block
                .split('\'')
                .skip(1)
                .step_by(2)
                .map(str::to_string)
                .collect()
        };
        let configs = strings_in("export const AUTO_RUN_CONFIGS = [", "] as const");
        assert!(configs.len() > 10, "{configs:?}");
        for c in &configs {
            let path = c.replace("/**", "/x/y");
            assert!(is_auto_run_config(&path), "the Node fence's {c} isn't refused here");
        }
        let files = strings_in("const AUTO_RUN_FILES = [", "]");
        assert_eq!(files, AUTO_RUN_FILES, "AUTO_RUN_FILES");
        let in_folder = strings_in("const AUTO_RUN_IN_FOLDER: ReadonlyMap<string, string> = new Map([", "])");
        let ours: Vec<String> = AUTO_RUN_IN_FOLDER
            .iter()
            .flat_map(|(d, f)| [d.to_string(), f.to_string()])
            .collect();
        assert_eq!(in_folder, ours, "AUTO_RUN_IN_FOLDER");
    }

    #[test]
    fn branch_names_use_the_label_slug_and_the_job_short_id() {
        assert_eq!(
            branch_name("native-intelligence", "38cb0eef-89e9-496d-bf08-0688225dbfcd"),
            "dial8/native-intelligence-38cb0eef"
        );
        assert_eq!(
            branch_name("My App", "ABCDEF12-0000-4000-8000-000000000000"),
            "dial8/my-app-abcdef12"
        );
        assert_eq!(branch_name("..", "38cb0eef-89e9"), "dial8/job-38cb0eef");
    }

    #[test]
    fn base_branch_names_are_checked_as_the_web_checks_them() {
        let longest = format!("r{}", "e".repeat(MAX_BASE_BRANCH - 1));
        for ok in [
            "main",
            "release/2.0",
            "feature_x-1",
            "a",
            "0ld",
            "head",
            "HEADS",
            "refs/remotes/origin/main",
            longest.as_str(),
        ] {
            assert_eq!(check_base_branch(ok), Ok(()), "{ok:?}");
        }
        let too_long = format!("{longest}e");
        for bad in [
            "",
            "HEAD",
            "@",
            too_long.as_str(),
            "-x",
            "--upload-pack=x",
            "@{-1}",
            "main@{1}",
            "HEAD~1",
            "HEAD^",
            "a..b",
            "x.lock",
            "a//b",
            "a/",
            "a.",
            ".a",
            "/a",
            "_a",
            "a b",
            "a:b",
            "a\\b",
            "a*",
            "a?",
            "a[b",
            "ma\0in",
            "ma\nin",
            "brañch",
        ] {
            assert_eq!(check_base_branch(bad), Err(BAD_BASE_BRANCH.to_string()), "{bad:?}");
        }
        assert_eq!(
            BAD_BASE_BRANCH,
            "The base branch must be the plain name of a local branch: up to 100 letters, digits, dots, \
             dashes, underscores and slashes"
        );
    }

    #[test]
    fn subjects_are_the_first_line_cut_to_72() {
        assert_eq!(commit_subject("Add the tests\n\nMore detail"), "Add the tests");
        assert_eq!(commit_subject("\n  \n  Fixed it  \nx"), "Fixed it");
        assert_eq!(commit_subject(""), DEFAULT_SUBJECT);
        assert_eq!(commit_subject(" \n\t"), DEFAULT_SUBJECT);
        let long = commit_subject(&"word ".repeat(40));
        assert!(long.chars().count() <= 72 && long.ends_with('…'), "{long}");
        let wide = commit_subject(&"é".repeat(100));
        assert_eq!(wide.chars().count(), 72);
        assert_eq!(commit_subject("tab\there"), "tabhere", "no control characters");
        assert_eq!(
            commit_subject("Fix login, closes #12 and acme/x#3, thanks @bob\nfixes #9"),
            "Fix login, closes issue 12 and acme/x#3, thanks @\u{200B}bob",
            "the agent's words close nothing and ping nobody"
        );
        assert_eq!(commit_subject("<!-- hidden --> Fix it"), "Fix it");
        assert_eq!(commit_subject("<!-- only hidden -->"), DEFAULT_SUBJECT);
    }

    #[test]
    fn the_commit_budget_refuses_huge_files_totals_and_counts() {
        let b = Budget {
            max_file_bytes: 100,
            max_total_bytes: 250,
            max_files: 3,
        };
        let f = |p: &str, n: u64| (p.to_string(), n);
        assert_eq!(over_budget(&[f("a", 100), f("b", 100)], &b), None);
        assert!(over_budget(&[f("a", 101)], &b).unwrap().contains("a is"));
        assert!(over_budget(&[f("a", 100), f("b", 100), f("c", 51)], &b)
            .unwrap()
            .contains("total"));
        assert!(over_budget(&[f("a", 0), f("b", 0), f("c", 0), f("d", 0)], &b)
            .unwrap()
            .contains("4 changed files"));
        assert_eq!(COMMIT_BUDGET.max_file_bytes, 50 * 1024 * 1024);
        assert_eq!(COMMIT_BUDGET.max_total_bytes, 200 * 1024 * 1024);
        assert_eq!(COMMIT_BUDGET.max_files, 20_000);
    }

    #[test]
    fn status_records_become_paths() {
        assert_eq!(
            parse_status_z(" M README.md\0?? new dir/file.txt\0 D gone.rs\0"),
            vec!["README.md", "new dir/file.txt", "gone.rs"]
        );
        assert!(parse_status_z("").is_empty());
    }

    #[test]
    fn submodules_are_read_from_the_index_and_from_what_it_stages() {
        let staged = [
            "100644 78981922613b2afb6025042ff6bd878ac1994e85 0\ta.txt",
            "160000 d03f28fbe49d208468000c034140f6ba5424a5dc 0\tvendor/lib",
            "120000 aaaa 0\tlink",
            "",
        ]
        .join("\0");
        assert_eq!(parse_gitlinks_z(&staged), vec!["vendor/lib"]);
        assert!(parse_gitlinks_z("").is_empty());
        let raw = format!(
            ":000000 160000 {z} {s} A\0sub\0:100644 100644 {s} {s} M\0README.md\0:160000 160000 {s} {z} M\0lib\0\
             :160000 000000 {s} {z} D\0gone\0",
            z = "0".repeat(40),
            s = "a".repeat(40)
        );
        assert_eq!(new_gitlinks(&raw), vec!["sub", "lib"], "added or moved, never removed");
        assert!(new_gitlinks("").is_empty());
    }

    #[test]
    fn a_git_folder_or_file_below_the_worktrees_own_is_found_in_any_case() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(wt.join("src/deep/er")).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /x\n").unwrap();
        std::fs::write(wt.join("src/.gitignore"), "x\n").unwrap();
        std::fs::create_dir_all(wt.join("src/.github")).unwrap();
        std::fs::create_dir_all(wt.join("x.git")).unwrap();
        assert_eq!(nested_gits(&wt, 10), Ok(vec![]), "the worktree's own link and look-alikes");
        for (nested, kind) in [
            ("src/deep/er/.git", "folder"),
            ("src/.git", "file"),
            ("src/deep/.GIT", "folder"),
            ("src/.Git", "symlink"),
        ] {
            let p = wt.join(nested);
            match kind {
                "folder" => std::fs::create_dir(&p).unwrap(),
                "file" => std::fs::write(&p, "gitdir: /elsewhere\n").unwrap(),
                _ => std::os::unix::fs::symlink(dir.path(), &p).unwrap(),
            }
            assert_eq!(nested_gits(&wt, 10), Ok(vec![PathBuf::from(nested)]), "{nested}");
            if kind == "folder" {
                std::fs::remove_dir(&p).unwrap();
            } else {
                std::fs::remove_file(&p).unwrap();
            }
        }
        // A symlink to a folder holding a repository is never followed.
        std::fs::create_dir_all(dir.path().join("other/.git")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("other"), wt.join("linked")).unwrap();
        assert_eq!(nested_gits(&wt, 10), Ok(vec![]));
        // Every one is found, up to one past the most it checks.
        for d in ["a/.git", "b/.git", "c/.git"] {
            std::fs::create_dir_all(wt.join(d)).unwrap();
        }
        assert_eq!(nested_gits(&wt, 10).unwrap().len(), 3);
        assert_eq!(nested_gits(&wt, 1).unwrap().len(), 2);
        for d in ["a", "b", "c"] {
            std::fs::remove_dir_all(wt.join(d)).unwrap();
        }
        // A folder it can't read fails the check.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let hidden = wt.join("src/deep");
            std::fs::set_permissions(&hidden, std::fs::Permissions::from_mode(0o000)).unwrap();
            let refused = nested_gits(&wt, 10);
            std::fs::set_permissions(&hidden, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(refused.is_err(), "{refused:?}");
        }
    }

    #[test]
    fn numstat_sums_lines_and_counts_binary_files() {
        assert_eq!(parse_numstat(""), (0, 0, 0));
        assert_eq!(
            parse_numstat("3\t1\tsrc/a.rs\n10\t0\tb.md\n-\t-\timg.png\n"),
            (3, 13, 1)
        );
    }
}
