//! Saving a SERVER export to a picked destination, straight from storage to
//! disk, instead of through the web view (which holds a whole download in
//! memory, and the Mac's web view has no download handler at all).
//!
//! The parts are signed links to the app's own storage, in order. Either
//! the page hands them over (`parts`, `bytes`, `sha256`), or it names the
//! export (`videoId`, `jobId`) and the app asks the app's parts route itself
//! (`GET <app>/api/account/studio/projects/<videoId>/exports/<jobId>/parts`),
//! with the person's own session token the page gave the app (`set_auth_token`:
//! the Supabase access token, read again at each ask since it is refreshed)
//! and the workspace in `x-workspace-id` (the Studio's door resolves the
//! workspace from that header, else the first membership): then links that
//! run out mid-download are asked for again from the first part not yet
//! saved (`?from=`), and the file carries on.
//!
//! A save can be stopped (`studio_export_save_cancel`, or the app quitting):
//! it stops between chunks and removes its temp file. An HTTP error never
//! reaches the page with its URL (a signed link carries its token).
//!
//! - A part link must be https to the app's storage host (`sb.<app domain>`,
//!   from the app's own configuration: [`crate::nav_guard::APP_DOMAINS`], as
//!   the Studio recorder's uploads are held), on its default port, under
//!   `/storage/v1/object/sign/`; a debug build also allows this machine and
//!   `*.supabase.co`. No redirect is followed. No cookie and no token goes to
//!   a part link: they are signed already.
//! - Each part's size and the total are checked, and the SHA-256 when known.
//! - The bytes go to a hidden file beside the destination ([`super::destinations`]),
//!   renamed over the chosen name only once whole and checked.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::destinations::{self, Claim};

/// Tries per part (the first and three retries, backing off 1, 2, 4 s).
const PART_TRIES: u32 = 4;
/// Asks for new links at most this many times in one save.
const MAX_RELINKS: u32 = 20;
/// No export is this big; anything claiming to be is refused.
const MAX_BYTES: u64 = 256 * 1024 * 1024 * 1024;
const MAX_PARTS: usize = 100_000;
/// Free space kept on the destination's volume beyond the file.
const DISK_MARGIN: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    /// The part's number (the parts route gives it); absent: its place in the list.
    #[serde(default)]
    pub index: Option<u64>,
    pub url: String,
    pub bytes: u64,
}

/// The parts route's answer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartsAnswer {
    pub bytes: u64,
    #[serde(default)]
    pub sha256: Option<String>,
    pub from: u64,
    pub parts: Vec<Part>,
}

/// The storage hosts a part may come from: `sb.<domain>` for each app domain.
fn storage_hosts() -> Vec<String> {
    crate::nav_guard::APP_DOMAINS.iter().map(|d| format!("sb.{d}")).collect()
}

/// Where a part may be read from ([`part_url_allowed_in`] for this build).
pub fn part_url_allowed(url: &str) -> bool {
    part_url_allowed_in(url, &storage_hosts(), cfg!(debug_assertions))
}

/// Pure: https to one of `hosts` on the default port, no credentials, a
/// signed storage path; `debug` also allows this machine (http or https) and
/// `<project>.supabase.co`.
pub fn part_url_allowed_in(url: &str, hosts: &[String], debug: bool) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    if !u.path().starts_with("/storage/v1/object/sign/") {
        return false;
    }
    let Some(host) = u.host_str().map(str::to_ascii_lowercase) else { return false };
    let loopback = host == "localhost"
        || host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if debug && loopback {
        return matches!(u.scheme(), "http" | "https");
    }
    if u.scheme() != "https" || u.port().is_some() {
        return false;
    }
    if hosts.iter().any(|h| h == &host) {
        return true;
    }
    debug && host.strip_suffix(".supabase.co").is_some_and(|p| !p.is_empty() && !p.contains('.'))
}

/// The byte offset each part starts at, from `first` on, checked: in order,
/// none empty but a lone empty file, within the total. Pure.
pub fn check_parts(parts: &[Part], first: u64, offset: u64, total: u64) -> Result<(), String> {
    if total > MAX_BYTES {
        return Err("bad-request: the file is larger than any export".into());
    }
    if parts.len() > MAX_PARTS {
        return Err("bad-request: too many parts".into());
    }
    let mut end = offset;
    for (i, p) in parts.iter().enumerate() {
        let want = first + i as u64;
        if p.index.is_some_and(|n| n != want) {
            return Err(format!("bad-request: part {want} is out of order"));
        }
        if p.bytes == 0 && !(total == 0 && parts.len() == 1) {
            return Err(format!("bad-request: part {want} is empty"));
        }
        end = end.checked_add(p.bytes).ok_or("bad-request: the parts overflow")?;
        if end > total {
            return Err("bad-request: the parts are larger than the file".into());
        }
        if !part_url_allowed(&p.url) {
            return Err(format!("bad-request: part {want} is not a link to the app's storage"));
        }
    }
    Ok(())
}

/// Where the parts come from: the page's list, and the route to ask again.
pub struct Source {
    pub parts: Vec<Part>,
    pub first: u64,
    pub bytes: u64,
    pub sha256: Option<String>,
    /// `(app origin, videoId, jobId, the person's token)`: ask for new links.
    pub relink: Option<Relink>,
}

pub struct Relink {
    pub origin: String,
    pub workspace_id: String,
    pub video_id: String,
    pub job_id: String,
    /// The person's current token, read at each ask.
    pub token: std::sync::Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

/// The parts route's refusal, as `<CODE>: <server's message>`.
async fn ask_parts(api: &reqwest::Client, r: &Relink, from: u64) -> Result<PartsAnswer, String> {
    let url = format!("{}/api/account/studio/projects/{}/exports/{}/parts?from={from}", r.origin, r.video_id, r.job_id);
    let token = (r.token)().filter(|t| !t.is_empty()).ok_or("signed-out: Sign in to Native Intelligence again, then save again.")?;
    let response = api
        .get(&url)
        .bearer_auth(token)
        .header("x-workspace-id", &r.workspace_id)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("network: Could not reach Native Intelligence ({})", e.without_url()))?;
    let status = response.status();
    if status.is_success() {
        return response.json::<PartsAnswer>().await.map_err(|e| format!("bad-answer: {}", e.without_url()));
    }
    let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    let code = body.get("code").and_then(|v| v.as_str()).unwrap_or(match status.as_u16() {
        401 => "UNAUTHORIZED",
        403 => "FORBIDDEN",
        404 => "NOT_FOUND",
        409 => "CONFLICT",
        _ => "ERROR",
    });
    let message = body
        .get("error")
        .or_else(|| body.get("message"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("The server answered {status}."));
    Err(format!("{code}: {message}"))
}

/// What one part's read ended with.
enum PartEnd {
    Done,
    /// The save was stopped.
    Cancelled,
    /// The link was refused (ran out): ask for new ones.
    Expired,
    Failed(String),
}

const CANCELLED: &str = "cancelled: The save was stopped.";

/// Save the parts into `claim`. `progress(received, total)`; `cancel` stops
/// it between chunks; `temp_at` is told the temp file's path (so a quit can
/// remove it).
pub async fn save(claim: &Claim, mut src: Source, cancel: &AtomicBool, temp_at: impl Fn(&std::path::Path), progress: impl Fn(u64, u64)) -> Result<String, String> {
    let api = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("network: {}", e.without_url()))?;
    // The part links' client: no redirects, no cookies, no default headers.
    let storage = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("network: {}", e.without_url()))?;
    if src.parts.is_empty() {
        let r = src.relink.as_ref().ok_or("bad-request: no parts and no export named")?;
        let a = ask_parts(&api, r, 0).await?;
        src = Source { parts: a.parts, first: a.from, bytes: a.bytes, sha256: a.sha256, relink: src.relink };
    }
    if src.first != 0 {
        return Err("bad-request: the parts must start at the first".into());
    }
    if let Some(s) = &src.sha256 {
        if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("bad-request: sha256 is not a SHA-256".into());
        }
    }
    check_parts(&src.parts, 0, 0, src.bytes)?;
    let target_dir = destinations::checked_target(claim)?;
    let free = crate::modules::assets::available_space(target_dir.parent().unwrap_or(&claim.dir)).unwrap_or(u64::MAX);
    if free < src.bytes.saturating_add(DISK_MARGIN) {
        return Err(format!(
            "disk-full: There is not enough free space there: {} MB are needed.",
            (src.bytes + DISK_MARGIN) / (1024 * 1024)
        ));
    }

    let temp = destinations::temp_beside(&claim.dir).map_err(|e| format!("write: {e}"))?;
    let temp_path = temp.path.clone();
    temp_at(&temp_path);
    let result = async {
        let mut file = tokio::fs::File::from_std(temp.file.try_clone().map_err(|e| format!("write: {e}"))?);
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        let mut next: u64 = 0;
        let mut relinks = 0u32;
        let mut queue: std::collections::VecDeque<Part> = src.parts.drain(..).collect();
        let mut last_report = Instant::now();
        loop {
            let Some(part) = queue.pop_front() else { break };
            let mut outcome = PartEnd::Failed(String::new());
            for attempt in 0..PART_TRIES {
                if attempt > 0 {
                    tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
                }
                if cancel.load(Ordering::SeqCst) {
                    return Err(CANCELLED.into());
                }
                // A retry starts the part again.
                file.set_len(written).await.map_err(|e| format!("write: {e}"))?;
                file.seek(std::io::SeekFrom::Start(written)).await.map_err(|e| format!("write: {e}"))?;
                let mut h = hasher.clone();
                outcome = read_part(&storage, &part, next, &mut file, &mut h, cancel, |n| {
                    if last_report.elapsed() >= Duration::from_millis(250) {
                        last_report = Instant::now();
                        progress(written + n, src.bytes);
                    }
                })
                .await;
                match &outcome {
                    PartEnd::Done => {
                        hasher = h;
                        break;
                    }
                    PartEnd::Expired | PartEnd::Cancelled => break,
                    PartEnd::Failed(why) if why.starts_with("retry:") => continue,
                    PartEnd::Failed(_) => break,
                }
            }
            match outcome {
                PartEnd::Done => {
                    written += part.bytes;
                    next += 1;
                    progress(written, src.bytes);
                }
                PartEnd::Cancelled => return Err(CANCELLED.into()),
                PartEnd::Expired => {
                    let Some(r) = src.relink.as_ref() else {
                        return Err(format!("links-expired: The links to this export ran out at part {next}. Ask for new ones and save again."));
                    };
                    relinks += 1;
                    if relinks > MAX_RELINKS {
                        return Err("links-expired: The export's links kept running out.".into());
                    }
                    let a = ask_parts(&api, r, next).await?;
                    if a.bytes != src.bytes || a.from != next || a.sha256.as_deref().is_some_and(|s| src.sha256.as_deref().is_some_and(|t| !s.eq_ignore_ascii_case(t))) {
                        return Err("changed: The export changed while it was being saved.".into());
                    }
                    check_parts(&a.parts, next, written, src.bytes)?;
                    queue = a.parts.into_iter().collect();
                }
                PartEnd::Failed(why) => return Err(format!("download: {}", why.trim_start_matches("retry:").trim())),
            }
        }
        if written != src.bytes {
            return Err(format!("download: {written} bytes arrived, the export is {}", src.bytes));
        }
        file.flush().await.map_err(|e| format!("write: {e}"))?;
        let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if let Some(want) = &src.sha256 {
            if !digest.eq_ignore_ascii_case(want) {
                return Err("checksum: The saved file is not the export (its SHA-256 differs).".into());
            }
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            let placed = destinations::finish(temp, claim)?;
            Ok(placed.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
        }
        Err(e) => {
            drop(temp);
            let _ = std::fs::remove_file(&temp_path);
            Err(e)
        }
    }
}

/// Read one part into `file` (at its current position), exactly `part.bytes`.
async fn read_part(
    client: &reqwest::Client,
    part: &Part,
    number: u64,
    file: &mut tokio::fs::File,
    hasher: &mut Sha256,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> PartEnd {
    // Long enough for a slow link: 60 s plus 4 s per MB.
    let timeout = Duration::from_secs(60 + 4 * (part.bytes / (1024 * 1024)));
    let response = match client.get(&part.url).timeout(timeout).send().await {
        Ok(r) => r,
        Err(e) => return PartEnd::Failed(format!("retry: part {number} failed ({})", e.without_url())),
    };
    let status = response.status();
    if status.is_redirection() {
        return PartEnd::Failed(format!("part {number} answered {status}: the app does not follow redirects"));
    }
    if matches!(status.as_u16(), 400 | 401 | 403) {
        return PartEnd::Expired;
    }
    if !status.is_success() {
        let retry = status.is_server_error() || matches!(status.as_u16(), 408 | 429);
        return PartEnd::Failed(format!("{}part {number} answered {status}", if retry { "retry: " } else { "" }));
    }
    if response.content_length().is_some_and(|n| n != part.bytes) {
        return PartEnd::Failed(format!("part {number} is not the size it should be"));
    }
    let mut got: u64 = 0;
    let mut response = response;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return PartEnd::Cancelled;
        }
        match response.chunk().await {
            Ok(Some(chunk)) => {
                got += chunk.len() as u64;
                if got > part.bytes {
                    return PartEnd::Failed(format!("part {number} is larger than it should be"));
                }
                hasher.update(&chunk);
                if let Err(e) = file.write_all(&chunk).await {
                    return PartEnd::Failed(format!("could not write ({e})"));
                }
                progress(got);
            }
            Ok(None) => break,
            Err(e) => return PartEnd::Failed(format!("retry: part {number} broke off ({})", e.without_url())),
        }
    }
    if got != part.bytes {
        return PartEnd::Failed(format!("retry: part {number} ended early"));
    }
    PartEnd::Done
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    fn hosts() -> Vec<String> {
        vec!["sb.example.test".into()]
    }

    #[test]
    fn part_links_go_to_the_app_storage_only() {
        let ok = "https://sb.example.test/storage/v1/object/sign/studio/w/k/0?token=x";
        assert!(part_url_allowed_in(ok, &hosts(), false));
        for bad in [
            "http://sb.example.test/storage/v1/object/sign/a",
            "https://sb.example.test:444/storage/v1/object/sign/a",
            "https://u:p@sb.example.test/storage/v1/object/sign/a",
            "https://sb.example.test.evil.example/storage/v1/object/sign/a",
            "https://sb.example.test/api/account/x",
            "https://evil.example/storage/v1/object/sign/a",
            "https://abc.supabase.co/storage/v1/object/sign/a",
            "http://127.0.0.1:54321/storage/v1/object/sign/a",
        ] {
            assert!(!part_url_allowed_in(bad, &hosts(), false), "{bad}");
        }
        assert!(part_url_allowed_in("http://127.0.0.1:54321/storage/v1/object/sign/a", &hosts(), true));
        assert!(part_url_allowed_in("https://abc.supabase.co/storage/v1/object/sign/a", &hosts(), true));
        assert!(!part_url_allowed_in("https://a.b.supabase.co/storage/v1/object/sign/a", &hosts(), true));
        assert!(!part_url_allowed_in("https://evilsupabase.co/storage/v1/object/sign/a", &hosts(), true));
        // The app's own domains, from its configuration.
        for d in crate::nav_guard::APP_DOMAINS {
            assert!(part_url_allowed_in(&format!("https://sb.{d}/storage/v1/object/sign/x"), &storage_hosts(), false));
        }
    }

    fn p(url: &str, bytes: u64) -> Part {
        Part { index: None, url: url.into(), bytes }
    }

    #[test]
    fn parts_must_add_up() {
        let u = "http://127.0.0.1:1/storage/v1/object/sign/a";
        assert!(check_parts(&[p(u, 4), p(u, 2)], 0, 0, 6).is_ok());
        assert!(check_parts(&[p(u, 4), p(u, 4)], 0, 0, 6).is_err());
        assert!(check_parts(&[p(u, 0)], 0, 0, 0).is_ok(), "an empty file is one empty part");
        assert!(check_parts(&[p(u, 4), p(u, 0)], 0, 0, 4).is_err());
        let mut out = p(u, 2);
        out.index = Some(5);
        assert!(check_parts(&[out], 0, 0, 2).unwrap_err().contains("out of order"));
        assert!(check_parts(&[p("https://evil.example/storage/v1/object/sign/a", 1)], 0, 0, 1).is_err());
        assert!(check_parts(&[p(u, 1)], 0, 0, MAX_BYTES + 1).is_err());
    }

    /// A storage stand-in: `/storage/v1/object/sign/<n>` answers part n, or
    /// 400 for the first `expire` requests of parts at or past `expire_from`.
    async fn storage(parts: Vec<Vec<u8>>, expire_from: usize, expire: usize) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let refused = Arc::new(AtomicUsize::new(0));
        let r2 = refused.clone();
        let parts = Arc::new(parts);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let (parts, refused) = (parts.clone(), r2.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let idx: usize = path.rsplit('/').next().and_then(|s| s.split('?').next()).and_then(|s| s.parse().ok()).unwrap_or(999);
                    let reply = if idx >= expire_from && refused.load(Ordering::SeqCst) < expire {
                        refused.fetch_add(1, Ordering::SeqCst);
                        b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                    } else if let Some(body) = parts.get(idx) {
                        let mut r = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                        r.extend_from_slice(body);
                        r
                    } else {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                    };
                    let _ = sock.write_all(&reply).await;
                });
            }
        });
        (format!("http://{addr}/storage/v1/object/sign"), refused)
    }

    fn sha(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    fn claim(dir: &std::path::Path) -> Claim {
        Claim { id: "x".into(), dir: std::fs::canonicalize(dir).unwrap(), name: "out.mp4".into() }
    }

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[tokio::test]
    async fn parts_are_saved_in_order_and_checked() {
        let parts = vec![b"hello ".to_vec(), b"world".to_vec()];
        let (base, _) = storage(parts.clone(), usize::MAX, 0).await;
        let dir = tempfile::tempdir().unwrap();
        let src = Source {
            parts: vec![p(&format!("{base}/0"), 6), p(&format!("{base}/1"), 5)],
            first: 0,
            bytes: 11,
            sha256: Some(sha(b"hello world")),
            relink: None,
        };
        let name = save(&claim(dir.path()), src, &AtomicBool::new(false), |_| {}, |_, _| {}).await.unwrap();
        assert_eq!(name, "out.mp4");
        assert_eq!(std::fs::read(dir.path().join("out.mp4")).unwrap(), b"hello world");
        assert_eq!(names(dir.path()), ["out.mp4"]);
    }

    #[tokio::test]
    async fn a_wrong_hash_or_size_leaves_nothing() {
        let parts = vec![b"hello ".to_vec(), b"world".to_vec()];
        let (base, _) = storage(parts, usize::MAX, 0).await;
        let dir = tempfile::tempdir().unwrap();
        let src = Source {
            parts: vec![p(&format!("{base}/0"), 6), p(&format!("{base}/1"), 5)],
            first: 0,
            bytes: 11,
            sha256: Some("00".repeat(32)),
            relink: None,
        };
        assert!(save(&claim(dir.path()), src, &AtomicBool::new(false), |_| {}, |_, _| {}).await.unwrap_err().starts_with("checksum"));
        let src = Source { parts: vec![p(&format!("{base}/0"), 5)], first: 0, bytes: 5, sha256: None, relink: None };
        assert!(save(&claim(dir.path()), src, &AtomicBool::new(false), |_| {}, |_, _| {}).await.unwrap_err().starts_with("download"));
        assert!(names(dir.path()).is_empty(), "{:?}", names(dir.path()));
    }

    #[tokio::test]
    async fn expired_links_without_a_route_say_so() {
        let parts = vec![b"ab".to_vec(), b"cd".to_vec()];
        let (base, _) = storage(parts, 1, 1).await;
        let dir = tempfile::tempdir().unwrap();
        let src = Source { parts: vec![p(&format!("{base}/0"), 2), p(&format!("{base}/1"), 2)], first: 0, bytes: 4, sha256: None, relink: None };
        let err = save(&claim(dir.path()), src, &AtomicBool::new(false), |_| {}, |_, _| {}).await.unwrap_err();
        assert!(err.starts_with("links-expired") && err.contains("part 1"), "{err}");
        assert!(names(dir.path()).is_empty());
    }

    /// The parts route stand-in: answers from `from` with links to `base`.
    async fn route(base: String, sizes: Vec<u64>, asked: Arc<AtomicUsize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let (base, sizes, asked) = (base.clone(), sizes.clone(), asked.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    assert!(head.to_ascii_lowercase().contains("authorization: bearer person-token"), "{head}");
                    assert!(head.to_ascii_lowercase().contains("x-workspace-id: w-1"), "{head}");
                    asked.fetch_add(1, Ordering::SeqCst);
                    let from: u64 = head.split("from=").nth(1).and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse().ok()).unwrap_or(0);
                    let parts: Vec<serde_json::Value> = (from..sizes.len() as u64)
                        .map(|i| serde_json::json!({ "index": i, "url": format!("{base}/{i}"), "bytes": sizes[i as usize] }))
                        .collect();
                    let body = serde_json::json!({ "name": "x.mp4", "bytes": sizes.iter().sum::<u64>(), "from": from, "expiresAt": "x", "parts": parts }).to_string();
                    let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = sock.write_all(reply.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn the_app_asks_for_new_links_and_carries_on() {
        let parts = vec![b"one-".to_vec(), b"two-".to_vec(), b"three".to_vec()];
        // Part 1's first two tries are refused: its link ran out.
        let (base, refused) = storage(parts, 1, 1).await;
        let asked = Arc::new(AtomicUsize::new(0));
        let origin = route(base, vec![4, 4, 5], asked.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let src = Source {
            parts: Vec::new(),
            first: 0,
            bytes: 0,
            sha256: None,
            relink: Some(Relink {
                origin,
                workspace_id: "w-1".into(),
                video_id: "v".into(),
                job_id: "j".into(),
                token: Arc::new(|| Some("person-token".to_string())),
            }),
        };
        save(&claim(dir.path()), src, &AtomicBool::new(false), |_| {}, |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(dir.path().join("out.mp4")).unwrap(), b"one-two-three");
        assert_eq!(refused.load(Ordering::SeqCst), 1);
        assert_eq!(asked.load(Ordering::SeqCst), 2, "once for the links, once again from part 1");
    }

    #[tokio::test]
    async fn a_stopped_save_leaves_nothing() {
        let parts = vec![b"hello ".to_vec(), b"world".to_vec()];
        let (base, _) = storage(parts, usize::MAX, 0).await;
        let dir = tempfile::tempdir().unwrap();
        let src = Source { parts: vec![p(&format!("{base}/0"), 6), p(&format!("{base}/1"), 5)], first: 0, bytes: 11, sha256: None, relink: None };
        let seen = std::sync::Mutex::new(None);
        let err = save(&claim(dir.path()), src, &AtomicBool::new(true), |t| *seen.lock().unwrap() = Some(t.to_path_buf()), |_, _| {})
            .await
            .unwrap_err();
        assert!(err.starts_with("cancelled:"), "{err}");
        assert!(seen.lock().unwrap().is_some(), "the temp file was named for a quit to find");
        assert!(names(dir.path()).is_empty());
    }

    /// A signed link's token never reaches the sentence the page shows.
    #[tokio::test]
    async fn an_http_error_does_not_carry_the_link() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing listens on port 9.
        let url = "http://127.0.0.1:9/storage/v1/object/sign/studio/w/k/0?token=SECRET-TOKEN";
        let src = Source { parts: vec![p(url, 4)], first: 0, bytes: 4, sha256: None, relink: None };
        let err = save(&claim(dir.path()), src, &AtomicBool::new(false), |_| {}, |_, _| {}).await.unwrap_err();
        assert!(err.starts_with("download:"), "{err}");
        assert!(!err.contains("SECRET-TOKEN") && !err.contains("127.0.0.1"), "{err}");
    }
}
