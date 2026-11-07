//! The `local_agent_*` commands (l0-contract §4 "Commands", l1-contract C).
//! Each is listed in all three places: `build.rs` `APP_COMMANDS`,
//! `generate_handler!` in lib.rs, and `capabilities/default.json`
//! (`allow-local-agent-*`), pinned by `tests/app_commands.rs`.
//!
//! All async, so none runs on the main thread: the folder dialog and the
//! edit confirm in particular round-trip through the main run loop and would
//! deadlock there (the same reason `save_file` is async).
//!
//! No command takes a path or a URL. The folder of a grant comes from the
//! native dialog, its mode from the native confirm, the folder of a job from
//! its grant, and the model relay's URL from the app's own API origin (plan
//! §1, invariant 3; l1-contract C2, C3).

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;

use super::ring::Entry;
use super::state::{Grant, GrantMode};
use super::{folder, DeviceInfo, LocalAgentService, ResumeArgs, ResumeMessage, StartArgs, StartResult, StatusReport};

const PICKER_TITLE: &str = "Choose a folder for Dial8's local agent";
/// The edit confirm (l1-contract C2). Its buttons: OK allows, Cancel (and
/// Esc) keeps the folder read-only.
pub(crate) const ALLOW_CHANGES: &str = "Allow changes";
pub(crate) const READ_ONLY: &str = "Read only";
const EDIT_CONFIRM_BODY: &str = "Changes go on a new git branch in a separate copy. Your files and current \
                                 branch stay as they are, and nothing is pushed without asking you.";
/// The folder's name in the confirm, at most, in characters.
const CONFIRM_NAME_MAX: usize = 60;

/// The edit confirm's title (the alert's bold line) and body.
pub(crate) fn edit_confirm_text(name: &str) -> (String, &'static str) {
    let mut short: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(CONFIRM_NAME_MAX)
        .collect();
    if name.chars().count() > CONFIRM_NAME_MAX {
        short.push('…');
    }
    (format!("Let Dial8's agent make changes in {short}?"), EDIT_CONFIRM_BODY)
}

/// Ask, natively, whether the agent may edit this git repo. Anything but
/// "Allow changes" is read-only.
async fn confirm_edits(app: &AppHandle, name: &str) -> GrantMode {
    let (title, body) = edit_confirm_text(name);
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            ALLOW_CHANGES.to_string(),
            READ_ONLY.to_string(),
        ))
        .show(move |allowed| {
            let _ = tx.send(allowed);
        });
    if rx.await.unwrap_or(false) {
        GrantMode::Edit
    } else {
        GrantMode::Read
    }
}

/// This Mac for the server's device registry.
#[tauri::command]
pub async fn local_agent_device(app: AppHandle, svc: State<'_, LocalAgentService>) -> Result<DeviceInfo, String> {
    svc.device(app.package_info().version.to_string()).await
}

#[tauri::command]
pub async fn local_agent_status(svc: State<'_, LocalAgentService>) -> Result<StatusReport, String> {
    svc.status().await
}

/// Show the native folder dialog and turn the chosen folder into a grant.
/// For a git repo root, a native confirm then asks whether the agent may
/// make changes (on a worktree); that answer is the grant's mode. `None`
/// when the person cancels the picker. Picking an already granted folder
/// returns its grant, with the mode just chosen.
#[tauri::command]
pub async fn local_agent_pick_folder(
    app: AppHandle,
    svc: State<'_, LocalAgentService>,
) -> Result<Option<Grant>, String> {
    svc.ensure_available().await?;
    let Some(_open) = svc.begin_pick() else {
        return Err("a folder dialog is already open".into());
    };
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(PICKER_TITLE)
        .set_can_create_directories(false)
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let picked: PathBuf = picked.into_path().map_err(|e| e.to_string())?;
    // Refuse a folder before asking anything about it.
    let (real, is_git) = svc.check_pick(picked).await?;
    let mode = if is_git {
        confirm_edits(&app, &folder::label_of(&real)).await
    } else {
        GrantMode::Read
    };
    let grant = svc.add_grant(real, mode).await?;
    // Its first start shouldn't wait for the runtime's download.
    svc.prewarm();
    // Every start is told in a banner ([`super::starts`]): ask for them now,
    // while the person is here, not when the page decides to (macOS asks once).
    tauri::async_runtime::spawn(async {
        let _ = crate::notifications::request_permission().await;
    });
    Ok(Some(grant))
}

#[tauri::command]
pub async fn local_agent_remove_grant(svc: State<'_, LocalAgentService>, grant_id: String) -> Result<(), String> {
    svc.remove_grant(grant_id).await
}

/// Start a job in a grant: `jobId` is the server's session uuid (absent: a
/// new local id), `mode` at most the grant's (absent: read), `modelToken`
/// the server's relay token (absent: the dev key in a debug build; any other
/// build refuses the start), `resume` the server's record of the eve session
/// when Rust has none, `worker` `claude-code` or `codex` to run on the
/// person's CLI instead of eve (absent: eve; [`super::workers`]),
/// `localModel` the model mode the server recorded for the session (a job
/// keeps it: a start in the other mode is refused), `baseBranch` the local
/// branch a new edit job's worktree starts from (absent: HEAD; a read job,
/// or a job with a worktree already, drops it; [`super::git`] checks and
/// resolves it). Already running: answers its current run. A new job counts
/// against the hour's cap and puts up a banner; a worker's launch waits (up
/// to 2 minutes) for the person's yes in a native confirm instead
/// ([`super::starts`]). `local_agent_resume` alike.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn local_agent_start(
    svc: State<'_, LocalAgentService>,
    grant_id: String,
    request: String,
    job_id: Option<String>,
    mode: Option<String>,
    model_token: Option<String>,
    resume: Option<ResumeArgs>,
    worker: Option<String>,
    local_model: Option<bool>,
    base_branch: Option<String>,
) -> Result<StartResult, String> {
    svc.start(StartArgs {
        grant_id,
        request,
        job_id,
        mode,
        model_token,
        resume,
        worker,
        local_model,
        base_branch,
    })
    .await
}

/// A refreshed relay token: written to the running launcher's stdin as
/// `{"type":"token"}`, and used for the job's next launch.
#[tauri::command]
pub async fn local_agent_set_model_token(
    svc: State<'_, LocalAgentService>,
    job_id: String,
    model_token: String,
) -> Result<(), String> {
    svc.set_model_token(job_id, model_token).await
}

#[tauri::command]
pub async fn local_agent_send(
    svc: State<'_, LocalAgentService>,
    job_id: String,
    text: String,
    policy: String,
) -> Result<(), String> {
    svc.send(job_id, text, policy).await
}

#[tauri::command]
pub async fn local_agent_stop(svc: State<'_, LocalAgentService>, job_id: String) -> Result<(), String> {
    svc.stop(job_id).await
}

/// Respawn the launcher on the job's stored session; `modelToken` replaces
/// the one it had, `localModel` is the model mode the server recorded (as for
/// a start). `message` `{ text, policy }`: the message the resume is for,
/// which Rust sends once the launcher reports its session (and a worker's
/// confirm shows).
#[tauri::command]
pub async fn local_agent_resume(
    svc: State<'_, LocalAgentService>,
    job_id: String,
    model_token: Option<String>,
    local_model: Option<bool>,
    message: Option<ResumeMessage>,
) -> Result<StartResult, String> {
    svc.resume(job_id, model_token, local_model, message).await
}

/// Events with `seq > sinceSeq` (absent: 0, the whole ring).
#[tauri::command]
pub async fn local_agent_events(
    svc: State<'_, LocalAgentService>,
    job_id: String,
    since_seq: Option<u64>,
) -> Result<Vec<Entry>, String> {
    svc.events(job_id, since_seq.unwrap_or(0)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_edit_confirm_says_what_happens() {
        let (title, body) = edit_confirm_text("dial8-website");
        assert_eq!(title, "Let Dial8's agent make changes in dial8-website?");
        assert_eq!(
            body,
            "Changes go on a new git branch in a separate copy. Your files and current branch stay as they are, \
             and nothing is pushed without asking you."
        );
        assert_eq!((ALLOW_CHANGES, READ_ONLY), ("Allow changes", "Read only"));
        let (long, _) = edit_confirm_text(&"n".repeat(200));
        assert!(long.chars().count() < 120 && long.contains('…'), "{long}");
        let (odd, _) = edit_confirm_text("a\nb");
        assert_eq!(odd, "Let Dial8's agent make changes in ab?");
    }
}
