//! Which folders can become a grant (l0-contract §4 `local_agent_pick_folder`).
//!
//! A grant only ever comes from the native folder dialog Rust draws (plan §1,
//! invariant 3: the webview runs code our server sends, so it can ask for the
//! picker but never name a path). The person can still pick something far too
//! wide, so these rules refuse the folders that would hand the agent the whole
//! disk, a whole home, or Native Intelligence's own data. All of them compare realpaths
//! ([`canonical_dir`] first), which is why `/tmp`, `/var` and `/etc` appear
//! in their `/private/...` forms:
//! - the contract's list: `/`, HOME itself, `/Users`, `/System`, `/Library`,
//!   `/Applications`, `/Volumes`, plus the other top-level system folders;
//! - every ancestor of HOME (a home somewhere other than `/Users/<name>`);
//! - anything inside `/System` (`/System/Volumes/Data` is the whole data
//!   volume, every home included);
//! - everything in `~/Library` (keychains, mail, browser profiles, other
//!   apps' data), except iCloud Drive's `~/Library/Mobile Documents`;
//! - the protected folders ([`super::Paths::protected`]: the app's data with
//!   every job's eve session, its WebKit data with the Native Intelligence session cookie,
//!   its caches, the jobs' temp root), anything inside them, and anything
//!   that contains them (`~/Library/Application Support` holds the app data).
//!
//! The same rules run again on every start and resume, against a fresh
//! realpath, so a grant whose folder was since swapped for a symlink to
//! somewhere else is refused rather than followed.

use std::path::{Path, PathBuf};

/// Refused as the grant itself (their subfolders are fine: `~/code/site`,
/// `/Volumes/Drive/photos`). Realpaths: `/tmp` is `/private/tmp`.
pub const EXACT_REFUSED: &[&str] = &[
    "/",
    "/Users",
    "/System",
    "/Library",
    "/Applications",
    "/Volumes",
    "/private",
    "/private/tmp",
    "/private/var",
    "/private/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/opt",
    "/dev",
    "/cores",
];

/// Refused with everything under it.
const SYSTEM_PREFIX: &str = "/System";

/// The one part of `~/Library` that may be granted: iCloud Drive.
pub const ICLOUD_DRIVE: &str = "Library/Mobile Documents";

/// `real` is one of the system-wide folders refused as a grant
/// ([`super::prompts`] compares the same list ignoring case).
pub fn is_system_wide(real: &Path) -> bool {
    EXACT_REFUSED.iter().any(|p| real == Path::new(p))
}

/// The realpath of a picked folder, or why it can't be a grant on its own
/// terms: it must exist, be a folder, and be a path the launcher's env and
/// the Seatbelt profile can carry (UTF-8, no `"`, no control characters; the
/// web side's profile builder refuses those too, so refuse them here first).
pub fn canonical_dir(picked: &Path) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(picked).map_err(|e| format!("can't open that folder: {e}"))?;
    if !real.is_dir() {
        return Err("that is not a folder".into());
    }
    let Some(s) = real.to_str() else {
        return Err("that folder's path is not valid UTF-8".into());
    };
    if s.contains('"') || s.chars().any(|c| c.is_control()) {
        return Err("that folder's path contains a quote or a control character".into());
    }
    Ok(real)
}

/// Whether `real` (a realpath, from [`canonical_dir`]) may be granted.
/// `home` is the realpath of HOME; `protected` are refused with everything
/// inside them and everything containing them.
pub fn check_folder(real: &Path, home: &Path, protected: &[PathBuf]) -> Result<(), String> {
    let refuse = |why: &str| Err(format!("{} can't be shared with a local agent: {why}", real.display()));
    if !real.is_absolute() {
        return refuse("not an absolute path");
    }
    if is_system_wide(real) {
        return refuse("it is a system-wide folder; pick a project folder inside it");
    }
    if real == home {
        return refuse("it is your whole home folder; pick a project folder inside it");
    }
    if home.starts_with(real) {
        return refuse("it contains your home folder");
    }
    if real.starts_with(SYSTEM_PREFIX) {
        return refuse("it is part of macOS");
    }
    if protected.iter().any(|p| real.starts_with(p) || p.starts_with(real)) {
        return refuse("it holds Native Intelligence's own data");
    }
    if real.starts_with(home.join("Library")) && !real.starts_with(home.join(ICLOUD_DRIVE)) {
        return refuse("your Library holds keychains, mail, browser and app data");
    }
    Ok(())
}

/// The folder's own name, for lists.
pub fn label_of(real: &Path) -> String {
    real.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| real.display().to_string())
}

/// `real` is the root of a git work tree: it holds a `.git` folder with a
/// `HEAD`, or a `.git` file pointing at one (`gitdir: …`, a linked worktree
/// or a submodule). A file system check only: `local_agent_status` runs it
/// for every grant, and git itself is only run for edit jobs.
pub fn is_git_root(real: &Path) -> bool {
    let dot_git = real.join(".git");
    let Ok(meta) = std::fs::symlink_metadata(&dot_git) else {
        return false;
    };
    if meta.is_dir() {
        return dot_git.join("HEAD").is_file();
    }
    if meta.is_file() && meta.len() < 4096 {
        return std::fs::read_to_string(&dot_git).is_ok_and(|t| t.starts_with("gitdir:"));
    }
    false
}

/// A branch-name-safe slug of a folder label: lowercase ASCII letters,
/// digits and single `-`, at most 32 characters; `job` when nothing is left.
pub fn slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 32 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "job".into()
    } else {
        out
    }
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A fake home with the app's protected folders, as the app builds them.
    struct Tree {
        _dir: tempfile::TempDir,
        base: PathBuf,
        home: PathBuf,
        protected: Vec<PathBuf>,
    }

    fn tree() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let home = base.join("home");
        let app_data = home.join("Library/Application Support/ai.dial8.desktop");
        let tmp_root = base.join("T/dial8-local-agent");
        let protected = vec![
            app_data.clone(),
            home.join("Library/WebKit/ai.dial8.desktop"),
            home.join("Library/WebKit/dial8-desktop"),
            home.join("Library/Caches/ai.dial8.desktop"),
            tmp_root.clone(),
        ];
        for d in [
            "code/site",
            "Documents/notes",
            "Library/Application Support/other-app",
            "Library/Keychains",
            "Library/Mail",
            "Library/Mobile Documents/com~apple~CloudDocs/project",
            "Library/WebKit/ai.dial8.desktop/WebsiteData",
            "Library/WebKit/dial8-desktop",
            "Library/Caches/ai.dial8.desktop",
        ] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::create_dir_all(app_data.join("local-agent/jobs/x")).unwrap();
        std::fs::create_dir_all(tmp_root.join("job")).unwrap();
        Tree {
            _dir: dir,
            base,
            home,
            protected,
        }
    }

    impl Tree {
        /// The rules as the app runs them: realpath first.
        fn check(&self, p: impl AsRef<Path>) -> Result<(), String> {
            let real = canonical_dir(p.as_ref())?;
            check_folder(&real, &self.home, &self.protected)
        }

        fn refused(&self, p: impl AsRef<Path>) -> bool {
            self.check(p).is_err()
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn system_folders_are_refused_as_their_realpaths() {
        let t = tree();
        for p in [
            "/",
            "/Users",
            "/System",
            "/Library",
            "/Applications",
            "/Volumes",
            "/private",
            "/tmp",
            "/var",
            "/etc",
            "/private/tmp",
            "/private/var",
            "/usr",
            "/System/Library",
            "/System/Volumes/Data",
        ] {
            let real = canonical_dir(Path::new(p)).unwrap();
            assert!(
                check_folder(&real, &t.home, &t.protected).is_err(),
                "{p} ({}) must be refused",
                real.display()
            );
        }
        // The real HOME too, with the real HOME.
        let home = canonical_dir(&dirs::home_dir().unwrap()).unwrap();
        assert!(check_folder(&home, &home, &[]).is_err());
        assert!(check_folder(&canonical_dir(&home.join("Library")).unwrap(), &home, &[]).is_err());
    }

    #[test]
    fn home_and_its_ancestors_are_refused() {
        let t = tree();
        assert!(t.refused(&t.home));
        assert!(t.refused(&t.base), "contains the home");
        assert!(t.refused(t.base.parent().unwrap()));
    }

    #[test]
    fn the_library_is_refused_except_icloud_drive() {
        let t = tree();
        for p in [
            "Library",
            "Library/Keychains",
            "Library/Mail",
            "Library/Application Support/other-app",
        ] {
            assert!(t.refused(t.home.join(p)), "{p}");
        }
        assert!(t
            .check(t.home.join("Library/Mobile Documents/com~apple~CloudDocs/project"))
            .is_ok());
        assert!(t.check(t.home.join("Library/Mobile Documents")).is_ok());
    }

    #[test]
    fn the_apps_own_data_is_refused_inside_and_above() {
        let t = tree();
        for p in [
            "Library/Application Support",
            "Library/Application Support/ai.dial8.desktop",
            "Library/Application Support/ai.dial8.desktop/local-agent/jobs/x",
            "Library/WebKit",
            "Library/WebKit/ai.dial8.desktop/WebsiteData",
            "Library/WebKit/dial8-desktop",
            "Library/Caches",
            "Library/Caches/ai.dial8.desktop",
        ] {
            let err = t.check(t.home.join(p)).unwrap_err();
            assert!(err.contains("Native Intelligence's own data"), "{p}: {err}");
        }
        assert!(t.refused(t.base.join("T/dial8-local-agent/job")), "a job's temp folder");
        assert!(t.refused(t.base.join("T")), "contains the jobs' temp root");
    }

    #[test]
    fn project_folders_are_allowed() {
        let t = tree();
        assert!(t.check(t.home.join("code/site")).is_ok());
        assert!(t.check(t.home.join("Documents/notes")).is_ok());
        assert!(t.check(t.home.join("code")).is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn symlinks_are_judged_by_where_they_lead() {
        let t = tree();
        std::os::unix::fs::symlink(t.home.join("Library/Keychains"), t.home.join("code/keys")).unwrap();
        std::os::unix::fs::symlink(t.home.join("code/site"), t.home.join("Documents/site")).unwrap();
        assert!(t.refused(t.home.join("code/keys")), "a link into the Library");
        assert_eq!(
            canonical_dir(&t.home.join("Documents/site")).unwrap(),
            t.home.join("code/site")
        );
        assert!(t.check(t.home.join("Documents/site")).is_ok());
    }

    #[test]
    fn relative_paths_are_refused() {
        let t = tree();
        assert!(check_folder(Path::new("code/site"), &t.home, &t.protected).is_err());
    }

    #[test]
    fn canonical_dir_refuses_files_missing_folders_and_odd_names() {
        let t = tree();
        std::fs::write(t.home.join("code/file.txt"), "x").unwrap();
        assert!(canonical_dir(&t.home.join("code/file.txt")).is_err());
        assert!(canonical_dir(&t.home.join("code/missing")).is_err());
        std::fs::create_dir(t.home.join("code/say \"hi\"")).unwrap();
        assert!(canonical_dir(&t.home.join("code/say \"hi\"")).is_err());
        std::fs::create_dir(t.home.join("code/tab\there")).unwrap();
        assert!(canonical_dir(&t.home.join("code/tab\there")).is_err());
    }

    #[test]
    fn git_roots_are_found_without_running_git() {
        let t = tree();
        let repo = t.home.join("code/site");
        assert!(!is_git_root(&repo));
        std::fs::create_dir(repo.join(".git")).unwrap();
        assert!(!is_git_root(&repo), "an empty .git folder is not a repo");
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(is_git_root(&repo));
        assert!(!is_git_root(&t.home.join("code")), "the parent is not the root");

        let linked = t.home.join("Documents/notes");
        std::fs::write(linked.join(".git"), "gitdir: /x/.git/worktrees/notes\n").unwrap();
        assert!(is_git_root(&linked), "a linked worktree's .git file");
        std::fs::write(linked.join(".git"), "not a gitfile").unwrap();
        assert!(!is_git_root(&linked));
    }

    #[test]
    fn slugs_are_branch_safe() {
        assert_eq!(slug("native-intelligence"), "native-intelligence");
        assert_eq!(slug("My Project (v2)"), "my-project-v2");
        assert_eq!(slug("  --weird__name--  "), "weird-name");
        assert_eq!(slug("日本語"), "job");
        assert_eq!(slug(""), "job");
        assert_eq!(slug("..lock"), "lock");
        let long = slug(&"abc ".repeat(40));
        assert!(long.len() <= 32 && !long.ends_with('-'), "{long}");
        for s in [slug("a/b"), slug("x.lock"), slug("@{u}")] {
            assert!(
                s.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{s}"
            );
        }
    }

    #[test]
    fn label_is_the_folder_name() {
        assert_eq!(label_of(Path::new("/Users/liam/code/site")), "site");
        assert_eq!(label_of(Path::new("/")), "/");
    }
}
