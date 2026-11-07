//! Who starts a job on this Mac, and what the person is told (security
//! review 2026-10-31, P1-1): a launch a cloud agent or a loop asks for is
//! never silent and never unbounded.
//!
//! **No start reaches Rust from the person's click.** Every start and resume
//! comes through `local_agent_start` / `local_agent_resume`, from the
//! webview, which runs code our server sends: the relay claims a job the
//! server queued (for a chat's agent, a loop, an action's Start) and starts
//! it, and nothing in a call can prove more. No native control starts a job
//! (the tray only stops them), so Rust counts every launch as one nobody on
//! this Mac asked for. The one answer from the person that counts is a native
//! one: the yes in a worker's confirm ([`super::prompts::worker_prompt`]),
//! drawn by Rust, which no page can give ([`super::Admit`]).
//!
//! - **Told**: a job's first launch the person didn't confirm puts up a
//!   banner in Notification Center, in Rust's words ([`started_notice`]):
//!   which folder, and that a cloud agent or a loop started it. The job is
//!   then announced (`Job::announced`, in state.json): its later launches,
//!   the revivals the person's own messages cause, aren't told again.
//! - **Bounded**: at most [`MAX_REMOTE_STARTS_PER_HOUR`] jobs started in any
//!   hour ([`StartWindow`]; a worker's counts before it is asked), counted
//!   once each, by wall clock, in state.json, so neither a relaunch (which
//!   the page can ask for) nor sleep empties the hour. Past that a start is
//!   refused with [`cap_refusal`], which the relay reports to the server like
//!   any failed start, and the person gets one banner ([`cap_notice`]) each
//!   time the hour fills.
//! - **Confirmed**: a worker (the person's own `claude` or `codex`, with
//!   network access) runs only after a yes, for every launch, start or
//!   resume; no answer within [`super::Timing::worker_confirm`] is a no, one
//!   confirm is up at a time ([`ONE_CONFIRM`]), and after a no (or no answer)
//!   that folder's workers aren't asked about again for
//!   [`super::Timing::worker_backoff`] ([`backed_off`]). A yes lasts
//!   [`super::Timing::worker_yes_for`]: the worker takes the follow-up
//!   messages Dial8 sends meanwhile (the confirm says so), and then it is
//!   parked, so the next message resumes it and the person is asked again.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::prompts::shown;
use super::state::{GrantMode, StartStamp};
use super::workers::Worker;

/// Jobs started in any hour, at most. A folder runs one agent at a time and
/// a loop's schedule fires at most hourly (a fire on a busy folder joins the
/// job already there), so a person and a few loops start far fewer.
pub const MAX_REMOTE_STARTS_PER_HOUR: usize = 20;
/// The window [`MAX_REMOTE_STARTS_PER_HOUR`] counts over.
pub const START_WINDOW: Duration = Duration::from_secs(60 * 60);
/// How long a job the person was told of stays told: a launch after that is
/// told (and counted) again, so an old job is never a standing pass.
pub const ANNOUNCED_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// The person was told of a job at `at` (ms), recently enough for a launch
/// at `now` to tell them nothing new.
pub fn still_announced(at: Option<u64>, now: u64) -> bool {
    at.is_some_and(|at| now.saturating_sub(at) < ANNOUNCED_FOR.as_millis() as u64 && at <= now + 60_000)
}
/// A worker's start while another worker's confirm is still up.
pub const ONE_CONFIRM: &str =
    "another coding agent is waiting for the person's answer on this Mac; try again once it's answered";
/// A worker launch without a yes (never reached: the start asks first).
pub const NOT_CONFIRMED: &str = "a coding agent runs only after the person says yes on this Mac";
/// A message to a worker whose yes has run out: it is being parked, and
/// the relay's retry ("try again") resumes it, which asks the person again.
pub const YES_RAN_OUT: &str = "this coding agent's yes on this Mac has run out and it is being parked; try again in \
                               a moment, and the person is asked again";
/// How much of a label a banner shows, in characters.
const SHOWN_LABEL: usize = 60;

/// Now, in milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The cap over the jobs of the last [`START_WINDOW`] (their stamps live in
/// state.json).
#[derive(Debug)]
pub struct StartWindow {
    max: usize,
    window: Duration,
    /// The person was told it is full, since it last had room (this app run).
    told: bool,
}

impl StartWindow {
    pub fn new(max: usize, window: Duration) -> Self {
        StartWindow {
            max,
            window,
            told: false,
        }
    }

    pub fn max(&self) -> usize {
        self.max
    }

    /// Drop the stamps that aged out by `now`, and any further ahead of it
    /// than the window (a clock set back would hold them for ever).
    pub fn prune(&self, stamps: &mut Vec<StartStamp>, now: u64) {
        let window = self.window.as_millis() as u64;
        stamps.retain(|s| now.saturating_sub(s.at) < window && s.at.saturating_sub(now) <= window);
    }

    /// Room at `now` for `job`'s start (one counted this hour needs none);
    /// `Err`: how long until there is.
    pub fn check(&mut self, stamps: &mut Vec<StartStamp>, job: &str, now: u64) -> Result<(), Duration> {
        self.prune(stamps, now);
        if stamps.len() < self.max || stamps.iter().any(|s| s.job_id == job) {
            if stamps.len() < self.max {
                self.told = false;
            }
            return Ok(());
        }
        let oldest = stamps.iter().map(|s| s.at).min().unwrap_or(now);
        let free_at = oldest + self.window.as_millis() as u64;
        Err(Duration::from_millis(free_at.saturating_sub(now)))
    }

    /// Count `job`'s start at `now`, once.
    pub fn record(stamps: &mut Vec<StartStamp>, job: &str, now: u64) {
        if !stamps.iter().any(|s| s.job_id == job) {
            stamps.push(StartStamp {
                job_id: job.to_string(),
                at: now,
            });
        }
    }

    /// True once each time the window fills: the person is told then.
    pub fn tell(&mut self) -> bool {
        !std::mem::replace(&mut self.told, true)
    }
}

/// The banner for a launch nobody on this Mac confirmed: (title, body).
pub fn started_notice(label: &str, mode: GrantMode, resumed: bool) -> (String, String) {
    let verb = if resumed { "resumed" } else { "started" };
    let what = match mode {
        GrantMode::Read => "to read this folder",
        GrantMode::Edit => "to make changes on its own branch",
    };
    (
        format!("Dial8's agent {verb} in {}", shown(label, SHOWN_LABEL)),
        format!(
            "A Dial8 cloud agent or one of your loops {verb} it, {what}. You can stop it from Dial8 in the menu bar."
        ),
    )
}

/// The banner when the hour's starts run out: (title, body).
pub fn cap_notice(max: usize) -> (String, String) {
    (
        "Dial8 is refusing more local agents for now".into(),
        format!(
            "Cloud agents and loops started {max} local agents on this Mac in the last hour, the most Dial8 allows, \
             so it refuses more until the hour is up. If you didn't expect this, turn Local Agents off in Dial8's \
             menu bar menu."
        ),
    )
}

/// What a start past the cap answers (the server shows it).
pub fn cap_refusal(max: usize, wait: Duration) -> String {
    format!(
        "this Mac has started {max} local agents for cloud agents and loops in the last hour, the most it allows; \
         it takes new ones again in {}",
        minutes(wait)
    )
}

/// A worker's confirm answered no (or closed without a yes).
pub fn denied(worker: Worker) -> String {
    format!("{} didn't run: the person said no on this Mac", worker.name())
}

/// A worker's confirm nobody answered in time.
pub fn unanswered(worker: Worker, wait: Duration) -> String {
    format!(
        "{} didn't run: nobody answered on this Mac within {}",
        worker.name(),
        super::human(wait)
    )
}

/// A worker's start in a folder where the person just said no (or didn't
/// answer): not asked about again for `left`. Final, like the no itself:
/// what it was for didn't run, and isn't tried again by itself.
pub fn backed_off(left: Duration) -> String {
    format!(
        "a coding agent wasn't allowed in this folder on this Mac a few minutes ago, so this didn't run and won't \
         be tried again; Dial8 won't ask the person about one there for {}",
        minutes(left)
    )
}

/// "N min", rounded up, at least 1.
fn minutes(d: Duration) -> String {
    format!("{} min", d.as_secs().div_ceil(60).max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamps(w: &mut StartWindow, list: &mut Vec<StartStamp>, at: u64) -> Result<(), Duration> {
        w.check(list, &format!("job-{at}"), at)
    }

    #[test]
    fn the_window_counts_jobs_once_for_an_hour_and_tells_once_each_time_it_fills() {
        let t0: u64 = 1_800_000_000_000;
        let min = 60_000;
        let mut w = StartWindow::new(2, START_WINDOW);
        let mut list = Vec::new();
        assert_eq!(w.max(), 2);
        for at in [t0, t0 + 10 * min] {
            assert_eq!(stamps(&mut w, &mut list, at), Ok(()));
            StartWindow::record(&mut list, &format!("job-{at}"), at);
        }
        // A job counted already needs no room, and isn't counted twice.
        assert_eq!(w.check(&mut list, &format!("job-{t0}"), t0 + 20 * min), Ok(()));
        StartWindow::record(&mut list, &format!("job-{t0}"), t0 + 20 * min);
        assert_eq!(list.len(), 2);
        let later = t0 + 20 * min;
        assert_eq!(stamps(&mut w, &mut list, later), Err(Duration::from_secs(40 * 60)));
        assert!(w.tell(), "the first refusal tells the person");
        assert_eq!(stamps(&mut w, &mut list, later + min), Err(Duration::from_secs(39 * 60)));
        assert!(!w.tell(), "and only the first");
        // An hour after the first start, there's room for one again.
        let hour = t0 + 60 * min;
        assert_eq!(stamps(&mut w, &mut list, hour), Ok(()));
        StartWindow::record(&mut list, &format!("job-{hour}"), hour);
        assert!(stamps(&mut w, &mut list, hour + 1).is_err());
        assert!(w.tell(), "filled again: told again");
        assert_eq!(stamps(&mut w, &mut list, t0 + 70 * min), Ok(()), "the second has aged out");
    }

    #[test]
    fn stamps_aged_out_or_far_ahead_of_the_clock_are_dropped() {
        let now: u64 = 1_800_000_000_000;
        let hour = 3_600_000;
        let w = StartWindow::new(20, START_WINDOW);
        let at = |job: &str, at: u64| StartStamp {
            job_id: job.into(),
            at,
        };
        let mut list = vec![
            at("old", now - hour),
            at("recent", now - hour + 1),
            at("ahead", now + hour),
            at("far-ahead", now + hour + 1),
        ];
        w.prune(&mut list, now);
        let kept: Vec<&str> = list.iter().map(|s| s.job_id.as_str()).collect();
        assert_eq!(kept, vec!["recent", "ahead"]);
        assert!(now_ms() > 1_700_000_000_000);
    }

    #[test]
    fn a_job_stays_announced_for_a_day() {
        let now: u64 = 1_800_000_000_000;
        let day = ANNOUNCED_FOR.as_millis() as u64;
        assert!(!still_announced(None, now));
        assert!(still_announced(Some(now - day + 1), now));
        assert!(!still_announced(Some(now - day), now), "a day on, told again");
        assert!(!still_announced(Some(now + 2 * day), now), "a stamp from a clock set back isn't a pass");
    }

    #[test]
    fn the_cap_is_a_count_a_person_and_a_few_loops_never_reach() {
        assert_eq!(MAX_REMOTE_STARTS_PER_HOUR, 20);
        assert_eq!(START_WINDOW, Duration::from_secs(3600));
    }

    #[test]
    fn the_words_say_which_folder_and_who_started_it() {
        let (title, body) = started_notice("dial8-website", GrantMode::Read, false);
        assert_eq!(title, "Dial8's agent started in dial8-website");
        assert_eq!(
            body,
            "A Dial8 cloud agent or one of your loops started it, to read this folder. You can stop it from \
             Dial8 in the menu bar."
        );
        let (title, body) = started_notice("site", GrantMode::Edit, true);
        assert_eq!(title, "Dial8's agent resumed in site");
        assert!(body.contains("resumed it, to make changes on its own branch"), "{body}");
        let (odd, _) = started_notice("a\u{202E}b\ncd", GrantMode::Read, false);
        assert_eq!(odd, "Dial8's agent started in ab cd", "no invisible or control characters");
        let (long, _) = started_notice(&"n".repeat(200), GrantMode::Read, false);
        assert!(long.chars().count() < 100 && long.ends_with('\u{2026}'), "{long}");

        let (title, body) = cap_notice(20);
        assert_eq!(title, "Dial8 is refusing more local agents for now");
        assert!(body.contains("started 20 local agents on this Mac in the last hour"), "{body}");
        assert!(body.contains("turn Local Agents off"), "{body}");
        assert_eq!(
            cap_refusal(20, Duration::from_secs(61)),
            "this Mac has started 20 local agents for cloud agents and loops in the last hour, the most it \
             allows; it takes new ones again in 2 min"
        );
        assert!(cap_refusal(20, Duration::from_millis(10)).ends_with("in 1 min"));
        assert_eq!(
            denied(Worker::ClaudeCode),
            "Claude Code didn't run: the person said no on this Mac"
        );
        assert_eq!(
            unanswered(Worker::Codex, Duration::from_secs(120)),
            "Codex didn't run: nobody answered on this Mac within 2 min"
        );
        assert!(backed_off(Duration::from_secs(590)).ends_with("about one there for 10 min"));
        assert!(backed_off(Duration::from_secs(60)).contains("didn't run and won't be tried again"));
        assert!(YES_RAN_OUT.contains("try again"), "the relay retries a send on it");
    }
}
