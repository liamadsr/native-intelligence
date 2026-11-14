//! What the page is told about one run of an export, as the runner's events,
//! the move into place and the process's end arrive. Pure, so the promises
//! the page builds on are tested without a runner:
//!
//! - `done` means the video is at the place the person picked;
//! - after `done` only `progress`, `log`, `uploaded` and `upload-failed`
//!   follow: an export that was made is never reported `failed` or
//!   `cancelled`;
//! - a video that was made ends the run with `done` or, when it is not where
//!   the person chose (the move failed, or a stop or a quit cut it short),
//!   `save-failed`: it is kept on this computer, to be saved again;
//! - otherwise the run ends with exactly one of `failed` or `cancelled`.

use super::events::Kind;
use super::runner;

/// One event to send: its kind, message and saved file name.
pub type Say = (Kind, Option<String>, Option<String>);

#[derive(Debug, Default, Clone)]
pub struct RunState {
    /// The person asked for the upload too.
    pub upload_wanted: bool,
    /// The file name at the destination, once `done` was sent.
    pub saved: Option<String>,
    /// The runner said the upload finished.
    pub uploaded: bool,
    /// The runner said it finished.
    pub runner_done: bool,
    /// The runner's own sentence about an upload that did not go through.
    pub upload_note: Option<String>,
    /// Before `done`: how the run ended, as the runner said.
    pub ended: Option<(Kind, String)>,
    /// After `done`: what stopped the upload.
    pub upload_problem: Option<String>,
    /// The move into place failed (the video is kept in the work folder);
    /// `save-failed` was said then.
    pub place_failed: Option<String>,
    /// The video exists whole (the runner said `saved`, or `done`).
    pub made: bool,
}

const STOPPED: &str = "The export was stopped.";

impl RunState {
    pub fn new(upload_wanted: bool) -> Self {
        Self { upload_wanted, ..Default::default() }
    }

    /// A runner log line (already scrubbed); the upload's own failure is
    /// kept for the end. Returns whether it is said as a `log`.
    pub fn on_log(&mut self, line: &str) -> bool {
        if line.starts_with("The upload did not go through") {
            self.upload_note = Some(line.to_string());
        }
        // Its "Saved to <job>.mp4" is said by the app, with the person's name.
        !line.starts_with("Saved to ")
    }

    /// The runner failed (`error` already scrubbed). Returns whether the tree
    /// is to be killed at once: the Studio took the job back (its refusal
    /// code, whatever `cancelled` says: the runner reports those as
    /// cancelled too). A video already made is still placed or kept.
    pub fn on_failed(&mut self, error: &str, cancelled: bool, code: Option<&str>) -> bool {
        let taken = runner::taken_back(code, error);
        let stopped = cancelled || taken;
        if self.saved.is_some() {
            let why = if stopped { "The upload was stopped.".to_string() } else { format!("The upload did not finish: {error}") };
            self.upload_problem.get_or_insert(why);
        } else if stopped {
            self.ended.get_or_insert((Kind::Cancelled, STOPPED.into()));
        } else {
            self.ended.get_or_insert((Kind::Failed, error.to_string()));
        }
        taken
    }

    /// The runner said the video is whole in its work folder.
    pub fn on_made(&mut self) {
        self.made = true;
    }

    /// The runner finished. What to say now.
    pub fn on_done(&mut self, uploaded: bool) -> Vec<Say> {
        self.runner_done = true;
        self.made = true;
        self.uploaded = uploaded;
        if self.saved.is_some() && uploaded {
            vec![(Kind::Uploaded, Some("Uploaded to the Studio".into()), None)]
        } else {
            Vec::new()
        }
    }

    /// The video is at its destination. What to say now.
    pub fn on_saved(&mut self, name: &str) -> Vec<Say> {
        self.saved = Some(name.to_string());
        let mut out = vec![(Kind::Done, Some(format!("Saved to {name}")), Some(name.to_string()))];
        if self.uploaded {
            out.push((Kind::Uploaded, Some("Uploaded to the Studio".into()), None));
        }
        out
    }

    /// The move into place failed (`why`: a sentence); the video is kept.
    /// Said at once, once.
    pub fn on_place_failed(&mut self, chosen: &str, why: &str) -> Option<Say> {
        if self.place_failed.is_some() {
            return None;
        }
        let message = save_failed_sentence(Some((chosen, why)));
        self.place_failed = Some(message.clone());
        Some((Kind::SaveFailed, Some(message), None))
    }

    /// The last word once the process is gone and the move has settled.
    /// `stopped`: the app stopped it (cancel, quit, taken back).
    pub fn final_event(&self, stopped: bool, exit: Option<i32>) -> Option<(Kind, String)> {
        if self.saved.is_some() {
            if !self.upload_wanted || self.uploaded {
                return None;
            }
            let why = self
                .upload_problem
                .clone()
                .or_else(|| self.upload_note.clone())
                .unwrap_or_else(|| {
                    if stopped {
                        "The upload was stopped.".into()
                    } else if self.runner_done {
                        "The upload did not go through: the video is kept on this computer only.".into()
                    } else {
                        "The upload stopped before it finished: the video is kept on this computer only.".into()
                    }
                });
            return Some((Kind::UploadFailed, why));
        }
        // Made but not in place, whatever stopped the run (checked before any
        // stop): it is kept. Already said when the move itself failed.
        if self.place_failed.is_some() {
            return None;
        }
        if self.made {
            return Some((Kind::SaveFailed, save_failed_sentence(None)));
        }
        if let Some(e) = &self.ended {
            return Some(e.clone());
        }
        if stopped || exit == Some(2) {
            return Some((Kind::Cancelled, STOPPED.into()));
        }
        Some((
            Kind::Failed,
            format!(
                "The export stopped on this computer before it finished ({}).",
                exit.map(|c| format!("exit code {c}")).unwrap_or_else(|| "it was ended".into())
            ),
        ))
    }
}

/// The sentence for a video made but not where the person chose.
pub fn save_failed_sentence(place: Option<(&str, &str)>) -> String {
    match place {
        Some((chosen, why)) => format!(
            "The video was made but could not be saved to {chosen}: {why} It is kept on this computer: pick a place to save it again."
        ),
        None => "The video was made but was not saved where you chose. It is kept on this computer: pick a place to save it again.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(says: &[Say]) -> Vec<Kind> {
        says.iter().map(|s| s.0).collect()
    }

    /// The runner's own failed line (studio-worker src/local.ts runLocal's
    /// catch; local-main.ts for a refused `take`): every 401/403/409 comes as
    /// cancelled with the app's code.
    fn failed_line(code: &str) -> (String, bool, Option<String>) {
        match runner::parse_line(&format!(r#"{{"type":"failed","error":"Cancelled","cancelled":true,"code":"{code}"}}"#)) {
            Some(runner::RunnerEvent::Failed { error, cancelled, code }) => (error, cancelled, code),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_whole_run_ends_with_done_and_uploaded() {
        let mut r = RunState::new(true);
        r.on_made();
        assert_eq!(kinds(&r.on_saved("A.mp4")), [Kind::Done]);
        assert_eq!(kinds(&r.on_done(true)), [Kind::Uploaded]);
        assert_eq!(r.final_event(false, Some(0)), None);
    }

    #[test]
    fn nothing_but_upload_kinds_after_done() {
        let mut r = RunState::new(true);
        r.on_made();
        r.on_saved("A.mp4");
        assert!(r.on_log("The upload did not go through (503): the video is kept on this computer only"));
        assert!(!r.on_failed("boom", false, None));
        let (k, m) = r.final_event(true, Some(1)).unwrap();
        assert_eq!(k, Kind::UploadFailed);
        assert!(m.contains("boom"), "{m}");
        // Taken back after done, as the runner says it: the upload stops, the file stays.
        let mut r = RunState::new(true);
        r.on_made();
        r.on_saved("A.mp4");
        let (e, c, code) = failed_line("NOT_HELD");
        assert!(r.on_failed(&e, c, code.as_deref()), "kill now");
        assert_eq!(r.final_event(true, Some(2)).unwrap().0, Kind::UploadFailed);
        // The runner finished without uploading.
        let mut r = RunState::new(true);
        r.on_made();
        r.on_saved("A.mp4");
        r.on_log("The upload did not go through (x): the video is kept on this computer only");
        assert!(r.on_done(false).is_empty());
        let (k, m) = r.final_event(false, Some(0)).unwrap();
        assert_eq!(k, Kind::UploadFailed);
        assert!(m.starts_with("The upload did not go through"));
        // Kept here only, as asked: nothing more to say.
        let mut r = RunState::new(false);
        r.on_made();
        r.on_saved("A.mp4");
        r.on_done(false);
        assert_eq!(r.final_event(false, Some(0)), None);
    }

    #[test]
    fn an_upload_that_finished_before_the_move_is_said_after_done() {
        let mut r = RunState::new(true);
        r.on_made();
        assert!(r.on_done(true).is_empty(), "not before done");
        assert_eq!(kinds(&r.on_saved("A.mp4")), [Kind::Done, Kind::Uploaded]);
    }

    #[test]
    fn taken_back_kills_whatever_cancelled_says() {
        for code in ["NOT_HELD", "ENDED", "UNAUTHORIZED", "FORBIDDEN"] {
            let mut r = RunState::new(true);
            let (e, c, k) = failed_line(code);
            assert!(c, "the runner says cancelled");
            assert!(r.on_failed(&e, c, k.as_deref()), "{code}");
            assert_eq!(r.final_event(true, Some(2)).unwrap().0, Kind::Cancelled, "{code}");
        }
        let mut r = RunState::new(true);
        let (e, c, k) = failed_line("TOO_FAST");
        assert!(!r.on_failed(&e, c, k.as_deref()), "not a refusal that ends the job");
        // The person's own cancel: no code, the runner stops by itself.
        let mut r = RunState::new(true);
        assert!(!r.on_failed("Cancelled", true, None));
        assert_eq!(r.final_event(false, Some(2)).unwrap().0, Kind::Cancelled);
    }

    #[test]
    fn a_made_video_is_saved_or_kept_whatever_stopped_the_run() {
        // Made, then taken back, the move cut short: kept, and said so.
        let mut r = RunState::new(true);
        r.on_made();
        let (e, c, k) = failed_line("NOT_HELD");
        r.on_failed(&e, c, k.as_deref());
        assert_eq!(r.final_event(true, Some(2)).unwrap().0, Kind::SaveFailed);
        // Made and finished, then a quit or a cancel during the move.
        let mut r = RunState::new(true);
        r.on_made();
        r.on_done(true);
        let (k, m) = r.final_event(true, None).unwrap();
        assert_eq!(k, Kind::SaveFailed);
        assert!(m.contains("kept on this computer"), "{m}");
        // The move failed: said at once, once, and nothing after.
        let mut r = RunState::new(true);
        r.on_made();
        let said = r.on_place_failed("A.mp4", "The disk is full.").unwrap();
        assert_eq!(said.0, Kind::SaveFailed);
        assert!(r.on_place_failed("A.mp4", "again").is_none());
        r.on_done(true);
        assert_eq!(r.final_event(false, Some(0)), None);
    }

    #[test]
    fn before_the_video_is_made_the_run_fails_or_is_cancelled() {
        let mut r = RunState::new(true);
        r.on_failed("ffmpeg exited 1", false, None);
        assert_eq!(r.final_event(false, Some(1)), Some((Kind::Failed, "ffmpeg exited 1".into())));
        assert_eq!(RunState::new(true).final_event(true, None).unwrap().0, Kind::Cancelled);
        assert!(RunState::new(true).final_event(false, Some(9)).unwrap().1.contains("exit code 9"));
    }

    #[test]
    fn the_runner_saved_line_is_said_by_the_app() {
        let mut r = RunState::new(true);
        assert!(!r.on_log("Saved to 1111.mp4"));
        assert!(r.on_log("Encoding with VideoToolbox"));
    }
}
