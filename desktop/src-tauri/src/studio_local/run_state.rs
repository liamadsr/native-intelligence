//! What the page is told about one run of an export, as the runner's events,
//! the move into place and the process's end arrive. Pure, so the promises
//! the page builds on are tested without a runner:
//!
//! - `done` means the video is at the place the person picked;
//! - after `done` only `progress`, `log`, `uploaded` and `upload-failed`
//!   follow: an export that was made is never reported `failed` or
//!   `cancelled`;
//! - before `done`, the run ends with exactly one of `failed` or `cancelled`
//!   (or nothing, when the runner finished and the move was the last word).

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
    /// The move into place failed (the video is kept in the work folder).
    pub place_failed: Option<String>,
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
    /// is to be killed at once (the Studio took the job back).
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
        taken && !cancelled
    }

    /// The runner finished. What to say now.
    pub fn on_done(&mut self, uploaded: bool) -> Vec<Say> {
        self.runner_done = true;
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
    pub fn on_place_failed(&mut self, chosen: &str, why: &str) {
        self.place_failed.get_or_insert(format!(
            "The video was made but could not be saved to {chosen}: {why} It is kept on this computer: pick a place to save it again."
        ));
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
        if let Some(why) = &self.place_failed {
            return Some((Kind::SaveFailed, why.clone()));
        }
        if let Some(e) = &self.ended {
            return Some(e.clone());
        }
        if stopped || exit == Some(2) {
            return Some((Kind::Cancelled, STOPPED.into()));
        }
        if self.runner_done {
            return Some((Kind::Failed, "The video was made but its file could not be found on this computer.".into()));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(says: &[Say]) -> Vec<Kind> {
        says.iter().map(|s| s.0).collect()
    }

    #[test]
    fn a_whole_run_ends_with_done_and_uploaded() {
        let mut r = RunState::new(true);
        assert_eq!(kinds(&r.on_saved("A.mp4")), [Kind::Done]);
        assert_eq!(kinds(&r.on_done(true)), [Kind::Uploaded]);
        assert_eq!(r.final_event(false, Some(0)), None);
    }

    #[test]
    fn nothing_but_upload_kinds_after_done() {
        // The upload fails, then the runner fails, then it is stopped: never failed or cancelled.
        let mut r = RunState::new(true);
        r.on_saved("A.mp4");
        assert!(r.on_log("The upload did not go through (503): the video is kept on this computer only"));
        assert!(!r.on_failed("boom", false, None));
        let (k, m) = r.final_event(true, Some(1)).unwrap();
        assert_eq!(k, Kind::UploadFailed);
        assert!(m.contains("boom"), "{m}");
        // Taken back after done: the upload stops, the file stays.
        let mut r = RunState::new(true);
        r.on_saved("A.mp4");
        assert!(r.on_failed("x", false, Some("NOT_HELD")), "kill now");
        assert_eq!(r.final_event(true, None).unwrap().0, Kind::UploadFailed);
        // The runner finished without uploading.
        let mut r = RunState::new(true);
        r.on_saved("A.mp4");
        r.on_log("The upload did not go through (x): the video is kept on this computer only");
        assert!(r.on_done(false).is_empty());
        let (k, m) = r.final_event(false, Some(0)).unwrap();
        assert_eq!(k, Kind::UploadFailed);
        assert!(m.starts_with("The upload did not go through"));
        // Kept here only, as asked: nothing more to say.
        let mut r = RunState::new(false);
        r.on_saved("A.mp4");
        r.on_done(false);
        assert_eq!(r.final_event(false, Some(0)), None);
    }

    #[test]
    fn an_upload_that_finished_before_the_move_is_said_after_done() {
        let mut r = RunState::new(true);
        assert!(r.on_done(true).is_empty(), "not before done");
        assert_eq!(kinds(&r.on_saved("A.mp4")), [Kind::Done, Kind::Uploaded]);
    }

    #[test]
    fn before_done_the_run_fails_or_is_cancelled() {
        let mut r = RunState::new(true);
        assert!(r.on_failed("x", false, Some("ENDED")));
        assert_eq!(r.final_event(true, Some(2)).unwrap().0, Kind::Cancelled);
        let mut r = RunState::new(true);
        assert!(!r.on_failed("Cancelled", true, None));
        assert_eq!(r.final_event(false, Some(2)).unwrap().0, Kind::Cancelled);
        let mut r = RunState::new(true);
        r.on_failed("ffmpeg exited 1", false, None);
        assert_eq!(r.final_event(false, Some(1)), Some((Kind::Failed, "ffmpeg exited 1".into())));
        let r = RunState::new(true);
        assert_eq!(r.final_event(true, None).unwrap().0, Kind::Cancelled);
        assert!(RunState::new(true).final_event(false, Some(9)).unwrap().1.contains("exit code 9"));
        let mut r = RunState::new(true);
        r.on_place_failed("A.mp4", "The disk is full.");
        r.on_done(true);
        let (k, m) = r.final_event(false, Some(0)).unwrap();
        assert_eq!(k, Kind::SaveFailed);
        assert!(m.contains("kept on this computer"), "{m}");
    }

    #[test]
    fn the_runner_saved_line_is_said_by_the_app() {
        let mut r = RunState::new(true);
        assert!(!r.on_log("Saved to 1111.mp4"));
        assert!(r.on_log("Encoding with VideoToolbox"));
    }
}
