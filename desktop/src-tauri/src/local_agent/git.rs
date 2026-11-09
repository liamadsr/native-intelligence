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
const DEFAULT_SUBJECT: &str = "Changes from Native Intelligence's local agent";
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
];

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

/// The summary's first non-empty line, at most [`SUBJECT_MAX`] characters.
pub fn commit_subject(summary: &str) -> String {
    let Some(line) = summary.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return DEFAULT_SUBJECT.into();
    };
    let line: String = line.chars().filter(|c| !c.is_control()).collect();
    if line.chars().count() <= SUBJECT_MAX {
        return line;
    }
    let mut cut: String = line.chars().take(SUBJECT_MAX - 1).collect();
    cut = cut.trim_end().to_string();
    cut.push('…');
    cut
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

    /// [`Git::run`] with more environment (a push's ssh-agent socket) and
    /// its own time limit.
    pub(super) async fn run_with(
        &self,
        dir: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<String, String> {
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
    pub async fn ensure_worktree(
        &self,
        repo: &Path,
        git_dir: &Path,
        root: &Path,
        job_id: &str,
        branch: &str,
        base: &Base,
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
        let exists = self
            .run(
                repo,
                &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
            )
            .await
            .is_ok();
        if exists {
            // Its worktree was deleted: drop the stale entry, check it out again.
            let _ = self.run(repo, &["worktree", "prune"]).await;
            self.run(repo, &["worktree", "add", "--quiet", dir_str, branch]).await?;
            check_worktree(&dir, git_dir)?;
            return Ok(Worktree {
                dir,
                branch: branch.to_string(),
                base: None,
                base_branch: None,
            });
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
        self.run(repo, &["worktree", "add", "--quiet", "-b", branch, dir_str, &start])
            .await?;
        check_worktree(&dir, git_dir)?;
        Ok(Worktree {
            dir,
            branch: branch.to_string(),
            base: Some(start),
            base_branch,
        })
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
    pub async fn stage(&self, worktree: &Path) -> Result<(), String> {
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
            return Ok(());
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

    /// Commit everything in the worktree on its branch.
    pub async fn commit(
        &self,
        worktree: &Path,
        git_dir: &Path,
        base: Option<&str>,
        summary: &str,
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
        self.stage(worktree).await?;
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

    #[test]
    fn branch_names_use_the_label_slug_and_the_job_short_id() {
        assert_eq!(
            branch_name("dial8-website", "38cb0eef-89e9-496d-bf08-0688225dbfcd"),
            "dial8/dial8-website-38cb0eef"
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
