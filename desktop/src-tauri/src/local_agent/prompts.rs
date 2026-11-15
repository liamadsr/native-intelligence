//! The launcher's questions for the person (teammate C3; plan §1, invariant
//! 5: anything outside the fence is asked in a native prompt on the Mac).
//!
//! A `prompt` line names a kind and carries a `detail`; this file checks the
//! detail and words the prompt. The prompt itself is drawn by Rust (the
//! actor's [`super::Host::ask`]: a system alert in the app, never the
//! webview, which runs code our server sends), and its answer goes back as
//! `prompt_answer`. Refused here means refused without asking.
//!
//! - **push** `{ title, body? }`: push the edit job's branch and open a pull
//!   request (C5, [`super::push`]). The branch and the remote are Rust's,
//!   never the launcher's.
//! - **fence** `{ path, access: "read", reason? }`: one more path to read,
//!   for this job only. **Fence grants are read-only** (C3): a write request
//!   is refused without asking, since an edit job only ever writes in its
//!   own worktree. Rust only asks and answers; the launcher widens its own
//!   fence for its process, and nothing is saved as a grant. The path is
//!   checked as a realpath, so a symlink into a refused place is refused, and
//!   the prompt shows the realpath the person is actually allowing. Rust's
//!   rules are at least as strict as the launcher's, all compared ignoring
//!   case (APFS does), as written and as realpaths. Never readable:
//!   - credentials, Native Intelligence's data, `~/Library`, or a hidden entry at HOME's
//!     top (settings, history, tokens), nor where one really lives when it
//!     is a symlink (a `~/.zshrc` kept in `~/dotfiles`), nor where an entry
//!     of a credentials folder really lives (a `~/.aws/credentials` kept in
//!     `~/Dropbox`), nor the keys and certificates `~/.ssh/config` names
//!     ([`ssh_config`]);
//!   - other people's home folders, other disks (`/Volumes`) and temporary
//!     folders (`/private/tmp`, `/private/var/folders`).
//!
//!   The write rules stay behind that refusal, as defense in depth: a write
//!   only inside HOME, never where Rust runs programs, git reads config or
//!   ssh runs commands from outside the sandbox ([`FenceRules::never_write`],
//!   [`git_config_paths`], [`ssh_config`]), nor any folder holding one, and
//!   never in or above the person's checkout, nor in a `.git`, `*.git` or
//!   `.husky`.
//!
//! Either kind carries `detail.timeoutMs`, how long the launcher still waits
//! for that ask (C3: 10,000 to 1,800,000 ms). Rust closes the alert and
//! answers no 2 s before it passes ([`answer_within`]): the launcher counts
//! from when it wrote the line, so a click can never act after the launcher
//! has taken the answer as no.
//!
//! Rust asks one question of its own, with no `prompt` line behind it: a
//! **worker's confirm** ([`worker_prompt`], P1-1, [`super::starts`]), before
//! the person's own coding CLI runs with network access for a cloud agent or
//! a loop. Its facts are Rust's: the folder, the worker, the job's request.
//!
//! **The alert** ([`show_alert`]) is `CFUserNotificationDisplayAlert`: drawn
//! by macOS, on the calling thread, with a timeout. Deny is the default
//! button, so Return, Esc, a timeout or a failure all answer no; only a click
//! on the allow button allows.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use super::folder;
use super::push::{Change, Changed};

pub const PUSH_ALLOW: &str = "Push and open PR";
pub const PUSH_DENY: &str = "Not now";
pub const FENCE_ALLOW: &str = "Allow for this job";
pub const FENCE_DENY: &str = "Don't allow";
/// A worker's confirm: allow is "Run Claude Code" ([`worker_prompt`]).
pub const WORKER_DENY: &str = "Don't run";

/// A pull request's title and body, at most, in characters (longer is cut).
const MAX_TITLE: usize = 256;
const MAX_BODY: usize = 60_000;
/// A fence path, at most, in bytes.
const MAX_PATH_BYTES: usize = 1_024;
const MAX_REASON: usize = 300;
/// The bounds on a prompt's `timeoutMs`. The launcher sends 10 s to 30 min;
/// Rust takes anything from 1 s as it is, so it never lengthens a wait and
/// its deadline is never later than the launcher's.
pub const MIN_TIMEOUT: Duration = Duration::from_secs(1);
pub const MAX_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// How much of the title, the reason and a path a prompt shows.
const SHOWN_TITLE: usize = 120;
const SHOWN_REASON: usize = 200;
const SHOWN_PATH: usize = 200;
/// A base branch, all of it ([`super::git::MAX_BASE_BRANCH`]).
const SHOWN_BASE: usize = super::git::MAX_BASE_BRANCH;
/// One changed file's path in a push prompt (its end, when cut).
const SHOWN_FILE: usize = 100;
/// A worker's task in its confirm.
const SHOWN_REQUEST: usize = 300;
/// The start of a pull request's description in its push prompt, and how
/// many of the issues it closes are named.
const SHOWN_BODY: usize = 280;
const SHOWN_CLOSES: usize = 5;

/// Folders of credentials: each entry's realpath is read-protected too, as
/// dotfile managers (Mackup, stow) symlink them into synced folders.
const CREDENTIAL_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".docker",
    ".kube",
    ".config/gh",
    ".codex",
    ".cargo",
];

/// Outside HOME, never read: other people's homes, other disks, temporary
/// folders (other apps' files, sockets and downloads).
const OUTSIDE_HOME_REFUSED: &[&str] = &[
    "/Users",
    "/Volumes",
    "/private/tmp",
    "/private/var/folders",
    "/private/var/root",
];

/// Why a fence write is refused, before anything is checked or asked.
pub const FENCE_READ_ONLY: &str =
    "fence grants are read-only: a local agent changes files only in its own copy, on the job's branch";

/// Credentials and Native Intelligence's own data under HOME: a fence never reaches them,
/// nor anything containing them (`~/.config` holds gh's token).
const HOME_DENIED: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gh",
    ".netrc",
    ".git-credentials",
    ".docker",
    ".kube",
    ".npmrc",
    ".pypirc",
    ".dial8",
];

/// One native question: the alert's bold line, its text and its buttons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativePrompt {
    pub title: String,
    pub body: String,
    pub allow: String,
    pub deny: String,
    /// A caution icon: the answer widens what the agent can reach.
    pub warning: bool,
}

/// `push`'s detail.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PushAsk {
    pub title: String,
    pub body: String,
    /// This repository's issues the description closes when merged (`#12`),
    /// once [`PushAsk::made_inert`]: the prompt lists them.
    pub closes: Vec<String>,
    /// Mentions, other repositories' closing references or hidden comments
    /// were made inert: the prompt says so.
    pub inert: bool,
    /// The description holds HTML (left as it is): the prompt says so.
    pub html: bool,
}

/// GitHub's longest pull request body, in characters.
const GITHUB_MAX_BODY: usize = 65_536;

/// `text` made inert ([`super::pr_text`]), at most `max` characters: the
/// text is cut BEFORE the change (a cut never splits a code span the change
/// made), shorter each round until the result fits.
fn inert_within(text: &str, repo: Option<&str>, max: usize) -> super::pr_text::Inert {
    let mut keep = text.chars().count();
    loop {
        let source = if keep < text.chars().count() { cut(text, keep.max(1)) } else { text.to_string() };
        let made = super::pr_text::make_inert(&source, repo, super::pr_text::Kind::Description);
        let len = made.text.chars().count();
        if len <= max || keep <= 1 {
            return made;
        }
        // Over by `len - max`: drop at least that much of the source (more
        // when a comment ate the cut part).
        keep = keep.saturating_sub((len - max).max(keep / 8).max(1));
    }
}

impl PushAsk {
    /// Every push goes through here before it is asked about (our own
    /// agent's and a coding agent's alike): the title and description made
    /// inert for the pull request's repository (`host/owner/name`, when
    /// known), and the description's same-repository closing references
    /// kept for the prompt to list.
    pub fn made_inert(self, repo: Option<&str>) -> PushAsk {
        let slug = repo.and_then(|r| r.split_once('/')).map(|(_, slug)| slug);
        let title = inert_within(&self.title, slug, MAX_TITLE);
        let body = inert_within(&self.body, slug, GITHUB_MAX_BODY);
        // The title's too: on a squash merge it becomes the commit's
        // subject, and closes what it names.
        let mut closes: Vec<String> = Vec::new();
        for c in title.closes.iter().chain(body.closes.iter()) {
            if !closes.contains(c) {
                closes.push(c.clone());
            }
        }
        let inert = title.changed() || body.changed();
        // Spaces a removed comment left, collapsed; never [`one_line`],
        // which would drop the zero-width spaces that keep mentions inert.
        let title = match title.text.split_whitespace().collect::<Vec<_>>().join(" ") {
            t if t.is_empty() => super::git::DEFAULT_SUBJECT.to_string(),
            t => t,
        };
        PushAsk {
            html: body.html,
            title,
            inert,
            body: body.text,
            closes,
        }
    }

    /// The prompt's lines about the description: its start (whitespace
    /// collapsed), the issues it closes, and whether anything was made inert.
    fn described(&self) -> String {
        let mut parts = Vec::new();
        let flat = one_line(&self.body);
        if !flat.is_empty() {
            let n = flat.chars().count();
            if n <= SHOWN_BODY {
                parts.push(format!("Description: {flat}"));
            } else {
                let start: String = flat.chars().take(SHOWN_BODY).collect();
                parts.push(format!("Description: {}\u{2026} ({} characters)", start.trim_end(), thousands(n)));
            }
        }
        let mut notes = Vec::new();
        if !self.closes.is_empty() {
            let shown: Vec<&str> = self.closes.iter().take(SHOWN_CLOSES).map(String::as_str).collect();
            let more = self.closes.len().saturating_sub(SHOWN_CLOSES);
            let more = if more > 0 { format!(" and {more} more") } else { String::new() };
            notes.push(format!("Closes when merged: {}{more}", shown.join(", ")));
        }
        if self.inert {
            notes.push("Mentions, other repositories' issue links and hidden comments in it were made inert.".to_string());
        }
        if self.html {
            notes.push("It contains HTML: some of it may be collapsed or not shown as written.".to_string());
        }
        if !notes.is_empty() {
            parts.push(notes.join("\n"));
        }
        parts.join("\n\n")
    }
}

/// 2340 → "2,340".
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

impl PushAsk {
    pub fn parse(detail: &Value) -> Result<Self, String> {
        let title = detail
            .get("title")
            .and_then(Value::as_str)
            .map(one_line)
            .filter(|t| !t.is_empty())
            .ok_or("a push needs a pull request title")?;
        let body = match detail.get("body") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(b)) => b
                .chars()
                .filter(|c| (!c.is_control() || matches!(c, '\n' | '\t')) && !is_format_char(*c))
                .collect(),
            Some(_) => return Err("the pull request body must be text".into()),
        };
        Ok(PushAsk {
            title: cut(&title, MAX_TITLE),
            body: cut(&body, MAX_BODY),
            ..PushAsk::default()
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Write => "write",
        }
    }

    /// Already allowed `self` covers a request for `want`.
    pub fn covers(self, want: Access) -> bool {
        self == Access::Write || want == Access::Read
    }
}

/// `fence`'s detail.
#[derive(Debug, Clone, PartialEq)]
pub struct FenceAsk {
    pub path: String,
    pub access: Access,
    pub reason: Option<String>,
}

impl FenceAsk {
    pub fn parse(detail: &Value) -> Result<Self, String> {
        let path = detail
            .get("path")
            .and_then(Value::as_str)
            .ok_or("a fence request needs a path")?;
        if path.len() > MAX_PATH_BYTES || path.chars().any(|c| c.is_control() || is_format_char(c)) {
            return Err("that path is too long or has control or invisible formatting characters".into());
        }
        if !Path::new(path).is_absolute() {
            return Err("a fence request needs an absolute path".into());
        }
        let access = match detail.get("access").and_then(Value::as_str) {
            Some("read") => Access::Read,
            Some("write") => Access::Write,
            _ => return Err("access must be \"read\" or \"write\"".into()),
        };
        let reason = detail
            .get("reason")
            .and_then(Value::as_str)
            .map(one_line)
            .filter(|r| !r.is_empty())
            .map(|r| cut(&r, MAX_REASON));
        Ok(FenceAsk {
            path: path.to_string(),
            access,
            reason,
        })
    }
}

/// Rust answers no this much before the launcher's own deadline: the
/// launcher counts its `timeoutMs` from when it wrote the line, a little
/// before the line arrived here.
pub const DEADLINE_MARGIN: Duration = Duration::from_secs(2);

/// Rust's deadline for a prompt the launcher waits `wait` for: 2 s sooner,
/// or half as long for a wait too short for that.
pub fn answer_within(wait: Duration) -> Duration {
    wait.saturating_sub(DEADLINE_MARGIN).max(wait / 2)
}

/// How long the launcher waits for a prompt: its `timeoutMs`, within
/// [`MIN_TIMEOUT`] and [`MAX_TIMEOUT`], else `default`.
pub fn prompt_timeout(detail: &Value, default: Duration) -> Duration {
    detail
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .map(|ms| Duration::from_millis(ms).clamp(MIN_TIMEOUT, MAX_TIMEOUT))
        .unwrap_or(default)
}

/// Where a fence request may not reach.
pub struct FenceRules<'a> {
    pub home: &'a Path,
    pub protected: &'a [PathBuf],
    /// The job's grant folder (the person's checkout): never written by a
    /// fence, whatever its mode.
    pub own: &'a Path,
    /// What Rust runs outside the sandbox: the tool PATH's folders, git, gh,
    /// ssh, the login shell, node, the launcher and the agent, the app.
    /// Never written, nor anything containing them.
    pub never_write: &'a [PathBuf],
}

/// `p`'s components, case-folded: APFS ignores case, so `~/.SSH` is `~/.ssh`.
fn folded(p: &Path) -> Vec<String> {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// `p` (folded) is `root` or inside it, ignoring case.
fn within(p: &[String], root: &Path) -> bool {
    p.starts_with(&folded(root))
}

/// One of `p` (folded) and `q` holds the other, ignoring case.
fn overlaps(p: &[String], q: &Path) -> bool {
    let q = folded(q);
    p.starts_with(&q) || q.starts_with(p)
}

/// The realpath the person would allow, or why it is refused without
/// asking. A path that doesn't exist yet is its parent's realpath plus its
/// name (a file the agent wants to create).
pub fn check_fence(ask: &FenceAsk, rules: &FenceRules<'_>) -> Result<PathBuf, String> {
    let asked = Path::new(&ask.path);
    let real = match std::fs::canonicalize(asked) {
        Ok(r) => r,
        Err(_) => {
            let (Some(parent), Some(Component::Normal(name))) = (asked.parent(), asked.components().next_back()) else {
                return Err(format!("{} doesn't exist", ask.path));
            };
            let parent = std::fs::canonicalize(parent).map_err(|_| format!("{} doesn't exist", ask.path))?;
            parent.join(name)
        }
    };
    let Some(s) = real.to_str() else {
        return Err("that path is not valid UTF-8".into());
    };
    if s.contains('"') || s.chars().any(|c| c.is_control() || is_format_char(c)) {
        return Err("that path contains a quote, a control or an invisible formatting character".into());
    }
    let refuse = |why: &str| Err(format!("{} can't be opened to a local agent: {why}", real.display()));
    let f = folded(&real);
    // The path as asked, too: a symlink on the way never hides what it is.
    let written = folded(&lexical(asked));
    let home = folded(rules.home);
    let system_wide = folder::EXACT_REFUSED.iter().any(|p| f == folded(Path::new(p)));
    if system_wide || f == home || home.starts_with(&f) {
        return refuse("it is far too wide");
    }
    if within(&f, Path::new("/System")) {
        return refuse("it is part of macOS");
    }
    if rules.protected.iter().any(|p| overlaps(&f, p)) {
        return refuse("it holds Native Intelligence's own data");
    }
    if within(&f, &rules.home.join("Library")) && !within(&f, &rules.home.join(folder::ICLOUD_DRIVE)) {
        return refuse("your Library holds keychains, mail, browser and app data");
    }
    if HOME_DENIED.iter().any(|d| overlaps(&f, &rules.home.join(d))) {
        return refuse("it holds credentials or Native Intelligence's own data");
    }
    // Hidden entries at the top of HOME hold settings, history and
    // credentials: never read or written, nor where they really live (a
    // `~/.zshrc` or `~/.ssh` that is a symlink into some other folder).
    let hidden = |p: &[String]| p.starts_with(&home) && p.get(home.len()).is_some_and(|top| top.starts_with('.'));
    if hidden(&f) || hidden(&written) {
        return refuse(
            "the hidden files and folders at the top of your home folder hold settings, history and credentials",
        );
    }
    let outside = |p: &[String]| !p.starts_with(&home) && OUTSIDE_HOME_REFUSED.iter().any(|r| within(p, Path::new(r)));
    if outside(&f) || outside(&written) {
        return refuse("it is another person's home folder, another disk or a temporary folder");
    }
    if hidden_targets(rules.home).iter().any(|t| overlaps(&f, t)) {
        return refuse("it holds the real files behind a hidden entry of your home folder (settings or credentials)");
    }
    let ssh = ssh_config(rules.home);
    if ssh.secrets.iter().any(|t| overlaps(&f, t) || overlaps(&written, t)) {
        return refuse("it holds a key or certificate your ssh config uses");
    }
    if ask.access == Access::Write {
        if !f.starts_with(&home) {
            return refuse("changes can only be opened inside your home folder");
        }
        // As written and as a realpath, both ways: a PATH entry that is a
        // symlink inside the folder counts, and so does one it points into.
        let runs = rules.never_write.iter().chain(&ssh.programs).any(|p| {
            let real_p = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
            [&f, &written]
                .into_iter()
                .any(|q| overlaps(q, p) || overlaps(q, &real_p))
        });
        if runs {
            return refuse("Native Intelligence runs programs or reads its config from there outside the sandbox");
        }
        if overlaps(&f, rules.own) || overlaps(&written, rules.own) {
            return refuse(
                "that is your own copy of the shared folder, or holds it; its changes go on the job's branch",
            );
        }
        // A repo's own data or hooks: `.git`, a bare `name.git`, `.husky`.
        if f.iter().any(|c| c.ends_with(".git") || c == ".husky") {
            return refuse("that is git's own data or its hooks");
        }
    }
    Ok(real)
}

/// `p` with `.` and `..` resolved by text alone (no file system).
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The realpaths of `dir`'s entries that are symlinks to somewhere else
/// (`hidden`: only the hidden ones).
fn linked_entries(dir: &Path, hidden: bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if hidden && !entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if let Ok(real) = std::fs::canonicalize(&path) {
            if real != path {
                out.push(real);
            }
        }
    }
}

/// Where HOME's hidden top-level entries, the credential places, and the
/// entries of each credentials folder really are, when they are symlinks to
/// somewhere else (`~/.aws/credentials` → `~/Dropbox/…`).
fn hidden_targets(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    linked_entries(home, true, &mut out);
    out.extend(
        HOME_DENIED
            .iter()
            .filter_map(|d| std::fs::canonicalize(home.join(d)).ok()),
    );
    for dir in CREDENTIAL_DIRS {
        linked_entries(&home.join(dir), false, &mut out);
    }
    out
}

/// What `~/.ssh/config`, and the files it `Include`s, points at.
#[derive(Debug, Default, PartialEq)]
pub struct SshConfig {
    /// `IdentityFile` and `CertificateFile`: never readable. A path with an
    /// unexpanded `%` token stands for its folder.
    pub secrets: Vec<PathBuf>,
    /// `ProxyCommand`, `KnownHostsCommand` and `Match exec` programs named
    /// by path: ssh runs them as the person, so never writable.
    pub programs: Vec<PathBuf>,
}

/// Config files read at most, and the size of one.
const SSH_MAX_FILES: usize = 32;
const SSH_MAX_BYTES: u64 = 1024 * 1024;

pub fn ssh_config(home: &Path) -> SshConfig {
    let mut out = SshConfig::default();
    let mut queue = vec![home.join(".ssh/config")];
    let mut read = 0;
    while let Some(file) = queue.pop() {
        read += 1;
        if read > SSH_MAX_FILES {
            break;
        }
        if std::fs::metadata(&file).map_or(true, |m| !m.is_file() || m.len() > SSH_MAX_BYTES) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let split = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
            let (key, rest) = line.split_at(split);
            let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
            let args = ssh_args(rest);
            match key.to_ascii_lowercase().as_str() {
                "include" => {
                    for pattern in &args {
                        queue.extend(ssh_glob(&ssh_path(pattern, home)));
                    }
                }
                "identityfile" | "certificatefile" => {
                    if let Some(arg) = args.first().filter(|a| !a.eq_ignore_ascii_case("none")) {
                        out.secrets.push(secret_path(&ssh_path(arg, home)));
                    }
                }
                "proxycommand" | "knownhostscommand" => {
                    let words: Vec<&str> = rest.split_whitespace().collect();
                    let word = match words.as_slice() {
                        ["exec", w, ..] => Some(*w),
                        [w, ..] => Some(*w),
                        [] => None,
                    };
                    out.programs.extend(word.and_then(|w| program_path(w, home)));
                }
                "match" => {
                    let exec = args.iter().position(|a| a.eq_ignore_ascii_case("exec"));
                    let command = exec.and_then(|i| args.get(i + 1));
                    let word = command.and_then(|c| c.split_whitespace().next());
                    out.programs.extend(word.and_then(|w| program_path(w, home)));
                }
                _ => {}
            }
        }
    }
    out
}

/// ssh's arguments: whitespace-separated, `"…"` kept whole.
fn ssh_args(rest: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        args.push(cur);
    }
    args
}

/// An ssh config path: `~/` and `%d` are HOME, a relative one is in `~/.ssh`.
fn ssh_path(p: &str, home: &Path) -> PathBuf {
    let p = p.replace("%d", &home.to_string_lossy());
    let path = if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(&p).is_absolute() {
        PathBuf::from(&p)
    } else {
        home.join(".ssh").join(&p)
    };
    lexical(&path)
}

/// A key path with a `%` token left (`id_%h`) stands for its folder.
fn secret_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.find('%') {
        None => p.to_path_buf(),
        Some(i) if s[..i].ends_with('/') => PathBuf::from(s[..i].trim_end_matches('/')),
        Some(i) => Path::new(&s[..i])
            .parent()
            .map_or_else(|| p.to_path_buf(), Path::to_path_buf),
    }
}

/// A command's program when it is named by path (`/…` or `~/…`).
fn program_path(word: &str, home: &Path) -> Option<PathBuf> {
    let word = word.trim_matches('"');
    if word.starts_with('/') || word.starts_with("~/") {
        Some(ssh_path(word, home))
    } else {
        None
    }
}

/// The files a `*` / `?` pattern in the last part of `p` matches.
fn ssh_glob(p: &Path) -> Vec<PathBuf> {
    let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![p.to_path_buf()];
    }
    let Some(dir) = p.parent() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| wildcard(&name, &e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    found.sort();
    found
}

/// `pattern` (with `*` and `?`) matches all of `text`.
fn wildcard(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a == b => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    go(&p, &t)
}

/// What the person's git reads and runs, from `git config --list
/// --show-origin --show-scope -z` run as them in their checkout `dir`:
/// every config file (`file:` origins, relative ones against `dir`), every
/// `include.path` / `includeIf.*.path` (even one whose condition doesn't
/// match here, or that doesn't exist yet), and the programs git runs from
/// config (`core.sshCommand`, credential helpers, filters, a remote's
/// receive-pack, gpg) when named by path. A fence never writes any of them,
/// nor a folder holding one.
pub fn git_config_paths(out: &str, dir: &Path, home: &Path) -> Vec<PathBuf> {
    let expand = |v: &str, base: &Path| -> Option<PathBuf> {
        let v = v.trim();
        if v.is_empty() {
            return None;
        }
        let p = if let Some(rest) = v.strip_prefix("~/") {
            home.join(rest)
        } else if Path::new(v).is_absolute() {
            PathBuf::from(v)
        } else {
            base.join(v)
        };
        Some(lexical(&p))
    };
    let mut paths = Vec::new();
    let fields: Vec<&str> = out.split('\0').collect();
    for record in fields.chunks(3) {
        let [_scope, origin, kv] = record else { continue };
        let file = origin.strip_prefix("file:").and_then(|f| expand(f, dir));
        let config_dir = file
            .as_ref()
            .and_then(|f| f.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| dir.to_path_buf());
        paths.extend(file);
        let (key, value) = kv.split_once('\n').unwrap_or((kv, ""));
        let key = key.to_ascii_lowercase();
        let parts: Vec<&str> = key.split('.').collect();
        let (first, last) = (
            parts.first().copied().unwrap_or(""),
            parts.last().copied().unwrap_or(""),
        );
        let include = matches!(first, "include" | "includeif") && last == "path";
        let program = matches!(key.as_str(), "core.sshcommand" | "core.askpass" | "gpg.program")
            || (first == "credential" && last == "helper")
            || (first == "filter" && matches!(last, "clean" | "smudge" | "process"))
            || (first == "remote" && matches!(last, "receivepack" | "uploadpack"))
            || (first == "gpg" && last == "program");
        if include {
            paths.extend(expand(value, &config_dir));
        } else if program {
            let command = value.trim().trim_start_matches('!').trim_start();
            let word = command.split_whitespace().next().unwrap_or("");
            if word.starts_with('/') || word.starts_with("~/") {
                paths.extend(expand(word, &config_dir));
            }
        }
    }
    paths
}

/// What a push prompt names: the branch, the commit it was asked about, the
/// remote, and the repository the pull request opens in (`host/owner/repo`)
/// when the push URL names one.
pub struct PushWhere<'a> {
    pub branch: &'a str,
    pub commit: &'a str,
    pub remote: &'a str,
    pub repo: Option<&'a str>,
    /// The shared folder's name.
    pub label: &'a str,
    /// The local branch the job's branch started from, when its start named
    /// one (`baseBranch`); `None`: it started from HEAD, and the title is as
    /// it always was.
    pub base: Option<&'a str>,
    /// What the push sends besides that commit ([`super::push::what_it_sends`]).
    pub sends: super::push::Sends,
    /// The files the job's commits change ([`super::push::changed_files`]).
    pub files: &'a Changed,
}

/// What a push sends, for the prompt's last sentence: "only that commit",
/// or every commit the remote lacks (the push takes them all along).
fn what_it_sends(at: &PushWhere<'_>) -> String {
    let n = |count: u64, what: &str| {
        if count == 1 {
            format!("1 {what}")
        } else {
            format!("{count} {what}s")
        }
    };
    let s = at.sends;
    if s.earlier == 0 {
        return match s.job {
            0 | 1 => "only that commit".into(),
            job => format!("{}, ending with that one", n(job, "commit")),
        };
    }
    let own = match s.job {
        0 | 1 => "that commit".to_string(),
        job => format!("this job's {}", n(job, "commit")),
    };
    let from = at
        .base
        .map(|b| shown(b, SHOWN_BASE))
        .unwrap_or_else(|| "your checkout".into());
    format!(
        "{own} and {} from {from} that {} doesn't have",
        n(s.earlier, "earlier commit"),
        shown(at.remote, 40)
    )
}

/// The push prompt's last paragraph: "Changed files (3):", one path a line
/// (marked when new or deleted), at most [`super::push::SHOWN_FILES`], then
/// "+N more".
fn changed_lines(c: &Changed) -> String {
    if c.total == 0 {
        return "It changes no files.".into();
    }
    let mut lines = vec![format!("Changed files ({}):", c.total)];
    for (path, how) in &c.files {
        let path = shown_end(path, SHOWN_FILE);
        lines.push(match how {
            Change::Added => format!("{path} (new)"),
            Change::Deleted => format!("{path} (deleted)"),
            Change::Modified => path,
        });
    }
    if c.total > c.files.len() {
        lines.push(format!("+{} more", c.total - c.files.len()));
    }
    lines.join("\n")
}

/// "Push dial8/x to github.com/o/r and open a pull request?", or with a base
/// branch, "Push dial8/x (from main) to github.com/o/r and open a pull
/// request?": what the push goes on top of. The body says what it sends:
/// "only that commit", or also the earlier commits the remote doesn't have
/// (then it is drawn as a warning), and then the files the job changed.
/// Between the title and that, the description as it will be published
/// ([`PushAsk::made_inert`]): its start, the issues it closes, and a line
/// when anything in it was made inert.
pub fn push_prompt(at: &PushWhere<'_>, ask: &PushAsk) -> NativePrompt {
    let short: String = at.commit.chars().take(7).collect();
    let from = at
        .base
        .map(|b| format!(" (from {})", shown(b, SHOWN_BASE)))
        .unwrap_or_default();
    NativePrompt {
        title: format!(
            "Push {}{from} to {} and open a pull request?",
            shown(at.branch, 80),
            shown(at.repo.unwrap_or(at.remote), 80)
        ),
        body: format!(
            "\u{201C}{}\u{201D}\n\n{}Commit {short}, from Native Intelligence's agent in {}. This runs git push to {} with your \
             own git login, and pushes {}.\n\n{}",
            shown(&ask.title, SHOWN_TITLE),
            match ask.described() {
                d if d.is_empty() => d,
                d => format!("{d}\n\n"),
            },
            shown(at.label, 60),
            shown(at.remote, 40),
            what_it_sends(at),
            changed_lines(at.files)
        ),
        allow: PUSH_ALLOW.into(),
        deny: PUSH_DENY.into(),
        warning: at.sends.earlier > 0,
    }
}

/// "Let Native Intelligence's agent read <path>?" (fence grants are read-only).
pub fn fence_prompt(real: &Path, label: &str, reason: Option<&str>) -> NativePrompt {
    let path = shown(&real.display().to_string(), SHOWN_PATH);
    let title = format!("Let Native Intelligence's agent read {path}?");
    let mut body = format!(
        "The local agent working in {} asked to read this; it can't change it. It lasts for this job only \
         and isn't added to your shared folders.",
        shown(label, 60)
    );
    if let Some(reason) = reason {
        body.push_str(&format!(
            "\n\nIts reason: \u{201C}{}\u{201D}",
            shown(reason, SHOWN_REASON)
        ));
    }
    NativePrompt {
        title,
        body,
        allow: FENCE_ALLOW.into(),
        deny: FENCE_DENY.into(),
        warning: true,
    }
}

/// What a worker's confirm is for: its job's first launch, or a resume,
/// with the message the resume delivers first when the relay sent one
/// along (Rust delivers exactly that one, so what is shown is what runs).
#[derive(Debug, Clone, Copy)]
pub enum WorkerLaunch<'a> {
    Start,
    Resume { message: Option<&'a str> },
}

/// "Let Claude Code work in site?" (a resume: "continue"), before the
/// person's own CLI first runs in a folder for a cloud agent or a loop
/// (P1-1). The folder, the worker's `name` (its label in the bundle's
/// registry, plain ASCII words), the job's request and the message are
/// Rust's; it says a yes is remembered for this folder until the worker is
/// switched off ([`super::starts`]). Deny is the default, and no answer
/// within `wait` is a no.
pub fn worker_prompt(
    name: &str,
    label: &str,
    path: &str,
    request: &str,
    launch: WorkerLaunch<'_>,
    wait: Duration,
) -> NativePrompt {
    let task = format!("\u{201C}{}\u{201D}", shown(request, SHOWN_REQUEST));
    let (verb, what) = match launch {
        WorkerLaunch::Start => ("work", format!("Its task: {task}")),
        WorkerLaunch::Resume { message: Some(m) } => (
            "continue",
            format!(
                "Its task: {task}\n\nThe message it runs now: \u{201C}{}\u{201D}",
                shown(m, SHOWN_REQUEST)
            ),
        ),
        WorkerLaunch::Resume { message: None } => (
            "continue",
            format!("Its task: {task}\n\nIt continues with a new message from Native Intelligence."),
        ),
    };
    NativePrompt {
        title: format!("Let {name} {verb} in {}?", shown(label, 60)),
        body: format!(
            "A Native Intelligence cloud agent or one of your loops wants to run your own {name}, on your own account and with \
             network access, in {}.\n\n{what}\n\nA yes is remembered for this folder: {name} can then work here whenever \
             Native Intelligence asks, without asking again, until you switch {name} off in the menu bar. That covers \
             reading and, when you have shared the folder for editing, changing files there. With no answer within {}, it \
             doesn't run.",
            shown(path, SHOWN_PATH),
            super::human(wait)
        ),
        allow: format!("Run {name}"),
        deny: WORKER_DENY.into(),
        warning: true,
    }
}

/// Unicode format characters (bidi overrides such as U+202E, zero-width
/// ones): invisible, and able to make an alert read differently from what it
/// allows. Shown text drops them; fence paths with them are refused.
fn is_format_char(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// Control and format characters gone, whitespace runs one space, trimmed.
fn one_line(s: &str) -> String {
    let visible: String = s.chars().filter(|c| !is_format_char(*c)).collect();
    visible
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// At most `max` characters, the last one `…` when cut.
fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('\u{2026}');
    out
}

pub(super) fn shown(s: &str, max: usize) -> String {
    cut(&one_line(s), max)
}

/// [`shown`], cut from the start: a long path keeps its file name.
fn shown_end(s: &str, max: usize) -> String {
    let line = one_line(s);
    let n = line.chars().count();
    if n <= max {
        return line;
    }
    let tail: String = line.chars().skip(n - (max - 1)).collect();
    format!("\u{2026}{tail}")
}

/// `CFUserNotificationDisplayAlert`'s responses (the low two bits).
const ALTERNATE_RESPONSE: u64 = 1;
const RESPONSE_MASK: u64 = 0x3;

/// The alert's buttons: deny is the default (Return), allow the alternate.
pub fn alert_buttons(p: &NativePrompt) -> (&str, &str) {
    (&p.deny, &p.allow)
}

/// Only the alternate button, allow, is a yes. The default button (deny,
/// Return), a cancel, a timeout or a failed call are a no.
pub fn alert_allowed(rc: i32, response: u64) -> bool {
    rc == 0 && response & RESPONSE_MASK == ALTERNATE_RESPONSE
}

/// Show the alert and wait for it, on this thread, for at most `timeout`;
/// macOS closes it then. True only for a click on allow.
#[cfg(target_os = "macos")]
pub fn show_alert(p: &NativePrompt, timeout: Duration) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use std::os::raw::{c_ulong, c_void};

    const NOTE_LEVEL: c_ulong = 1;
    const CAUTION_LEVEL: c_ulong = 2;
    const CANCEL_RESPONSE: c_ulong = 3;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFUserNotificationDisplayAlert(
            timeout: f64,
            flags: c_ulong,
            icon_url: *const c_void,
            sound_url: *const c_void,
            localization_url: *const c_void,
            alert_header: CFStringRef,
            alert_message: CFStringRef,
            default_button_title: CFStringRef,
            alternate_button_title: CFStringRef,
            other_button_title: CFStringRef,
            response_flags: *mut c_ulong,
        ) -> i32;
    }

    let (default, alternate) = alert_buttons(p);
    let header = CFString::new(&p.title);
    let message = CFString::new(&p.body);
    let default = CFString::new(default);
    let alternate = CFString::new(alternate);
    let level = if p.warning { CAUTION_LEVEL } else { NOTE_LEVEL };
    let mut response: c_ulong = CANCEL_RESPONSE;
    // SAFETY: the strings outlive the call; null URLs and a null third button
    // are allowed; it blocks only this thread until an answer or the timeout.
    let rc = unsafe {
        CFUserNotificationDisplayAlert(
            timeout.as_secs_f64(),
            level,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            header.as_concrete_TypeRef(),
            message.as_concrete_TypeRef(),
            default.as_concrete_TypeRef(),
            alternate.as_concrete_TypeRef(),
            std::ptr::null(),
            &mut response,
        )
    };
    alert_allowed(rc, response as u64)
}

#[cfg(not(target_os = "macos"))]
pub fn show_alert(_p: &NativePrompt, _timeout: Duration) -> bool {
    false
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn push_details_need_a_title_and_are_cleaned_and_cut() {
        let ask = PushAsk::parse(&json!({"title":"  Fix\nthe\tlogin  ","body":"line 1\nline 2\u{0007}"})).unwrap();
        assert_eq!(ask.title, "Fix the login");
        assert_eq!(ask.body, "line 1\nline 2");
        assert_eq!(PushAsk::parse(&json!({"title":"t"})).unwrap().body, "");
        for bad in [json!({}), json!({"title":" \n "}), json!({"title":3}), json!(null)] {
            assert!(PushAsk::parse(&bad).is_err(), "{bad}");
        }
        assert!(PushAsk::parse(&json!({"title":"t","body":[1]})).is_err());
        let long = PushAsk::parse(&json!({"title":"é".repeat(300),"body":"b".repeat(70_000)})).unwrap();
        assert_eq!(long.title.chars().count(), MAX_TITLE);
        assert!(long.title.ends_with('\u{2026}'));
        assert_eq!(long.body.chars().count(), MAX_BODY);
    }

    #[test]
    fn fence_details_need_an_absolute_path_and_an_access() {
        let ask = FenceAsk::parse(&json!({"path":"/Users/x/lib","access":"write","reason":"to\nbuild"})).unwrap();
        assert_eq!(ask.path, "/Users/x/lib");
        assert_eq!(ask.access, Access::Write);
        assert_eq!(ask.reason.as_deref(), Some("to build"));
        assert_eq!(
            FenceAsk::parse(&json!({"path":"/a","access":"read"})).unwrap().reason,
            None
        );
        for bad in [
            json!({"path":"rel/path","access":"read"}),
            json!({"path":"/a","access":"all"}),
            json!({"path":"/a"}),
            json!({"access":"read"}),
            json!({"path":"/a\nb","access":"read"}),
            json!({"path":"/a/\u{202E}txt.exe","access":"read"}),
            json!({"path":format!("/{}", "a".repeat(1100)),"access":"read"}),
        ] {
            assert!(FenceAsk::parse(&bad).is_err(), "{bad}");
        }
        assert!(Access::Write.covers(Access::Read) && Access::Write.covers(Access::Write));
        assert!(Access::Read.covers(Access::Read) && !Access::Read.covers(Access::Write));
    }

    #[test]
    fn fences_never_reach_credentials_the_apps_data_or_the_persons_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let home = base.join("home");
        let data = base.join("data");
        let own = home.join("projects/site");
        for d in [
            &own,
            &home.join("code/lib/.git"),
            &home.join(".ssh"),
            &home.join(".config/gh"),
            &data,
        ] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::create_dir_all(home.join("Library/Mobile Documents/notes")).unwrap();
        std::fs::create_dir_all(own.join(".git")).unwrap();
        std::os::unix::fs::symlink(home.join(".ssh"), home.join("code/innocent")).unwrap();
        // Where Rust runs programs from: a tool PATH folder in HOME, the
        // app, and a git binary somewhere else.
        for d in ["bin", "go/bin", "Apps/Native Intelligence.app/Contents/Resources"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::write(home.join(".gitconfig"), "").unwrap();
        std::fs::write(home.join(".zshrc"), "").unwrap();
        std::fs::write(home.join(".zsh_history"), "").unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/auth.json"), "{}").unwrap();
        // Dotfiles that are symlinks into other folders: an rc file, and a
        // credentials folder kept elsewhere.
        std::fs::create_dir_all(home.join("dotfiles")).unwrap();
        std::fs::write(home.join("dotfiles/zprofile"), "").unwrap();
        std::os::unix::fs::symlink(home.join("dotfiles/zprofile"), home.join(".zprofile")).unwrap();
        std::fs::create_dir_all(home.join("keys/aws")).unwrap();
        std::os::unix::fs::symlink(home.join("keys/aws"), home.join(".aws")).unwrap();
        // A tool PATH entry that is a symlink inside a project to elsewhere.
        std::fs::create_dir_all(home.join("code/proj")).unwrap();
        std::fs::create_dir_all(base.join("elsewhere/bin")).unwrap();
        std::os::unix::fs::symlink(base.join("elsewhere/bin"), home.join("code/proj/bin")).unwrap();
        let protected = vec![data.clone()];
        let never_write = vec![
            home.join("bin"),
            home.join("go/bin"),
            home.join("Apps/Native Intelligence.app"),
            home.join("tools/git"),
            PathBuf::from("/usr/bin"),
            home.join("code/proj/bin"),
            // A git config file git reads (an includeIf'd one).
            home.join("work/.gitconfig"),
        ];
        let rules = FenceRules {
            home: &home,
            protected: &protected,
            own: &own,
            never_write: &never_write,
        };
        let check = |p: &Path, access: Access| {
            check_fence(
                &FenceAsk {
                    path: p.display().to_string(),
                    access,
                    reason: None,
                },
                &rules,
            )
        };
        assert_eq!(
            check(&home.join("code/lib"), Access::Read).unwrap(),
            home.join("code/lib")
        );
        assert_eq!(
            check(&home.join("code/lib"), Access::Write).unwrap(),
            home.join("code/lib")
        );
        // Not there yet: its parent's realpath plus its name.
        assert_eq!(
            check(&home.join("code/lib/new.txt"), Access::Write).unwrap(),
            home.join("code/lib/new.txt")
        );
        assert!(check(&home.join("nowhere/new.txt"), Access::Read).is_err());
        assert!(
            check(&home.join("code/lib/.."), Access::Read).is_ok(),
            "the realpath ~/code"
        );
        assert_eq!(
            check(&home.join("Library/Mobile Documents/notes"), Access::Read).unwrap(),
            home.join("Library/Mobile Documents/notes")
        );
        // Reading the checkout is fine; writing it never.
        assert!(check(&own, Access::Read).is_ok());
        let refused = [
            (home.join(".ssh"), Access::Read),
            (home.join(".ssh/id_ed25519"), Access::Read),
            (home.join("code/innocent"), Access::Read),
            (home.join(".config"), Access::Read),
            (home.join(".config/gh"), Access::Read),
            (home.join(".dial8/worktrees"), Access::Read),
            (home.clone(), Access::Read),
            (base.clone(), Access::Read),
            (PathBuf::from("/"), Access::Read),
            (data.join("local-agent/state.json"), Access::Read),
            (home.join("Library"), Access::Read),
            (home.join("Library/Keychains"), Access::Read),
            (own.join("src"), Access::Write),
            (own.clone(), Access::Write),
            (own.join(".git"), Access::Write),
            (home.join("code/lib/.git/config"), Access::Write),
            (home.join("code/mirror.git"), Access::Write),
            // Reads of hidden entries at HOME's top, as the launcher refuses.
            (home.join(".gitconfig"), Access::Read),
            (home.join(".zsh_history"), Access::Read),
            (home.join(".codex/auth.json"), Access::Read),
            // Where symlinked dotfiles really live: read or written.
            (home.join("dotfiles"), Access::Read),
            (home.join("dotfiles"), Access::Write),
            (home.join("dotfiles/zprofile"), Access::Write),
            (home.join("keys"), Access::Read),
            (home.join("keys/aws/credentials"), Access::Write),
            // A PATH entry that is a symlink inside the folder asked for.
            (home.join("code/proj"), Access::Write),
            // The folder holding a git config file.
            (home.join("work"), Access::Write),
            // An ancestor of the person's checkout.
            (home.join("projects"), Access::Write),
            (home.join("code/lib/.husky/pre-commit"), Access::Write),
            (home.join("code/lib/.HUSKY"), Access::Write),
            // Case doesn't matter on APFS.
            (home.join(".SSH"), Access::Read),
            (home.join(".Config/GH"), Access::Read),
            (home.join("LIBRARY/Keychains"), Access::Read),
            (own.join("SRC"), Access::Write),
            // Writes: never where Rust runs programs from, nor above them…
            (home.join("bin"), Access::Write),
            (home.join("bin/ssh"), Access::Write),
            (home.join("BIN/git"), Access::Write),
            (home.join("go"), Access::Write),
            (home.join("go/bin/gh"), Access::Write),
            (home.join("tools"), Access::Write),
            (
                home.join("Apps/Native Intelligence.app/Contents/Resources/local-agent"),
                Access::Write,
            ),
            // …never shell or git config (hidden at the top of HOME)…
            (home.join(".gitconfig"), Access::Write),
            (home.join(".zshrc"), Access::Write),
            (home.join(".config/git/config"), Access::Write),
            (home.join(".cargo"), Access::Write),
            // …and never outside HOME.
            (base.join("elsewhere.txt"), Access::Write),
            (PathBuf::from("/usr/local/bin/tool"), Access::Write),
            (PathBuf::from("/opt"), Access::Write),
        ];
        for (p, access) in refused {
            assert!(
                check(&p, access).is_err(),
                "{} {access:?} should be refused",
                p.display()
            );
        }
        let err = check(&home.join("code/innocent"), Access::Read).unwrap_err();
        assert!(
            err.contains(&home.join(".ssh").display().to_string()),
            "shown as its realpath: {err}"
        );
        // Reading is still fine where writing isn't.
        for p in [
            home.join("bin"),
            home.join("go"),
            home.join("code/proj"),
            home.join("work"),
        ] {
            assert!(check(&p, Access::Read).is_ok(), "{}", p.display());
        }
        // Next to a git config file, not holding one: fine.
        std::fs::create_dir_all(home.join("work/app")).unwrap();
        assert!(check(&home.join("work/app"), Access::Write).is_ok());
        let why = check(&home.join("dotfiles"), Access::Read).unwrap_err();
        assert!(why.contains("real files behind a hidden entry"), "{why}");
        let why = check(&home.join("projects"), Access::Write).unwrap_err();
        assert!(why.contains("your own copy of the shared folder, or holds it"), "{why}");
        let why = check(&home.join("work"), Access::Write).unwrap_err();
        assert!(why.contains("reads its config from there"), "{why}");
        let why = check(&home.join("bin/ssh"), Access::Write).unwrap_err();
        assert!(why.contains("runs programs or reads its config from there"), "{why}");
        let why = check(&home.join(".zshrc"), Access::Write).unwrap_err();
        assert!(why.contains("hidden files and folders"), "{why}");
    }

    #[test]
    fn every_config_file_and_program_git_reads_as_the_person_is_found() {
        let home = Path::new("/Users/x");
        let dir = Path::new("/Users/x/code/site");
        let rec = |scope: &str, origin: &str, kv: &str| format!("{scope}\0{origin}\0{kv}\0");
        let out = [
            rec("global", "file:/Users/x/.gitconfig", "user.name\nX"),
            rec(
                "global",
                "file:/Users/x/.gitconfig",
                "includeif.gitdir:~/work/.path\n~/work/.gitconfig",
            ),
            rec("global", "file:/Users/x/.gitconfig", "include.path\nextra/more.inc"),
            rec(
                "global",
                "file:/Users/x/work/.gitconfig",
                "core.sshcommand\n~/bin/myssh -v",
            ),
            rec(
                "global",
                "file:/Users/x/work/.gitconfig",
                "credential.https://github.com.helper\n/opt/x/helper --store",
            ),
            rec(
                "global",
                "file:/Users/x/work/.gitconfig",
                "credential.helper\nosxkeychain",
            ),
            rec(
                "global",
                "file:/Users/x/work/.gitconfig",
                "filter.lfs.clean\ngit-lfs clean -- %f",
            ),
            rec(
                "global",
                "file:/Users/x/work/.gitconfig",
                "filter.crypt.smudge\n!~/tools/decrypt",
            ),
            rec("local", "file:.git/config", "remote.origin.receivepack\n/Users/x/rp"),
            rec("local", "file:.git/config", "core.bare\nfalse"),
            rec("command", "command line:", "core.hookspath\n/dev/null"),
        ]
        .concat();
        let got = git_config_paths(&out, dir, home);
        for want in [
            "/Users/x/.gitconfig",
            "/Users/x/work/.gitconfig",
            "/Users/x/extra/more.inc",
            "/Users/x/bin/myssh",
            "/opt/x/helper",
            "/Users/x/tools/decrypt",
            "/Users/x/code/site/.git/config",
            "/Users/x/rp",
        ] {
            assert!(got.contains(&PathBuf::from(want)), "{want} missing from {got:#?}");
        }
        assert!(!got
            .iter()
            .any(|p| p.ends_with("osxkeychain") || p.ends_with("git-lfs") || p == Path::new("/dev/null")));
        assert!(git_config_paths("", dir, home).is_empty());
        assert!(git_config_paths("half\0a record", dir, home).is_empty());
    }

    #[test]
    fn a_prompt_waits_as_long_as_the_launcher_says_within_bounds() {
        let default = Duration::from_secs(300);
        assert_eq!(prompt_timeout(&json!({}), default), default);
        assert_eq!(
            prompt_timeout(&json!({"timeoutMs": 120_000}), default),
            Duration::from_secs(120)
        );
        assert_eq!(prompt_timeout(&json!({"timeoutMs": 1}), default), MIN_TIMEOUT);
        assert_eq!(
            prompt_timeout(&json!({"timeoutMs": 10_000}), default),
            Duration::from_secs(10),
            "the launcher's minimum, as sent"
        );
        assert_eq!(MAX_TIMEOUT, Duration::from_millis(1_800_000), "the launcher's maximum");
        assert_eq!(
            prompt_timeout(&json!({"timeoutMs": 2_500}), default),
            Duration::from_millis(2_500),
            "a short wait left is kept, never lengthened"
        );
        assert_eq!(
            prompt_timeout(&json!({"timeoutMs": 86_400_000u64}), default),
            MAX_TIMEOUT
        );
        assert_eq!(prompt_timeout(&json!({"timeoutMs": "soon"}), default), default);
    }

    #[test]
    fn rust_answers_before_the_launchers_deadline() {
        assert_eq!(answer_within(Duration::from_secs(300)), Duration::from_secs(298));
        assert_eq!(answer_within(Duration::from_secs(10)), Duration::from_secs(8));
        assert_eq!(answer_within(Duration::from_secs(3)), Duration::from_millis(1_500));
        assert_eq!(answer_within(Duration::from_millis(300)), Duration::from_millis(150));
        for ms in [1_000u64, 10_000, 60_000, 1_800_000] {
            let wait = Duration::from_millis(ms);
            assert!(answer_within(wait) < wait, "{ms}");
        }
    }

    #[test]
    fn only_a_click_on_allow_allows() {
        let p = fence_prompt(Path::new("/Users/x/lib"), "site", None);
        // Deny is the default button (Return); allow is the alternate.
        assert_eq!(alert_buttons(&p), (FENCE_DENY, FENCE_ALLOW));
        assert!(alert_allowed(0, 1), "the alternate button: allow");
        assert!(!alert_allowed(0, 0), "the default button (Return): deny");
        assert!(!alert_allowed(0, 2), "no third button");
        assert!(!alert_allowed(0, 3), "cancelled or timed out");
        assert!(!alert_allowed(-1, 1), "the call failed");
        assert!(alert_allowed(0, 1 | 0x100), "checkbox bits ignored");
    }

    #[test]
    fn invisible_formatting_never_reaches_an_alert() {
        let ask = PushAsk::parse(&json!({"title":"Fix \u{202E}gnp.exe\u{200B} login","body":"a\u{2066}b"})).unwrap();
        assert_eq!(ask.title, "Fix gnp.exe login");
        assert_eq!(ask.body, "ab");
        let p = fence_prompt(Path::new("/x"), "si\u{202E}te", Some("why\u{FEFF}"));
        assert!(!p.body.chars().any(is_format_char), "{:?}", p.body);
    }

    #[test]
    fn prompts_say_what_they_allow() {
        let ask = PushAsk {
            title: "Fix the login redirect".into(),
            body: String::new(),
            ..PushAsk::default()
        };
        let files = Changed {
            files: vec![("src/login.ts".into(), Change::Modified)],
            total: 1,
        };
        let mut at = PushWhere {
            branch: "dial8/site-1234abcd",
            commit: "0123456789abcdef0123456789abcdef01234567",
            remote: "origin",
            repo: Some("github.com/o/r"),
            label: "site",
            base: None,
            sends: super::super::push::Sends { job: 1, earlier: 0 },
            files: &files,
        };
        let p = push_prompt(&at, &ask);
        assert_eq!(
            p.title,
            "Push dial8/site-1234abcd to github.com/o/r and open a pull request?"
        );
        assert!(
            p.body.starts_with("\u{201C}Fix the login redirect\u{201D}"),
            "{}",
            p.body
        );
        assert!(p.body.contains("Commit 0123456"), "{}", p.body);
        assert!(p.body.contains("git push to origin") && p.body.contains("your own git login"));
        assert!(
            p.body.ends_with("and pushes only that commit.\n\nChanged files (1):\nsrc/login.ts"),
            "{}",
            p.body
        );
        at.repo = None;
        assert_eq!(
            push_prompt(&at, &ask).title,
            "Push dial8/site-1234abcd to origin and open a pull request?"
        );
        assert_eq!((p.allow.as_str(), p.deny.as_str()), (PUSH_ALLOW, PUSH_DENY));
        assert!(!p.warning);
        // A job started from a named base branch: the title says which.
        at.base = Some("release/2.0");
        let from = push_prompt(&at, &ask);
        assert_eq!(
            from.title,
            "Push dial8/site-1234abcd (from release/2.0) to origin and open a pull request?"
        );
        assert_eq!(from.body, push_prompt(&PushWhere { base: None, ..at }, &ask).body);
        at.repo = Some("github.com/o/r");
        assert_eq!(
            push_prompt(&at, &ask).title,
            "Push dial8/site-1234abcd (from release/2.0) to github.com/o/r and open a pull request?"
        );

        let f = fence_prompt(Path::new("/Users/x/code/lib"), "site", Some("shared types"));
        assert_eq!(f.title, "Let Native Intelligence's agent read /Users/x/code/lib?");
        assert!(f.body.contains("for this job only") && f.body.contains("isn't added to your shared folders"));
        assert!(f.body.contains("it can't change it"), "read-only: {}", f.body);
        assert!(f.body.ends_with("\u{201C}shared types\u{201D}"), "{}", f.body);
        assert!(f.warning);
        let plain = fence_prompt(Path::new("/tmp/out"), "site", None);
        assert!(!plain.body.contains("reason"));
        assert!(!plain.title.contains("change"));
        let long = fence_prompt(&PathBuf::from(format!("/{}", "d".repeat(500))), "s", None);
        assert!(long.title.chars().count() < 260, "{}", long.title);
    }

    #[test]
    fn push_prompts_say_every_commit_the_push_sends() {
        use super::super::push::Sends;
        let ask = PushAsk {
            title: "Fix it".into(),
            body: String::new(),
            ..PushAsk::default()
        };
        static NONE: Changed = Changed {
            files: Vec::new(),
            total: 0,
        };
        fn at(base: Option<&str>, job: u64, earlier: u64) -> PushWhere<'_> {
            PushWhere {
                branch: "dial8/site-1234abcd",
                commit: "0123456789abcdef0123456789abcdef01234567",
                remote: "origin",
                repo: Some("github.com/o/r"),
                label: "site",
                base,
                sends: Sends { job, earlier },
                files: &NONE,
            }
        }
        // The commit's paragraph: the files come after it.
        let ends = |p: &NativePrompt, tail: &str| {
            let commit = p.body.split("\n\n").nth(1).unwrap_or_default();
            assert!(commit.ends_with(tail), "{:?} doesn't end with {tail:?}", p.body);
            assert!(p.body.ends_with("\n\nIt changes no files."), "{:?}", p.body);
        };
        for (job, earlier) in [(0, 0), (1, 0)] {
            let p = push_prompt(&at(Some("main"), job, earlier), &ask);
            ends(&p, "and pushes only that commit.");
            assert!(!p.warning);
        }
        ends(
            &push_prompt(&at(None, 3, 0), &ask),
            "and pushes 3 commits, ending with that one.",
        );
        let ahead = push_prompt(&at(Some("feature"), 1, 2), &ask);
        ends(
            &ahead,
            "and pushes that commit and 2 earlier commits from feature that origin doesn't have.",
        );
        assert!(ahead.warning, "more than the person's job goes: drawn as a warning");
        ends(
            &push_prompt(&at(Some("feature"), 3, 1), &ask),
            "and pushes this job's 3 commits and 1 earlier commit from feature that origin doesn't have.",
        );
        ends(
            &push_prompt(&at(None, 1, 4), &ask),
            "and pushes that commit and 4 earlier commits from your checkout that origin doesn't have.",
        );
        // A base branch is shown whole, up to the longest the web allows.
        let longest = format!("r{}", "e".repeat(super::super::git::MAX_BASE_BRANCH - 1));
        let long = push_prompt(&at(Some(&longest), 1, 0), &ask);
        assert!(long.title.contains(&format!("(from {longest})")), "{}", long.title);
    }

    fn push_where<'a>(files: &'a Changed) -> PushWhere<'a> {
        PushWhere {
            branch: "dial8/site-1234abcd",
            commit: "0123456789abcdef0123456789abcdef01234567",
            remote: "origin",
            repo: Some("github.com/Acme/site"),
            label: "site",
            base: None,
            sends: super::super::push::Sends { job: 1, earlier: 0 },
            files,
        }
    }

    #[test]
    fn push_prompts_show_the_description_as_it_will_be_published() {
        let files = Changed {
            files: Vec::new(),
            total: 0,
        };
        let at = push_where(&files);
        let asked = |title: &str, body: &str| {
            let ask = PushAsk::parse(&json!({"title": title, "body": body})).unwrap().made_inert(at.repo);
            (push_prompt(&at, &ask).body, ask)
        };
        // A short one, whitespace collapsed; nothing else to say.
        let (p, ask) = asked("Fix it", "Fixes the login\n\n  redirect.");
        assert!(p.contains("\n\nDescription: Fixes the login redirect.\n\nCommit 0123456"), "{p}");
        assert!(!p.contains("Closes when merged") && !p.contains("inert"), "{p}");
        assert_eq!(ask.body, "Fixes the login\n\n  redirect.");
        // No description: no line.
        let (p, _) = asked("Fix it", "");
        assert!(p.starts_with("\u{201C}Fix it\u{201D}\n\nCommit 0123456"), "{p}");
        // A long one: its start, and how long it is.
        let (p, _) = asked("Fix it", &"word ".repeat(468));
        let line = p.lines().find(|l| l.starts_with("Description: ")).unwrap();
        assert!(line.ends_with("\u{2026} (2,339 characters)"), "{line}");
        assert!(line.chars().count() < 280 + 40, "{line}");
        // This repository's closing references stay, and are listed.
        let (p, ask) = asked("Fix it", "fixes #12, Closes: #40, resolves acme/site#40");
        assert!(p.contains("\nCloses when merged: #12, #40\n\nCommit"), "{p}");
        assert_eq!(ask.body, "fixes #12, Closes: #40, resolves acme/site#40");
        let many: String = (1..=8).map(|n| format!("fixes #{n} ")).collect();
        let (p, _) = asked("Fix it", &many);
        assert!(p.contains("Closes when merged: #1, #2, #3, #4, #5 and 3 more"), "{p}");
        // Mentions, other repositories and hidden text: inert, and one line says so.
        let (p, ask) = asked(
            "Fix it for @alice",
            "cc @acme/core <!-- @hidden --> fixes other/repo#3, see https://github.com/x/y/issues/1",
        );
        assert_eq!(ask.title, "Fix it for @\u{200B}alice", "the break survives the title's clean-up");
        assert_eq!(ask.body, "cc @\u{200B}acme/core  fixes other/repo issue 3, see https://github.com/x/y/issues/1");
        assert!(ask.inert && ask.closes.is_empty());
        assert!(p.starts_with("\u{201C}Fix it for @alice\u{201D}"), "{p}");
        assert!(p.contains("Description: cc @acme/core fixes other/repo issue 3"), "{p}");
        assert!(p.contains("\nMentions, other repositories' issue links and hidden comments in it were made inert.\n\nCommit"), "{p}");
        assert!(!p.contains("@hidden"), "hidden text is gone: {p}");
        // HTML: said, never stripped.
        let (p, ask) = asked("Fix it", "<details><summary>Logs</summary>long</details>");
        assert!(ask.html && ask.body.contains("<details>"));
        assert!(p.contains("\nIt contains HTML: some of it may be collapsed or not shown as written.\n\nCommit"), "{p}");
        let (p, _) = asked("Fix it", "a < b, and `<b>` in code");
        assert!(!p.contains("HTML"), "{p}");
        // The title's closers are listed too (a squash merge's subject),
        // once each, under the same cap.
        let (p, ask) = asked("Fix login, fixes #12", "closes #12 and resolves #3");
        assert_eq!(ask.closes, ["#12", "#3"]);
        assert!(p.contains("\nCloses when merged: #12, #3\n"), "{p}");
        assert!(ask.title.contains("fixes #12"), "published as written: {}", ask.title);
        let (p, _) = asked("fixes #1, fixes #2, fixes #3", "fixes #4 fixes #5 fixes #6 fixes #2");
        assert!(p.contains("Closes when merged: #1, #2, #3, #4, #5 and 1 more"), "{p}");
        // Spelled closers and HTML blocks: listed all the same.
        let (p, _) = asked("Fix it", "fixes \\#12\n\n<details>\nfixes &#35;40 and `closes #41`\n</details>");
        assert!(p.contains("\nCloses when merged: #12, #40, #41\n"), "{p}");
        // Hidden text only: the title falls back, the body is empty.
        let (_, ask) = asked("<!-- x -->", "<!-- y -->");
        assert_eq!((ask.title.as_str(), ask.body.as_str()), (super::super::git::DEFAULT_SUBJECT, ""));
    }

    #[test]
    fn a_long_description_stays_within_githubs_limit_once_inert() {
        // 60,000 characters (the most a push takes) of mentions: each grows by one.
        let ask = PushAsk::parse(&json!({"title": "t", "body": "@ab ".repeat(15_000)})).unwrap();
        assert_eq!(ask.body.chars().count(), 60_000);
        let made = ask.made_inert(Some("github.com/o/r"));
        assert!(made.body.chars().count() <= GITHUB_MAX_BODY, "{}", made.body.chars().count());
        assert_eq!(made.body.matches('@').count(), made.body.matches("@\u{200B}").count(), "every mention made inert");
        assert_eq!(made.clone().made_inert(Some("github.com/o/r")).body, made.body, "idempotent");
        assert_eq!(thousands(2_340), "2,340");
        assert_eq!(thousands(60_000), "60,000");
        assert_eq!(thousands(999), "999");
    }

    #[test]
    fn push_prompts_list_the_files_the_job_changed() {
        let ask = PushAsk {
            title: "Fix it".into(),
            body: String::new(),
            ..PushAsk::default()
        };
        let deep = format!("src/{}/main.rs", "d".repeat(200));
        let files = Changed {
            files: vec![
                ("README.md".into(), Change::Modified),
                ("added.txt".into(), Change::Added),
                ("old.txt".into(), Change::Deleted),
                (deep.clone(), Change::Modified),
                ("a\u{202E}b\nc.txt".into(), Change::Modified),
            ],
            total: 17,
        };
        let p = push_prompt(
            &PushWhere {
                branch: "dial8/site-1234abcd",
                commit: "0123456789abcdef0123456789abcdef01234567",
                remote: "origin",
                repo: None,
                label: "site",
                base: None,
                sends: super::super::push::Sends { job: 1, earlier: 0 },
                files: &files,
            },
            &ask,
        );
        let list: Vec<&str> = p.body.rsplit("\n\n").next().unwrap().lines().collect();
        assert_eq!(list[0], "Changed files (17):");
        assert_eq!(&list[1..4], ["README.md", "added.txt (new)", "old.txt (deleted)"]);
        // A long path keeps its end; a name can't add a line or hide text.
        assert!(list[4].starts_with('\u{2026}') && list[4].ends_with("/main.rs"), "{}", list[4]);
        assert_eq!(list[4].chars().count(), SHOWN_FILE);
        assert_eq!(list[5], "ab c.txt");
        assert_eq!(list[6], "+12 more");
        assert_eq!(list.len(), 7);
    }

    #[test]
    fn a_workers_confirm_says_who_asks_where_and_what_for() {
        let p = worker_prompt(
            "Claude Code",
            "site",
            "/Users/x/code/site",
            "Fix the\nlogin \u{202E}redirect",
            WorkerLaunch::Start,
            Duration::from_secs(120),
        );
        assert_eq!(p.title, "Let Claude Code work in site?");
        assert_eq!(
            p.body,
            "A Native Intelligence cloud agent or one of your loops wants to run your own Claude Code, on your own account and \
             with network access, in /Users/x/code/site.\n\nIts task: \u{201C}Fix the login redirect\u{201D}\n\n\
             A yes is remembered for this folder: Claude Code can then work here whenever Native Intelligence asks, without \
             asking again, until you switch Claude Code off in the menu bar. That covers reading and, when you have shared \
             the folder for editing, changing files there. With no answer within 2 min, it doesn't run."
        );
        assert_eq!((p.allow.as_str(), p.deny.as_str()), ("Run Claude Code", WORKER_DENY));
        assert_eq!(alert_buttons(&p), (WORKER_DENY, "Run Claude Code"), "deny is the default");
        assert!(p.warning);
        let again = worker_prompt(
            "Codex",
            "site",
            "/s",
            "x",
            WorkerLaunch::Resume {
                message: Some("now add\nthe \u{202E}tests"),
            },
            Duration::from_secs(30),
        );
        assert_eq!(again.title, "Let Codex continue in site?");
        assert!(
            again.body.contains("\n\nThe message it runs now: \u{201C}now add the tests\u{201D}\n\n"),
            "{}",
            again.body
        );
        assert!(again.body.ends_with("within 30 s, it doesn't run."), "{}", again.body);
        let blind = worker_prompt(
            "Codex",
            "site",
            "/s",
            "x",
            WorkerLaunch::Resume { message: None },
            Duration::from_secs(30),
        );
        assert!(blind.body.contains("It continues with a new message from Native Intelligence."), "{}", blind.body);
        let long = worker_prompt(
            "Codex",
            "s",
            "/s",
            &"w".repeat(1_000),
            WorkerLaunch::Resume {
                message: Some(&"m".repeat(1_000)),
            },
            Duration::from_secs(60),
        );
        assert!(long.body.chars().count() < 1_100, "{}", long.body);
    }

    fn read_check(home: &Path, p: &Path) -> Result<PathBuf, String> {
        let own = home.join("projects/site");
        check_fence(
            &FenceAsk {
                path: p.display().to_string(),
                access: Access::Read,
                reason: None,
            },
            &FenceRules {
                home,
                protected: &[],
                own: &own,
                never_write: &[],
            },
        )
    }

    #[test]
    fn credentials_kept_elsewhere_through_symlinks_are_never_readable() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let home = base.join("home");
        // Mackup / stow style: ~/.aws/credentials and ~/.kube/config live in
        // a synced folder; ~/.cargo/credentials.toml too.
        for d in [".aws", ".kube", ".cargo", ".codex", "Dropbox/Mackup", "Dropbox/notes"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        for (link, target) in [
            (".aws/credentials", "Dropbox/Mackup/aws-credentials"),
            (".kube/config", "Dropbox/Mackup/kubeconfig"),
            (".cargo/credentials.toml", "Dropbox/Mackup/cargo.toml"),
            (".codex/auth.json", "Dropbox/Mackup/codex.json"),
        ] {
            std::fs::write(home.join(target), "secret").unwrap();
            std::os::unix::fs::symlink(home.join(target), home.join(link)).unwrap();
        }
        for p in [
            home.join("Dropbox"),
            home.join("Dropbox/Mackup"),
            home.join("Dropbox/Mackup/aws-credentials"),
            home.join("Dropbox/Mackup/codex.json"),
        ] {
            let why = read_check(&home, &p).unwrap_err();
            assert!(why.contains("hidden entry"), "{}: {why}", p.display());
        }
        assert!(read_check(&home, &home.join("Dropbox/notes")).is_ok());
    }

    #[test]
    fn keys_and_certificates_the_ssh_config_names_are_never_readable() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let home = base.join("home");
        for d in [
            ".ssh/config.d",
            "keys",
            "vault/hosts",
            "certs",
            "code/app",
            "tools",
            "scripts",
        ] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::write(home.join("keys/id_work"), "k").unwrap();
        std::fs::write(home.join("certs/id_work-cert.pub"), "c").unwrap();
        std::fs::write(
            home.join(".ssh/config"),
            "# mine\nHost work\n  IdentityFile ~/keys/id_work\n  CertificateFile=\"~/certs/id_work-cert.pub\"\n  \
             ProxyCommand ~/tools/proxy %h %p\nMatch host *.corp exec \"~/scripts/onvpn %h\"\n  IdentityFile none\n\
             Include config.d/*\n",
        )
        .unwrap();
        std::fs::write(
            home.join(".ssh/config.d/hosts"),
            "Host *\n  IdentityFile %d/vault/hosts/id_%h\n  KnownHostsCommand exec /opt/kh %H\n",
        )
        .unwrap();
        let ssh = ssh_config(&home);
        assert_eq!(
            ssh.secrets,
            vec![
                home.join("keys/id_work"),
                home.join("certs/id_work-cert.pub"),
                home.join("vault/hosts"),
            ]
        );
        assert_eq!(
            ssh.programs,
            vec![
                home.join("tools/proxy"),
                home.join("scripts/onvpn"),
                PathBuf::from("/opt/kh")
            ]
        );
        for p in [
            home.join("keys"),
            home.join("certs/id_work-cert.pub"),
            home.join("vault"),
            home.join("vault/hosts/id_github"),
        ] {
            let why = read_check(&home, &p).unwrap_err();
            assert!(why.contains("key or certificate"), "{}: {why}", p.display());
        }
        assert!(read_check(&home, &home.join("code/app")).is_ok());
        // ssh's programs are write-protected, like everything Rust runs.
        let own = home.join("projects/site");
        for p in [home.join("tools"), home.join("scripts/onvpn")] {
            let write = check_fence(
                &FenceAsk {
                    path: p.display().to_string(),
                    access: Access::Write,
                    reason: None,
                },
                &FenceRules {
                    home: &home,
                    protected: &[],
                    own: &own,
                    never_write: &[],
                },
            );
            assert!(write.unwrap_err().contains("runs programs"), "{}", p.display());
        }
        assert_eq!(ssh_config(&base.join("nobody")), SshConfig::default());
    }

    #[test]
    fn reads_never_reach_other_homes_other_disks_or_temporary_folders() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap().join("home");
        std::fs::create_dir_all(home.join("code")).unwrap();
        // This test's own HOME is in a temporary folder: inside it is fine.
        assert!(read_check(&home, &home.join("code")).is_ok());
        let tmp = std::fs::canonicalize(dir.path()).unwrap().join("elsewhere.txt");
        for p in [
            PathBuf::from("/Users/Shared"),
            PathBuf::from("/private/tmp/some.sock"),
            PathBuf::from("/tmp/x"),
            tmp,
        ] {
            let why = read_check(&home, &p).unwrap_err();
            assert!(
                why.contains("another person's home folder, another disk or a temporary folder")
                    || why.contains("doesn't exist"),
                "{}: {why}",
                p.display()
            );
        }
        let why = read_check(&home, Path::new("/private/tmp")).unwrap_err();
        assert!(
            why.contains("far too wide") || why.contains("temporary folder"),
            "{why}"
        );
        assert!(wildcard("*.conf", "a.conf") && wildcard("h?st*", "host-1") && !wildcard("*.conf", "a.cfg"));
    }
}
