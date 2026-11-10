//! Where the launcher comes from and what it runs with (l0-contract §4 "Dev
//! config", §1 env).
//!
//! Two modes:
//! - **Packaged** (every release build, and a debug build without dev.json):
//!   the agent ships inside the app at `Contents/Resources/local-agent/`
//!   ([`BUNDLE_FILES`]), started as `<node> <bundle>/launcher/launcher.mjs`
//!   with `LOCAL_AGENT_DIR=<bundle>`; node is the pinned one
//!   [`super::runtime`] downloads on first use. A status check doesn't
//!   download it (`node` is whatever is ready); a launch waits for it.
//! - **Dev** (a debug build with `<app_data>/local-agent/dev.json`): the
//!   agent checkout the file names.
//!
//! ```json
//! { "node": "/abs/node", "agentDir": "/abs/agents/local-agent", "envFile": "/abs/.env.local" }
//! ```
//!
//! dev.json is read only when `cfg!(debug_assertions)`; a release build never
//! reads it. Optional `launcher` (absolute) overrides
//! `<agentDir>/launcher/launcher.ts`, in case eve's build rejects a
//! `launcher/` folder and the agent moves it (contract §1). `envFile` is
//! passed as a path only; Rust never opens it.
//!
//! In dev mode without `node`, it is resolved: the login shell's `command -v
//! node`, then the newest `~/.nvm/versions/node/v24*/bin/node`, then
//! `/opt/homebrew/bin/node`. The jobs' toolchain PATH is the login shell's
//! `$PATH` (else [`FALLBACK_PATH`]); in dev mode with node's folder first.
//! Packaged mode leaves the person's PATH as it is: our node lives under
//! ~/Library/Application Support, which the agent's Seatbelt profile can't
//! read, so it must not shadow their own `node` for their commands (the
//! launcher runs by absolute path and starts the server with
//! `process.execPath`). Both come from ONE `$SHELL -ilc` probe with an 8 s
//! timeout, run once per app run and cached (an interactive zsh with nvm
//! takes ~3.4 s on Liam's Mac, so 4 s was too close to the edge), and kicked
//! off early (at launch when dev.json exists; in packaged mode when a folder
//! is shared, or at launch when one already is) so the first start doesn't
//! wait for it. Markers around each value keep rc-file chatter (nvm, motd)
//! out of it.
//!
//! The launcher's environment is built from scratch ([`launcher_env`]): the
//! app's own environment (its tokens, `NI_*`, anything a parent shell
//! exported) never reaches it.

use crate::sidecar::NoConsole;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::sync::OnceCell;

use super::runtime::Runtime;

/// The launcher's PATH when the login shell can't be asked.
pub const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/// The login shell probe, at most.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PATH_MARK: &str = "__NI_LA_PATH__";
const NODE_MARK: &str = "__NI_LA_NODE__";
const END_MARK: &str = "__NI_LA_END__";
/// Node major the launcher's type stripping is written for.
const NODE_MAJOR: u64 = 24;
/// A complete packaged agent: what dev.sh, build.sh and release.sh stage
/// into `Contents/Resources/local-agent/`.
pub const BUNDLE_FILES: &[&str] = &[
    "BUNDLE.json",
    PACKAGED_LAUNCHER,
    "launcher/server-guard.ts",
    ".output/server/index.mjs",
];
/// The packaged launcher, eve's client bundled in.
pub const PACKAGED_LAUNCHER: &str = "launcher/launcher.mjs";

/// Every file of [`BUNDLE_FILES`] is in `dir`.
pub fn bundle_complete(dir: &Path) -> bool {
    BUNDLE_FILES.iter().all(|f| dir.join(f).is_file())
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevConfig {
    #[serde(default)]
    pub node: Option<PathBuf>,
    pub agent_dir: PathBuf,
    #[serde(default)]
    pub env_file: Option<PathBuf>,
    #[serde(default)]
    pub launcher: Option<PathBuf>,
}

/// `Ok(None)`: no dev.json.
pub fn read_dev_config(path: &Path) -> Result<Option<DevConfig>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("can't read {}: {e}", path.display())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("{} is invalid: {e}", path.display()))
}

/// What the login shell said, between its markers.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Probe {
    pub path: Option<String>,
    pub node: Option<String>,
}

/// The probe's command line for `$SHELL -ilc`.
pub fn probe_script() -> String {
    format!(
        "printf '\\n{PATH_MARK}%s{END_MARK}\\n' \"$PATH\"; printf '\\n{NODE_MARK}%s{END_MARK}\\n' \"$(command -v node 2>/dev/null)\""
    )
}

/// Pull the two values out of the probe's stdout, ignoring whatever the rc
/// files printed around them. An empty value is `None`.
pub fn parse_probe(out: &str) -> Probe {
    let between = |mark: &str| -> Option<String> {
        let start = out.rfind(mark)? + mark.len();
        let len = out[start..].find(END_MARK)?;
        let v = out[start..start + len].trim();
        (!v.is_empty()).then(|| v.to_string())
    };
    Probe {
        path: between(PATH_MARK),
        node: between(NODE_MARK),
    }
}

/// A PATH fit for the launcher: absolute entries only (a relative one would
/// resolve against the job folder), no duplicates, order kept.
pub fn sanitize_path(raw: &str) -> Option<String> {
    let mut seen: Vec<&str> = Vec::new();
    for entry in raw.split(':') {
        let trimmed = entry.trim_end_matches('/');
        let entry = if trimmed.is_empty() && entry.starts_with('/') {
            "/"
        } else {
            trimmed
        };
        if !entry.starts_with('/') || entry.chars().any(|c| c.is_control()) || seen.contains(&entry) {
            continue;
        }
        seen.push(entry);
    }
    (!seen.is_empty()).then(|| seen.join(":"))
}

/// `path` with node's own folder first if it isn't on it already, so the
/// `node` the launcher and the agent's tools find is the one Rust started.
pub fn with_node_dir(path: &str, node: &Path) -> String {
    let Some(dir) = node.parent().and_then(Path::to_str) else {
        return path.to_string();
    };
    if path.split(':').any(|e| e == dir) {
        path.to_string()
    } else {
        format!("{dir}:{path}")
    }
}

/// The newest `v<major>.*` under an nvm `versions/node` folder.
pub fn newest_nvm_node(versions: &Path, major: u64) -> Option<PathBuf> {
    let mut best: Option<((u64, u64, u64), PathBuf)> = None;
    for entry in std::fs::read_dir(versions).ok()?.flatten() {
        let name = entry.file_name();
        let Some(v) = name.to_str().and_then(parse_version) else {
            continue;
        };
        if v.0 != major {
            continue;
        }
        let node = entry.path().join("bin/node");
        if is_executable(&node) && best.as_ref().is_none_or(|(b, _)| v > *b) {
            best = Some((v, node));
        }
    }
    best.map(|(_, p)| p)
}

fn parse_version(name: &str) -> Option<(u64, u64, u64)> {
    let mut it = name.strip_prefix('v')?.split('.');
    let v = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    it.next().is_none().then_some(v)
}

pub fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// Run the login shell probe. `None` on any failure or timeout (the shell and
/// whatever its rc files started are killed as a group).
pub async fn shell_probe(shell: &Path, timeout: Duration) -> Option<Probe> {
    let mut cmd = tokio::process::Command::new(shell);
    cmd.no_console();
    cmd.arg("-ilc")
        .arg(probe_script())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let mut stdout = child.stdout.take()?;
    let run = async {
        let mut out = Vec::new();
        // A runaway rc file can't fill memory: 1 MiB is plenty for a PATH.
        let _ = (&mut stdout).take(1 << 20).read_to_end(&mut out).await;
        let _ = child.wait().await;
        out
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(out) => Some(parse_probe(&String::from_utf8_lossy(&out))),
        Err(_) => {
            crate::log_to_file(&format!(
                "[local-agent] {} -ilc took over {:?}; using the fallback PATH",
                shell.display(),
                timeout
            ));
            if let Some(pid) = pid {
                super::supervisor::signal_group(pid, super::supervisor::Signal::Kill);
            }
            None
        }
    }
}

/// The path of the Native Intelligence model relay under the app's API origin.
pub const MODEL_RELAY_PATH: &str = "/api/local-agent/model";

/// The model relay's base URL, built from the app's own API origin
/// ([`crate::tray::api_base_url`]) and nothing else: the webview passes a
/// token, never a URL (l1-contract C3), so a page can't point the local
/// agent's model calls (with their prompts: the folder's contents) anywhere.
pub fn model_base_url(origin: &str) -> String {
    format!("{}{MODEL_RELAY_PATH}", origin.trim_end_matches('/'))
}

/// Everything a launch needs, resolved and validated.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchConfig {
    pub node: PathBuf,
    pub launcher: PathBuf,
    pub agent_dir: String,
    pub env_file: Option<String>,
    pub tool_path: String,
    pub home: String,
    /// [`model_base_url`] of the app's API origin.
    pub model_base_url: String,
    /// The `git` Rust runs for edit jobs (worktree, commit), outside the
    /// sandbox: the first on [`LaunchConfig::tool_path`], else /usr/bin/git.
    pub git: PathBuf,
    /// Added to git's environment (tests: a config-free git).
    pub git_env: Vec<(String, String)>,
    /// The person's `gh`, if it is on [`LaunchConfig::tool_path`]: an
    /// allowed push opens its pull request with it (teammate C5).
    pub gh: Option<PathBuf>,
    /// The app's own API origin ([`crate::tray::api_base_url`]): the server's
    /// pull request route when `gh` isn't signed in.
    pub api_origin: String,
}

/// One launch's own values for [`launcher_env`].
#[derive(Debug, Clone, Copy)]
pub struct LaunchEnv<'a> {
    pub job_id: &'a str,
    /// Read: the grant's realpath. Edit: the job's worktree.
    pub folder: &'a str,
    pub mode: &'a str,
    /// The job's own (canonical) temp folder.
    pub tmpdir: &'a str,
    /// The relay token the server minted for this session.
    pub model_token: Option<&'a str>,
    /// Edit jobs: the repo's `.git` folder, readable (only) so git in the
    /// sandbox finds the worktree's objects.
    pub extra_read: Option<&'a str>,
    /// L4: the Mac's model choice and the job's worker ([`super::workers`]).
    pub run: Option<&'a super::workers::RunSpec>,
}

/// The launcher's environment, from scratch (contract §1). With a model
/// token, the model goes through the Native Intelligence relay; without one (the dev page)
/// a debug build falls back to the dev env file's gateway key.
pub fn launcher_env(l: &LaunchConfig, e: LaunchEnv<'_>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = [
        ("HOME", l.home.as_str()),
        ("TMPDIR", e.tmpdir),
        ("LANG", "en_US.UTF-8"),
        ("PATH", l.tool_path.as_str()),
        ("LOCAL_AGENT_JOB_ID", e.job_id),
        ("LOCAL_AGENT_FOLDER", e.folder),
        ("LOCAL_AGENT_MODE", e.mode),
        ("LOCAL_AGENT_TOOL_PATH", l.tool_path.as_str()),
        ("LOCAL_AGENT_DIR", l.agent_dir.as_str()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    if let Some(dir) = e.extra_read {
        env.push(("LOCAL_AGENT_EXTRA_READ".into(), dir.to_string()));
    }
    match e.model_token {
        Some(token) => {
            env.push(("LOCAL_AGENT_MODEL_BASE_URL".into(), l.model_base_url.clone()));
            env.push(("LOCAL_AGENT_MODEL_TOKEN".into(), token.to_string()));
        }
        None if cfg!(debug_assertions) => {
            if let Some(f) = &l.env_file {
                env.push(("LOCAL_AGENT_DEV_ENV_FILE".into(), f.clone()));
            }
        }
        None => {}
    }
    if let Some(run) = e.run {
        run.apply(&mut env, l);
    }
    env
}

/// The first executable `git` on `path`, else /usr/bin/git.
pub fn find_git(path: &str) -> PathBuf {
    find_tool(path, "git").unwrap_or_else(|| PathBuf::from("/usr/bin/git"))
}

/// The first executable `name` on `path` (absolute entries only).
pub fn find_tool(path: &str, name: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|d| d.starts_with('/'))
        .map(|d| Path::new(d).join(name))
        .find(|g| is_executable(g))
}

/// What `local_agent_status` reports about the setup, plus the launch config
/// when it was asked for and everything checks out.
#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub reason: Option<String>,
    pub node: Option<PathBuf>,
    pub agent_dir: Option<PathBuf>,
    pub built: bool,
    pub launch: Option<LaunchConfig>,
    /// The packaged agent (no dev.json): `local_agent_status` reports the
    /// runtime too.
    pub packaged: bool,
}

impl Resolved {
    pub fn available(&self) -> bool {
        self.reason.is_none()
    }

    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            reason: Some(reason.into()),
            ..Self::default()
        }
    }
}

/// Reads dev.json on every call (cheap; Liam can add it without a relaunch)
/// and caches only the shell probe.
pub struct Resolver {
    enabled: bool,
    dev_json: PathBuf,
    home: PathBuf,
    shell: PathBuf,
    probe: OnceCell<Option<Probe>>,
    /// `<resource_dir>/local-agent`: the packaged agent, if the app has a
    /// resource folder at all.
    bundle_dir: Option<PathBuf>,
    runtime: Arc<Runtime>,
}

impl Resolver {
    /// `enabled`: macOS. `home` is canonical.
    pub fn new(
        enabled: bool,
        dev_json: PathBuf,
        home: PathBuf,
        bundle_dir: Option<PathBuf>,
        runtime: Arc<Runtime>,
    ) -> Self {
        let shell = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|s| s.is_absolute() && is_executable(s))
            .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
        Self {
            enabled,
            dev_json,
            home,
            shell,
            probe: OnceCell::new(),
            bundle_dir,
            runtime,
        }
    }

    /// Dev mode: a debug build with dev.json.
    pub fn has_dev_config(&self) -> bool {
        self.enabled && cfg!(debug_assertions) && self.dev_json.is_file()
    }

    /// Packaged mode with a complete bundle: what a shared folder warms.
    pub fn packaged_ready(&self) -> bool {
        self.enabled
            && cfg!(target_os = "macos")
            && !self.has_dev_config()
            && self.bundle_dir.as_deref().is_some_and(bundle_complete)
    }

    pub fn runtime(&self) -> &Arc<Runtime> {
        &self.runtime
    }

    async fn probe(&self) -> Option<&Probe> {
        self.probe
            .get_or_init(|| shell_probe(&self.shell, PROBE_TIMEOUT))
            .await
            .as_ref()
    }

    /// Run the probe now, so a later start finds it cached.
    pub async fn warm(&self) {
        let _ = self.probe().await;
    }

    /// The login shell's PATH, sanitized, else [`FALLBACK_PATH`].
    pub(super) async fn shell_path(&self) -> String {
        self.probe()
            .await
            .and_then(|p| p.path.as_deref())
            .and_then(sanitize_path)
            .unwrap_or_else(|| FALLBACK_PATH.to_string())
    }

    /// Check the setup. With `launch`, also resolve the toolchain PATH and
    /// return a [`LaunchConfig`] (waiting for the probe on first use, and in
    /// packaged mode for the runtime's download).
    pub async fn resolve(&self, launch: bool) -> Resolved {
        if !cfg!(target_os = "macos") {
            return Resolved::unavailable("local agents run on macOS only");
        }
        if !self.enabled {
            return Resolved::unavailable("local agents are off in this build");
        }
        if self.has_dev_config() {
            self.resolve_dev(launch).await
        } else {
            self.resolve_packaged(launch).await
        }
    }

    /// The agent inside the app, on the pinned runtime.
    async fn resolve_packaged(&self, launch: bool) -> Resolved {
        let Some(bundle) = self.bundle_dir.clone().filter(|b| bundle_complete(b)) else {
            return Resolved {
                packaged: true,
                ..Resolved::unavailable("this build has no local agent bundle")
            };
        };
        let Some(agent_dir) = bundle.to_str().map(str::to_string) else {
            return Resolved {
                packaged: true,
                ..Resolved::unavailable("the local agent bundle's path is not valid UTF-8")
            };
        };
        let mut out = Resolved {
            agent_dir: Some(bundle.clone()),
            built: true,
            packaged: true,
            ..Resolved::default()
        };
        if !launch {
            // Available before the runtime is downloaded: a start fetches it.
            out.node = self.runtime.ready_node().await;
            return out;
        }
        let node = match self.runtime.ensure().await {
            Ok(n) => n,
            Err(e) => {
                out.reason = Some(e);
                return out;
            }
        };
        out.node = Some(node.clone());
        let Some(home) = self.home.to_str().map(str::to_string) else {
            out.reason = Some("HOME is not valid UTF-8".into());
            return out;
        };
        // The person's PATH as it is: no runtime folder in front of it.
        let tool_path = self.shell_path().await;
        out.launch = Some(LaunchConfig {
            node,
            launcher: bundle.join(PACKAGED_LAUNCHER),
            agent_dir,
            env_file: None,
            git: find_git(&tool_path),
            gh: find_tool(&tool_path, "gh"),
            tool_path,
            home,
            model_base_url: model_base_url(crate::tray::api_base_url()),
            git_env: Vec::new(),
            api_origin: crate::tray::api_base_url().to_string(),
        });
        out
    }

    /// dev.json's agent checkout (debug builds).
    async fn resolve_dev(&self, launch: bool) -> Resolved {
        let dev = match read_dev_config(&self.dev_json) {
            Ok(Some(d)) => d,
            Ok(None) => return Resolved::unavailable(format!("no dev config at {}", self.dev_json.display())),
            Err(e) => return Resolved::unavailable(e),
        };
        let agent_dir = dev.agent_dir.clone();
        let Some(agent_dir_str) = agent_dir.to_str().map(str::to_string) else {
            return Resolved::unavailable("agentDir is not valid UTF-8");
        };
        if !agent_dir.is_absolute() || !agent_dir.is_dir() {
            return Resolved::unavailable(format!("agentDir {} is not a folder", agent_dir.display()));
        }
        let built = agent_dir.join(".output/server/index.mjs").is_file();
        let mut out = Resolved {
            agent_dir: Some(agent_dir.clone()),
            built,
            ..Resolved::default()
        };

        let launcher = dev
            .launcher
            .clone()
            .unwrap_or_else(|| agent_dir.join("launcher/launcher.ts"));
        if !launcher.is_absolute() || !launcher.is_file() {
            out.reason = Some(format!("no launcher at {}", launcher.display()));
            return out;
        }

        let node = match &dev.node {
            Some(n) if n.is_absolute() && is_executable(n) => n.clone(),
            Some(n) => {
                out.reason = Some(format!("dev.json node {} is not an executable", n.display()));
                return out;
            }
            None => match self.find_node().await {
                Some(n) => n,
                None => {
                    out.reason = Some("node not found (set \"node\" in dev.json)".into());
                    return out;
                }
            },
        };
        out.node = Some(node.clone());

        let env_file = match &dev.env_file {
            None => None,
            Some(f) if f.is_absolute() && f.is_file() => match f.to_str() {
                Some(s) => Some(s.to_string()),
                None => {
                    out.reason = Some("envFile is not valid UTF-8".into());
                    return out;
                }
            },
            Some(f) => {
                out.reason = Some(format!("envFile {} not found", f.display()));
                return out;
            }
        };

        if launch {
            let Some(home) = self.home.to_str().map(str::to_string) else {
                out.reason = Some("HOME is not valid UTF-8".into());
                return out;
            };
            let tool_path = with_node_dir(&self.shell_path().await, &node);
            out.launch = Some(LaunchConfig {
                node,
                launcher,
                agent_dir: agent_dir_str,
                env_file,
                git: find_git(&tool_path),
                gh: find_tool(&tool_path, "gh"),
                tool_path,
                home,
                model_base_url: model_base_url(crate::tray::api_base_url()),
                git_env: Vec::new(),
                api_origin: crate::tray::api_base_url().to_string(),
            });
        }
        out
    }

    async fn find_node(&self) -> Option<PathBuf> {
        if let Some(n) = self.probe().await.and_then(|p| p.node.as_deref()).map(PathBuf::from) {
            if n.is_absolute() && is_executable(&n) {
                return Some(n);
            }
        }
        if let Some(n) = newest_nvm_node(&self.home.join(".nvm/versions/node"), NODE_MAJOR) {
            return Some(n);
        }
        let brew = PathBuf::from("/opt/homebrew/bin/node");
        is_executable(&brew).then_some(brew)
    }
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn probe_output_is_read_between_markers_whatever_the_rc_files_print() {
        let out = format!(
            "Now using node v24.18.0 (npm v11)\nlast login: today\n\n{PATH_MARK}/opt/homebrew/bin:/usr/bin:/bin{END_MARK}\n\n{NODE_MARK}/Users/x/.nvm/versions/node/v24.18.0/bin/node{END_MARK}\nbye\n"
        );
        assert_eq!(
            parse_probe(&out),
            Probe {
                path: Some("/opt/homebrew/bin:/usr/bin:/bin".into()),
                node: Some("/Users/x/.nvm/versions/node/v24.18.0/bin/node".into()),
            }
        );
    }

    #[test]
    fn probe_output_without_values_or_markers_is_none() {
        assert_eq!(parse_probe(""), Probe::default());
        assert_eq!(parse_probe("zsh: command not found: nvm"), Probe::default());
        let no_node = format!("{PATH_MARK}/usr/bin{END_MARK}\n{NODE_MARK}{END_MARK}\n");
        assert_eq!(
            parse_probe(&no_node),
            Probe {
                path: Some("/usr/bin".into()),
                node: None
            }
        );
        let cut = format!("{PATH_MARK}/usr/bin");
        assert_eq!(
            parse_probe(&cut).path,
            None,
            "an unterminated value (timeout mid-print) is dropped"
        );
    }

    #[test]
    fn the_last_marker_wins_when_an_rc_file_echoes_one() {
        let out = format!("{PATH_MARK}/evil{END_MARK}\n{PATH_MARK}/usr/bin{END_MARK}\n");
        assert_eq!(parse_probe(&out).path.as_deref(), Some("/usr/bin"));
    }

    #[test]
    fn probe_script_prints_both_markers() {
        let s = probe_script();
        assert!(s.contains(PATH_MARK) && s.contains(NODE_MARK) && s.contains(END_MARK));
        assert!(s.contains("command -v node"));
    }

    #[test]
    fn sanitized_path_keeps_absolute_entries_once_in_order() {
        assert_eq!(
            sanitize_path("/opt/homebrew/bin::.:bin:/usr/bin:/opt/homebrew/bin/:~/x:/bin").as_deref(),
            Some("/opt/homebrew/bin:/usr/bin:/bin")
        );
        assert_eq!(sanitize_path(""), None);
        assert_eq!(sanitize_path(".:relative"), None);
        assert_eq!(sanitize_path("/a\n/b:/c").as_deref(), Some("/c"));
    }

    #[test]
    fn node_dir_goes_first_unless_present() {
        let node = Path::new("/Users/x/.nvm/versions/node/v24.18.0/bin/node");
        assert_eq!(
            with_node_dir("/usr/bin:/bin", node),
            "/Users/x/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin"
        );
        let has = "/usr/bin:/Users/x/.nvm/versions/node/v24.18.0/bin";
        assert_eq!(with_node_dir(has, node), has);
    }

    #[test]
    fn newest_nvm_24_is_picked_numerically() {
        let dir = tempfile::tempdir().unwrap();
        for v in [
            "v24.2.0",
            "v24.18.0",
            "v24.9.1",
            "v22.20.0",
            "v25.0.0",
            "v24.99.0-nightly",
            "system",
        ] {
            let bin = dir.path().join(v).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let node = bin.join("node");
            std::fs::write(&node, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        // A newer one that isn't executable doesn't count.
        let bin = dir.path().join("v24.30.0/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("node"), "").unwrap();
        assert_eq!(
            newest_nvm_node(dir.path(), 24),
            Some(dir.path().join("v24.18.0/bin/node"))
        );
        assert_eq!(newest_nvm_node(dir.path(), 23), None);
        assert_eq!(newest_nvm_node(&dir.path().join("missing"), 24), None);
    }

    #[test]
    fn dev_config_parses_and_rejects_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dev.json");
        assert_eq!(read_dev_config(&path), Ok(None));
        std::fs::write(&path, r#"{"node":"/n","agentDir":"/a","envFile":"/e"}"#).unwrap();
        assert_eq!(
            read_dev_config(&path),
            Ok(Some(DevConfig {
                node: Some("/n".into()),
                agent_dir: "/a".into(),
                env_file: Some("/e".into()),
                launcher: None
            }))
        );
        std::fs::write(&path, r#"{"agentDir":"/a","agentdir":"/b"}"#).unwrap();
        assert!(
            read_dev_config(&path).is_err(),
            "a typo is an error, not a silent default"
        );
    }

    fn launch() -> LaunchConfig {
        LaunchConfig {
            node: "/n/bin/node".into(),
            launcher: "/a/launcher/launcher.ts".into(),
            agent_dir: "/a".into(),
            env_file: Some("/w/.env.local".into()),
            tool_path: "/n/bin:/usr/bin:/bin".into(),
            home: "/Users/x".into(),
            model_base_url: model_base_url("https://nativeintelligence.dev"),
            git: "/usr/bin/git".into(),
            git_env: Vec::new(),
            gh: None,
            api_origin: "https://nativeintelligence.dev".into(),
        }
    }

    fn read_env<'a>(job: &'a str, folder: &'a str) -> LaunchEnv<'a> {
        LaunchEnv {
            job_id: job,
            folder,
            mode: "read",
            tmpdir: "/private/var/folders/t/job-1",
            model_token: None,
            extra_read: None,
            run: None,
        }
    }

    #[test]
    fn the_model_url_is_the_api_origin_plus_the_relay_path() {
        assert_eq!(
            model_base_url("https://nativeintelligence.dev"),
            "https://nativeintelligence.dev/api/local-agent/model"
        );
        assert_eq!(
            model_base_url("http://localhost:3000/"),
            "http://localhost:3000/api/local-agent/model"
        );
        // What the app itself resolves: the tray's origin, debug or release.
        let built = model_base_url(crate::tray::api_base_url());
        assert!(
            built == "http://localhost:3000/api/local-agent/model" || built == "https://nativeintelligence.dev/api/local-agent/model",
            "{built}"
        );
    }

    #[test]
    fn a_model_token_routes_the_model_through_the_relay_and_drops_the_dev_key() {
        let env = launcher_env(
            &launch(),
            LaunchEnv {
                model_token: Some("tok.abc"),
                ..read_env("job-1", "/Users/x/code/site")
            },
        );
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(
            get("LOCAL_AGENT_MODEL_BASE_URL"),
            Some("https://nativeintelligence.dev/api/local-agent/model")
        );
        assert_eq!(get("LOCAL_AGENT_MODEL_TOKEN"), Some("tok.abc"));
        assert_eq!(get("LOCAL_AGENT_DEV_ENV_FILE"), None, "the dev key is only a fallback");
        assert_eq!(get("LOCAL_AGENT_EXTRA_READ"), None);
    }

    #[test]
    fn edit_launches_add_the_one_extra_read_root() {
        let env = launcher_env(
            &launch(),
            LaunchEnv {
                mode: "edit",
                extra_read: Some("/Users/x/code/site/.git"),
                ..read_env("job-1", "/Users/x/.dial8/worktrees/job-1")
            },
        );
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("LOCAL_AGENT_MODE"), Some("edit"));
        assert_eq!(get("LOCAL_AGENT_FOLDER"), Some("/Users/x/.dial8/worktrees/job-1"));
        assert_eq!(get("LOCAL_AGENT_EXTRA_READ"), Some("/Users/x/code/site/.git"));
    }

    #[test]
    fn git_is_found_on_the_tool_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        assert_eq!(find_git(bin.to_str().unwrap()), PathBuf::from("/usr/bin/git"));
        let git = bin.join("git");
        std::fs::write(&git, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(find_git(&format!("relative:{}:/usr/bin", bin.display())), git);
        assert_eq!(find_tool(bin.to_str().unwrap(), "gh"), None);
        assert_eq!(find_tool(&format!("relative:{}", bin.display()), "git"), Some(git));
    }

    #[test]
    fn launcher_env_is_exactly_the_contract_list() {
        let env = launcher_env(&launch(), read_env("job-1", "/Users/x/code/site"));
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "HOME",
                "TMPDIR",
                "LANG",
                "PATH",
                "LOCAL_AGENT_JOB_ID",
                "LOCAL_AGENT_FOLDER",
                "LOCAL_AGENT_MODE",
                "LOCAL_AGENT_TOOL_PATH",
                "LOCAL_AGENT_DIR",
                "LOCAL_AGENT_DEV_ENV_FILE",
            ]
        );
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PATH"), get("LOCAL_AGENT_TOOL_PATH"));
        assert_eq!(get("LOCAL_AGENT_FOLDER"), Some("/Users/x/code/site"));
        assert_eq!(get("LANG"), Some("en_US.UTF-8"));
        assert_eq!(get("AI_GATEWAY_API_KEY"), None);
        assert_eq!(get("LOCAL_AGENT_SECRET"), None, "the launcher makes its own");

        assert_eq!(get("LOCAL_AGENT_MODEL_TOKEN"), None);

        let mut no_file = launch();
        no_file.env_file = None;
        let env = launcher_env(&no_file, read_env("j", "/f"));
        assert!(env.iter().all(|(k, _)| k != "LOCAL_AGENT_DEV_ENV_FILE"));
    }

    fn packaged(dir: &Path, runtime: Runtime) -> (Resolver, PathBuf) {
        let bundle = dir.join("Resources/local-agent");
        for f in BUNDLE_FILES {
            let p = bundle.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "// bundled\n").unwrap();
        }
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut r = Resolver::new(
            true,
            dir.join("data/local-agent/dev.json"),
            home,
            Some(bundle.clone()),
            Arc::new(runtime),
        );
        // A quick stand-in for the login shell.
        r.shell = PathBuf::from("/bin/sh");
        (r, bundle)
    }

    fn missing_runtime(dir: &Path) -> Runtime {
        Runtime::new(
            super::super::runtime::RuntimeSpec::pinned(),
            dir.join("data/local-agent/runtime"),
            reqwest::Client::new(),
        )
    }

    #[tokio::test]
    async fn a_complete_bundle_is_available_before_the_runtime_is_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let (r, bundle) = packaged(dir.path(), missing_runtime(dir.path()));
        let got = r.resolve(false).await;
        assert!(got.available(), "{:?}", got.reason);
        assert!(got.built && got.packaged);
        assert_eq!(got.agent_dir, Some(bundle));
        assert_eq!(got.node, None);
        assert!(got.launch.is_none());
        assert!(r.packaged_ready());
        assert!(!r.has_dev_config());
        assert!(!dir.path().join("data/local-agent/runtime").exists());
    }

    #[tokio::test]
    async fn an_incomplete_or_missing_bundle_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        for f in BUNDLE_FILES {
            let (r, bundle) = packaged(dir.path(), missing_runtime(dir.path()));
            std::fs::remove_file(bundle.join(f)).unwrap();
            let got = r.resolve(true).await;
            assert_eq!(
                got.reason.as_deref(),
                Some("this build has no local agent bundle"),
                "without {f}"
            );
            assert!(got.packaged && !got.built && got.launch.is_none());
            assert!(!r.packaged_ready());
        }
        let mut r = packaged(dir.path(), missing_runtime(dir.path())).0;
        r.bundle_dir = None;
        assert_eq!(
            r.resolve(false).await.reason.as_deref(),
            Some("this build has no local agent bundle")
        );
    }

    #[tokio::test]
    async fn a_packaged_launch_runs_the_bundled_launcher_on_the_runtime_without_it_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = super::super::runtime::fixture::installed(&dir.path().join("data/local-agent/runtime"));
        let node = runtime.node_path();
        let (r, bundle) = packaged(dir.path(), runtime);
        let got = r.resolve(true).await;
        assert!(got.available(), "{:?}", got.reason);
        let l = got.launch.expect("a launch config");
        assert_eq!(l.node, node);
        assert_eq!(l.launcher, bundle.join("launcher/launcher.mjs"));
        assert_eq!(l.agent_dir, bundle.to_str().unwrap());
        assert_eq!(l.env_file, None);
        let node_dir = node.parent().unwrap().to_str().unwrap();
        assert!(
            !l.tool_path.split(':').any(|e| e == node_dir),
            "the runtime shadows the person's node: {}",
            l.tool_path
        );
        assert!(!l.tool_path.contains("local-agent/runtime"), "{}", l.tool_path);
        assert_eq!(l.git, find_git(&l.tool_path));
        assert_eq!(l.gh, find_tool(&l.tool_path, "gh"));
        assert_eq!(l.api_origin, crate::tray::api_base_url());
        // The env it becomes: the bundle is LOCAL_AGENT_DIR, no dev key.
        let env = launcher_env(&l, read_env("job-1", "/Users/x/code/site"));
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("LOCAL_AGENT_DIR"), bundle.to_str());
        assert_eq!(get("LOCAL_AGENT_DEV_ENV_FILE"), None);
    }

    #[tokio::test]
    async fn a_packaged_launch_whose_runtime_cant_be_set_up_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let mut spec = super::super::runtime::RuntimeSpec::pinned();
        // Nothing listens there: no internet in tests.
        spec.tarball.url = format!("http://127.0.0.1:9/{}", spec.tarball.file);
        let runtime = Runtime::new(
            spec,
            dir.path().join("data/local-agent/runtime"),
            reqwest::Client::new(),
        );
        let (r, _) = packaged(dir.path(), runtime);
        let got = r.resolve(true).await;
        let why = got.reason.expect("unavailable");
        assert!(why.starts_with("couldn't set up the local agent runtime: "), "{why}");
        assert!(got.launch.is_none());
    }

    #[tokio::test]
    async fn dev_json_wins_in_a_debug_build() {
        let dir = tempfile::tempdir().unwrap();
        let (r, _) = packaged(dir.path(), missing_runtime(dir.path()));
        std::fs::create_dir_all(dir.path().join("data/local-agent")).unwrap();
        std::fs::write(dir.path().join("data/local-agent/dev.json"), r#"{"agentDir":"/nope"}"#).unwrap();
        let got = r.resolve(false).await;
        // Tests are debug builds: dev mode, today's checks.
        assert!(r.has_dev_config() && !r.packaged_ready());
        assert!(!got.packaged);
        assert_eq!(got.reason.as_deref(), Some("agentDir /nope is not a folder"));
    }

    #[tokio::test]
    async fn shell_probe_reads_a_real_shell() {
        // /bin/sh stands in for the login shell: -i and -l are accepted, and
        // the script is the same.
        let probe = shell_probe(Path::new("/bin/sh"), Duration::from_secs(5))
            .await
            .expect("probe ran");
        assert!(probe.path.is_some());
    }
}
