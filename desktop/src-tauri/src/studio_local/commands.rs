//! The `studio_local_*` and `studio_export_*` commands (web
//! src/lib/tauri-bridge.ts `studioLocalExport`). Each is listed in all
//! three places: `build.rs` `APP_COMMANDS`, `generate_handler!` in lib.rs,
//! and `capabilities/default.json`, pinned by `tests/app_commands.rs`.
//!
//! All async, so none runs on the main thread (the save panel round-trips
//! through it). None takes a path or a URL the app would act on: a
//! destination is an id, the app's origin is Rust's own, and the only URLs
//! accepted (a server export's part links) are held to the app's storage.
//!
//! Refusals come back as `<code>: <sentence>` (as the Studio recorder's do).

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use super::destinations::{self, Claim};
use super::events::ExportEvent;
use super::save_parts::{self, Part, Relink, Source};
use super::{runner, Status, StudioLocal, SAVE_EVENT};

const SAVE_TITLE: &str = "Save the video";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub destination_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Saved {
    pub name: String,
}

/// The native save panel, for an MP4. `null` when the person cancels. The
/// page gets an id and the file name, never the folder.
#[tauri::command]
pub async fn studio_export_pick_destination(
    app: AppHandle,
    svc: State<'_, Arc<StudioLocal>>,
    suggested_name: String,
) -> Result<Option<Destination>, String> {
    let Some(_open) = svc.begin_pick() else {
        return Err("busy: A save dialog is already open.".into());
    };
    let suggested = destinations::sanitize_name(&suggested_name);
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(SAVE_TITLE)
        .set_file_name(&suggested)
        .add_filter("MPEG-4 video", &["mp4"])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let picked = picked.into_path().map_err(|e| format!("bad-path: {e}"))?;
    let chosen = picked.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).ok_or("bad-path: no file name was picked")?;
    let name = destinations::force_mp4(&chosen);
    let parent = picked.parent().ok_or("bad-path: no folder was picked")?;
    let dir = std::fs::canonicalize(parent).map_err(|_| "gone: The folder you picked is not there.".to_string())?;
    // The panel asked about replacing the name the person typed; a name the
    // app changed (".mp4" added) was never asked about.
    if name != chosen && std::fs::symlink_metadata(dir.join(&name)).is_ok() {
        return Err(format!("exists: A file named {name} is already there. Pick another name."));
    }
    let destination_id = svc.destinations.add(dir, name.clone());
    Ok(Some(Destination { destination_id, name }))
}

/// Save a server export into a picked destination, straight from storage:
/// `{ destinationId, workspaceId, videoId, jobId, parts, bytes, sha256? }`.
/// With the ids, the app asks the parts route itself when the links run out
/// (as the person, in `workspaceId`); `parts` may then be empty, and the app
/// asks from the first part. Stopped by `studio_export_save_cancel`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn studio_export_save_parts(
    app: AppHandle,
    svc: State<'_, Arc<StudioLocal>>,
    destination_id: String,
    parts: Option<Vec<Part>>,
    bytes: Option<u64>,
    sha256: Option<String>,
    workspace_id: Option<String>,
    video_id: Option<String>,
    job_id: Option<String>,
) -> Result<Saved, String> {
    let relink = match (video_id, job_id) {
        (Some(v), Some(j)) => {
            let w = workspace_id.ok_or("bad-request: workspaceId comes with videoId and jobId (the export's workspace).")?;
            if !runner::valid_job_id(&v) || !runner::valid_job_id(&j) || !runner::valid_job_id(&w) {
                return Err("bad-request: workspaceId, videoId and jobId are ids.".into());
            }
            let handle = app.clone();
            // Read at each ask: the page refreshes it (set_auth_token).
            let token: Arc<dyn Fn() -> Option<String> + Send + Sync> =
                Arc::new(move || handle.state::<crate::AppState>().auth_token.lock().ok().and_then(|t| t.clone()));
            Some(Relink { origin: crate::tray::api_base_url().to_string(), workspace_id: w, video_id: v, job_id: j, token })
        }
        (None, None) => None,
        _ => return Err("bad-request: videoId and jobId come together.".into()),
    };
    let parts = parts.unwrap_or_default();
    if parts.is_empty() && relink.is_none() {
        return Err("bad-request: There are no parts to save, and no export to ask about.".into());
    }
    if !parts.is_empty() && bytes.is_none() {
        return Err("bad-request: bytes is the whole file's size.".into());
    }
    let claim: Claim = svc.destinations.claim(&destination_id)?;
    let run = svc.begin_save(&destination_id);
    let _awake = crate::sleep_guard::SleepGuard::new();
    let source = Source { parts, first: 0, bytes: bytes.unwrap_or(0), sha256, relink };
    let id = destination_id.clone();
    let emitter = app.clone();
    let temp = run.temp.clone();
    let result = save_parts::save(
        &claim,
        source,
        &run.cancel,
        move |path| *temp.lock().unwrap() = Some(path.to_path_buf()),
        move |received, total| {
            let _ = emitter.emit(SAVE_EVENT, serde_json::json!({ "destinationId": id, "receivedBytes": received, "totalBytes": total }));
        },
    )
    .await;
    svc.end_save(&destination_id);
    match result {
        Ok(name) => {
            svc.destinations.release(&destination_id, true);
            Ok(Saved { name })
        }
        Err(e) => {
            svc.destinations.release(&destination_id, false);
            Err(e)
        }
    }
}

/// Stop a save of part links to `destinationId` (nothing when none runs).
/// The save then refuses with `cancelled:`, and leaves nothing behind.
#[tauri::command]
pub async fn studio_export_save_cancel(svc: State<'_, Arc<StudioLocal>>, destination_id: String) -> Result<(), String> {
    if !destinations::valid_id(&destination_id) {
        return Err("bad-request: That is not a place to save the app knows.".into());
    }
    svc.cancel_save(&destination_id);
    Ok(())
}

/// Save a finished export of this computer whose move into place failed
/// (it is kept for three days) into a newly picked destination.
#[tauri::command]
pub async fn studio_local_export_save_again(svc: State<'_, Arc<StudioLocal>>, job_id: String, destination_id: String) -> Result<Saved, String> {
    if !runner::valid_job_id(&job_id) {
        return Err("bad-request: jobId is not an id".into());
    }
    let claim = svc.destinations.claim(&destination_id)?;
    match svc.save_again(&job_id, claim).await {
        Ok(name) => {
            svc.destinations.release(&destination_id, true);
            Ok(Saved { name })
        }
        Err(e) => {
            svc.destinations.release(&destination_id, false);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn studio_local_status(svc: State<'_, Arc<StudioLocal>>) -> Result<Status, String> {
    Ok(svc.inner().status().await)
}

/// Download what a computer export needs (Node, Chrome's headless shell,
/// FFmpeg), each pinned; resolves once all of it is here and checked.
#[tauri::command]
pub async fn studio_local_prepare(svc: State<'_, Arc<StudioLocal>>) -> Result<(), String> {
    svc.prepare().await
}

#[tauri::command]
pub async fn studio_local_export_start(
    svc: State<'_, Arc<StudioLocal>>,
    job_id: String,
    token: String,
    destination_id: Option<String>,
    upload: bool,
) -> Result<(), String> {
    if !runner::valid_job_id(&job_id) {
        return Err("bad-request: jobId is not an id".into());
    }
    if !runner::valid_token(&token) {
        // Never says what the token was.
        return Err("bad-request: the token is not one the Studio makes".into());
    }
    let Some(destination_id) = destination_id else {
        return Err("bad-request: destinationId is where the video goes (pick it first)".into());
    };
    let claim = svc.destinations.claim(&destination_id)?;
    let started = svc.inner().start(job_id, token, claim, upload).await;
    if started.is_err() {
        svc.destinations.release(&destination_id, false);
    }
    started
}

/// Stop the export of `jobId` (nothing when it is not running here).
#[tauri::command]
pub async fn studio_local_export_cancel(svc: State<'_, Arc<StudioLocal>>, job_id: String) -> Result<(), String> {
    if !runner::valid_job_id(&job_id) {
        return Err("bad-request: jobId is not an id".into());
    }
    svc.cancel(&job_id);
    Ok(())
}

#[tauri::command]
pub async fn studio_local_export_events(svc: State<'_, Arc<StudioLocal>>, job_id: String, since_seq: u64) -> Result<Vec<ExportEvent>, String> {
    if !runner::valid_job_id(&job_id) {
        return Err("bad-request: jobId is not an id".into());
    }
    Ok(svc.events_since(&job_id, since_seq))
}

/// Show a file this app saved in Finder or Explorer.
#[tauri::command]
pub async fn studio_export_reveal(svc: State<'_, Arc<StudioLocal>>, destination_id: String) -> Result<(), String> {
    svc.reveal(&destination_id)
}
