//! The actor end to end, against stand-in launchers written in POSIX sh
//! (`/bin/sh` plays node): spawn with a clean env in the job folder, the
//! protocol both ways, persistence, stop, resume, the 3-job cap, crashes and
//! the app-exit shutdown. No model, no eve, no window: native prompts are
//! answered by the [`Recorder`] from a script.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::config::{LaunchConfig, Resolver};
use super::state::{GrantMode, Job, JobStatus, StateFile};
use super::supervisor::ExitInfo;
use super::*;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<EventPayload>>,
    trays: Mutex<Vec<TrayView>>,
    /// Every native prompt shown, with how long it may stay up.
    asked: Mutex<Vec<NativePrompt>>,
    timeouts: Mutex<Vec<Duration>>,
    /// The person's answers, in order; with none left a prompt stays open.
    answers: Mutex<VecDeque<bool>>,
    open: Mutex<Vec<oneshot::Sender<bool>>>,
    /// Every banner put up: (title, body).
    notices: Mutex<Vec<(String, String)>>,
}

impl Host for Recorder {
    fn emit(&self, payload: &EventPayload) {
        self.events.lock().unwrap().push(payload.clone());
    }

    fn tray(&self, view: &TrayView) {
        self.trays.lock().unwrap().push(view.clone());
    }

    fn ask(&self, prompt: &NativePrompt, timeout: Duration, answer: oneshot::Sender<bool>) {
        self.asked.lock().unwrap().push(prompt.clone());
        self.timeouts.lock().unwrap().push(timeout);
        match self.answers.lock().unwrap().pop_front() {
            Some(a) => {
                let _ = answer.send(a);
            }
            None => self.open.lock().unwrap().push(answer),
        }
    }

    fn notify(&self, title: &str, body: &str) {
        self.notices.lock().unwrap().push((title.to_string(), body.to_string()));
    }
}

impl Recorder {
    fn notice_titles(&self) -> Vec<String> {
        self.notices.lock().unwrap().iter().map(|(t, _)| t.clone()).collect()
    }

    fn of(&self, job: &str) -> Vec<EventPayload> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.job_id == job)
            .cloned()
            .collect()
    }

    async fn wait_for(&self, what: &str, pred: impl Fn(&EventPayload) -> bool) -> EventPayload {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(e) = self.events.lock().unwrap().iter().find(|e| pred(e)).cloned() {
                return e;
            }
            if tokio::time::Instant::now() > deadline {
                panic!("timed out waiting for {what}; got {:#?}", self.events.lock().unwrap());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_tray(&self, what: &str, pred: impl Fn(&TrayView) -> bool) -> TrayView {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(v) = self.trays.lock().unwrap().last().filter(|v| pred(v)).cloned() {
                return v;
            }
            if tokio::time::Instant::now() > deadline {
                panic!("timed out waiting for the tray to show {what}; got {:#?}", self.trays.lock().unwrap());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_exit(&self, job: &str, after_seq: u64) -> EventPayload {
        self.wait_for("a process exit", |e| {
            e.job_id == job && e.seq > after_seq && e.event.get("reason").is_some()
        })
        .await
    }
}

fn is_status(e: &EventPayload, job: &str, status: &str) -> bool {
    e.job_id == job && e.event["kind"] == "status" && e.event["status"] == status
}

/// Speaks the l0 protocol; never starts eve.
const FAKE_LAUNCHER: &str = r#"
names=$(env | cut -d= -f1 | sort | tr '\n' ',')
tmp=no; [ -d "$TMPDIR" ] && tmp=yes
printf '{"type":"ready","port":4242,"eveVersion":"0.79.1"}\n'
echo "fake launcher up" >&2
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
      printf 'a stray console.log from a library\n'
      printf '{"type":"heartbeat"}\n'
      printf '{"type":"event","event":{"kind":"text","delta":"cwd=%s|folder=%s|mode=%s|tmp=%s|path=%s|model=%s|token=%s|env=%s"}}\n' "$(pwd -P)" "$LOCAL_AGENT_FOLDER" "$LOCAL_AGENT_MODE" "$tmp" "$PATH" "${LOCAL_AGENT_MODEL_BASE_URL:-none}" "${LOCAL_AGENT_MODEL_TOKEN:-none}" "$names"
      printf '{"type":"cursor","streamIndex":5}\n'
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"resume"'*)
      idx=other; case "$line" in *'"sessionId":"ses-'*'"streamIndex":5'*) idx=ok;; esac
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":5}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"text","delta":"resumed %s token=%s"}}\n' "$idx" "${LOCAL_AGENT_MODEL_TOKEN:-none}"
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"send"'*)
      p=queue; case "$line" in *'"policy":"steer"'*) p=steer;; esac
      printf '{"type":"event","event":{"kind":"message","text":"got a %s message"}}\n' "$p"
      ;;
    *'"type":"token"'*)
      t=$(printf '%s' "$line" | sed 's/.*"modelToken":"\([^"]*\)".*/\1/')
      printf '{"type":"event","event":{"kind":"message","text":"token %s"}}\n' "$t"
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
exit 0
"#;

/// Ignores stop, EOF and SIGTERM; only SIGKILL ends it.
const STUBBORN_LAUNCHER: &str = r#"
trap '' TERM
printf '{"type":"session","sessionId":"ses-stubborn","streamIndex":0}\n'
printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
while :; do sleep 1; done
"#;

/// Reports a fatal error and exits non-zero once started.
const FATAL_LAUNCHER: &str = r#"
read -r line
printf '{"type":"session","sessionId":"ses-fatal","streamIndex":0}\n'
printf '{"type":"fatal","message":"eve server did not start"}\n'
exit 3
"#;

/// Finds the job's lock held by a leftover launcher.
const LOCKED_LAUNCHER: &str = r#"
read -r line
printf '{"type":"fatal","message":"job already running"}\n'
exit 1
"#;

/// Dies before it reports a session.
const EARLY_EXIT_LAUNCHER: &str = r#"
read -r line
exit 2
"#;

/// Dies mid-job without a word.
const CRASHING_LAUNCHER: &str = r#"
read -r line
printf '{"type":"session","sessionId":"ses-crash","streamIndex":2}\n'
printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
exit 1
"#;

struct Rig {
    svc: LocalAgentService,
    rec: Arc<Recorder>,
    _dir: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    folder: PathBuf,
    launch: LaunchConfig,
}

fn fast() -> Timing {
    Timing {
        stop_term_after: Duration::from_millis(300),
        stop_kill_after: Duration::from_millis(600),
        exit_kill_after: Duration::from_millis(800),
        exit_give_up_after: Duration::from_millis(1_400),
        resume_confirm_after: Duration::from_secs(5),
        // Off unless a test asks: nothing else here waits ten minutes.
        idle_park_after: Duration::from_secs(3600),
        idle_check_every: Duration::from_millis(50),
        // Off unless a test asks: none waits a minute for an answer.
        prompt_timeout: Duration::from_secs(60),
        worker_confirm: Duration::from_secs(60),
        worker_yes_for: Duration::from_secs(3600),
        worker_backoff: Duration::from_secs(600),
    }
}

/// A service over a temp tree, with `seed` as the state file it finds.
fn rig_with(script: &str, seed: Option<&StateFile>) -> Rig {
    build(script, seed, MAX_RINGS)
}

/// `max_rings`: how many jobs' rings the actor keeps.
fn build(script: &str, seed: Option<&StateFile>, max_rings: usize) -> Rig {
    build_timed(script, seed, max_rings, fast())
}

fn build_timed(script: &str, seed: Option<&StateFile>, max_rings: usize, timing: Timing) -> Rig {
    build_tuned(script, seed, timing, |actor| actor.max_rings = max_rings)
}

/// `tune`: the actor, before it runs.
fn build_tuned(script: &str, seed: Option<&StateFile>, timing: Timing, tune: impl FnOnce(&mut Actor)) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let root = base.join("data/local-agent");
    let home = base.join("home");
    let folder = home.join("project");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::create_dir_all(base.join("tmp")).unwrap();
    if let Some(s) = seed {
        s.save(&root.join("state.json")).unwrap();
    }
    let script_path = base.join("launcher.sh");
    std::fs::write(&script_path, script).unwrap();
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
        Arc::new(Runtime::new(
            RuntimeSpec::pinned(),
            root.join("runtime"),
            reqwest::Client::new(),
        )),
    ));
    let rec = Arc::new(Recorder::default());
    let (svc, mut actor) = LocalAgentService::with_host(rec.clone(), paths, timing, resolver, true);
    tune(&mut actor);
    tokio::spawn(actor.run());
    let launch = LaunchConfig {
        node: "/bin/sh".into(),
        launcher: script_path,
        agent_dir: base.join("agent").to_str().unwrap().into(),
        env_file: None,
        tool_path: "/usr/bin:/bin".into(),
        home: home.to_str().unwrap().into(),
        model_base_url: super::config::model_base_url("https://dial8.test"),
        git: "/usr/bin/git".into(),
        // A git without the developer's global or system config.
        git_env: vec![
            ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ],
        gh: None,
        api_origin: "https://dial8.test".into(),
    };
    Rig {
        svc,
        rec,
        _dir: dir,
        base,
        root,
        folder,
        launch,
    }
}

fn rig(script: &str) -> Rig {
    rig_with(script, None)
}

impl Rig {
    async fn grant(&self) -> String {
        self.svc
            .add_grant(self.folder.clone(), GrantMode::Read)
            .await
            .unwrap()
            .id
    }

    async fn start(&self, grant: &str) -> Result<String, String> {
        self.start_args(StartArgs {
            grant_id: grant.into(),
            request: "list the files".into(),
            ..StartArgs::default()
        })
        .await
        .map(|r| r.job_id)
    }

    async fn start_args(&self, args: StartArgs) -> Result<StartResult, String> {
        self.svc.start_with(args, self.launch.clone()).await
    }

    async fn resume(&self, id: &str) -> Result<StartResult, String> {
        self.svc.resume_with(id.into(), None, self.launch.clone()).await
    }

    async fn job(&self, id: &str) -> JobSummary {
        let report = self.svc.ask(|reply| Cmd::Snapshot { reply }).await.unwrap();
        report.jobs.into_iter().find(|j| j.id == id).expect("job listed")
    }

    fn on_disk(&self) -> StateFile {
        StateFile::load(&self.root.join("state.json")).unwrap()
    }
}

#[tokio::test]
async fn a_job_streams_persists_its_session_steers_stops_and_resumes() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    assert!(is_safe_id(&id));
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;

    // Only the three NormalizedEvents arrive: the stray stdout line and the
    // unknown message type are dropped, the control messages are Rust's.
    let events = rig.rec.of(&id);
    assert_eq!(
        events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "{events:#?}"
    );
    let text = events[1].event["delta"].as_str().unwrap().to_string();
    let field = |k: &str| {
        text.split('|')
            .find_map(|kv| kv.strip_prefix(&format!("{k}=")))
            .unwrap()
            .to_string()
    };
    assert_eq!(
        field("cwd"),
        rig.root.join("jobs").join(&id).display().to_string(),
        "cwd = the job folder"
    );
    assert_eq!(
        field("folder"),
        rig.folder.display().to_string(),
        "the folder comes from the grant"
    );
    assert_eq!(field("mode"), "read");
    assert_eq!(field("tmp"), "yes", "the job's own TMPDIR exists");
    assert_eq!(field("path"), "/usr/bin:/bin");
    assert_eq!(field("model"), "none", "no token: no relay (the dev key, if any)");
    assert_eq!(field("token"), "none");
    let allowed = [
        "HOME",
        "TMPDIR",
        "LANG",
        "PATH",
        "LOCAL_AGENT_JOB_ID",
        "LOCAL_AGENT_FOLDER",
        "LOCAL_AGENT_MODE",
        "LOCAL_AGENT_TOOL_PATH",
        "LOCAL_AGENT_DIR",
        // set by sh itself
        "PWD",
        "SHLVL",
        "OLDPWD",
        "_",
    ];
    for name in field("env").split(',').filter(|n| !n.is_empty()) {
        assert!(allowed.contains(&name), "{name} leaked into the launcher's env");
    }

    // The session and the cursor are persisted for resume.
    let job = rig.job(&id).await;
    assert_eq!(job.status, JobStatus::Waiting);
    assert!(job.live);
    assert_eq!(job.last_seq, 3);
    let disk = rig.on_disk();
    let stored = disk.job(&id).unwrap();
    assert_eq!(stored.session_id.as_deref(), Some(format!("ses-{id}").as_str()));
    assert_eq!(stored.stream_index, Some(5));
    assert_eq!(stored.status, JobStatus::Waiting);

    // Messages reach stdin with their policy.
    rig.svc
        .send(id.clone(), "also check the tests".into(), "steer".into())
        .await
        .unwrap();
    rig.rec
        .wait_for("the steer echo", |e| {
            e.job_id == id && e.event["text"] == "got a steer message"
        })
        .await;
    assert!(
        rig.svc.send(id.clone(), "x".into(), "now".into()).await.is_err(),
        "bad policy"
    );
    assert!(
        rig.svc.send(id.clone(), "   ".into(), "queue".into()).await.is_err(),
        "empty message"
    );

    // A reloaded page rebuilds from the ring; sinceSeq is exclusive.
    let all = rig.svc.events(id.clone(), 0).await.unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(
        rig.svc
            .events(id.clone(), 2)
            .await
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(rig.svc.events("nope".into(), 0).await.is_err());

    // Stop: the launcher reports cancelled and exits; the exit says why.
    rig.svc.stop(id.clone()).await.unwrap();
    let exit = rig.rec.wait_exit(&id, 0).await;
    assert_eq!(exit.event["status"], "cancelled");
    assert_eq!(exit.event["reason"], "stopped");
    let job = rig.job(&id).await;
    assert_eq!(job.status, JobStatus::Cancelled);
    assert!(!job.live);
    assert!(job.ended_at.is_some());
    assert!(job.session_id.is_some(), "kept: the job stays resumable");
    assert!(rig
        .svc
        .send(id.clone(), "hello?".into(), "queue".into())
        .await
        .unwrap_err()
        .contains("resume"));
    rig.svc
        .stop(id.clone())
        .await
        .expect("stopping a stopped job is a no-op");

    // Resume: a new process gets the stored session and cursor.
    rig.resume(&id).await.unwrap();
    let resumed = rig
        .rec
        .wait_for("resumed", |e| {
            e.job_id == id && e.event["kind"] == "text" && e.seq > exit.seq
        })
        .await;
    assert_eq!(
        resumed.event["delta"], "resumed ok token=none",
        "resume carries sessionId and streamIndex 5"
    );
    assert!(resumed.seq > exit.seq, "seq keeps counting across runs");
    assert!(rig.resume(&id).await.unwrap_err().contains("already running"));
    rig.rec
        .wait_for("waiting again", |e| is_status(e, &id, "waiting") && e.seq > resumed.seq)
        .await;
    assert!(rig.job(&id).await.live);

    rig.svc.shutdown().await;
    assert_eq!(rig.on_disk().job(&id).unwrap().status, JobStatus::Interrupted);
}

/// Stays mid-turn (`running`) until stopped.
const BUSY_LAUNCHER: &str = r#"
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
"#;

#[tokio::test]
async fn at_most_three_run_and_quitting_interrupts_them_all_within_three_seconds() {
    let rig = rig(BUSY_LAUNCHER);
    let grant = rig.grant().await;
    let mut ids = Vec::new();
    for _ in 0..MAX_RUNNING {
        ids.push(rig.start(&grant).await.unwrap());
    }
    for id in &ids {
        rig.rec.wait_for("running", |e| is_status(e, id, "running")).await;
    }
    let refused = rig.start(&grant).await.unwrap_err();
    assert!(
        refused.contains("already running"),
        "running jobs are never parked: {refused}"
    );

    let t0 = std::time::Instant::now();
    rig.svc.shutdown().await;
    assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
    for id in &ids {
        let job = rig.job(id).await;
        assert_eq!(
            job.status,
            JobStatus::Interrupted,
            "the app quit: resumable, not cancelled"
        );
        assert!(!job.live);
        assert_eq!(rig.on_disk().job(id).unwrap().status, JobStatus::Interrupted);
    }
    assert!(rig.start(&grant).await.unwrap_err().contains("quitting"));
}

#[tokio::test]
async fn a_launcher_that_ignores_stop_is_terminated_then_killed() {
    let rig = rig(STUBBORN_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("running", |e| is_status(e, &id, "running")).await;
    let t0 = std::time::Instant::now();
    rig.svc.stop(id.clone()).await.unwrap();
    let exit = rig.rec.wait_exit(&id, 0).await;
    assert!(
        t0.elapsed() >= Duration::from_millis(550),
        "SIGTERM is ignored, so it took the SIGKILL"
    );
    assert_eq!(exit.event["status"], "cancelled");
    assert_eq!(exit.event["reason"], "stopped (the launcher killed by signal 9)");
}

#[tokio::test]
async fn quitting_kills_a_stubborn_launcher_inside_the_budget() {
    let rig = rig(STUBBORN_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("running", |e| is_status(e, &id, "running")).await;
    let t0 = std::time::Instant::now();
    rig.svc.shutdown().await;
    assert!(t0.elapsed() < Duration::from_secs(3));
    assert_eq!(rig.on_disk().job(&id).unwrap().status, JobStatus::Interrupted);
}

#[tokio::test]
async fn a_fatal_line_fails_the_job_with_its_message() {
    let rig = rig(FATAL_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    let exit = rig.rec.wait_exit(&id, 0).await;
    assert_eq!(exit.event["status"], "failed");
    assert_eq!(exit.event["reason"], "eve server did not start");
    let job = rig.job(&id).await;
    assert_eq!(job.status, JobStatus::Failed);
    assert_eq!(
        job.session_id.as_deref(),
        Some("ses-fatal"),
        "the session line before the fatal one counted"
    );
}

#[tokio::test]
async fn a_launcher_dying_mid_job_interrupts_it() {
    let rig = rig(CRASHING_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    let exit = rig.rec.wait_exit(&id, 0).await;
    assert_eq!(exit.event["status"], "interrupted");
    assert_eq!(exit.event["reason"], "the launcher exited with code 1");
    // Its final lines arrived before the exit did.
    let events = rig.rec.of(&id);
    assert!(is_status(&events[0], &id, "running") && events[0].seq < exit.seq);
    assert_eq!(rig.job(&id).await.stream_index, Some(2));
}

#[tokio::test]
async fn launch_marks_jobs_the_last_run_left_live_as_interrupted() {
    let mut seed = StateFile::default();
    for (id, status) in [("left-running", JobStatus::Running), ("done", JobStatus::Completed)] {
        seed.jobs.push(Job {
            session_id: Some("s".into()),
            stream_index: Some(1),
            ..Job::new(id, "g", "r", status, "2026-10-20T00:00:00.000Z")
        });
    }
    let rig = rig_with(FAKE_LAUNCHER, Some(&seed));
    assert_eq!(rig.job("left-running").await.status, JobStatus::Interrupted);
    assert_eq!(rig.job("done").await.status, JobStatus::Completed);
    assert_eq!(
        rig.on_disk().job("left-running").unwrap().status,
        JobStatus::Interrupted,
        "and saved"
    );
    let err = rig.resume("left-running").await.unwrap_err();
    assert!(err.contains("no longer shared"), "its grant is gone: {err}");
}

#[tokio::test]
async fn grants_are_checked_deduped_and_kept_while_in_use() {
    let rig = rig(FAKE_LAUNCHER);
    let home = rig.base.join("home");
    let read = GrantMode::Read;
    assert!(rig.svc.add_grant(home.clone(), read).await.is_err(), "HOME itself");
    assert!(
        rig.svc.add_grant(rig.base.join("data"), read).await.is_err(),
        "Native Intelligence's own data"
    );
    assert!(rig.svc.add_grant(rig.base.join("missing"), read).await.is_err());
    let a = rig.svc.add_grant(rig.folder.clone(), read).await.unwrap();
    assert_eq!(a.label, "project");
    assert_eq!(a.path, rig.folder.display().to_string());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&rig.folder, home.join("link")).unwrap();
        let b = rig.svc.add_grant(home.join("link"), read).await.unwrap();
        assert_eq!(a.id, b.id, "the same realpath is the same grant");
    }

    let id = rig.start(&a.id).await.unwrap();
    assert!(rig
        .svc
        .remove_grant(a.id.clone())
        .await
        .unwrap_err()
        .contains("stop it first"));
    rig.svc.stop(id.clone()).await.unwrap();
    rig.rec.wait_exit(&id, 0).await;
    rig.svc.remove_grant(a.id.clone()).await.unwrap();
    assert!(rig.on_disk().grants.is_empty());
    assert!(rig.start(&a.id).await.unwrap_err().contains("unknown folder"));
}

#[tokio::test]
async fn a_grant_whose_folder_now_points_elsewhere_is_refused() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    // Swap the granted folder for a symlink to somewhere else.
    std::fs::rename(&rig.folder, rig.base.join("home/moved")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(rig.base.join("data"), &rig.folder).unwrap();
    let err = rig.start(&grant).await.unwrap_err();
    assert!(err.contains("now resolves to") || err.contains("can't open"), "{err}");
}

#[tokio::test]
async fn requests_are_checked() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let args = |request: String| StartArgs {
        grant_id: grant.clone(),
        request,
        ..StartArgs::default()
    };
    let empty = rig.start_args(args(" \n".into())).await.unwrap_err();
    assert!(empty.contains("empty"));
    let long = rig.start_args(args("x".repeat(MAX_TEXT_BYTES + 1))).await.unwrap_err();
    assert!(long.contains("too long"));
    let mut bad = rig.launch.clone();
    bad.node = rig.base.join("no-such-node");
    let err = rig.svc.start_with(args("hi".into()), bad).await.unwrap_err();
    assert!(err.contains("could not start the launcher"), "{err}");
    let report = rig.svc.ask(|reply| Cmd::Snapshot { reply }).await.unwrap();
    assert!(report.jobs.is_empty(), "a launch that failed leaves no job behind");
}

#[tokio::test]
async fn seq_never_repeats_after_a_jobs_ring_is_dropped() {
    let rig = build(FAKE_LAUNCHER, None, 1);
    let grant = rig.grant().await;
    let a = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("a waiting", |e| is_status(e, &a, "waiting")).await;
    rig.svc.stop(a.clone()).await.unwrap();
    let a_exit = rig.rec.wait_exit(&a, 0).await;

    // Room for one ring: starting b drops a's.
    let b = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("b waiting", |e| is_status(e, &b, "waiting")).await;
    assert!(
        rig.svc.events(a.clone(), 0).await.unwrap().is_empty(),
        "a's ring was dropped"
    );
    assert_eq!(rig.job(&a).await.last_seq, a_exit.seq, "its last seq is remembered");

    rig.resume(&a).await.unwrap();
    rig.rec
        .wait_for("a's resumed events, numbered on", |e| {
            e.job_id == a && e.event["kind"] == "text" && e.seq > a_exit.seq
        })
        .await;
    let after = rig.svc.events(a.clone(), 0).await.unwrap();
    assert_eq!(after[0].seq, a_exit.seq + 1, "{after:#?}");
    assert!(after.iter().all(|e| e.seq > a_exit.seq));
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn resuming_a_job_a_leftover_launcher_still_holds_fails_clearly() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    rig.svc.stop(id.clone()).await.unwrap();
    let stopped = rig.rec.wait_exit(&id, 0).await;

    let mut locked = rig.launch.clone();
    locked.launcher = rig.base.join("locked.sh");
    std::fs::write(&locked.launcher, LOCKED_LAUNCHER).unwrap();
    let err = rig.svc.resume_with(id.clone(), None, locked).await.unwrap_err();
    assert!(err.contains("still running in another launcher"), "{err}");
    let exit = rig.rec.wait_exit(&id, stopped.seq).await;
    assert_eq!(exit.event["status"], "cancelled", "it keeps the status it had");
    assert_eq!(rig.job(&id).await.status, JobStatus::Cancelled);
    assert!(!rig.job(&id).await.live);

    let mut early = rig.launch.clone();
    early.launcher = rig.base.join("early.sh");
    std::fs::write(&early.launcher, EARLY_EXIT_LAUNCHER).unwrap();
    let err = rig.svc.resume_with(id.clone(), None, early).await.unwrap_err();
    assert_eq!(err, "the job didn't resume: the launcher exited with code 2");

    // And a healthy launcher resumes it.
    rig.resume(&id).await.unwrap();
    assert!(rig.job(&id).await.live);
    rig.svc.shutdown().await;
}

#[test]
fn exit_outcomes() {
    let clean = ExitInfo {
        code: Some(0),
        signal: None,
        error: None,
    };
    let crash = ExitInfo {
        code: Some(1),
        signal: None,
        error: None,
    };
    let killed = ExitInfo {
        code: None,
        signal: Some(9),
        error: None,
    };
    use JobStatus::*;
    let o = |cur, stop, info: &ExitInfo, fatal: Option<&str>| exit_outcome(cur, stop, info, fatal, true);
    assert_eq!(
        o(Waiting, Some(StopKind::Park), &killed, None),
        (Waiting, PARKED.into()),
        "parked: still waiting, however it exited"
    );
    assert_eq!(
        exit_outcome(Waiting, Some(StopKind::Park), &clean, None, false).0,
        Failed
    );
    assert_eq!(
        o(Running, Some(StopKind::User), &clean, None),
        (Cancelled, "stopped".into())
    );
    assert_eq!(
        o(Completed, Some(StopKind::User), &clean, None).0,
        Cancelled,
        "after a stop: always cancelled"
    );
    assert_eq!(o(Running, Some(StopKind::User), &killed, None).0, Cancelled);
    assert_eq!(
        o(Waiting, Some(StopKind::AppExit), &clean, None),
        (Interrupted, "the app quit".into())
    );
    assert_eq!(o(Running, None, &crash, Some("boom")), (Failed, "boom".into()));
    assert_eq!(
        o(Running, None, &crash, None),
        (Interrupted, "the launcher exited with code 1".into())
    );
    assert_eq!(
        o(Waiting, None, &clean, None).0,
        Interrupted,
        "an unasked exit mid-job is resumable"
    );
    assert_eq!(
        o(Completed, None, &clean, None),
        (Completed, "the launcher exited with code 0".into())
    );
    assert_eq!(
        o(Failed, None, &killed, None),
        (Failed, "the launcher killed by signal 9".into())
    );
    assert_eq!(
        exit_outcome(Starting, None, &crash, None, false),
        (
            Failed,
            "the launcher exited with code 1 before it started a session".into()
        ),
        "no session: nothing to resume"
    );
    assert_eq!(
        exit_outcome(Starting, Some(StopKind::AppExit), &clean, None, false).0,
        Interrupted
    );
}

#[test]
fn ids_that_become_paths_are_plain() {
    assert!(is_safe_id(&uuid::Uuid::new_v4().to_string()));
    for bad in ["", "..", "../x", "a/b", "a b", &"x".repeat(65)] {
        assert!(!is_safe_id(bad), "{bad:?}");
    }
}

#[test]
fn status_report_serializes_camel_case_without_empty_fields() {
    let r = StatusReport {
        available: false,
        reason: Some("no dev config".into()),
        node: None,
        agent_dir: None,
        built: false,
        grants: vec![],
        jobs: vec![JobSummary {
            id: "j".into(),
            grant_id: "g".into(),
            request: "r".into(),
            mode: GrantMode::Edit,
            status: JobStatus::Interrupted,
            created_at: "t".into(),
            ended_at: None,
            session_id: Some("s".into()),
            stream_index: Some(4),
            live: false,
            worker: None,
            asking: false,
            parked: true,
            last_seq: 0,
            run_id: Some("run".into()),
            branch: Some("dial8/site-12345678".into()),
            commit: None,
            pull_request: None,
        }],
        runtime: None,
        local_model: false,
        base_branch: true,
    };
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v["reason"], "no dev config");
    assert_eq!(v["localModel"], false);
    assert_eq!(v["baseBranch"], true, "the web shows its base-branch field for this app");
    assert!(v.get("node").is_none() && v.get("agentDir").is_none());
    assert!(v.get("runtime").is_none(), "dev mode has no runtime");
    let job = &v["jobs"][0];
    assert_eq!(job["grantId"], "g");
    assert_eq!(job["status"], "interrupted");
    assert_eq!(job["sessionId"], "s");
    assert_eq!(job["streamIndex"], 4);
    assert_eq!(job["lastSeq"], 0);
    assert_eq!(job["mode"], "edit");
    assert_eq!(job["parked"], true);
    assert_eq!(job["runId"], "run");
    assert_eq!(job["branch"], "dial8/site-12345678");
    assert!(job.get("endedAt").is_none() && job.get("commit").is_none());
    assert!(job.get("pullRequest").is_none());
    let payload = serde_json::to_value(EventPayload {
        job_id: "j".into(),
        seq: 1,
        run_id: Some("run".into()),
        event: serde_json::json!({"kind":"text"}),
    })
    .unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"jobId":"j","seq":1,"runId":"run","event":{"kind":"text"}})
    );
    let started = serde_json::to_value(StartResult {
        job_id: "j".into(),
        run_id: "run".into(),
    })
    .unwrap();
    assert_eq!(started, serde_json::json!({"jobId":"j","runId":"run"}));
}

// ─── L1: device, server job ids, run ids, tokens, edit jobs ─────────────────

/// Plays an edit job: edits its folder (the worktree), calls `finish`, waits.
const EDIT_LAUNCHER: &str = r#"
printf '{"type":"ready","port":4242}\n'
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
      printf '{"type":"event","event":{"kind":"text","delta":"folder=%s|mode=%s|extra=%s|model=%s|token=%s"}}\n' "$LOCAL_AGENT_FOLDER" "$LOCAL_AGENT_MODE" "${LOCAL_AGENT_EXTRA_READ:-none}" "${LOCAL_AGENT_MODEL_BASE_URL:-none}" "${LOCAL_AGENT_MODEL_TOKEN:-none}"
      printf 'changed by the agent\n' > "$LOCAL_AGENT_FOLDER/README.md"
      printf 'new\n' > "$LOCAL_AGENT_FOLDER/added.txt"
      printf '{"type":"event","event":{"kind":"finish","summary":"Update the readme\\n\\nAnd add a file."}}\n'
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
exit 0
"#;

/// A config-free git, as the person's tests would run it.
fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repo on `main` with one commit, and hooks that would leave a marker
/// (and refuse the commit) if git ever ran them.
fn init_repo(dir: &std::path::Path, markers: &std::path::Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("README.md"), "original\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "init"]);
    for hook in ["pre-commit", "commit-msg", "post-commit", "post-checkout", "pre-push"] {
        let path = dir.join(".git/hooks").join(hook);
        std::fs::write(
            &path,
            format!("#!/bin/sh\ntouch '{}'\nexit 1\n", markers.join(hook).display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

fn text_field(text: &str, k: &str) -> String {
    text.split('|')
        .find_map(|kv| kv.strip_prefix(&format!("{k}=")))
        .unwrap_or_else(|| panic!("{k} not in {text}"))
        .to_string()
}

#[tokio::test]
async fn edit_jobs_work_in_a_worktree_and_commit_on_finish_without_hooks() {
    let rig = rig(EDIT_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    let head = git(&rig.folder, &["rev-parse", "HEAD"]);

    let grant = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    assert_eq!(grant.mode, GrantMode::Edit);
    assert!(grant.is_git);
    let job_id = uuid::Uuid::new_v4().to_string();
    let started = rig
        .start_args(StartArgs {
            grant_id: grant.id.clone(),
            request: "update the readme".into(),
            job_id: Some(job_id.clone()),
            mode: Some("edit".into()),
            model_token: Some("tok-test-0123456789abcdef".into()),
            resume: None,
            worker: None,
            local_model: None,
            base_branch: None,
        })
        .await
        .unwrap();
    assert_eq!(started.job_id, job_id);

    let branch_ev = rig
        .rec
        .wait_for("the branch event", |e| {
            e.job_id == job_id && e.event["kind"] == "branch"
        })
        .await;
    let worktree = rig.base.join("home/.dial8/worktrees").join(&job_id);
    assert!(worktree.join(".git").is_file(), "a linked worktree");

    // The launcher worked in the worktree, could read the repo's .git, and
    // talked to the relay at the app's origin with the server's token.
    let events = rig.rec.of(&job_id);
    let text = events.iter().find(|e| e.event["kind"] == "text").unwrap().event["delta"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(text_field(&text, "folder"), worktree.display().to_string());
    assert_eq!(text_field(&text, "mode"), "edit");
    assert_eq!(
        text_field(&text, "extra"),
        rig.folder.join(".git").display().to_string()
    );
    assert_eq!(text_field(&text, "model"), "https://dial8.test/api/local-agent/model");
    assert_eq!(text_field(&text, "token"), "tok-test-0123456789abcdef");

    // The commit: after the finish (and the turn's end), with the next seq.
    let finish = events.iter().find(|e| e.event["kind"] == "finish").unwrap();
    assert!(branch_ev.seq > finish.seq);
    assert_eq!(branch_ev.run_id.as_deref(), Some(started.run_id.as_str()));
    let branch = format!("dial8/project-{}", &job_id[..8]);
    assert_eq!(branch_ev.event["branch"], branch);
    assert_eq!(branch_ev.event["filesChanged"], 2);
    assert_eq!(branch_ev.event["insertions"], 2);
    assert_eq!(branch_ev.event["deletions"], 1);
    let sha = git(&rig.folder, &["rev-parse", &branch]);
    assert_eq!(branch_ev.event["commit"], sha);
    assert_eq!(
        git(&rig.folder, &["log", "-1", "--format=%s", &branch]),
        "Update the readme"
    );
    assert_eq!(git(&rig.folder, &["log", "-1", "--format=%an", &branch]), "Test");

    // The person's checkout: same branch, same HEAD, same files, clean.
    assert_eq!(git(&rig.folder, &["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(git(&rig.folder, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(rig.folder.join("README.md")).unwrap(),
        "original\n"
    );
    assert!(!rig.folder.join("added.txt").exists());
    assert_eq!(git(&rig.folder, &["status", "--porcelain"]), "");
    // No hook ran: not the commit's, not the checkout's.
    let ran: Vec<_> = std::fs::read_dir(&markers)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(ran.is_empty(), "hooks ran: {ran:?}");

    let job = rig.job(&job_id).await;
    assert_eq!(job.mode, GrantMode::Edit);
    assert_eq!(job.branch.as_deref(), Some(branch.as_str()));
    assert_eq!(job.commit.as_deref(), Some(sha.as_str()));
    let stored = rig.on_disk().job(&job_id).unwrap().clone();
    assert_eq!(stored.base_commit.as_deref(), Some(head.as_str()));
    assert_eq!(stored.worktree.as_deref(), Some(worktree.to_str().unwrap()));

    // Stop, then resume: the same worktree and branch, a new run, a second
    // commit (empty: nothing new), stats still against the branch's start.
    rig.svc.stop(job_id.clone()).await.unwrap();
    let stopped = rig.rec.wait_exit(&job_id, branch_ev.seq).await;
    let resumed = rig.resume(&job_id).await.unwrap();
    assert_ne!(resumed.run_id, started.run_id, "a run id per launcher process");
    let again = rig
        .rec
        .wait_for("the second branch event", |e| {
            e.job_id == job_id && e.event["kind"] == "branch" && e.seq > stopped.seq
        })
        .await;
    assert_eq!(again.run_id.as_deref(), Some(resumed.run_id.as_str()));
    assert_eq!(again.event["filesChanged"], 2);
    assert_eq!(
        git(&rig.folder, &["rev-list", "--count", &format!("{head}..{branch}")]),
        "2"
    );
    assert_eq!(git(&rig.folder, &["rev-parse", "HEAD"]), head, "still untouched");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_worktree_that_no_longer_points_at_its_repo_is_refused() {
    let rig = rig(EDIT_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    let grant = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    let started = rig
        .start_args(StartArgs {
            grant_id: grant.id,
            request: "edit".into(),
            mode: Some("edit".into()),
            ..StartArgs::default()
        })
        .await
        .unwrap();
    let id = started.job_id;
    rig.rec
        .wait_for("branch", |e| e.job_id == id && e.event["kind"] == "branch")
        .await;
    rig.svc.stop(id.clone()).await.unwrap();
    rig.rec.wait_exit(&id, 0).await;
    // Point the worktree at some other repository.
    let other = rig.base.join("home/other");
    std::fs::create_dir_all(&other).unwrap();
    git(&other, &["init", "-q"]);
    let wt = rig.base.join("home/.dial8/worktrees").join(&id);
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", other.join(".git").display())).unwrap();
    let err = rig.resume(&id).await.unwrap_err();
    assert!(err.contains("worktree is not usable"), "{err}");
}

#[tokio::test]
async fn edits_need_a_git_root_granted_for_edits() {
    let rig = rig(FAKE_LAUNCHER);
    // Not a git repo: the grant is read-only whatever was asked.
    let (real, is_git) = rig.svc.check_pick(rig.folder.clone()).await.unwrap();
    assert_eq!(real, rig.folder);
    assert!(!is_git);
    let g = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    assert_eq!(g.mode, GrantMode::Read);
    let edit = |grant_id: String, mode: &str| StartArgs {
        grant_id,
        request: "edit".into(),
        mode: Some(mode.into()),
        ..StartArgs::default()
    };
    let err = rig.start_args(edit(g.id.clone(), "edit")).await.unwrap_err();
    assert!(err.contains("read-only"), "{err}");
    let err = rig.start_args(edit(g.id.clone(), "write")).await.unwrap_err();
    assert!(err.contains("mode must be"), "{err}");

    // A git root granted read-only: still no edits, until it is picked
    // again with "Allow changes" (the same grant, its mode flipped).
    git(&rig.folder, &["init", "-q"]);
    assert!(rig.svc.check_pick(rig.folder.clone()).await.unwrap().1);
    let read = rig.svc.add_grant(rig.folder.clone(), GrantMode::Read).await.unwrap();
    assert_eq!(read.id, g.id);
    assert!(read.is_git);
    assert!(rig
        .start_args(edit(g.id.clone(), "edit"))
        .await
        .unwrap_err()
        .contains("read-only"));
    let allowed = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    assert_eq!((allowed.id.as_str(), allowed.mode), (g.id.as_str(), GrantMode::Edit));
    let status = rig.svc.ask(|reply| Cmd::Snapshot { reply }).await.unwrap();
    assert!(status.grants[0].is_git);
    assert_eq!(rig.on_disk().grants[0].mode, GrantMode::Edit);
    // A repo with no commit can't get a worktree: a clear error, no job.
    let err = rig.start_args(edit(g.id.clone(), "edit")).await.unwrap_err();
    assert!(err.contains("no commits yet"), "{err}");
    assert!(rig
        .svc
        .ask(|reply| Cmd::Snapshot { reply })
        .await
        .unwrap()
        .jobs
        .is_empty());
}

#[tokio::test]
async fn starts_take_the_servers_job_id_and_a_run_id_per_process() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let args = |job_id: Option<&str>| StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        job_id: job_id.map(String::from),
        ..StartArgs::default()
    };
    for bad in [
        "nope",
        "../x",
        "38CB0EEF-89E9-496D-BF08-0688225DBFCD",
        "{38cb0eef-89e9-496d-bf08-0688225dbfcd}",
    ] {
        let err = rig.start_args(args(Some(bad))).await.unwrap_err();
        assert!(err.contains("jobId"), "{bad}: {err}");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let started = rig.start_args(args(Some(&id))).await.unwrap();
    assert_eq!(started.job_id, id);
    assert!(uuid::Uuid::parse_str(&started.run_id).is_ok());
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    assert!(
        rig.rec
            .of(&id)
            .iter()
            .all(|e| e.run_id.as_deref() == Some(started.run_id.as_str())),
        "every event carries its run"
    );
    assert!(rig
        .svc
        .events(id.clone(), 0)
        .await
        .unwrap()
        .iter()
        .all(|e| e.run_id.as_deref() == Some(started.run_id.as_str())));
    assert_eq!(rig.job(&id).await.run_id.as_deref(), Some(started.run_id.as_str()));

    // Starting it again while it runs is a no-op that names the same run.
    let again = rig.start_args(args(Some(&id))).await.unwrap();
    assert_eq!(again, started);
    let other = rig
        .svc
        .add_grant(rig.base.join("home"), GrantMode::Read)
        .await
        .err()
        .map(|_| ());
    assert_eq!(other, Some(()), "HOME is refused");
    let mut wrong = args(Some(&id));
    wrong.mode = Some("edit".into());
    assert!(rig.start_args(wrong).await.unwrap_err().contains("read mode"));

    // A stopped job started again under its id resumes its own session.
    rig.svc.stop(id.clone()).await.unwrap();
    let exit = rig.rec.wait_exit(&id, 0).await;
    let restarted = rig
        .start_args(StartArgs {
            resume: Some(ResumeArgs {
                eve_session_id: "ses-from-the-server".into(),
                stream_index: 99,
            }),
            ..args(Some(&id))
        })
        .await
        .unwrap();
    assert_ne!(restarted.run_id, started.run_id);
    let resumed = rig
        .rec
        .wait_for("resumed", |e| {
            e.job_id == id && e.event["kind"] == "text" && e.seq > exit.seq
        })
        .await;
    assert_eq!(
        resumed.event["delta"], "resumed ok token=none",
        "Rust's own record (cursor 5) wins over the server's"
    );
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_start_with_resume_and_no_local_record_resumes_the_servers_session() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let id = uuid::Uuid::new_v4().to_string();
    rig.start_args(StartArgs {
        grant_id: grant,
        request: "list the files".into(),
        job_id: Some(id.clone()),
        resume: Some(ResumeArgs {
            eve_session_id: "ses-from-the-server".into(),
            stream_index: 5,
        }),
        ..StartArgs::default()
    })
    .await
    .unwrap();
    let resumed = rig
        .rec
        .wait_for("resumed", |e| e.job_id == id && e.event["kind"] == "text")
        .await;
    assert_eq!(resumed.event["delta"], "resumed ok token=none");
    let bad: Result<ResumeArgs, _> =
        serde_json::from_value(serde_json::json!({"eveSessionId":"s","streamIndex":1,"path":"/etc"}));
    assert!(bad.is_err(), "resume carries a session, nothing else");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn the_model_token_reaches_the_launcher_and_refreshes_over_stdin() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let args = |token: &str| StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        model_token: Some(token.into()),
        ..StartArgs::default()
    };
    // The launcher's MODEL_TOKEN rule: 16 to 2048 printable ASCII, no spaces.
    let fifteen = "x".repeat(MIN_TOKEN_BYTES - 1);
    for bad in [
        "",
        "short-token",
        fifteen.as_str(),
        "has a space in it 0123456789",
        "new\nline-0123456789abc",
        &"x".repeat(MAX_TOKEN_BYTES + 1),
    ] {
        assert!(
            rig.start_args(args(bad)).await.unwrap_err().contains("modelToken"),
            "{bad:?}"
        );
    }
    assert_eq!(
        check_token(&"x".repeat(MIN_TOKEN_BYTES)).unwrap().len(),
        16,
        "16 is enough"
    );
    assert!(check_token(&"x".repeat(MAX_TOKEN_BYTES)).is_ok());
    let id = rig
        .start_args(args("tok-1.abc_DEF-0123456789abcdef"))
        .await
        .unwrap()
        .job_id;
    let text = rig
        .rec
        .wait_for("the env", |e| e.job_id == id && e.event["kind"] == "text")
        .await;
    let text = text.event["delta"].as_str().unwrap();
    assert_eq!(text_field(text, "model"), "https://dial8.test/api/local-agent/model");
    assert_eq!(text_field(text, "token"), "tok-1.abc_DEF-0123456789abcdef");
    let names = text_field(text, "env");
    assert!(!names.contains("LOCAL_AGENT_DEV_ENV_FILE"));

    rig.svc
        .set_model_token(id.clone(), "tok-2-0123456789abcdef".into())
        .await
        .unwrap();
    rig.rec
        .wait_for("the token line", |e| {
            e.job_id == id && e.event["text"] == "token tok-2-0123456789abcdef"
        })
        .await;
    assert!(rig
        .svc
        .set_model_token("nope".into(), "tok-nope-0123456789".into())
        .await
        .unwrap_err()
        .contains("unknown job"));
    assert!(rig.svc.set_model_token(id.clone(), "bad token".into()).await.is_err());

    // The latest token goes to the next launch; resume can replace it.
    rig.svc.stop(id.clone()).await.unwrap();
    let exit = rig.rec.wait_exit(&id, 0).await;
    rig.resume(&id).await.unwrap();
    let r1 = rig
        .rec
        .wait_for("resumed", |e| {
            e.job_id == id && e.event["kind"] == "text" && e.seq > exit.seq
        })
        .await;
    assert_eq!(r1.event["delta"], "resumed ok token=tok-2-0123456789abcdef");
    rig.svc.stop(id.clone()).await.unwrap();
    let exit = rig.rec.wait_exit(&id, r1.seq).await;
    rig.svc
        .resume_with(id.clone(), Some("tok-3-0123456789abcdef".into()), rig.launch.clone())
        .await
        .unwrap();
    let r2 = rig
        .rec
        .wait_for("resumed again", |e| {
            e.job_id == id && e.event["kind"] == "text" && e.seq > exit.seq
        })
        .await;
    assert_eq!(r2.event["delta"], "resumed ok token=tok-3-0123456789abcdef");
    let disk = std::fs::read_to_string(rig.root.join("state.json")).unwrap();
    assert!(!disk.contains("tok-"), "tokens are never written to disk");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn the_device_id_is_made_once_and_kept() {
    let rig = rig(FAKE_LAUNCHER);
    let a = rig.svc.device("1.2.3".into()).await.unwrap();
    assert!(uuid::Uuid::parse_str(&a.device_id).is_ok());
    assert_eq!(a.app_version, "1.2.3");
    assert_eq!(a.platform, std::env::consts::OS);
    assert!(!a.name.is_empty());
    let b = rig.svc.device("1.2.3".into()).await.unwrap();
    assert_eq!(a, b);
    let disk = rig.on_disk();
    assert_eq!(disk.device_id.as_deref(), Some(a.device_id.as_str()));
    // The next app run finds it.
    let next = rig_with(FAKE_LAUNCHER, Some(&disk));
    assert_eq!(next.svc.device("1.2.4".into()).await.unwrap().device_id, a.device_id);
}

#[tokio::test]
async fn quitting_saves_interrupted_and_a_second_exit_event_returns_at_once() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    assert_eq!(rig.on_disk().job(&id).unwrap().status, JobStatus::Waiting);
    rig.svc.shutdown().await;
    assert_eq!(rig.on_disk().job(&id).unwrap().status, JobStatus::Interrupted);
    let t0 = std::time::Instant::now();
    rig.svc.shutdown().await;
    assert!(t0.elapsed() < Duration::from_millis(50));
}

#[tokio::test]
async fn a_stop_while_a_start_is_being_prepared_cancels_it_and_a_live_start_takes_a_new_token() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let id = uuid::Uuid::new_v4().to_string();
    let args = StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        job_id: Some(id.clone()),
        model_token: Some("tok-a-0123456789abcdef".into()),
        ..StartArgs::default()
    }
    .check()
    .unwrap();
    // Plan (the slot is reserved), then a stop arrives, then the launch.
    let plan = match rig
        .svc
        .ask(|reply| Cmd::PlanStart {
            args: args.clone(),
            reply,
        })
        .await
        .unwrap()
        .unwrap()
    {
        Plan::Launch(p) => p,
        Plan::Live(_) => panic!("nothing runs yet"),
    };
    assert!(rig
        .start_args(StartArgs {
            job_id: Some(id.clone()),
            ..StartArgs {
                grant_id: grant.clone(),
                request: "x".into(),
                ..StartArgs::default()
            }
        })
        .await
        .unwrap_err()
        .contains("already starting"));
    rig.svc.stop(id.clone()).await.unwrap();
    let err = rig
        .svc
        .ask(|reply| Cmd::Launch {
            args: args.clone(),
            plan,
            prepared: Ok(None),
            launch: rig.launch.clone(),
            reply,
        })
        .await
        .unwrap()
        .unwrap_err();
    assert!(err.contains("stopped before it started"), "{err}");
    assert!(rig
        .svc
        .ask(|reply| Cmd::Snapshot { reply })
        .await
        .unwrap()
        .jobs
        .is_empty());

    // Started for real; a retried start with a fresh token hands it over.
    let started = rig
        .svc
        .start_with(
            StartArgs {
                grant_id: grant.clone(),
                request: "list the files".into(),
                job_id: Some(id.clone()),
                model_token: Some("tok-a-0123456789abcdef".into()),
                ..StartArgs::default()
            },
            rig.launch.clone(),
        )
        .await
        .unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    let again = rig
        .svc
        .start_with(
            StartArgs {
                grant_id: grant,
                request: "list the files".into(),
                job_id: Some(id.clone()),
                model_token: Some("tok-b-0123456789abcdef".into()),
                ..StartArgs::default()
            },
            rig.launch.clone(),
        )
        .await
        .unwrap();
    assert_eq!(again, started);
    rig.rec
        .wait_for("the new token", |e| {
            e.job_id == id && e.event["text"] == "token tok-b-0123456789abcdef"
        })
        .await;
    rig.svc.shutdown().await;
}

/// Like [`EDIT_LAUNCHER`], plus one 60 MB file (sparse: instant, no disk).
const BIG_EDIT_LAUNCHER: &str = r#"
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
      printf 'changed by the agent\n' > "$LOCAL_AGENT_FOLDER/README.md"
      dd if=/dev/zero of="$LOCAL_AGENT_FOLDER/big.bin" bs=1 count=0 seek=62914560 2>/dev/null
      printf '{"type":"event","event":{"kind":"finish","summary":"Add a big file"}}\n'
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"stop"'*) exit 0 ;;
  esac
done
"#;

#[tokio::test]
async fn changes_over_the_commit_budget_are_not_committed_and_stay_in_the_worktree() {
    let rig = rig(BIG_EDIT_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    let head = git(&rig.folder, &["rev-parse", "HEAD"]);
    let grant = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    let id = rig
        .start_args(StartArgs {
            grant_id: grant.id,
            request: "add a big file".into(),
            mode: Some("edit".into()),
            ..StartArgs::default()
        })
        .await
        .unwrap()
        .job_id;
    let err = rig
        .rec
        .wait_for("the error", |e| e.job_id == id && e.event["kind"] == "error")
        .await;
    let message = err.event["message"].as_str().unwrap();
    assert!(
        message.contains("too large to commit") && message.contains("big.bin is 60 MB"),
        "{message}"
    );
    assert!(rig.rec.of(&id).iter().all(|e| e.event["kind"] != "branch"));
    let branch = rig.job(&id).await.branch.unwrap();
    assert_eq!(
        git(&rig.folder, &["rev-parse", &branch]),
        head,
        "no commit on the branch"
    );
    assert_eq!(rig.job(&id).await.commit, None);
    // The worktree is left as it was: the changes are still there, unstaged.
    let wt = rig.base.join("home/.dial8/worktrees").join(&id);
    assert_eq!(std::fs::metadata(wt.join("big.bin")).unwrap().len(), 62_914_560);
    assert_eq!(
        std::fs::read_to_string(wt.join("README.md")).unwrap(),
        "changed by the agent\n"
    );
    assert_eq!(git(&wt, &["diff", "--cached", "--name-only"]), "", "nothing staged");
    assert_eq!(git(&rig.folder, &["rev-parse", "HEAD"]), head);
    rig.svc.shutdown().await;
}

// ─── Parking idle launchers ─────────────────────────────────────────────────

fn parked_exit(e: &EventPayload, job: &str) -> bool {
    e.job_id == job && e.event["reason"] == PARKED
}

#[test]
fn the_oldest_idle_job_is_picked_and_ten_minutes_is_the_bar() {
    // A fake clock: instants made, not waited for.
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let idle = [("a", at(300)), ("b", at(0)), ("c", at(500))];
    assert_eq!(oldest_idle(idle).as_deref(), Some("b"));
    assert_eq!(oldest_idle([]), None);
    let ten = Timing::default().idle_park_after;
    assert_eq!(ten, Duration::from_secs(600));
    assert_eq!(
        idle_too_long(idle, at(900), ten),
        vec!["a".to_string(), "b".to_string()]
    );
    assert_eq!(idle_too_long(idle, at(599), ten), Vec::<String>::new());
    assert_eq!(idle_too_long(idle, at(600), ten), vec!["b".to_string()]);
}

#[tokio::test]
async fn a_fourth_start_parks_the_least_recently_active_idle_job_and_it_resumes() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let mut ids = Vec::new();
    for _ in 0..MAX_RUNNING {
        let id = rig.start(&grant).await.unwrap();
        rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
        ids.push(id);
    }
    let (a, b, c) = (ids[0].clone(), ids[1].clone(), ids[2].clone());
    // a was talked to last: b is now the least recently active idle job.
    rig.svc
        .send(a.clone(), "anything else?".into(), "queue".into())
        .await
        .unwrap();
    rig.rec
        .wait_for("a's answer", |e| e.job_id == a && e.event["kind"] == "message")
        .await;

    let d = rig.start(&grant).await.unwrap();
    let exit = rig.rec.wait_for("b parked", |e| parked_exit(e, &b)).await;
    assert_eq!(exit.event["status"], "waiting");
    assert!(
        rig.rec.of(&b).iter().all(|e| e.event["status"] != "cancelled"),
        "its launcher's own cancelled on the way out is not passed on"
    );
    let job = rig.job(&b).await;
    assert_eq!(
        (job.status, job.live, job.parked),
        (JobStatus::Waiting, false, true),
        "parked: waiting, no process"
    );
    assert!(job.session_id.is_some() && job.ended_at.is_none());
    assert_eq!(rig.on_disk().job(&b).unwrap().status, JobStatus::Waiting);
    for other in [&a, &c, &d] {
        assert!(rig.job(other).await.live, "only b was parked");
    }
    let v = serde_json::to_value(rig.job(&b).await).unwrap();
    assert_eq!(
        (v["status"].clone(), v["live"].clone(), v["parked"].clone()),
        ("waiting".into(), false.into(), true.into())
    );

    // The next message revives it (resume, then send): resuming needs a slot
    // too, so the least recently active idle one goes (c; a is mid-turn).
    rig.rec.wait_for("d waiting", |e| is_status(e, &d, "waiting")).await;
    rig.resume(&b).await.unwrap();
    rig.rec
        .wait_for("b resumed", |e| {
            e.job_id == b && e.event["delta"] == "resumed ok token=none"
        })
        .await;
    rig.rec.wait_for("c parked", |e| parked_exit(e, &c)).await;
    let job = rig.job(&b).await;
    assert!(job.live && !job.parked);
    rig.svc
        .send(b.clone(), "and now?".into(), "queue".into())
        .await
        .unwrap();
    rig.svc.shutdown().await;
    // A parked job stays waiting through a quit and the next launch.
    let disk = rig.on_disk();
    assert_eq!(disk.job(&c).unwrap().status, JobStatus::Waiting);
    assert!(disk.job(&c).unwrap().parked);
    assert_eq!(
        disk.job(&b).unwrap().status,
        JobStatus::Interrupted,
        "b was live at quit"
    );
    let next = rig_with(FAKE_LAUNCHER, Some(&disk));
    assert_eq!(next.job(&c).await.status, JobStatus::Waiting);
}

#[tokio::test]
async fn running_jobs_are_never_parked_to_make_room() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let mut busy = rig.launch.clone();
    busy.launcher = rig.base.join("busy.sh");
    std::fs::write(&busy.launcher, BUSY_LAUNCHER).unwrap();
    let start_busy = || async {
        rig.svc
            .start_with(
                StartArgs {
                    grant_id: grant.clone(),
                    request: "work".into(),
                    ..StartArgs::default()
                },
                busy.clone(),
            )
            .await
            .unwrap()
            .job_id
    };
    let r1 = start_busy().await;
    let r2 = start_busy().await;
    let idle = rig.start(&grant).await.unwrap();
    rig.rec
        .wait_for("idle waiting", |e| is_status(e, &idle, "waiting"))
        .await;
    for r in [&r1, &r2] {
        rig.rec.wait_for("running", |e| is_status(e, r, "running")).await;
    }
    // Full: the idle one makes room; then only running ones are left.
    let fourth = start_busy().await;
    rig.rec.wait_for("idle parked", |e| parked_exit(e, &idle)).await;
    rig.rec.wait_for("running", |e| is_status(e, &fourth, "running")).await;
    let err = rig.start(&grant).await.unwrap_err();
    assert!(err.contains("already running"), "{err}");
    for r in [&r1, &r2, &fourth] {
        let job = rig.job(r).await;
        assert!(job.live && !job.parked, "{r} kept running");
    }
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_job_idle_past_the_bar_is_parked_and_resumes() {
    let timing = Timing {
        idle_park_after: Duration::from_millis(300),
        ..fast()
    };
    let rig = build_timed(FAKE_LAUNCHER, None, MAX_RINGS, timing);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    let waiting = rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    let exit = rig.rec.wait_for("parked when idle", |e| parked_exit(e, &id)).await;
    assert!(exit.seq > waiting.seq);
    let job = rig.job(&id).await;
    assert_eq!((job.status, job.live, job.parked), (JobStatus::Waiting, false, true));
    let resumed = rig.resume(&id).await.unwrap();
    rig.rec
        .wait_for("resumed", |e| {
            e.job_id == id && e.event["delta"] == "resumed ok token=none"
        })
        .await;
    assert_eq!(rig.job(&id).await.run_id.as_deref(), Some(resumed.run_id.as_str()));
    // A job that keeps talking is not idle.
    rig.svc
        .send(id.clone(), "still there?".into(), "queue".into())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(rig.job(&id).await.live, "a message counts as a turn on its way");
    rig.svc.shutdown().await;
}

// ─── Packaged mode: the bundled agent, the pinned runtime ───────────────────

/// A packaged agent's files, as the build stages them.
fn fake_bundle(dir: &std::path::Path) -> PathBuf {
    let bundle = dir.join("Resources/local-agent");
    for f in super::config::BUNDLE_FILES {
        let p = bundle.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "// bundled\n").unwrap();
    }
    bundle
}

#[tokio::test]
async fn status_reports_the_packaged_agent_and_its_runtime() {
    let mut rig = rig(FAKE_LAUNCHER);
    let bundle = fake_bundle(&rig.base);
    // No dev.json: packaged mode, in a debug build too.
    rig.svc.resolver = Arc::new(Resolver::new(
        true,
        rig.root.join("dev.json"),
        rig.base.join("home"),
        Some(bundle.clone()),
        Arc::new(Runtime::new(
            RuntimeSpec::pinned(),
            rig.root.join("runtime"),
            reqwest::Client::new(),
        )),
    ));
    let report = rig.svc.status().await.unwrap();
    assert!(report.available, "{:?}", report.reason);
    assert!(report.built);
    assert_eq!(report.agent_dir.as_deref(), bundle.to_str());
    assert_eq!(report.node, None, "the runtime isn't downloaded by a status check");
    let v: Value = serde_json::to_value(&report).unwrap();
    assert_eq!(v["runtime"]["state"], "missing");
    assert_eq!(v["runtime"]["version"], RuntimeSpec::pinned().version.as_str());
    assert!(!rig.root.join("runtime").exists(), "nothing was downloaded");
}

#[tokio::test]
async fn starts_and_resumes_without_a_model_token_are_refused_unless_debug() {
    let mut rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    rig.svc.require_model_token = true;
    let args = |token: Option<&str>| StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        model_token: token.map(str::to_string),
        ..StartArgs::default()
    };
    assert_eq!(
        rig.svc.start(args(None)).await.unwrap_err(),
        "local agents need a session from Native Intelligence"
    );
    assert_eq!(
        rig.svc
            .resume(uuid::Uuid::new_v4().to_string(), None, None, None)
            .await
            .unwrap_err(),
        "local agents need a session from Native Intelligence"
    );
    // With one it goes on (here to the rig's unavailable setup).
    let err = rig.svc.start(args(Some("tok.0123456789abcdef"))).await.unwrap_err();
    assert!(err.starts_with("unavailable: "), "{err}");
    // The dev page's build starts without one.
    rig.svc.require_model_token = false;
    let err = rig.svc.start(args(None)).await.unwrap_err();
    assert!(err.starts_with("unavailable: "), "{err}");
    assert_eq!(
        LocalAgentService::with_host(
            Arc::new(Recorder::default()),
            Paths {
                root: rig.root.clone(),
                tmp_root: rig.base.join("tmp"),
                home: rig.base.join("home"),
                protected: vec![],
            },
            fast(),
            rig.svc.resolver.clone(),
            true,
        )
        .0
        .require_model_token,
        !cfg!(debug_assertions),
        "only a debug build starts without a token"
    );
}

#[tokio::test]
async fn the_tray_shows_running_jobs_once_a_folder_is_shared() {
    let rig = rig(FAKE_LAUNCHER);
    // Nothing shared: nothing to draw, and a view that doesn't change isn't sent again.
    rig.rec.wait_tray("nothing", |v| !v.shown).await;
    rig.svc.ask(|reply| Cmd::Snapshot { reply }).await.unwrap();
    assert_eq!(rig.rec.trays.lock().unwrap().len(), 1);

    let grant = rig.grant().await;
    rig.rec.wait_tray("the switch", |v| v.shown && !v.off && v.jobs.is_empty()).await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    let v = rig
        .rec
        .wait_tray("a waiting job", |v| v.jobs.iter().any(|j| j.state == TrayJobState::Waiting))
        .await;
    assert_eq!(
        v.jobs,
        vec![TrayJob {
            id: id.clone(),
            label: "project".into(),
            state: TrayJobState::Waiting,
        }]
    );

    rig.svc.stop(id.clone()).await.unwrap();
    rig.rec.wait_exit(&id, 0).await;
    rig.rec.wait_tray("no jobs", |v| v.shown && v.jobs.is_empty()).await;
    let seen = rig.rec.trays.lock().unwrap().clone();
    assert!(
        seen.windows(2).all(|w| w[0] != w[1]),
        "only changes are sent: {seen:#?}"
    );
}

#[tokio::test]
async fn turning_local_agents_off_stops_every_job_and_refuses_new_ones_until_on() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;

    rig.svc.set_off(true).await.unwrap();
    let exit = rig.rec.wait_exit(&id, 0).await;
    assert_eq!(exit.event["status"], "cancelled", "{exit:#?}");
    let job = rig.job(&id).await;
    assert_eq!(job.status, JobStatus::Cancelled);
    assert!(job.session_id.is_some(), "its session is kept");
    rig.rec.wait_tray("off", |v| v.shown && v.off && v.jobs.is_empty()).await;

    // Kept across launches, and everything that would run something is refused.
    assert!(rig.on_disk().off);
    assert_eq!(rig.start(&grant).await.unwrap_err(), OFF);
    assert_eq!(rig.resume(&id).await.unwrap_err(), OFF);
    assert_eq!(
        rig.svc
            .add_grant(rig.base.join("home"), GrantMode::Read)
            .await
            .unwrap_err(),
        OFF
    );
    let status = rig.svc.status().await.unwrap();
    assert!(!status.available);
    assert_eq!(status.reason.as_deref(), Some(OFF));
    assert_eq!(status.grants.len(), 1, "the folders stay shared");
    // Turning it off again is a no-op.
    rig.svc.set_off(true).await.unwrap();

    rig.svc.set_off(false).await.unwrap();
    assert!(!rig.on_disk().off);
    assert_ne!(rig.svc.status().await.unwrap().reason.as_deref(), Some(OFF));
    rig.resume(&id).await.unwrap();
    rig.rec.wait_tray("the resumed job", |v| !v.off && v.jobs.len() == 1).await;
}

#[tokio::test]
async fn a_start_being_prepared_is_cancelled_by_the_off_switch() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let args = StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        ..StartArgs::default()
    }
    .check()
    .unwrap();
    let Plan::Launch(plan) = rig
        .svc
        .ask(|reply| Cmd::PlanStart {
            args: args.clone(),
            reply,
        })
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("a new job is launched")
    };
    rig.rec.wait_tray("the start", |v| v.jobs.len() == 1).await;
    rig.svc.set_off(true).await.unwrap();
    rig.rec.wait_tray("off, without it", |v| v.off && v.jobs.is_empty()).await;
    let launched = rig
        .svc
        .ask(|reply| Cmd::Launch {
            args,
            plan,
            prepared: Ok(None),
            launch: rig.launch.clone(),
            reply,
        })
        .await
        .unwrap();
    assert!(launched.is_err(), "{launched:?}");
}

#[test]
fn the_runtime_folder_can_never_be_granted() {
    // The app's real protected list, over a temp data folder.
    let dir = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(dir.path()).unwrap().join("ai.dial8.desktop");
    let paths = Paths::for_app(&data, "ai.dial8.desktop");
    let node = paths.runtime_root().join("v24.22.1/node");
    std::fs::create_dir_all(&node).unwrap();
    for p in [&node, &paths.runtime_root(), &paths.root, &data] {
        let real = folder::canonical_dir(p).unwrap();
        let err = folder::check_folder(&real, &paths.home, &paths.protected).unwrap_err();
        assert!(err.contains("Native Intelligence's own data"), "{}: {err}", p.display());
    }
}


// ─── teammate C3 / C5: native prompts, the push, the command log ────────────

/// An edit job like the real push tool: one tool call, `finish`, then a push
/// asked for in the same turn, which stays open until the answer comes back
/// (each answer is echoed). Any message asks for a second push.
/// `# BEFORE_FINISH` is replaced by tests that need something done first.
const PUSH_LAUNCHER: &str = r#"
printf '{"type":"ready","port":4242}\n'
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
      printf '{"type":"event","event":{"kind":"tool","callId":"c1","name":"bash","input":"{\\"command\\":\\"echo hi > README.md\\"}"}}\n'
      printf 'changed by the agent\n' > "$LOCAL_AGENT_FOLDER/README.md"
      printf '{"type":"event","event":{"kind":"tool_result","callId":"c1","name":"bash","ok":true,"output":"\\"\\""}}\n'
      # BEFORE_FINISH
      printf '{"type":"event","event":{"kind":"finish","summary":"Update the readme"}}\n'
      printf '{"type":"prompt","id":"push-1","kind":"push","detail":{"title":"Update the readme","body":"Made by a test."}}\n'
      ;;
    *'"type":"prompt_answer"'*)
      a=no; case "$line" in *'"allow":true'*) a=yes;; esac
      id=$(printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
      printf '{"type":"event","event":{"kind":"message","text":"answer %s %s"}}\n' "$id" "$a"
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"send"'*)
      printf '{"type":"prompt","id":"push-2","kind":"push","detail":{"title":"Again"}}\n'
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
exit 0
"#;

/// Prints the next line of `$LOCAL_AGENT_DIR/prompts.txt` for each message
/// it is sent (and ends the turn), echoes each answer, and on stop prints
/// `on-stop.txt` first.
const PROMPT_LAUNCHER: &str = r#"
printf '{"type":"ready","port":4242}\n'
n=0
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"send"'*)
      n=$((n+1))
      sed -n "${n}p" "$LOCAL_AGENT_DIR/prompts.txt"
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"prompt_answer"'*)
      a=no; case "$line" in *'"allow":true'*) a=yes;; esac
      id=$(printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
      printf '{"type":"event","event":{"kind":"message","text":"answer %s %s"}}\n' "$id" "$a"
      ;;
    *'"type":"stop"'*)
      [ -f "$LOCAL_AGENT_DIR/on-stop.txt" ] && cat "$LOCAL_AGENT_DIR/on-stop.txt"
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
exit 0
"#;

/// The launcher's echo of the answer to `id`: "yes" or "no".
async fn answer_to(rec: &Recorder, job: &str, id: &str) -> String {
    let prefix = format!("answer {id} ");
    let e = rec
        .wait_for(&format!("the answer to {id}"), |e| {
            e.job_id == job
                && e.event["kind"] == "message"
                && e.event["text"].as_str().is_some_and(|t| t.starts_with(&prefix))
        })
        .await;
    e.event["text"].as_str().unwrap()[prefix.len()..].to_string()
}

fn answers_to(rec: &Recorder, job: &str, id: &str) -> usize {
    let prefix = format!("answer {id} ");
    rec.of(job)
        .iter()
        .filter(|e| e.event["kind"] == "message" && e.event["text"].as_str().is_some_and(|t| t.starts_with(&prefix)))
        .count()
}

/// The `prompt` events for `id`, in order.
fn prompt_states(rec: &Recorder, job: &str, id: &str) -> Vec<Value> {
    rec.of(job)
        .into_iter()
        .filter(|e| e.event["kind"] == "prompt" && e.event["id"] == id)
        .map(|e| e.event)
        .collect()
}

async fn wait_prompt(rec: &Recorder, job: &str, id: &str, state: &str) -> Value {
    rec.wait_for(&format!("{id} {state}"), |e| {
        e.job_id == job && e.event["kind"] == "prompt" && e.event["id"] == id && e.event["state"] == state
    })
    .await
    .event
}

async fn wait_pr(rec: &Recorder, job: &str) -> Value {
    rec.wait_for("the pull request", |e| {
        e.job_id == job && e.event["kind"] == "pull_request"
    })
    .await
    .event
}

fn executable(path: &std::path::Path, script: &str) {
    std::fs::write(path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// A `gh` that records its arguments and environment; `pr create` waits
/// `delay` seconds, then opens pull request 7.
fn fake_gh(base: &std::path::Path, signed_in: bool, delay: u32) -> PathBuf {
    let bin = base.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let gh = bin.join("gh");
    executable(
        &gh,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{args}'\nenv | sort > '{env}'\npwd > '{cwd}'\ncase \"$1 $2\" in\n  \"auth status\") exit {auth};;\n  \"pr create\") sleep {delay}; printf 'Creating pull request\\n\\nhttps://github.com/o/r/pull/7\\n'; exit 0;;\nesac\nexit 1\n",
            args = base.join("gh-args").display(),
            env = base.join("gh-env").display(),
            cwd = base.join("gh-cwd").display(),
            auth = if signed_in { 0 } else { 1 },
        ),
    );
    gh
}

fn gh_started_pr(base: &std::path::Path) -> bool {
    std::fs::read_to_string(base.join("gh-args")).is_ok_and(|a| a.contains("pr create"))
}

async fn wait_until(what: &str, ok: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The person's repo (hooks that leave markers, `pre-push` too) with `main`
/// on a bare `remote.git`, a tag, and their own config pushing tags along.
/// `origin/main` is where `main` is, as after a fetch.
fn push_repo(rig: &Rig, markers: &std::path::Path) -> PathBuf {
    init_repo(&rig.folder, markers);
    let bare = rig.base.join("remote.git");
    git(
        &rig.base,
        &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()],
    );
    git(
        &rig.folder,
        &["push", "-q", "--no-verify", bare.to_str().unwrap(), "main"],
    );
    git(&rig.folder, &["tag", "-a", "v1", "-m", "a tag"]);
    git(&rig.folder, &["config", "push.followTags", "true"]);
    git(&rig.folder, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    bare
}

/// `origin` fetches from the bare repo and pushes to `push_url`, an ssh URL
/// that a stand-in `ssh` (the repo's `core.sshCommand`) serves from the bare
/// repo; `origin/HEAD` is `main`.
fn ssh_remote(rig: &Rig, bare: &std::path::Path, push_url: &str) {
    let ssh = rig.base.join("bin/fake-ssh");
    std::fs::create_dir_all(rig.base.join("bin")).unwrap();
    executable(
        &ssh,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{args}'\nenv | sort > '{env}'\ncase \"$1\" in -G) exit 0;; esac\nexec /usr/bin/git receive-pack '{bare}'\n",
            args = rig.base.join("ssh-args").display(),
            env = rig.base.join("ssh-env").display(),
            bare = bare.display(),
        ),
    );
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&rig.folder, &["remote", "set-url", "--push", "origin", push_url]);
    git(&rig.folder, &["config", "core.sshCommand", ssh.to_str().unwrap()]);
    git(
        &rig.folder,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    );
}

/// Start the edit job, the server's way.
async fn start_edit(rig: &Rig) -> (String, String) {
    start_edit_from(rig, None).await
}

/// [`start_edit`], from the local branch `base` when one is named.
async fn start_edit_from(rig: &Rig, base: Option<&str>) -> (String, String) {
    let grant = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    let job_id = uuid::Uuid::new_v4().to_string();
    rig.start_args(StartArgs {
        grant_id: grant.id,
        request: "update the readme".into(),
        job_id: Some(job_id.clone()),
        mode: Some("edit".into()),
        model_token: Some("tok-test-0123456789abcdef".into()),
        resume: None,
        worker: None,
        local_model: None,
        base_branch: base.map(str::to_string),
    })
    .await
    .unwrap();
    let branch = format!("dial8/project-{}", &job_id[..8]);
    (job_id, branch)
}

/// One HTTP request answered with `status` and `body`; the task returns
/// the request as it came (head and body).
async fn one_http_request(status: &'static str, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .map_or(0, |v| v.trim().parse::<usize>().unwrap());
                if buf.len() >= end + 4 + len {
                    break;
                }
            }
        }
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(resp.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    });
    (origin, task)
}

fn request_body(req: &str) -> Value {
    serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap()
}

fn heads(bare: &std::path::Path) -> Vec<String> {
    git(bare, &["for-each-ref", "--format=%(refname)"])
        .lines()
        .map(str::to_string)
        .collect()
}

fn command_log(rig: &Rig, job: &str) -> String {
    std::fs::read_to_string(rig.root.join("logs").join(format!("{job}.log"))).unwrap_or_default()
}

/// The commit Rust made, from its `branch` event.
async fn committed(rig: &Rig, job: &str) -> String {
    rig.rec
        .wait_for("the commit", |e| e.job_id == job && e.event["kind"] == "branch")
        .await
        .event["commit"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_push_in_finishs_turn_commits_at_once_then_pushes_that_commit_and_opens_the_pr_with_gh() {
    let mut rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    ssh_remote(&rig, &bare, "ssh://git@github.com/o/r.git");
    rig.launch.gh = Some(fake_gh(&rig.base, true, 0));
    rig.rec.answers.lock().unwrap().push_back(true);
    let (job_id, branch) = start_edit(&rig).await;

    // The launcher holds its turn open until it hears the answer, so the
    // commit can't wait for the turn's end: it runs when the push is asked.
    let pr = wait_pr(&rig.rec, &job_id).await;
    let sha = committed(&rig, &job_id).await;
    assert_eq!(
        pr,
        serde_json::json!({"kind":"pull_request","ok":true,"branch":branch,"commit":sha,"remote":"origin",
                           "base":"main","url":"https://github.com/o/r/pull/7","via":"gh"})
    );
    let asked = rig.rec.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(
        asked[0].title,
        format!("Push {branch} to github.com/o/r and open a pull request?")
    );
    assert!(
        asked[0].body.contains(&format!("Commit {}", &sha[..7])),
        "{}",
        asked[0].body
    );
    // origin has everything but the job's commit, and the files are git's.
    assert!(
        asked[0]
            .body
            .ends_with("and pushes only that commit.\n\nChanged files (1):\nREADME.md"),
        "{}",
        asked[0].body
    );
    assert!(!asked[0].warning);
    let left = rig.rec.timeouts.lock().unwrap()[0];
    assert!(
        left <= Duration::from_secs(60) && left > Duration::from_secs(50),
        "{left:?}"
    );
    let events = rig.rec.of(&job_id);
    let seq = |pred: &dyn Fn(&Value) -> bool| events.iter().find(|e| pred(&e.event)).unwrap().seq;
    let commit_seq = seq(&|e| e["kind"] == "branch");
    let asking = seq(&|e| e["kind"] == "prompt" && e["state"] == "asking");
    let allowed = seq(&|e| e["kind"] == "prompt" && e["state"] == "allowed");
    let turn_end = seq(&|e| e["kind"] == "status" && e["status"] == "waiting");
    assert!(
        commit_seq < asking && asking < allowed && allowed < turn_end,
        "{events:#?}"
    );
    assert_eq!(answer_to(&rig.rec, &job_id, "push-1").await, "yes");
    assert_eq!(answers_to(&rig.rec, &job_id, "push-1"), 1);

    // The remote got that commit on the job's branch and nothing else: no
    // tag, even though the person's config pushes them along; no hook ran.
    assert_eq!(
        heads(&bare),
        vec![format!("refs/heads/{branch}"), "refs/heads/main".into()]
    );
    assert_eq!(git(&bare, &["rev-parse", &branch]), sha);
    let ran: Vec<_> = std::fs::read_dir(&markers)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(ran.is_empty(), "hooks ran: {ran:?}");
    // ssh ran as the person would: their ssh-agent, nothing of the agent's.
    let ssh_env = std::fs::read_to_string(rig.base.join("ssh-env")).unwrap();
    match std::env::var("SSH_AUTH_SOCK").ok().filter(|s| s.starts_with('/')) {
        Some(sock) => assert!(ssh_env.contains(&format!("SSH_AUTH_SOCK={sock}")), "{ssh_env}"),
        None => assert!(!ssh_env.contains("SSH_AUTH_SOCK"), "{ssh_env}"),
    }
    assert!(
        !ssh_env.contains("LOCAL_AGENT") && !ssh_env.contains("tok-test"),
        "{ssh_env}"
    );

    // gh: signed in for the push URL's host, the PR with --flag=value, in
    // an empty folder of its own (gone afterwards).
    let args = std::fs::read_to_string(rig.base.join("gh-args")).unwrap();
    assert_eq!(
        args.lines().collect::<Vec<_>>(),
        vec![
            "auth status --hostname github.com".to_string(),
            format!(
                "pr create --repo=github.com/o/r --head={branch} --title=Update the readme --body=Made by a test. --base=main"
            ),
        ]
    );
    let env = std::fs::read_to_string(rig.base.join("gh-env")).unwrap();
    assert!(env.contains("GH_PROMPT_DISABLED=1") && env.contains(&format!("HOME={}", rig.base.join("home").display())));
    assert!(!env.contains("LOCAL_AGENT") && !env.contains("tok-test"), "{env}");
    let cwd = std::fs::read_to_string(rig.base.join("gh-cwd")).unwrap();
    assert!(cwd.contains("dial8-gh-"), "{cwd}");
    assert!(!std::path::Path::new(cwd.trim()).exists(), "removed after");

    let job = rig.job(&job_id).await;
    assert_eq!(job.pull_request.as_deref(), Some("https://github.com/o/r/pull/7"));
    let stored = rig.on_disk().job(&job_id).unwrap().clone();
    assert_eq!(stored.pull_request.as_deref(), Some("https://github.com/o/r/pull/7"));
    assert_eq!(stored.push_running, None, "the marker is cleared once the push ends");

    let log = command_log(&rig, &job_id);
    for needle in [
        "job    run ",
        "agent  bash {\"command\":\"echo hi > README.md\"}",
        "agent  bash ok",
        "dial8  git worktree add ",
        &format!("dial8  git commit on {branch}: {sha}"),
        &format!("ask    push push-1: Push {branch} to github.com/o/r"),
        "you    push push-1 allowed",
        &format!("dial8  pushing {branch} ({}) to origin as you", &sha[..7]),
        &format!("dial8  git push origin {}:refs/heads/{branch}: ok", &sha[..7]),
        &format!("dial8  gh pr create --repo github.com/o/r --head {branch} --base main: https://github.com/o/r/pull/7"),
    ] {
        assert!(log.contains(needle), "{needle:?} not in\n{log}");
    }
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn without_gh_the_server_opens_the_pr_with_the_session_token_and_never_a_credential() {
    let (origin, server) = one_http_request("201 Created", r#"{"url":"https://github.com/o/r/pull/8"}"#).await;
    let mut rig = rig(PUSH_LAUNCHER);
    rig.launch.api_origin = origin;
    rig.launch.gh = Some(fake_gh(&rig.base, false, 0));
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    ssh_remote(&rig, &bare, "ssh://user:s3cret@github.com/o/r.git");
    rig.rec.answers.lock().unwrap().push_back(true);
    let (job_id, branch) = start_edit(&rig).await;

    let pr = wait_pr(&rig.rec, &job_id).await;
    assert_eq!(pr["ok"], true, "{pr}");
    assert_eq!(pr["via"], "server");
    assert_eq!(pr["url"], "https://github.com/o/r/pull/8");
    let req = server.await.unwrap();
    assert!(
        req.starts_with(&format!(
            "POST /api/local-agent/sessions/{job_id}/pull-request HTTP/1.1\r\n"
        )),
        "{req}"
    );
    assert!(req
        .to_ascii_lowercase()
        .contains("authorization: bearer tok-test-0123456789abcdef"));
    assert!(!req.contains("s3cret"), "{req}");
    let sha = committed(&rig, &job_id).await;
    assert_eq!(
        request_body(&req),
        serde_json::json!({"sessionId":job_id,"remoteUrl":"ssh://github.com/o/r.git","branch":branch,
                           "base":"main","title":"Update the readme","body":"Made by a test."})
    );
    assert_eq!(git(&bare, &["rev-parse", &branch]), sha);
    // gh was asked whether it is signed in, and nothing more.
    let args = std::fs::read_to_string(rig.base.join("gh-args")).unwrap();
    assert_eq!(args.trim(), "auth status --hostname github.com");
    // Neither the token nor the credential is anywhere the person or the
    // server can read: the command log, the events.
    let log = command_log(&rig, &job_id);
    assert!(
        log.contains("gh auth status --hostname github.com: not signed in"),
        "{log}"
    );
    assert!(
        log.contains("POST the pull request to Native Intelligence (ssh://github.com/o/r.git "),
        "{log}"
    );
    let events = serde_json::to_string(&rig.rec.of(&job_id).iter().map(|e| &e.event).collect::<Vec<_>>()).unwrap();
    for secret in ["s3cret", "tok-test-0123456789abcdef"] {
        assert!(!log.contains(secret), "{secret} in the log");
        assert!(!events.contains(secret), "{secret} in an event");
    }
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn the_base_comes_from_the_remote_and_a_server_refusal_is_reported() {
    let (origin, server) = one_http_request("403 Forbidden", r#"{"error":"no GitHub sign-in for this repo"}"#).await;
    let mut rig = rig(PUSH_LAUNCHER);
    rig.launch.api_origin = origin;
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    // A plain path remote: no gh, no refs/remotes/origin/HEAD.
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    rig.rec.answers.lock().unwrap().push_back(true);
    let (job_id, branch) = start_edit(&rig).await;

    let pr = wait_pr(&rig.rec, &job_id).await;
    assert_eq!(pr["ok"], false);
    assert_eq!(pr["pushed"], true);
    let err = pr["error"].as_str().unwrap();
    assert!(err.contains("no GitHub sign-in for this repo"), "{err}");
    let body = request_body(&server.await.unwrap());
    assert_eq!(body["base"], "main", "from git ls-remote --symref");
    assert_eq!(body["remoteUrl"], bare.to_str().unwrap());
    assert!(heads(&bare).contains(&format!("refs/heads/{branch}")));
    assert_eq!(rig.job(&job_id).await.pull_request, None);
    // The alert named the remote, as the push URL names no repository.
    let asked = rig.rec.asked.lock().unwrap().clone();
    assert_eq!(
        asked[0].title,
        format!("Push {branch} to origin and open a pull request?")
    );
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_no_pushes_nothing_and_the_launcher_hears_it() {
    let rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    rig.rec.answers.lock().unwrap().push_back(false);
    let (job_id, _) = start_edit(&rig).await;

    assert_eq!(answer_to(&rig.rec, &job_id, "push-1").await, "no");
    let states: Vec<_> = prompt_states(&rig.rec, &job_id, "push-1")
        .iter()
        .map(|e| e["state"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(states, vec!["asking", "denied"]);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(heads(&bare), vec!["refs/heads/main".to_string()], "nothing pushed");
    assert!(!rig.rec.of(&job_id).iter().any(|e| e.event["kind"] == "pull_request"));
    assert!(command_log(&rig, &job_id).contains("you    push push-1 denied"));
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn the_commit_asked_about_is_pushed_even_if_the_branch_moves_before_the_yes() {
    let (origin, _server) = one_http_request("201 Created", r#"{"url":"https://github.com/o/r/pull/9"}"#).await;
    let mut rig = rig(PUSH_LAUNCHER);
    rig.launch.api_origin = origin;
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    let (job_id, branch) = start_edit(&rig).await;
    wait_prompt(&rig.rec, &job_id, "push-1", "asking").await;
    let asked_about = committed(&rig, &job_id).await;

    // Someone commits on the branch while the alert is up.
    let worktree = rig.base.join("home/.dial8/worktrees").join(&job_id);
    git(
        &worktree,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "moved",
        ],
    );
    let moved = git(&rig.folder, &["rev-parse", &branch]);
    assert_ne!(moved, asked_about);
    let open = rig.rec.open.lock().unwrap().pop().expect("the alert is up");
    let _ = open.send(true);

    let pr = wait_pr(&rig.rec, &job_id).await;
    assert_eq!(pr["ok"], true, "{pr}");
    assert_eq!(pr["commit"], asked_about.as_str());
    assert_eq!(
        git(&bare, &["rev-parse", &branch]),
        asked_about,
        "what the person was asked about"
    );
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_push_waiting_on_a_commit_that_fails_is_refused_without_asking() {
    // The agent breaks its worktree's link to the repo: the commit fails.
    let script = PUSH_LAUNCHER.replace(
        "# BEFORE_FINISH",
        "printf 'gitdir: /nowhere\\n' > \"$LOCAL_AGENT_FOLDER/.git\"",
    );
    let rig = rig(&script);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    rig.rec.answers.lock().unwrap().push_back(true);
    let (job_id, _) = start_edit(&rig).await;

    assert_eq!(answer_to(&rig.rec, &job_id, "push-1").await, "no");
    let refused = prompt_states(&rig.rec, &job_id, "push-1");
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert_eq!(refused[0]["state"], "refused");
    assert!(refused[0]["why"].as_str().unwrap().contains("couldn't be committed"));
    assert!(rig.rec.asked.lock().unwrap().is_empty(), "never asked");
    assert_eq!(heads(&bare), vec!["refs/heads/main".to_string()]);
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_second_push_while_one_runs_is_refused() {
    let mut rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    ssh_remote(&rig, &bare, "ssh://git@github.com/o/r.git");
    rig.launch.gh = Some(fake_gh(&rig.base, true, 2));
    rig.rec.answers.lock().unwrap().extend([true, true]);
    let (job_id, _) = start_edit(&rig).await;
    wait_until("gh pr create", || gh_started_pr(&rig.base)).await;

    rig.svc
        .send(job_id.clone(), "push again".into(), "queue".into())
        .await
        .unwrap();
    assert_eq!(answer_to(&rig.rec, &job_id, "push-2").await, "no");
    let why = prompt_states(&rig.rec, &job_id, "push-2")[0]["why"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(why.contains("being pushed already"), "{why}");
    assert_eq!(rig.rec.asked.lock().unwrap().len(), 1, "never asked about the second");
    assert_eq!(wait_pr(&rig.rec, &job_id).await["ok"], true);
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn turning_local_agents_off_stops_a_push_before_its_pull_request() {
    let mut rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    ssh_remote(&rig, &bare, "ssh://git@github.com/o/r.git");
    rig.launch.gh = Some(fake_gh(&rig.base, true, 10));
    rig.rec.answers.lock().unwrap().push_back(true);
    let (job_id, branch) = start_edit(&rig).await;
    wait_until("gh pr create", || gh_started_pr(&rig.base)).await;

    let started = tokio::time::Instant::now();
    rig.svc.set_off(true).await.unwrap();
    let pr = wait_pr(&rig.rec, &job_id).await;
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert_eq!(pr["ok"], false);
    assert_eq!(pr["pushed"], true);
    assert!(pr["error"].as_str().unwrap().contains("turned off"), "{pr}");
    assert!(
        heads(&bare).contains(&format!("refs/heads/{branch}")),
        "the push itself had landed"
    );
    assert_eq!(rig.on_disk().job(&job_id).unwrap().push_running, None);
}

#[tokio::test]
async fn turning_local_agents_off_with_the_alert_up_pushes_nothing_whatever_the_answer() {
    let rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    let (job_id, _) = start_edit(&rig).await;
    wait_prompt(&rig.rec, &job_id, "push-1", "asking").await;

    rig.svc.set_off(true).await.unwrap();
    rig.rec.wait_exit(&job_id, 0).await;
    let open = rig.rec.open.lock().unwrap().pop().expect("the alert was up");
    let _ = open.send(true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(heads(&bare), vec!["refs/heads/main".to_string()], "nothing pushed");
    assert!(!rig.rec.of(&job_id).iter().any(|e| e.event["kind"] == "pull_request"));
    let log = command_log(&rig, &job_id);
    assert!(
        log.contains("push-1 answered yes after it closed; nothing done"),
        "{log}"
    );
}

#[tokio::test]
async fn quitting_mid_push_is_reported_at_the_next_launch() {
    let mut rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    ssh_remote(&rig, &bare, "ssh://git@github.com/o/r.git");
    rig.launch.gh = Some(fake_gh(&rig.base, true, 10));
    rig.rec.answers.lock().unwrap().push_back(true);
    let (job_id, branch) = start_edit(&rig).await;
    wait_until("gh pr create", || gh_started_pr(&rig.base)).await;

    // On disk before the push started.
    let sha = committed(&rig, &job_id).await;
    let on_disk = rig.on_disk();
    assert_eq!(
        on_disk.job(&job_id).unwrap().push_running,
        Some(PushMarker {
            branch: branch.clone(),
            commit: sha.clone(),
            remote: "origin".into()
        })
    );
    let started = tokio::time::Instant::now();
    rig.svc.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_millis(3_500),
        "{:?}",
        started.elapsed()
    );

    // The next launch finds it, says so once, and clears it.
    let next = rig_with(PUSH_LAUNCHER, Some(&on_disk));
    let pr = wait_pr(&next.rec, &job_id).await;
    assert_eq!(pr["ok"], false);
    assert_eq!(pr["pushed"], Value::Null, "unknown whether it reached the remote");
    assert_eq!(pr["commit"], sha.as_str());
    assert!(pr["error"].as_str().unwrap().contains("quit during the push"), "{pr}");
    assert_eq!(next.on_disk().job(&job_id).unwrap().push_running, None);
    assert!(command_log(&next, &job_id).contains("Native Intelligence quit during the push"));
}

#[tokio::test]
async fn quitting_with_an_alert_up_finishes_in_time_and_a_late_yes_does_nothing() {
    let rig = rig(PROMPT_LAUNCHER);
    let other = rig.base.join("home/other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::create_dir_all(rig.base.join("agent")).unwrap();
    std::fs::write(
        rig.base.join("agent/prompts.txt"),
        serde_json::json!({"type":"prompt","id":"q1","kind":"fence","detail":{"path":other,"access":"read"}})
            .to_string()
            + "\n",
    )
    .unwrap();
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    rig.svc.send(id.clone(), "next".into(), "queue".into()).await.unwrap();
    wait_prompt(&rig.rec, &id, "q1", "asking").await;

    let started = tokio::time::Instant::now();
    rig.svc.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_millis(3_500),
        "{:?}",
        started.elapsed()
    );
    let open = rig.rec.open.lock().unwrap().pop().expect("the alert was up");
    let _ = open.send(true);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(answers_to(&rig.rec, &id, "q1"), 0);
    assert!(command_log(&rig, &id).contains("q1 answered yes after it closed; nothing done"));
}

#[tokio::test]
async fn a_prompt_nobody_answers_closes_at_its_deadline_says_no_once_and_frees_the_job() {
    let timing = Timing {
        prompt_timeout: Duration::from_millis(300),
        idle_park_after: Duration::from_millis(150),
        ..fast()
    };
    let rig = build_timed(PROMPT_LAUNCHER, None, MAX_RINGS, timing);
    let other = rig.base.join("home/other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::create_dir_all(rig.base.join("agent")).unwrap();
    std::fs::write(
        rig.base.join("agent/prompts.txt"),
        serde_json::json!({"type":"prompt","id":"t1","kind":"fence","detail":{"path":other,"access":"read"}})
            .to_string()
            + "\n",
    )
    .unwrap();
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    rig.svc.send(id.clone(), "next".into(), "queue".into()).await.unwrap();
    wait_prompt(&rig.rec, &id, "t1", "asking").await;
    // The alert itself is told to close by then.
    assert!(rig.rec.timeouts.lock().unwrap()[0] <= Duration::from_millis(300));

    let expired = wait_prompt(&rig.rec, &id, "t1", "expired").await;
    assert_eq!(expired["why"], "nobody answered within 300 ms");
    assert_eq!(answer_to(&rig.rec, &id, "t1").await, "no");
    // A click after that never acts.
    let open = rig.rec.open.lock().unwrap().pop().expect("the alert was up");
    let _ = open.send(true);
    rig.rec.wait_for("parked", |e| parked_exit(e, &id)).await;
    assert_eq!(answers_to(&rig.rec, &id, "t1"), 1);
    let log = command_log(&rig, &id);
    assert!(
        log.contains("dial8  fence t1 expired: nobody answered within 300 ms"),
        "{log}"
    );
}

#[tokio::test]
async fn fence_prompts_are_checked_asked_once_per_path_and_never_become_grants() {
    let mut rig = rig(PROMPT_LAUNCHER);
    let home = rig.base.join("home");
    let (other, later) = (home.join("other"), home.join("later"));
    for d in [
        &other,
        &later,
        &home.join(".ssh"),
        &home.join("bin"),
        &rig.base.join("agent"),
    ] {
        std::fs::create_dir_all(d).unwrap();
    }
    // The person's own tools come first on their PATH.
    rig.launch.tool_path = format!("{}:/usr/bin:/bin", home.join("bin").display());
    let fence = |id: &str, path: &str, access: &str| {
        serde_json::json!({"type":"prompt","id":id,"kind":"fence","detail":{"path":path,"access":access,"reason":"to compare"}})
            .to_string()
    };
    let p = |p: &std::path::Path| p.to_str().unwrap().to_string();
    let lines = [
        fence("f1", &p(&other), "read"),
        fence("f2", &p(&other.join("sub.txt")), "read"),
        fence("f3", &p(&other), "write"),
        fence("f4", &p(&home.join(".ssh")), "read"),
        fence("f5", &p(&rig.folder.join("x.txt")), "write"),
        fence("f6", "relative/path", "read"),
        r#"{"type":"prompt","id":"f7","kind":"camera","detail":{}}"#.to_string(),
        r#"{"type":"prompt","id":"p8","kind":"push","detail":{"title":"x"}}"#.to_string(),
        fence("f9", &p(&home.join("bin/ssh")), "write"),
        fence("f10", &p(&home.join(".SSH")), "read"),
        fence("f1", &p(&later), "read"),
        fence("f12", &p(&later), "read"),
        fence("f12", &p(&other), "read"),
        fence("f13", &p(&other), "read"),
    ];
    std::fs::write(rig.base.join("agent/prompts.txt"), lines.join("\n") + "\n").unwrap();
    rig.rec.answers.lock().unwrap().push_back(true);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    let next = || rig.svc.send(id.clone(), "next".into(), "queue".into());

    let mut got = Vec::new();
    for pid in ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "p8", "f9", "f10"] {
        next().await.unwrap();
        got.push((pid, answer_to(&rig.rec, &id, pid).await));
    }
    let want: Vec<(&str, String)> = [
        ("f1", "yes"),
        ("f2", "yes"),
        ("f3", "no"),
        ("f4", "no"),
        ("f5", "no"),
        ("f6", "no"),
        ("f7", "no"),
        ("p8", "no"),
        ("f9", "no"),
        ("f10", "no"),
    ]
    .into_iter()
    .map(|(a, b)| (a, b.to_string()))
    .collect();
    assert_eq!(got, want);
    // Asked once: the first read. Writes are refused without an alert.
    let asked = rig.rec.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1, "{asked:#?}");
    assert_eq!(asked[0].title, format!("Let Native Intelligence's agent read {}?", other.display()));
    assert!(asked[0].body.contains("to compare") && asked[0].warning);
    let why = |pid: &str| {
        prompt_states(&rig.rec, &id, pid)
            .last()
            .and_then(|e| e["why"].as_str().map(str::to_string))
            .unwrap_or_default()
    };
    assert!(why("f2").contains("already allowed"), "{}", why("f2"));
    assert!(why("f4").contains("credentials"), "{}", why("f4"));
    for pid in ["f3", "f5", "f9"] {
        assert!(why(pid).contains("read-only"), "{pid}: {}", why(pid));
    }
    assert!(why("f6").contains("absolute"), "{}", why("f6"));
    assert!(why("f7").contains("can't ask"), "{}", why("f7"));
    assert!(why("p8").contains("edit job"), "{}", why("p8"));
    assert!(why("f10").contains("credentials"), "{}", why("f10"));
    for pid in ["f3", "f4", "f5", "f6", "f7", "p8", "f9", "f10"] {
        assert_eq!(
            prompt_states(&rig.rec, &id, pid).len(),
            1,
            "{pid}: refused, never asking"
        );
    }

    // An id already answered comes again: dropped, never answered twice.
    next().await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(answers_to(&rig.rec, &id, "f1"), 1);

    // One open at a time: the tray says it needs the person; a repeat of the
    // open one is dropped, and another question meanwhile is refused.
    next().await.unwrap();
    wait_prompt(&rig.rec, &id, "f12", "asking").await;
    rig.rec
        .wait_tray("the job needs the person", |v| {
            v.jobs.iter().any(|j| j.id == id && j.state == TrayJobState::Asking)
        })
        .await;
    next().await.unwrap();
    next().await.unwrap();
    assert_eq!(answer_to(&rig.rec, &id, "f13").await, "no");
    assert!(why("f13").contains("still open"), "{}", why("f13"));
    assert_eq!(
        answers_to(&rig.rec, &id, "f12"),
        0,
        "the repeat of the open one isn't answered"
    );

    // None of it became a grant.
    let snap = rig.svc.ask(|reply| Cmd::Snapshot { reply }).await.unwrap();
    assert_eq!(snap.grants.len(), 1);
    assert_eq!(rig.on_disk().grants.len(), 1);

    // Stopped with f12 open: a late yes does nothing.
    rig.svc.stop(id.clone()).await.unwrap();
    rig.rec.wait_exit(&id, 0).await;
    let late = rig.rec.open.lock().unwrap().pop().expect("f12 still open");
    let _ = late.send(true);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(answers_to(&rig.rec, &id, "f12"), 0);
    let log = command_log(&rig, &id);
    for needle in [
        &format!("ask    fence f1: Let Native Intelligence's agent read {}?", other.display()),
        "you    fence f1 allowed",
        "dial8  fence f2 allowed: read ",
        "dial8  fence f3 refused: fence grants are read-only",
        "dial8  fence f4 refused: ",
        "dial8  fence f1 asked again; ignored",
        "dial8  fence f12 asked again; ignored",
        "ask    fence f12: the launcher ended before an answer; nothing done",
        "you    f12 answered yes after it closed; nothing done",
    ] {
        assert!(log.contains(needle), "{needle:?} not in\n{log}");
    }
}

#[tokio::test]
async fn under_the_off_switch_a_prompt_is_refused_without_asking() {
    let rig = rig(PROMPT_LAUNCHER);
    let other = rig.base.join("home/other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::create_dir_all(rig.base.join("agent")).unwrap();
    std::fs::write(
        rig.base.join("agent/on-stop.txt"),
        serde_json::json!({"type":"prompt","id":"o1","kind":"fence","detail":{"path":other,"access":"read"}})
            .to_string()
            + "\n",
    )
    .unwrap();
    rig.rec.answers.lock().unwrap().push_back(true);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    rig.svc.set_off(true).await.unwrap();
    let refused = wait_prompt(&rig.rec, &id, "o1", "refused").await;
    assert_eq!(refused["why"], OFF);
    rig.rec.wait_exit(&id, 0).await;
    assert!(rig.rec.asked.lock().unwrap().is_empty(), "never asked");
}

#[tokio::test]
async fn a_job_waiting_on_the_person_is_never_parked() {
    let timing = Timing {
        idle_park_after: Duration::from_millis(150),
        ..fast()
    };
    let rig = build_timed(PROMPT_LAUNCHER, None, MAX_RINGS, timing);
    let other = rig.base.join("home/other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::create_dir_all(rig.base.join("agent")).unwrap();
    std::fs::write(
        rig.base.join("agent/prompts.txt"),
        serde_json::json!({"type":"prompt","id":"w1","kind":"fence","detail":{"path":other,"access":"read"}})
            .to_string()
            + "\n",
    )
    .unwrap();
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    rig.svc.send(id.clone(), "next".into(), "queue".into()).await.unwrap();
    wait_prompt(&rig.rec, &id, "w1", "asking").await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !rig.rec.of(&id).iter().any(|e| parked_exit(e, &id)),
        "parked while the person was being asked"
    );
    // Answered: idle again, so parked.
    let open = rig.rec.open.lock().unwrap().pop().expect("w1 open");
    let _ = open.send(true);
    assert_eq!(answer_to(&rig.rec, &id, "w1").await, "yes");
    rig.rec.wait_for("parked", |e| parked_exit(e, &id)).await;
}

#[test]
fn tray_views_are_drawn_in_order_and_the_newest_wins() {
    let drawn = Arc::new(Mutex::new(Vec::new()));
    let sink = drawn.clone();
    let tx = latest_worker("test-tray", move |n: u32| {
        std::thread::sleep(Duration::from_millis(2));
        sink.lock().unwrap().push(n);
    });
    for n in 0..200 {
        tx.send(n).unwrap();
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while drawn.lock().unwrap().last() != Some(&199) {
        assert!(std::time::Instant::now() < deadline, "{:?}", drawn.lock().unwrap());
        std::thread::sleep(Duration::from_millis(5));
    }
    let drawn = drawn.lock().unwrap().clone();
    assert!(drawn.windows(2).all(|w| w[0] < w[1]), "out of order: {drawn:?}");
}

#[test]
fn what_rust_runs_is_never_opened_for_writing_and_never_closes_all_of_home() {
    let launch = |node: &str| LaunchConfig {
        node: node.into(),
        launcher: "/Users/x/code/site/agents/local-agent/launcher/launcher.ts".into(),
        agent_dir: "/Users/x/code/site/agents/local-agent".into(),
        env_file: None,
        tool_path: "/Users/x/bin:/opt/homebrew/bin:/usr/bin".into(),
        home: "/Users/x".into(),
        model_base_url: "https://dial8.test/api/local-agent/model".into(),
        git: "/opt/homebrew/bin/git".into(),
        git_env: Vec::new(),
        gh: Some("/opt/homebrew/bin/gh".into()),
        api_origin: "https://dial8.test".into(),
    };
    let nvm = never_write(&launch("/Users/x/.nvm/versions/node/v24.22.1/bin/node"));
    for p in [
        "/Users/x/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/opt/homebrew/bin/git",
        "/opt/homebrew/bin/gh",
        "/usr/bin/ssh",
        "/Users/x/.nvm/versions/node/v24.22.1/bin/node",
        "/Users/x/.nvm/versions/node/v24.22.1",
        "/Users/x/code/site/agents/local-agent",
        "/Users/x/code/site/agents/local-agent/launcher/launcher.ts",
    ] {
        assert!(nvm.contains(&PathBuf::from(p)), "{p} missing from {nvm:#?}");
    }
    // A node whose install root would be HOME or `/` adds only the binary.
    for node in ["/Users/x/bin/node", "/bin/sh"] {
        let list = never_write(&launch(node));
        assert!(list.contains(&PathBuf::from(node)));
        assert!(
            !list
                .iter()
                .any(|p| p == std::path::Path::new("/Users/x") || p == std::path::Path::new("/")),
            "{node}: {list:#?}"
        );
    }
}

/// `finish`, with another tool call still running, then a push asked from
/// a tool call of its own. A message returns the other tool call; the
/// answer returns the push tool's call and ends the turn.
const TOOLS_LAUNCHER: &str = r#"
printf '{"type":"ready","port":4242}\n'
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*|*'"type":"resume"'*)
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"status","status":"running"}}\n'
      printf 'changed by the agent\n' > "$LOCAL_AGENT_FOLDER/README.md"
      printf '{"type":"event","event":{"kind":"tool","callId":"c1","name":"bash","input":"{\\"command\\":\\"npm test\\"}"}}\n'
      printf '{"type":"event","event":{"kind":"finish","summary":"Update the readme"}}\n'
      printf '{"type":"event","event":{"kind":"tool","callId":"c2","name":"open_pull_request","input":"{}"}}\n'
      printf '{"type":"prompt","id":"push-1","kind":"push","detail":{"title":"Update the readme"}}\n'
      ;;
    *'"type":"send"'*)
      printf '{"type":"event","event":{"kind":"tool_result","callId":"c1","name":"bash","ok":true,"output":"\\"ok\\""}}\n'
      ;;
    *'"type":"prompt_answer"'*)
      a=no; case "$line" in *'"allow":true'*) a=yes;; esac
      printf '{"type":"event","event":{"kind":"message","text":"answer push-1 %s"}}\n' "$a"
      printf '{"type":"event","event":{"kind":"tool_result","callId":"c2","name":"open_pull_request","ok":true,"output":"\\"done\\""}}\n'
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"stop"'*)
      printf '{"type":"event","event":{"kind":"status","status":"cancelled"}}\n'
      exit 0
      ;;
  esac
done
exit 0
"#;

#[tokio::test]
async fn a_push_commits_early_only_once_no_other_tool_call_is_running() {
    let rig = rig(TOOLS_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    rig.rec.answers.lock().unwrap().push_back(false);
    let (job_id, _) = start_edit(&rig).await;

    // `npm test` is still running: nothing is committed, nothing asked.
    rig.rec
        .wait_for("the push tool's call", |e| {
            e.job_id == job_id && e.event["callId"] == "c2"
        })
        .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !rig.rec.of(&job_id).iter().any(|e| e.event["kind"] == "branch"),
        "committed under a running tool"
    );
    assert!(rig.rec.asked.lock().unwrap().is_empty());

    // It returns; the push tool is the last call in flight: commit, then ask.
    rig.svc
        .send(job_id.clone(), "go on".into(), "queue".into())
        .await
        .unwrap();
    assert_eq!(answer_to(&rig.rec, &job_id, "push-1").await, "no");
    let events = rig.rec.of(&job_id);
    let seq = |pred: &dyn Fn(&Value) -> bool| events.iter().find(|e| pred(&e.event)).unwrap().seq;
    let returned = seq(&|e| e["kind"] == "tool_result" && e["callId"] == "c1");
    let committed = seq(&|e| e["kind"] == "branch");
    let asking = seq(&|e| e["kind"] == "prompt" && e["state"] == "asking");
    let turn_end = seq(&|e| e["kind"] == "status" && e["status"] == "waiting");
    assert!(
        returned < committed && committed < asking && asking < turn_end,
        "{events:#?}"
    );
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_fence_write_is_refused_without_an_alert_and_logged() {
    let rig = rig(PROMPT_LAUNCHER);
    let home = rig.base.join("home");
    std::fs::create_dir_all(home.join("work/app")).unwrap();
    std::fs::create_dir_all(rig.base.join("agent")).unwrap();
    let line = serde_json::json!({"type":"prompt","id":"w1","kind":"fence",
                                  "detail":{"path":home.join("work/app"),"access":"write","reason":"build output"}});
    std::fs::write(rig.base.join("agent/prompts.txt"), line.to_string() + "\n").unwrap();
    rig.rec.answers.lock().unwrap().push_back(true);
    let grant = rig.grant().await;
    let id = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;

    rig.svc.send(id.clone(), "next".into(), "queue".into()).await.unwrap();
    assert_eq!(answer_to(&rig.rec, &id, "w1").await, "no");
    let states = prompt_states(&rig.rec, &id, "w1");
    assert_eq!(states.len(), 1, "refused, never asking: {states:?}");
    assert_eq!(states[0]["state"], "refused");
    assert_eq!(states[0]["why"], prompts::FENCE_READ_ONLY);
    assert!(rig.rec.asked.lock().unwrap().is_empty(), "no alert");
    assert!(command_log(&rig, &id).contains("dial8  fence w1 refused: fence grants are read-only"));
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn an_edit_jobs_commit_never_takes_eves_own_files() {
    // eve stages tool-result media under `.eve/` in the folder it works in.
    let script = EDIT_LAUNCHER.replace(
        "      printf 'new\\n' > \"$LOCAL_AGENT_FOLDER/added.txt\"",
        "      printf 'new\\n' > \"$LOCAL_AGENT_FOLDER/added.txt\"\n      \
         mkdir -p \"$LOCAL_AGENT_FOLDER/.eve/attachments\" \"$LOCAL_AGENT_FOLDER/docs/.eve/attachments\"\n      \
         printf 'png' > \"$LOCAL_AGENT_FOLDER/.eve/attachments/x.png\"\n      \
         printf 'png' > \"$LOCAL_AGENT_FOLDER/docs/.eve/attachments/y.png\"\n      \
         printf 'kept\\n' > \"$LOCAL_AGENT_FOLDER/.evening.txt\"",
    );
    assert_ne!(script, EDIT_LAUNCHER, "the launcher's added.txt line moved");
    let rig = rig(&script);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    let (job_id, branch) = start_edit(&rig).await;

    let committed = rig
        .rec
        .wait_for("the branch event", |e| {
            e.job_id == job_id && e.event["kind"] == "branch"
        })
        .await;
    assert_eq!(committed.event["filesChanged"], 3, "{}", committed.event);
    let files = git(&rig.folder, &["ls-tree", "-r", "--name-only", &branch]);
    let files: Vec<&str> = files.lines().collect();
    assert_eq!(files, vec![".evening.txt", "README.md", "added.txt"]);
    // They stay in the worktree, uncommitted.
    let worktree = rig.base.join("home/.dial8/worktrees").join(&job_id);
    assert!(worktree.join(".eve/attachments/x.png").is_file());
    assert!(worktree.join("docs/.eve/attachments/y.png").is_file());
    rig.svc.shutdown().await;
}

// ─── E3: an edit job's base branch ──────────────────────────────────────────

/// [`git`] with hooks off: the tests' own setup, in a repo whose hooks leave
/// markers.
fn git_quiet(dir: &std::path::Path, args: &[&str]) -> String {
    let mut all = vec!["-c", "core.hooksPath=/dev/null"];
    all.extend_from_slice(args);
    git(dir, &all)
}

/// [`init_repo`], plus a local branch `feature` one commit ahead of `main`;
/// HEAD stays on `main`, with `feature` checked out just before (so `@{-1}`
/// names it). At `feature` too: a tag `v1`, a tag named `refs/heads/sneaky`
/// (`refs/tags/refs/heads/sneaky`), and the remote-tracking branch
/// `origin/only-remote`; `origin/main` is at `main`. Returns main's and
/// feature's commits.
fn base_repo(rig: &Rig) -> (String, String) {
    let markers = rig.base.join("markers");
    std::fs::create_dir_all(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    let main = git(&rig.folder, &["rev-parse", "HEAD"]);
    git_quiet(&rig.folder, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(rig.folder.join("FEATURE.md"), "on feature\n").unwrap();
    git_quiet(&rig.folder, &["add", "-A"]);
    git_quiet(&rig.folder, &["commit", "-q", "-m", "feature work"]);
    let feature = git(&rig.folder, &["rev-parse", "HEAD"]);
    git_quiet(&rig.folder, &["checkout", "-q", "main"]);
    git(&rig.folder, &["tag", "v1", &feature]);
    git(&rig.folder, &["tag", "refs/heads/sneaky", &feature]);
    git(&rig.folder, &["update-ref", "refs/remotes/origin/main", &main]);
    git(&rig.folder, &["update-ref", "refs/remotes/origin/only-remote", &feature]);
    (main, feature)
}

fn no_branch(name: &str) -> String {
    format!("There's no branch {name} in project")
}

#[tokio::test]
async fn a_base_branch_resolves_only_as_a_local_branch() {
    let rig = rig(FAKE_LAUNCHER);
    let (main, feature) = base_repo(&rig);
    let g = Git::from_launch(&rig.launch);
    assert_eq!(g.resolve_base(&rig.folder, "feature").await.unwrap(), feature);
    assert_eq!(g.resolve_base(&rig.folder, "main").await.unwrap(), main);
    // git's own guessing would find a commit for these.
    assert_eq!(git(&rig.folder, &["rev-parse", "@{-1}"]), feature);
    assert_eq!(
        git(&rig.folder, &["rev-parse", "--verify", "refs/heads/sneaky^{commit}"]),
        feature,
        "rev-parse alone takes the tag refs/tags/refs/heads/sneaky"
    );
    let bad = super::git::BAD_BASE_BRANCH.to_string();
    let long = "b".repeat(101);
    let cases = [
        ("v1", no_branch("v1")),
        ("sneaky", no_branch("sneaky")),
        ("refs/remotes/origin/main", no_branch("refs/remotes/origin/main")),
        ("origin/main", no_branch("origin/main")),
        ("origin/only-remote", no_branch("origin/only-remote")),
        ("only-remote", no_branch("only-remote")),
        (feature.as_str(), no_branch(&feature)),
        ("missing", no_branch("missing")),
        ("@{-1}", bad.clone()),
        ("HEAD~1", bad.clone()),
        ("HEAD", bad.clone()),
        ("@", bad.clone()),
        // Passes the pattern; `git check-ref-format --branch` refuses it.
        ("a/.hidden", bad.clone()),
        ("--upload-pack=x", bad.clone()),
        ("-x", bad.clone()),
        ("a..b", bad.clone()),
        ("x.lock", bad.clone()),
        ("", bad.clone()),
        (long.as_str(), bad.clone()),
    ];
    for (name, want) in &cases {
        assert_eq!(g.resolve_base(&rig.folder, name).await.as_ref(), Err(want), "{name:?}");
    }

    // A tag with the branch's own name: the branch.
    git(&rig.folder, &["tag", "feature", &main]);
    assert_eq!(g.resolve_base(&rig.folder, "feature").await.unwrap(), feature);
    // A case variant: loose refs open as either on APFS; packed, they don't.
    for packed in [false, true] {
        if packed {
            git(&rig.folder, &["pack-refs", "--all"]);
        }
        for variant in ["Feature", "MAIN"] {
            assert_eq!(
                g.resolve_base(&rig.folder, variant).await,
                Err(no_branch(variant)),
                "{variant} (packed: {packed})"
            );
        }
        assert_eq!(g.resolve_base(&rig.folder, "feature").await.unwrap(), feature);
    }
    // A symbolic ref under refs/heads, and a branch that points at a tree.
    let not_plain = |n: &str| {
        format!(
            "The branch {n} in project isn't a plain branch: it points at another ref, or at something that isn't a \
             commit"
        )
    };
    git(&rig.folder, &["symbolic-ref", "refs/heads/sym", "refs/remotes/origin/only-remote"]);
    assert_eq!(git(&rig.folder, &["rev-parse", "refs/heads/sym"]), feature, "git follows it");
    assert_eq!(g.resolve_base(&rig.folder, "sym").await, Err(not_plain("sym")));
    let tree = git(&rig.folder, &["rev-parse", "HEAD^{tree}"]);
    std::fs::write(rig.folder.join(".git/refs/heads/tree"), format!("{tree}\n")).unwrap();
    assert_eq!(g.resolve_base(&rig.folder, "tree").await, Err(not_plain("tree")));
}

#[tokio::test]
async fn an_edit_job_branches_from_the_local_branch_its_start_names() {
    let rig = rig(EDIT_LAUNCHER);
    let (main, feature) = base_repo(&rig);
    let (job_id, branch) = start_edit_from(&rig, Some("feature")).await;
    let ev = rig
        .rec
        .wait_for("the branch event", |e| {
            e.job_id == job_id && e.event["kind"] == "branch"
        })
        .await;

    // One commit on top of feature's tip, counted from there.
    let sha = git(&rig.folder, &["rev-parse", &branch]);
    assert_eq!(ev.event["commit"], sha);
    assert_eq!(git(&rig.folder, &["rev-parse", &format!("{branch}~1")]), feature);
    assert_eq!(ev.event["filesChanged"], 2);
    let worktree = rig.base.join("home/.dial8/worktrees").join(&job_id);
    assert_eq!(
        std::fs::read_to_string(worktree.join("FEATURE.md")).unwrap(),
        "on feature\n"
    );
    // The person's checkout and both branches are as they were; no hook ran.
    assert_eq!(git(&rig.folder, &["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(git(&rig.folder, &["rev-parse", "HEAD"]), main);
    assert_eq!(git(&rig.folder, &["rev-parse", "refs/heads/feature"]), feature);
    assert_eq!(git(&rig.folder, &["status", "--porcelain"]), "");
    assert_eq!(std::fs::read_dir(rig.base.join("markers")).unwrap().count(), 0);

    let stored = rig.on_disk().job(&job_id).unwrap().clone();
    assert_eq!(stored.base_commit.as_deref(), Some(feature.as_str()));
    assert_eq!(stored.base_branch.as_deref(), Some("feature"));
    let log = command_log(&rig, &job_id);
    let line = format!(
        "dial8  git worktree add {} -b {branch} (from feature at {feature})",
        worktree.display()
    );
    assert!(log.contains(&line), "{line:?} not in\n{log}");
    assert!(rig.svc.status().await.unwrap().base_branch);
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_start_naming_anything_but_a_local_branch_is_refused_and_leaves_nothing() {
    let rig = rig(EDIT_LAUNCHER);
    let (_, feature) = base_repo(&rig);
    let grant = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    let bad = super::git::BAD_BASE_BRANCH.to_string();
    let long = "c".repeat(101);
    let cases = [
        ("v1", no_branch("v1")),
        ("refs/remotes/origin/main", no_branch("refs/remotes/origin/main")),
        ("origin/main", no_branch("origin/main")),
        ("origin/only-remote", no_branch("origin/only-remote")),
        (feature.as_str(), no_branch(&feature)),
        ("missing", no_branch("missing")),
        ("@{-1}", bad.clone()),
        ("HEAD~1", bad.clone()),
        ("--upload-pack=x", bad.clone()),
        ("-x", bad.clone()),
        ("a..b", bad.clone()),
        ("x.lock", bad.clone()),
        ("", bad.clone()),
        (long.as_str(), bad.clone()),
    ];
    for (name, want) in &cases {
        let job_id = uuid::Uuid::new_v4().to_string();
        let err = rig
            .start_args(StartArgs {
                grant_id: grant.id.clone(),
                request: "edit".into(),
                job_id: Some(job_id.clone()),
                mode: Some("edit".into()),
                base_branch: Some(name.to_string()),
                ..StartArgs::default()
            })
            .await
            .unwrap_err();
        assert_eq!(&err, want, "{name:?}");
        let dir = rig.base.join("home/.dial8/worktrees").join(&job_id);
        assert!(!dir.exists(), "{name:?}: no worktree");
    }
    let snap = rig.svc.ask(|reply| Cmd::Snapshot { reply }).await.unwrap();
    assert!(snap.jobs.is_empty(), "no job");
    assert_eq!(
        git(&rig.folder, &["for-each-ref", "--format=%(refname)", "refs/heads/dial8"]),
        "",
        "no branch made"
    );
    assert!(rig.rec.events.lock().unwrap().is_empty(), "nothing launched");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_read_job_drops_the_base_branch() {
    let rig = rig(FAKE_LAUNCHER);
    base_repo(&rig);
    // A git repo shared for edits, and a read job: nothing resolves the name.
    let grant = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    for (mode, name) in [(Some("read"), "--upload-pack=x"), (Some("read"), "missing"), (None, "feature")] {
        let started = rig
            .start_args(StartArgs {
                grant_id: grant.id.clone(),
                request: "list the files".into(),
                mode: mode.map(str::to_string),
                base_branch: Some(name.into()),
                ..StartArgs::default()
            })
            .await
            .unwrap();
        let job = rig.job(&started.job_id).await;
        assert_eq!((job.mode, job.branch), (GrantMode::Read, None), "{name:?}");
        let stored = rig.on_disk().job(&started.job_id).unwrap().clone();
        assert_eq!((stored.base_branch, stored.worktree), (None, None), "{name:?}");
    }
    assert!(!rig.base.join("home/.dial8/worktrees").exists(), "no worktree");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_resumed_or_restarted_edit_job_keeps_its_worktree_and_never_resolves_its_base_again() {
    let rig = rig(EDIT_LAUNCHER);
    let (_, feature) = base_repo(&rig);
    let (job_id, branch) = start_edit_from(&rig, Some("feature")).await;
    let first = rig
        .rec
        .wait_for("the first commit", |e| {
            e.job_id == job_id && e.event["kind"] == "branch"
        })
        .await;
    // The base branch goes away: resolving it again would fail the job.
    git(&rig.folder, &["branch", "-D", "feature"]);
    assert_eq!(
        rig.svc.ask(|reply| Cmd::Snapshot { reply }).await.unwrap().jobs.len(),
        1
    );
    let next_commit = |after: u64| {
        let id = job_id.clone();
        let rec = rig.rec.clone();
        async move {
            rec.wait_for("the next commit", move |e| {
                e.job_id == id && e.event["kind"] == "branch" && e.seq > after
            })
            .await
        }
    };

    // A resume.
    rig.svc.stop(job_id.clone()).await.unwrap();
    let stopped = rig.rec.wait_exit(&job_id, first.seq).await;
    rig.resume(&job_id).await.unwrap();
    let second = next_commit(stopped.seq).await;

    // A start under its id (a relaunch), naming the base again.
    rig.svc.stop(job_id.clone()).await.unwrap();
    let stopped = rig.rec.wait_exit(&job_id, second.seq).await;
    rig.start_args(StartArgs {
        grant_id: rig.on_disk().job(&job_id).unwrap().grant_id.clone(),
        request: "update the readme".into(),
        job_id: Some(job_id.clone()),
        mode: Some("edit".into()),
        base_branch: Some("feature".into()),
        ..StartArgs::default()
    })
    .await
    .unwrap();
    next_commit(stopped.seq).await;

    // Three commits on the one branch, all on top of feature's old tip.
    assert_eq!(
        git(&rig.folder, &["rev-list", "--count", &format!("{feature}..{branch}")]),
        "3"
    );
    let stored = rig.on_disk().job(&job_id).unwrap().clone();
    assert_eq!(stored.base_commit.as_deref(), Some(feature.as_str()));
    assert_eq!(stored.base_branch.as_deref(), Some("feature"));
    let log = command_log(&rig, &job_id);
    assert_eq!(log.matches("git worktree add").count(), 1, "{log}");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn the_push_prompt_names_the_base_branch_the_job_started_from() {
    let rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&rig.folder, &["branch", "release/2.0"]);
    git(&rig.folder, &["update-ref", "refs/remotes/origin/release/2.0", "HEAD"]);
    rig.rec.answers.lock().unwrap().push_back(false);
    let (job_id, branch) = start_edit_from(&rig, Some("release/2.0")).await;

    assert_eq!(answer_to(&rig.rec, &job_id, "push-1").await, "no");
    let asked = rig.rec.asked.lock().unwrap().clone();
    assert_eq!(
        asked[0].title,
        format!("Push {branch} (from release/2.0) to origin and open a pull request?")
    );
    // release/2.0 is on origin as it is here: only the job's commit goes.
    assert!(
        asked[0].body.contains("and pushes only that commit.\n\n"),
        "{}",
        asked[0].body
    );
    assert!(!asked[0].warning);
    let log = command_log(&rig, &job_id);
    let line = format!("ask    push push-1: Push {branch} (from release/2.0) to origin");
    assert!(log.contains(&line), "{line:?} not in\n{log}");
    rig.svc.shutdown().await;
}

/// [`push_repo`] with an ssh `origin` whose default branch Rust can't learn
/// (its fetch URL leads nowhere, and there's no `origin/HEAD`), a local
/// branch `release/2.0`, and a signed-in `gh` that writes each argument of
/// `pr create` on a line of its own. The push will be allowed.
fn gh_argv_rig() -> Rig {
    let mut rig = rig(PUSH_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    ssh_remote(&rig, &bare, "ssh://git@github.com/o/r.git");
    let gone = rig.base.join("gone.git");
    git(&rig.folder, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
    git(&rig.folder, &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    git(&rig.folder, &["branch", "release/2.0"]);
    git(&rig.folder, &["update-ref", "refs/remotes/origin/release/2.0", "HEAD"]);
    let gh = rig.base.join("bin/gh");
    executable(
        &gh,
        &format!(
            "#!/bin/sh\ncase \"$1 $2\" in\n  \"auth status\") exit 0;;\n  \"pr create\") for a in \"$@\"; do printf '%s\\n' \"$a\" >> '{argv}'; done; printf 'Creating pull request\\n\\nhttps://github.com/o/r/pull/7\\n'; exit 0;;\nesac\nexit 1\n",
            argv = rig.base.join("gh-argv").display(),
        ),
    );
    rig.launch.gh = Some(gh);
    rig.rec.answers.lock().unwrap().push_back(true);
    rig
}

fn gh_argv(rig: &Rig) -> Vec<String> {
    std::fs::read_to_string(rig.base.join("gh-argv"))
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

#[tokio::test]
async fn a_jobs_pull_request_goes_to_its_base_branch_with_gh() {
    let rig = gh_argv_rig();
    let (job_id, branch) = start_edit_from(&rig, Some("release/2.0")).await;
    let pr = wait_pr(&rig.rec, &job_id).await;
    assert_eq!(pr["ok"], true, "{pr}");
    assert_eq!(pr["via"], "gh");
    assert_eq!(pr["base"], "release/2.0");
    let want: Vec<String> = [
        "pr",
        "create",
        "--repo=github.com/o/r",
        &format!("--head={branch}"),
        "--title=Update the readme",
        "--body=Made by a test.",
        "--base=release/2.0",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    assert_eq!(gh_argv(&rig), want, "--base=<the job's base> is one argument");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn without_a_base_branch_or_a_default_rust_can_learn_gh_gets_no_base() {
    let rig = gh_argv_rig();
    let (job_id, _) = start_edit(&rig).await;
    let pr = wait_pr(&rig.rec, &job_id).await;
    assert_eq!(pr["ok"], true, "{pr}");
    assert_eq!(pr["base"], Value::Null);
    let argv = gh_argv(&rig);
    assert_eq!(argv.len(), 6, "{argv:?}");
    assert!(!argv.iter().any(|a| a.starts_with("--base")), "{argv:?}");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn the_server_opens_the_pull_request_against_the_jobs_base_branch() {
    let (origin, server) = one_http_request("201 Created", r#"{"url":"https://github.com/o/r/pull/8"}"#).await;
    let mut rig = rig(PUSH_LAUNCHER);
    rig.launch.api_origin = origin;
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(&rig, &markers);
    // A plain path remote (no gh), whose default branch is main.
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&rig.folder, &["branch", "release/2.0"]);
    git(&rig.folder, &["update-ref", "refs/remotes/origin/release/2.0", "HEAD"]);
    rig.rec.answers.lock().unwrap().push_back(true);
    let (job_id, branch) = start_edit_from(&rig, Some("release/2.0")).await;

    let pr = wait_pr(&rig.rec, &job_id).await;
    assert_eq!(pr["ok"], true, "{pr}");
    assert_eq!(pr["via"], "server");
    assert_eq!(pr["base"], "release/2.0");
    let body = request_body(&server.await.unwrap());
    assert_eq!(body["base"], "release/2.0", "the job's base, not the remote's main");
    assert_eq!(body["branch"], branch);
    rig.svc.shutdown().await;
}

/// [`push_repo`] with `origin` (a plain path remote) and a local branch
/// `name` with `ahead` commits of its own on top of `main`; `origin/<name>`
/// is at `main` when `on_origin` (pushed once, then worked on here).
fn push_repo_with_branch(rig: &Rig, name: &str, ahead: usize, on_origin: bool) -> PathBuf {
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    let bare = push_repo(rig, &markers);
    git(&rig.folder, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git_quiet(&rig.folder, &["checkout", "-q", "-b", name]);
    for i in 0..ahead {
        std::fs::write(rig.folder.join(format!("LOCAL-{i}.md")), "only here\n").unwrap();
        git_quiet(&rig.folder, &["add", "-A"]);
        git_quiet(&rig.folder, &["commit", "-q", "-m", &format!("local {i}")]);
    }
    git_quiet(&rig.folder, &["checkout", "-q", "main"]);
    if on_origin {
        git(&rig.folder, &["update-ref", &format!("refs/remotes/origin/{name}"), "main"]);
    }
    bare
}

#[tokio::test]
async fn a_base_branch_the_remote_doesnt_have_is_refused_before_anyone_is_asked() {
    let rig = rig(PUSH_LAUNCHER);
    let bare = push_repo_with_branch(&rig, "wip", 1, false);
    let (job_id, _) = start_edit_from(&rig, Some("wip")).await;

    let refused = wait_prompt(&rig.rec, &job_id, "push-1", "refused").await;
    let why = "wip isn't on origin, so nothing was pushed. Push wip first, or start the job from a branch that's there.";
    assert_eq!(refused["why"], why);
    assert_eq!(answer_to(&rig.rec, &job_id, "push-1").await, "no");
    assert!(rig.rec.asked.lock().unwrap().is_empty(), "no alert");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(heads(&bare), vec!["refs/heads/main".to_string()], "nothing pushed");
    assert!(!rig.rec.of(&job_id).iter().any(|e| e.event["kind"] == "pull_request"));
    let log = command_log(&rig, &job_id);
    assert!(log.contains(&format!("dial8  push push-1 refused: {why}")), "{log}");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_base_branch_ahead_of_its_remote_says_what_else_the_push_sends() {
    let rig = rig(PUSH_LAUNCHER);
    let bare = push_repo_with_branch(&rig, "feature", 2, true);
    rig.rec.answers.lock().unwrap().push_back(false);
    let (job_id, branch) = start_edit_from(&rig, Some("feature")).await;

    assert_eq!(answer_to(&rig.rec, &job_id, "push-1").await, "no");
    let asked = rig.rec.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(
        asked[0].title,
        format!("Push {branch} (from feature) to origin and open a pull request?")
    );
    // The files listed are the job's own (LOCAL-*.md came with feature).
    assert!(
        asked[0].body.ends_with(
            "and pushes that commit and 2 earlier commits from feature that origin doesn't have.\n\nChanged files \
             (1):\nREADME.md"
        ),
        "{}",
        asked[0].body
    );
    assert!(asked[0].warning);
    assert_eq!(heads(&bare), vec!["refs/heads/main".to_string()], "nothing pushed");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_job_whose_worktree_and_branch_are_gone_is_rebuilt_from_the_commit_it_started_from() {
    let rig = rig(EDIT_LAUNCHER);
    let (main, feature) = base_repo(&rig);
    let (job_id, branch) = start_edit_from(&rig, Some("feature")).await;
    let first = rig
        .rec
        .wait_for("the first commit", |e| {
            e.job_id == job_id && e.event["kind"] == "branch"
        })
        .await;
    rig.svc.stop(job_id.clone()).await.unwrap();
    let stopped = rig.rec.wait_exit(&job_id, first.seq).await;

    // The person removes the job's worktree, its branch and the base
    // branch, and main moves on: a rebuild from HEAD would be wrong.
    let worktree = rig.base.join("home/.dial8/worktrees").join(&job_id);
    git(&rig.folder, &["worktree", "remove", "--force", worktree.to_str().unwrap()]);
    git(&rig.folder, &["branch", "-D", &branch, "feature"]);
    git_quiet(&rig.folder, &["commit", "-q", "--allow-empty", "-m", "main moves on"]);
    assert_ne!(git(&rig.folder, &["rev-parse", "HEAD"]), main);

    rig.start_args(StartArgs {
        grant_id: rig.on_disk().job(&job_id).unwrap().grant_id.clone(),
        request: "update the readme".into(),
        job_id: Some(job_id.clone()),
        mode: Some("edit".into()),
        ..StartArgs::default()
    })
    .await
    .unwrap();
    let again = rig
        .rec
        .wait_for("the rebuilt branch's commit", |e| {
            e.job_id == job_id && e.event["kind"] == "branch" && e.seq > stopped.seq
        })
        .await;
    assert_eq!(git(&rig.folder, &["rev-parse", &format!("{branch}~1")]), feature);
    assert_eq!(again.event["filesChanged"], 2, "counted from feature's commit");
    let stored = rig.on_disk().job(&job_id).unwrap().clone();
    assert_eq!(stored.base_commit.as_deref(), Some(feature.as_str()));
    assert_eq!(stored.base_branch.as_deref(), Some("feature"));
    let log = command_log(&rig, &job_id);
    let adds: Vec<&str> = log.lines().filter(|l| l.contains("git worktree add")).collect();
    assert_eq!(adds.len(), 2, "{log}");
    assert!(adds[1].ends_with(&format!("(from feature at {feature})")), "{log}");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn a_start_that_checks_out_its_existing_branch_never_resolves_a_base() {
    let rig = rig(EDIT_LAUNCHER);
    let (main, _) = base_repo(&rig);
    let grant = rig.svc.add_grant(rig.folder.clone(), GrantMode::Edit).await.unwrap();
    let job_id = uuid::Uuid::new_v4().to_string();
    let branch = format!("dial8/project-{}", &job_id[..8]);
    git(&rig.folder, &["branch", &branch, "main"]);

    rig.start_args(StartArgs {
        grant_id: grant.id,
        request: "update the readme".into(),
        job_id: Some(job_id.clone()),
        mode: Some("edit".into()),
        base_branch: Some("missing".into()),
        ..StartArgs::default()
    })
    .await
    .unwrap();
    rig.rec
        .wait_for("the commit", |e| e.job_id == job_id && e.event["kind"] == "branch")
        .await;
    assert_eq!(git(&rig.folder, &["rev-parse", &format!("{branch}~1")]), main);
    let stored = rig.on_disk().job(&job_id).unwrap().clone();
    assert_eq!((stored.base_commit, stored.base_branch), (None, None));
    rig.svc.shutdown().await;
}

// ─── Security review 2026-10-31: launches the person is told of (P1-1) ──────

#[tokio::test]
async fn a_jobs_first_launch_puts_up_a_banner_and_its_revivals_dont() {
    let rig = rig(FAKE_LAUNCHER);
    let grant = rig.grant().await;
    let id = uuid::Uuid::new_v4().to_string();
    let args = StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        job_id: Some(id.clone()),
        ..StartArgs::default()
    };
    rig.start_args(args.clone()).await.unwrap();
    assert_eq!(
        rig.rec.notices.lock().unwrap().clone(),
        vec![(
            "Agent started in project".to_string(),
            "A Native Intelligence cloud agent or one of your loops started it, to read this folder. You can stop it from the menu bar's \
             Local Agents menu."
                .to_string()
        )]
    );
    // A retried claim of a running job launches nothing: no second banner.
    rig.start_args(args).await.unwrap();
    assert_eq!(rig.rec.notices.lock().unwrap().len(), 1);
    rig.rec.wait_for("waiting", |e| is_status(e, &id, "waiting")).await;
    rig.svc.stop(id.clone()).await.unwrap();
    rig.rec.wait_exit(&id, 0).await;
    // The revival the person's next message causes: told nothing new.
    rig.resume(&id).await.unwrap();
    assert_eq!(rig.rec.notice_titles(), vec!["Agent started in project"]);
    assert!(rig.on_disk().job(&id).unwrap().announced_at.is_some(), "kept in state.json");
    // A job this Mac has no record of, resumed from the server's: told.
    let other = uuid::Uuid::new_v4().to_string();
    rig.start_args(StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        job_id: Some(other.clone()),
        resume: Some(ResumeArgs {
            eve_session_id: format!("ses-{other}"),
            stream_index: 5,
        }),
        ..StartArgs::default()
    })
    .await
    .unwrap();
    assert_eq!(
        rig.rec.notice_titles(),
        vec!["Agent started in project", "Agent resumed in project"]
    );
    // A start that doesn't launch is never announced.
    assert!(rig.start("no-such-grant").await.is_err());
    assert_eq!(rig.rec.notices.lock().unwrap().len(), 2);
    assert!(rig.rec.asked.lock().unwrap().is_empty(), "eve's jobs are told, never asked");
    rig.svc.shutdown().await;
}

fn capped(err: String) {
    assert!(
        err.starts_with(
            "this Mac has started 2 local agents for cloud agents and loops in the last hour, the most it \
             allows; it takes new ones again in "
        ) && err.ends_with(" min"),
        "{err}"
    );
}

/// A rig whose hour holds two jobs.
fn capped_rig(seed: Option<&StateFile>) -> Rig {
    build_tuned(FAKE_LAUNCHER, seed, fast(), |actor| {
        actor.starts = StartWindow::new(2, starts::START_WINDOW);
    })
}

#[tokio::test]
async fn jobs_past_the_hours_cap_are_refused_and_the_person_told_once() {
    let rig = capped_rig(None);
    let grant = rig.grant().await;
    let first = rig.start(&grant).await.unwrap();
    rig.rec.wait_for("waiting", |e| is_status(e, &first, "waiting")).await;
    rig.svc.stop(first.clone()).await.unwrap();
    let stopped = rig.rec.wait_exit(&first, 0).await;
    // A revival isn't another job: it isn't counted.
    rig.resume(&first).await.unwrap();
    let second = rig.start(&grant).await.unwrap();
    capped(rig.start(&grant).await.unwrap_err());
    capped(rig.start(&grant).await.unwrap_err());
    // A retried claim of the running job launches nothing, so it isn't refused.
    rig.start_args(StartArgs {
        grant_id: grant.clone(),
        request: "list the files".into(),
        job_id: Some(first.clone()),
        ..StartArgs::default()
    })
    .await
    .unwrap();
    rig.rec.wait_for("waiting again", |e| e.seq > stopped.seq && is_status(e, &first, "waiting")).await;
    rig.svc.stop(first.clone()).await.unwrap();
    rig.rec
        .wait_for("the second exit", |e| {
            e.seq > stopped.seq && e.job_id == first && e.event.get("reason").is_some()
        })
        .await;
    // Nor is a revival refused once the hour is full.
    rig.resume(&first).await.unwrap();
    assert_eq!(
        rig.rec.notice_titles(),
        vec![
            "Agent started in project",
            "Agent started in project",
            "Refusing more local agents for now",
        ],
        "told once, however many are refused"
    );
    let disk = rig.on_disk();
    assert_eq!(disk.jobs.len(), 2, "nothing recorded for a refused start");
    let counted: Vec<&str> = disk.starts.iter().map(|s| s.job_id.as_str()).collect();
    assert_eq!(counted, vec![first.as_str(), second.as_str()], "each job once");
    rig.svc.shutdown().await;
}

#[tokio::test]
async fn the_hours_starts_survive_a_relaunch_and_older_ones_go() {
    let before = capped_rig(None);
    let grant = before.grant().await;
    before.start(&grant).await.unwrap();
    before.start(&grant).await.unwrap();
    before.svc.shutdown().await;
    let mut disk = before.on_disk();
    assert_eq!(disk.starts.len(), 2);
    disk.starts.push(state::StartStamp {
        job_id: "two-hours-ago".into(),
        at: starts::now_ms() - 2 * 3_600_000,
    });
    // The relaunched app (which the page can ask for) still has its hour.
    let after = capped_rig(Some(&disk));
    let grant = after.grant().await;
    capped(after.start(&grant).await.unwrap_err());
    let kept: Vec<String> = after.on_disk().starts.into_iter().map(|s| s.job_id).collect();
    assert_eq!(kept.len(), 2, "the stale one went at load: {kept:?}");
    assert!(!kept.iter().any(|j| j == "two-hours-ago"));
    after.svc.shutdown().await;
}

// ─── Security review 2026-10-31: no repository of the agent's own (P1-2) ────

#[tokio::test]
async fn a_repository_the_agent_makes_in_its_worktree_is_never_committed() {
    let script = EDIT_LAUNCHER.replace(
        "      printf 'new\\n' > \"$LOCAL_AGENT_FOLDER/added.txt\"",
        "      printf 'new\\n' > \"$LOCAL_AGENT_FOLDER/added.txt\"\n      \
         mkdir -p \"$LOCAL_AGENT_FOLDER/vendor/sub/.GIT\"\n      \
         printf '[filter \"x\"]\\n\\tclean = cat\\n' > \"$LOCAL_AGENT_FOLDER/vendor/sub/.GIT/config\"",
    );
    assert_ne!(script, EDIT_LAUNCHER, "the launcher's added.txt line moved");
    let rig = rig(&script);
    let markers = rig.base.join("markers");
    std::fs::create_dir(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    let head = git(&rig.folder, &["rev-parse", "HEAD"]);
    let (job_id, branch) = start_edit(&rig).await;
    let err = rig
        .rec
        .wait_for("the error", |e| e.job_id == job_id && e.event["kind"] == "error")
        .await;
    let message = err.event["message"].as_str().unwrap();
    assert!(
        message.contains("the changes hold a git repository of their own (vendor/sub/.GIT), and Native Intelligence never commits one")
            && message.contains("nothing was committed"),
        "{message}"
    );
    assert!(rig.rec.of(&job_id).iter().all(|e| e.event["kind"] != "branch"));
    assert_eq!(git(&rig.folder, &["rev-parse", &branch]), head, "no commit on the branch");
    let wt = rig.base.join("home/.dial8/worktrees").join(&job_id);
    assert_eq!(git(&wt, &["diff", "--cached", "--name-only"]), "", "nothing staged");
    assert!(wt.join("added.txt").is_file(), "the changes stay in the worktree");
    rig.svc.shutdown().await;
}

/// The person's repo with a submodule at `lib` (a gitlink; never checked out
/// in a worktree) and a job's worktree of it, made the way an edit job's is.
async fn repo_with_a_submodule(rig: &Rig) -> (Git, Worktree, PathBuf) {
    let markers = rig.base.join("markers");
    std::fs::create_dir_all(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    let lib = rig.base.join("libsrc");
    std::fs::create_dir_all(&lib).unwrap();
    git(&lib, &["init", "-q", "-b", "main"]);
    std::fs::write(lib.join("f.txt"), "x\n").unwrap();
    git(&lib, &["add", "f.txt"]);
    git(&lib, &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "lib"]);
    let sha = git(&lib, &["rev-parse", "HEAD"]);
    git(&rig.folder, &["update-index", "--add", "--cacheinfo", &format!("160000,{sha},lib")]);
    git_quiet(&rig.folder, &["commit", "-q", "-m", "a submodule"]);
    let g = Git::from_launch(&rig.launch);
    let git_dir = g.repo_git_dir(&rig.folder).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let wt = g
        .ensure_worktree(
            &rig.folder,
            &git_dir,
            &rig.base.join("home/.dial8/worktrees"),
            &id,
            &git::branch_name("project", &id),
            &git::Base::Head,
        )
        .await
        .unwrap();
    (g, wt, git_dir)
}

#[tokio::test]
async fn status_and_add_never_look_inside_a_submodule() {
    let rig = rig(FAKE_LAUNCHER);
    let (g, wt, _) = repo_with_a_submodule(&rig).await;
    let dir = wt.dir.clone();
    assert!(dir.join("lib").is_dir() && !dir.join("lib/.git").exists(), "not checked out");
    // As if a repository appeared at `lib` after the commit's check: dirty,
    // with a clean filter of its own that would run as the person.
    git(&dir, &["clone", "-q", rig.base.join("libsrc").to_str().unwrap(), "lib-tmp"]);
    std::fs::remove_dir(dir.join("lib")).unwrap();
    std::fs::rename(dir.join("lib-tmp"), dir.join("lib")).unwrap();
    let ran = rig.base.join("filter-ran");
    let config = std::fs::read_to_string(dir.join("lib/.git/config")).unwrap();
    std::fs::write(
        dir.join("lib/.git/config"),
        format!("{config}[filter \"evil\"]\n\tclean = \"touch {}; cat\"\n", ran.display()),
    )
    .unwrap();
    std::fs::write(dir.join("lib/.gitattributes"), "* filter=evil\n").unwrap();
    std::thread::sleep(Duration::from_millis(1_100));
    std::fs::write(dir.join("lib/f.txt"), "y\n").unwrap();
    std::fs::write(dir.join("README.md"), "changed by the agent\n").unwrap();

    g.check_budget(&dir, &git::COMMIT_BUDGET).await.unwrap();
    assert!(!ran.exists(), "status looked inside the submodule");
    g.stage(&dir).await.unwrap();
    assert!(!ran.exists(), "add looked inside the submodule");
    assert_eq!(git(&dir, &["diff", "--cached", "--name-only", "--ignore-submodules=all"]), "README.md");
    // The vector is real: a plain `git add -A` runs the submodule's filter.
    git(&dir, &["-c", "core.hooksPath=/dev/null", "add", "-A"]);
    assert!(ran.exists(), "this git no longer looks inside submodules; the test proves nothing");
}

#[tokio::test]
async fn a_submodule_staged_anyway_is_unstaged_and_never_committed() {
    let rig = rig(FAKE_LAUNCHER);
    let (g, wt, git_dir) = repo_with_a_submodule(&rig).await;
    let dir = wt.dir.clone();
    let head = git(&dir, &["rev-parse", "HEAD"]);
    // A new submodule in the index (as a repository that raced the check
    // would leave it), its folder empty.
    std::fs::create_dir_all(dir.join("vendor/x")).unwrap();
    git(&dir, &["update-index", "--add", "--cacheinfo", &format!("160000,{head},vendor/x")]);
    std::fs::write(dir.join("README.md"), "changed by the agent\n").unwrap();
    let err = g.commit(&dir, &git_dir, wt.base.as_deref(), "Sneak a submodule in").await.unwrap_err();
    assert!(
        err.starts_with("the changes would add a git submodule (vendor/x), and Native Intelligence never commits one; nothing was committed"),
        "{err}"
    );
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head, "no commit");
    assert_eq!(git(&dir, &["ls-files", "--stage", "vendor/x"]), "", "unstaged");
    // The repo's own submodule is no problem: the next commit goes through.
    std::fs::remove_dir(dir.join("vendor/x")).unwrap();
    let info = g.commit(&dir, &git_dir, wt.base.as_deref(), "Update the readme").await.unwrap();
    assert_eq!(info.files_changed, 1);
    assert_eq!(git(&dir, &["ls-tree", "HEAD", "lib"]).split_whitespace().next(), Some("160000"));
}

#[tokio::test]
async fn a_repository_in_a_folder_git_ignores_is_committed_around() {
    let rig = rig(FAKE_LAUNCHER);
    let markers = rig.base.join("markers");
    std::fs::create_dir_all(&markers).unwrap();
    init_repo(&rig.folder, &markers);
    std::fs::write(rig.folder.join(".gitignore"), ".build/\n.terraform/\n").unwrap();
    git_quiet(&rig.folder, &["add", ".gitignore"]);
    git_quiet(&rig.folder, &["commit", "-q", "-m", "ignore build output"]);
    let g = Git::from_launch(&rig.launch);
    let git_dir = g.repo_git_dir(&rig.folder).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let wt = g
        .ensure_worktree(
            &rig.folder,
            &git_dir,
            &rig.base.join("home/.dial8/worktrees"),
            &id,
            &git::branch_name("project", &id),
            &git::Base::Head,
        )
        .await
        .unwrap();
    let dir = wt.dir.clone();
    // SwiftPM's checkouts and Terraform's modules: git never stages them or looks inside.
    for d in [".build/checkouts/swift-nio/.git", ".terraform/modules/vpc/.git"] {
        std::fs::create_dir_all(dir.join(d)).unwrap();
    }
    std::fs::write(dir.join("README.md"), "changed by the agent\n").unwrap();
    let info = g.commit(&dir, &git_dir, wt.base.as_deref(), "Update the readme").await.unwrap();
    assert_eq!(info.files_changed, 1);
    assert_eq!(git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]), ".gitignore\nREADME.md");
    // One in a folder git doesn't ignore (a `pip -e` clone in src/) still refuses.
    std::fs::create_dir_all(dir.join("src/pkg/.git")).unwrap();
    std::fs::write(dir.join("README.md"), "again\n").unwrap();
    let err = g
        .commit(&dir, &git_dir, wt.base.as_deref(), "Again")
        .await
        .unwrap_err();
    assert!(
        err.contains("the changes hold a git repository of their own (src/pkg/.git)"),
        "{err}"
    );
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), info.commit, "no commit");
}

#[tokio::test]
async fn a_job_told_of_over_a_day_ago_is_told_and_counted_again() {
    let before = rig(FAKE_LAUNCHER);
    let grant = before.grant().await;
    let (old, recent) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
    let args = |id: &str, request: &str| StartArgs {
        grant_id: grant.clone(),
        request: request.into(),
        job_id: Some(id.to_string()),
        ..StartArgs::default()
    };
    for id in [&old, &recent] {
        before.start_args(args(id, "list the files")).await.unwrap();
        before.rec.wait_for("waiting", |e| is_status(e, id, "waiting")).await;
    }
    before.svc.shutdown().await;
    let mut disk = before.on_disk();
    let day = starts::ANNOUNCED_FOR.as_millis() as u64;
    disk.jobs.iter_mut().find(|j| j.id == old).unwrap().announced_at = Some(starts::now_ms() - day - 1_000);
    disk.starts.clear();
    let after = rig_with(FAKE_LAUNCHER, Some(&disk));
    for id in [&old, &recent] {
        after.start_args(args(id, "something else")).await.unwrap();
    }
    assert_eq!(after.rec.notice_titles(), vec!["Agent resumed in project"], "only the day-old one");
    let disk = after.on_disk();
    let counted: Vec<&str> = disk.starts.iter().map(|s| s.job_id.as_str()).collect();
    assert_eq!(counted, vec![old.as_str()]);
    assert!(starts::still_announced(disk.job(&old).unwrap().announced_at, starts::now_ms()), "told now");
    after.svc.shutdown().await;
}

/// Says what request its start line carried.
const REQUEST_LAUNCHER: &str = r#"
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      r=$(printf '%s' "$line" | sed 's/.*"request":"\([^"]*\)".*/\1/')
      printf '{"type":"session","sessionId":"ses-%s","streamIndex":0}\n' "$LOCAL_AGENT_JOB_ID"
      printf '{"type":"event","event":{"kind":"text","delta":"request=%s"}}\n' "$r"
      printf '{"type":"event","event":{"kind":"status","status":"waiting"}}\n'
      ;;
    *'"type":"stop"'*) exit 0 ;;
  esac
done
"#;

#[tokio::test]
async fn a_job_rust_has_a_record_of_runs_its_own_request_never_a_new_one() {
    let first = rig(REQUEST_LAUNCHER);
    let grant = first.grant().await;
    first.svc.shutdown().await;
    let mut disk = first.on_disk();
    let id = uuid::Uuid::new_v4().to_string();
    // It failed before it had a session: a start under its id begins afresh.
    disk.jobs.push(Job::new(&id, &grant, "the recorded request", JobStatus::Failed, "2026-10-31T00:00:00.000Z"));
    let rig = rig_with(REQUEST_LAUNCHER, Some(&disk));
    rig.start_args(StartArgs {
        grant_id: grant,
        request: "a request the page sent again".into(),
        job_id: Some(id.clone()),
        ..StartArgs::default()
    })
    .await
    .unwrap();
    let said = rig
        .rec
        .wait_for("its request", |e| e.job_id == id && e.event["kind"] == "text")
        .await;
    assert_eq!(said.event["delta"], "request=the recorded request");
    rig.svc.shutdown().await;
}
