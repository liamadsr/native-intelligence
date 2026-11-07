//! The last lines each local module logged, for `module_log_tail`: the module
//! manager's own lines (`[modules] … local-stt …`) and the sidecar's output
//! (`[module:local-stt] …`). The web attaches them to a failure it reports to
//! PostHog, so "won't start on this Mac" arrives with its cause (a dyld error,
//! a Metal failure, an HTTP status) without asking anyone for their log file.
//!
//! Fed from `log_to_file`. The home folder is replaced with `~`, so no user
//! name leaves the Mac in a path. The sidecars log ids, sizes and timings,
//! never what was said or heard.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use super::registry;

/// Lines kept per module.
pub const MAX_LINES: usize = 60;

fn tails() -> &'static Mutex<HashMap<&'static str, VecDeque<String>>> {
    static TAILS: OnceLock<Mutex<HashMap<&'static str, VecDeque<String>>>> = OnceLock::new();
    TAILS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The module a log line is about, if any: `[module:<id>] …`, or a
/// `[modules] …` line that names a registered module.
fn module_of(msg: &str) -> Option<&'static str> {
    if let Some(rest) = msg.strip_prefix("[module:") {
        let id = rest.split(']').next()?;
        return registry::MODULES.iter().map(|m| m.id).find(|known| *known == id);
    }
    if msg.starts_with("[modules] ") {
        return registry::MODULES.iter().map(|m| m.id).find(|known| msg.contains(known));
    }
    None
}

/// `msg` with the home folder written as `~`.
fn redact(msg: &str, home: Option<&str>) -> String {
    match home {
        Some(home) if home.len() > 1 => msg.replace(home, "~"),
        _ => msg.to_string(),
    }
}

/// Keep `msg` (stamped `time`) if it is about a module.
pub fn record(time: &str, msg: &str) {
    let Some(id) = module_of(msg) else { return };
    let home = std::env::var("HOME").ok();
    let line = format!("[{time}] {}", redact(msg, home.as_deref()));
    let mut tails = tails().lock().unwrap_or_else(|e| e.into_inner());
    let tail = tails.entry(id).or_default();
    if tail.len() == MAX_LINES {
        tail.pop_front();
    }
    tail.push_back(line);
}

/// `id`'s last lines, oldest first. Empty for a module that logged nothing.
pub fn tail(id: &str) -> Vec<String> {
    let tails = tails().lock().unwrap_or_else(|e| e.into_inner());
    tails.get(id).map(|t| t.iter().cloned().collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_each_modules_own_lines_only() {
        record("10:00:00", "[module:local-tts] models loaded in 0.35s");
        record("10:00:01", "[modules] local-tts warmed up in 1.2s");
        record("10:00:02", "[modules] init local-stt enabled=true needs_job=true");
        record("10:00:03", "[voice] mic released");
        record("10:00:04", "[module:unknown] whatever");
        let tts = tail("local-tts");
        assert!(tts.contains(&"[10:00:00] [module:local-tts] models loaded in 0.35s".to_string()));
        assert!(tts.contains(&"[10:00:01] [modules] local-tts warmed up in 1.2s".to_string()));
        assert!(tts.iter().all(|l| !l.contains("local-stt") && !l.contains("[voice]")));
        assert!(tail("local-stt").iter().any(|l| l.contains("init local-stt")));
        assert!(tail("unknown").is_empty());
    }

    #[test]
    fn keeps_only_the_newest_lines() {
        for i in 0..(MAX_LINES + 15) {
            record("11:00:00", &format!("[module:local-stt] cap test line {i}"));
        }
        let stt: Vec<_> = tail("local-stt").into_iter().filter(|l| l.contains("cap test")).collect();
        assert!(stt.len() <= MAX_LINES);
        assert!(stt.last().unwrap().ends_with(&format!("cap test line {}", MAX_LINES + 14)));
        assert!(!stt.iter().any(|l| l.ends_with("cap test line 0")));
    }

    #[test]
    fn writes_the_home_folder_as_tilde() {
        assert_eq!(
            redact("spawned /Users/pat/Library/x (pid 1)", Some("/Users/pat")),
            "spawned ~/Library/x (pid 1)"
        );
        assert_eq!(redact("no path here", Some("/Users/pat")), "no path here");
        assert_eq!(redact("/ stays", Some("/")), "/ stays");
        assert_eq!(redact("no home", None), "no home");
    }
}
