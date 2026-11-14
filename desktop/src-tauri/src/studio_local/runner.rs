//! The runner's command line, environment and output, as pure functions
//! (studio-worker src/local-main.ts is the other side).
//!
//! The runner is started as `<node> [--import <watchdog>] runner.cjs --app
//! <origin> --job <id> --out <work>/out/<id>.mp4 --work <work> --ffmpeg ..
//! --ffprobe .. --bundle .. --chrome .. [--no-upload]`, every path absolute
//! and chosen here, never by the page. The token goes on standard input
//! only. Its environment is built from nothing: a fixed PATH of system
//! folders, HOME, a temp folder inside its work folder, and on Windows the
//! few system variables a program needs to start.
//!
//! Destination: the runner writes into its own work folder (`--out` there),
//! and the app moves the file to the place the person picked
//! ([`super::destinations::place_file`]). So the runner (Node, third-party
//! packages, a browser, all working on data from the web) never holds a
//! path outside its folder, and the app alone checks the destination
//! (links, a swapped folder) and marks the file.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// What the runner needs on disk, all absolute.
#[derive(Debug, Clone, PartialEq)]
pub struct RunnerFiles {
    pub node: PathBuf,
    /// `<runner dir>/runner/runner.cjs`.
    pub runner: PathBuf,
    /// `<runner dir>/render-bundle`.
    pub bundle: PathBuf,
    /// Chrome's headless shell executable.
    pub chrome: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

/// Node's own options before the runner: the watchdog on macOS.
fn node_prefix(os: &str) -> Vec<OsString> {
    if os == "macos" {
        vec!["--import".into(), super::procs::WATCHDOG.into()]
    } else {
        Vec::new()
    }
}

/// The export's command line (after the program, Node). Pure.
pub fn export_args(os: &str, f: &RunnerFiles, origin: &str, job_id: &str, out: &Path, work: &Path, upload: bool) -> Vec<OsString> {
    let mut a = node_prefix(os);
    a.push(f.runner.clone().into());
    for (k, v) in [
        ("--app", OsString::from(origin)),
        ("--job", job_id.into()),
        ("--out", out.into()),
        ("--work", work.into()),
        ("--ffmpeg", f.ffmpeg.clone().into()),
        ("--ffprobe", f.ffprobe.clone().into()),
        ("--bundle", f.bundle.clone().into()),
        ("--chrome", f.chrome.clone().into()),
    ] {
        a.push(k.into());
        a.push(v);
    }
    if !upload {
        a.push("--no-upload".into());
    }
    a
}

/// The encoder probe's command line: no job, no token. Pure.
pub fn probe_args(os: &str, f: &RunnerFiles, work: &Path) -> Vec<OsString> {
    let mut a = node_prefix(os);
    a.push(f.runner.clone().into());
    for (k, v) in [("--probe", None), ("--work", Some(work)), ("--ffmpeg", Some(f.ffmpeg.as_path())), ("--ffprobe", Some(f.ffprobe.as_path()))] {
        a.push(k.into());
        if let Some(v) = v {
            a.push(v.into());
        }
    }
    a
}

/// The Windows variables a program needs to start at all (studio-worker
/// src/platform.ts WINDOWS_BASE_KEYS), besides PATH and the temp folders.
const WINDOWS_KEYS: [&str; 10] = [
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
    "PATHEXT",
    "COMSPEC",
    "NUMBER_OF_PROCESSORS",
];

/// The runner's environment, from nothing: `get` reads the app's own (only
/// the names listed here), `tmp` is its temp folder. Pure.
pub fn runner_env(os: &str, get: impl Fn(&str) -> Option<String>, tmp: &Path) -> Vec<(String, String)> {
    let tmp = tmp.to_string_lossy().into_owned();
    let mut env = Vec::new();
    if os == "windows" {
        for k in WINDOWS_KEYS {
            if let Some(v) = get(k).filter(|v| !v.is_empty()) {
                env.push((k.to_string(), v));
            }
        }
        let root = get("SYSTEMROOT").filter(|v| !v.is_empty()).unwrap_or_else(|| "C:\\Windows".into());
        let root = root.trim_end_matches(['\\', '/']);
        env.push(("PATH".into(), format!("{root}\\System32;{root};{root}\\System32\\Wbem")));
        env.push(("TEMP".into(), tmp.clone()));
        env.push(("TMP".into(), tmp));
    } else {
        env.push(("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()));
        if let Some(home) = get("HOME").filter(|h| h.starts_with('/')) {
            env.push(("HOME".into(), home));
        }
        env.push(("TMPDIR".into(), tmp));
        env.push(("LANG".into(), "en_US.UTF-8".into()));
    }
    env.push(("NODE_ENV".into(), "production".into()));
    env
}

/// One line of the runner's output (studio-worker src/local.ts LocalEvent).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RunnerEvent {
    Taken {
        #[serde(default)]
        title: String,
    },
    Progress {
        progress: f64,
    },
    Log {
        line: String,
    },
    /// The video is whole at `--out` (the upload, if any, after).
    Saved {
        file: String,
        #[serde(default)]
        bytes: u64,
    },
    Done {
        #[serde(default)]
        uploaded: bool,
    },
    Failed {
        error: String,
        #[serde(default)]
        cancelled: bool,
        /// The app's refusal code, when a route refused (`NOT_HELD`, `ENDED`, …).
        #[serde(default)]
        code: Option<String>,
    },
    Encoder {
        profile: String,
        rung: Option<String>,
    },
}

/// A line of output, or None for one that is not an event. Pure.
pub fn parse_line(line: &str) -> Option<RunnerEvent> {
    serde_json::from_str(line.trim()).ok()
}

/// The Studio took the job back ("Finish on the server", another computer):
/// a 409 NOT_HELD or ENDED, or a 401/403 (UNAUTHORIZED, FORBIDDEN), from any
/// runner route; the runner reports those as cancelled, with its `code`, which
/// decides. The runner's `code` says
/// so; a runner from before it is read by whole words and the app's own
/// sentences. Then the export stops quietly, as cancelled. Pure.
pub fn taken_back(code: Option<&str>, error: &str) -> bool {
    if let Some(code) = code {
        return matches!(code, "NOT_HELD" | "ENDED" | "UNAUTHORIZED" | "FORBIDDEN");
    }
    static WORDS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let words = WORDS.get_or_init(|| {
        regex::Regex::new(r"\b(NOT_HELD|ENDED)\b|took the job back|does not hold that export|That export has ended").expect("a valid pattern")
    });
    words.is_match(error)
}

/// The encoder a probe or an export settled on, for the status and the
/// page: the runner's words held to a few plain characters. Pure.
pub fn encoder_label(profile: &str, rung: Option<&str>) -> String {
    let raw = match rung {
        Some(r) => format!("{profile} ({r})"),
        None => profile.to_string(),
    };
    let kept: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || " ._()+-".contains(*c))
        .take(40)
        .collect();
    let kept = kept.trim().to_string();
    if kept.is_empty() { "unknown".into() } else { kept }
}

/// Text from the runner made fit for the page: the folders of this computer
/// it might name replaced by a word, the token never, control characters
/// out, 500 characters at most. Pure.
pub struct Scrub {
    /// Longest first.
    pairs: Vec<(String, &'static str)>,
    secret: Option<String>,
}

impl Scrub {
    pub fn new(folders: &[(&Path, &'static str)], secret: Option<String>) -> Self {
        let mut pairs = Vec::new();
        for (p, word) in folders {
            let s = p.to_string_lossy().into_owned();
            if s.len() < 2 {
                continue;
            }
            for v in [s.clone(), s.replace('\\', "/"), s.replace('/', "\\")] {
                pairs.push((v, *word));
            }
        }
        pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        pairs.dedup();
        Self { pairs, secret: secret.filter(|s| !s.is_empty()) }
    }

    pub fn apply(&self, text: &str) -> String {
        let mut out = text.to_string();
        if let Some(s) = &self.secret {
            out = out.replace(s.as_str(), "[token]");
        }
        // The token's own shape, should another one turn up.
        static TOKEN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        // [`valid_token`]'s shape: `ls1.<payload>.<mac>`.
        let re = TOKEN.get_or_init(|| regex::Regex::new(r"ls1\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+").expect("a valid pattern"));
        out = re.replace_all(&out, "[token]").into_owned();
        for (from, to) in &self.pairs {
            out = out.replace(from.as_str(), to);
        }
        let out: String = out.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
        let mut out: String = out.trim().chars().take(500).collect();
        if text.chars().count() > 500 {
            out.push('…');
        }
        out
    }
}

/// A job id as the Studio makes them: a uuid. Pure.
pub fn valid_job_id(id: &str) -> bool {
    id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()
}

/// A local token as the Studio mints them (web src/lib/studio/server/
/// local-token.ts): `ls1.<payload>.<mac>`, both URL-safe base64, at most
/// 2 KB (so it is one line on standard input). Pure.
pub fn valid_token(token: &str) -> bool {
    let b64 = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    let parts: Vec<&str> = token.split('.').collect();
    token.len() <= 2048 && parts.len() == 3 && parts[0] == "ls1" && b64(parts[1]) && b64(parts[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> RunnerFiles {
        RunnerFiles {
            node: "/d/node/bin/node".into(),
            runner: "/r/runner/runner.cjs".into(),
            bundle: "/r/render-bundle".into(),
            chrome: "/d/chrome/files/chrome-headless-shell".into(),
            ffmpeg: "/d/ffmpeg/files/ffmpeg".into(),
            ffprobe: "/d/ffmpeg/files/ffprobe".into(),
        }
    }

    fn strs(a: &[OsString]) -> Vec<String> {
        a.iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn the_export_command_line_has_paths_from_here_and_no_token() {
        let a = strs(&export_args("macos", &files(), "https://app.example", "11111111-2222-4333-8444-555555555555", Path::new("/w/out/x.mp4"), Path::new("/w"), true));
        assert_eq!(a[0], "--import");
        assert!(a[1].starts_with("data:text/javascript,"));
        assert_eq!(
            &a[2..],
            [
                "/r/runner/runner.cjs", "--app", "https://app.example", "--job", "11111111-2222-4333-8444-555555555555", "--out", "/w/out/x.mp4", "--work", "/w",
                "--ffmpeg", "/d/ffmpeg/files/ffmpeg", "--ffprobe", "/d/ffmpeg/files/ffprobe", "--bundle", "/r/render-bundle", "--chrome",
                "/d/chrome/files/chrome-headless-shell"
            ]
        );
        assert!(!a.iter().any(|s| s.contains("token") || s.starts_with("ls1.")));
        let w = strs(&export_args("windows", &files(), "https://app.example", "j", Path::new("/w/o.mp4"), Path::new("/w"), false));
        assert_eq!(w[0], "/r/runner/runner.cjs", "no watchdog on Windows: the job object");
        assert_eq!(w.last().unwrap(), "--no-upload");
    }

    #[test]
    fn the_probe_command_line() {
        let a = strs(&probe_args("windows", &files(), Path::new("/w/probe")));
        assert_eq!(a, ["/r/runner/runner.cjs", "--probe", "--work", "/w/probe", "--ffmpeg", "/d/ffmpeg/files/ffmpeg", "--ffprobe", "/d/ffmpeg/files/ffprobe"]);
    }

    #[test]
    fn the_environment_is_built_from_nothing() {
        let get = |k: &str| match k {
            "HOME" => Some("/Users/p".to_string()),
            "SYSTEMROOT" => Some("C:\\Windows\\".to_string()),
            "USERPROFILE" => Some("C:\\Users\\p".to_string()),
            "SECRET_KEY" | "NODE_OPTIONS" | "STUDIO_LOCAL_TOKEN" => Some("nope".to_string()),
            _ => None,
        };
        let mac = runner_env("macos", get, Path::new("/w/tmp"));
        let names: Vec<&str> = mac.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["PATH", "HOME", "TMPDIR", "LANG", "NODE_ENV"]);
        assert_eq!(mac[0].1, "/usr/bin:/bin:/usr/sbin:/sbin");
        let win = runner_env("windows", get, Path::new("C:\\w\\tmp"));
        let get_w = |k: &str| win.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get_w("PATH").unwrap(), "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem");
        assert_eq!(get_w("TEMP").unwrap(), "C:\\w\\tmp");
        assert_eq!(get_w("USERPROFILE").unwrap(), "C:\\Users\\p");
        for leak in ["SECRET_KEY", "NODE_OPTIONS", "STUDIO_LOCAL_TOKEN", "HOME"] {
            assert!(get_w(leak).is_none(), "{leak}");
            assert!(!mac.iter().any(|(k, _)| k == leak) || leak == "HOME", "{leak}");
        }
    }

    #[test]
    fn runner_lines_parse() {
        assert_eq!(parse_line(r#"{"type":"progress","progress":0.5}"#), Some(RunnerEvent::Progress { progress: 0.5 }));
        assert_eq!(
            parse_line(r#"{"type":"saved","file":"/w/out/x.mp4","bytes":12}"#),
            Some(RunnerEvent::Saved { file: "/w/out/x.mp4".into(), bytes: 12 })
        );
        assert_eq!(
            parse_line(r#"{"type":"done","file":"/w/out/x.mp4","uploaded":true,"result":{"key":"k"}}"#),
            Some(RunnerEvent::Done { uploaded: true })
        );
        assert_eq!(
            parse_line(r#"{"type":"failed","error":"Cancelled","cancelled":true}"#),
            Some(RunnerEvent::Failed { error: "Cancelled".into(), cancelled: true, code: None })
        );
        assert_eq!(
            parse_line(r#"{"type":"failed","error":"x","cancelled":false,"code":"NOT_HELD"}"#),
            Some(RunnerEvent::Failed { error: "x".into(), cancelled: false, code: Some("NOT_HELD".into()) })
        );
        assert_eq!(
            parse_line(r#"{"type":"encoder","profile":"videotoolbox","rung":"quality","tried":[]}"#),
            Some(RunnerEvent::Encoder { profile: "videotoolbox".into(), rung: Some("quality".into()) })
        );
        assert_eq!(parse_line(r#"{"type":"taken","jobId":"j","attempt":1,"title":"T"}"#), Some(RunnerEvent::Taken { title: "T".into() }));
        assert_eq!(parse_line("not json"), None);
        assert_eq!(parse_line(r#"{"type":"other"}"#), None);
    }

    #[test]
    fn taken_back_is_told_apart() {
        assert!(taken_back(Some("NOT_HELD"), "whatever"));
        assert!(taken_back(Some("ENDED"), ""));
        assert!(taken_back(Some("UNAUTHORIZED"), "Cancelled") && taken_back(Some("FORBIDDEN"), "Cancelled"));
        assert!(!taken_back(Some("TOO_FAST"), "That export has ended"), "the code decides when there is one");
        assert!(taken_back(None, "The Studio took the job back (This computer does not hold that export any more.)"));
        assert!(taken_back(None, "The export failed on this computer: That export has ended."));
        assert!(taken_back(None, "refused: NOT_HELD"));
        assert!(!taken_back(None, "The export failed on this computer: ffmpeg exited 1"));
        assert!(!taken_back(None, "EXTENDED attributes could not be read"));
        assert!(!taken_back(None, "NOT_HELDX"));
    }

    #[test]
    fn encoder_labels_are_plain() {
        assert_eq!(encoder_label("videotoolbox", Some("quality")), "videotoolbox (quality)");
        assert_eq!(encoder_label("<img src=x>", None), "img srcx");
        assert_eq!(encoder_label("", None), "unknown");
        assert_eq!(encoder_label(&"a".repeat(80), None).len(), 40);
    }

    #[test]
    fn scrubbed_text_names_no_folder_and_no_token() {
        let s = Scrub::new(&[(Path::new("/Users/p/Library/Caches/x/work"), "<work folder>"), (Path::new("/Users/p"), "~")], Some("ls1.abc.def".into()));
        assert_eq!(s.apply("read /Users/p/Library/Caches/x/work/cache/a.mp4 and /Users/p/Movies"), "read <work folder>/cache/a.mp4 and ~/Movies");
        assert_eq!(s.apply("token ls1.abc.def and ls1.zzz.yyy\nnext"), "token [token] and [token] next");
        let w = Scrub::new(&[(Path::new("C:\\Users\\p\\AppData\\Local\\x\\sl"), "<work folder>")], None);
        assert_eq!(w.apply("C:/Users/p/AppData/Local/x/sl/out"), "<work folder>/out");
        assert_eq!(s.apply(&"x".repeat(600)).chars().count(), 501);
    }

    #[test]
    fn arguments_are_checked() {
        assert!(valid_job_id("11111111-2222-4333-8444-555555555555"));
        assert!(!valid_job_id("11111111222243338444555555555555"));
        assert!(!valid_job_id("../x"));
        assert!(valid_token("ls1.eyJqaWQiOiJ4In0.sig-_"));
        for bad in ["ls1.", "ls2.abc.def", "ls1.a\nb.c", "ls1.a b.c", "abc", "ls1.abc", "ls1.a.b.c", "ls1..b", "ls1.a."] {
            assert!(!valid_token(bad), "{bad:?}");
        }
        assert!(!valid_token(&format!("ls1.{}.b", "a".repeat(2045))));
        assert_eq!(encoder_label("videotoolbox", Some("quality")), "videotoolbox (quality)");
    }
}
