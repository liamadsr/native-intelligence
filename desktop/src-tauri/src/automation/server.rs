//! The bridge's HTTP side: HTTP/1.1 with keep-alive (hyper), on the app's
//! tokio runtime, bound to 127.0.0.1 by the caller (mod.rs).
//!
//! Every request passes [`gate`] before anything else:
//!   - an `Origin` header → 403 (a browser page; no CORS header is ever sent);
//!   - no `Authorization: Bearer <token>`, or the wrong token → 401 (compared
//!     in constant time, as SHA-256 digests so the length doesn't leak).
//!
//! Then the two routes (protocol version 1):
//!
//!   GET  /health → { ok, bridge, app, version, url, webviewFrame, pageZoom, magnification }
//!   POST /eval   { script, args?, timeoutMs? }
//!                → { ok: true, value } | { ok: false, error, stack? }
//!
//! A body over [`MAX_BODY_BYTES`] → 413, whether its Content-Length says so up
//! front or a chunked body runs past it. A script that takes longer than its
//! timeout answers `{ ok: false, error: "timeout" }` (it may keep running in
//! the page). Malformed requests → 400, unknown paths → 404, a wrong method →
//! 405, all with an `{ ok: false, error }` body.
//!
//! The page itself is reached through a [`Backend`] (webview.rs on macOS), so
//! all of this is tested without a web view.

use std::convert::Infallible;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::Incoming;
use hyper::header::{
    HeaderMap, HeaderValue, ALLOW, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN,
    WWW_AUTHENTICATE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::PROTOCOL_VERSION;
use crate::log_to_file;

/// The largest request body accepted: 1 MB.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// `/eval`'s `timeoutMs` when the request has none, and its ceiling.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const MAX_TIMEOUT_MS: u64 = 60_000;

/// One `/eval`, checked: `args` names are JavaScript identifiers.
#[derive(Debug, PartialEq)]
pub struct EvalRequest {
    pub script: String,
    pub args: Map<String, Value>,
    pub timeout: Duration,
}

/// The page the bridge drives.
pub trait Backend: Send + Sync + 'static {
    /// `/health`'s fields about the app and its main web view: `app`,
    /// `version`, `url`, `webviewFrame`, `pageZoom`, `magnification`.
    fn health(&self) -> impl Future<Output = Result<Map<String, Value>, String>> + Send;
    /// Run the script: the response body, `{ ok: true, value }` or
    /// `{ ok: false, error, stack? }`. The server times it out.
    fn eval(&self, request: EvalRequest) -> impl Future<Output = Value> + Send;
}

pub struct Server<B> {
    token_digest: [u8; 32],
    backend: B,
}

impl<B: Backend> Server<B> {
    pub fn new(token: &str, backend: B) -> Self {
        Self { token_digest: Sha256::digest(token.as_bytes()).into(), backend }
    }

    async fn handle(&self, req: Request<Incoming>) -> Response<Full<Bytes>> {
        if let Err(status) = gate(req.headers(), &self.token_digest) {
            return error(status, if status == StatusCode::FORBIDDEN { "forbidden" } else { "unauthorized" });
        }
        let path = req.uri().path().to_string();
        match (req.method(), path.as_str()) {
            (&Method::GET, "/health") => match self.backend.health().await {
                Ok(fields) => {
                    let mut body = Map::new();
                    body.insert("ok".into(), Value::Bool(true));
                    body.insert("bridge".into(), json!(PROTOCOL_VERSION));
                    body.extend(fields);
                    respond(StatusCode::OK, &Value::Object(body))
                }
                Err(why) => error(StatusCode::SERVICE_UNAVAILABLE, &why),
            },
            (&Method::POST, "/eval") => {
                let body = match read_body(req).await {
                    Ok(body) => body,
                    Err(status) => {
                        let why = if status == StatusCode::PAYLOAD_TOO_LARGE { "body over 1 MB" } else { "unreadable body" };
                        return error(status, why);
                    }
                };
                let request = match parse_eval(&body) {
                    Ok(request) => request,
                    Err(why) => return error(StatusCode::BAD_REQUEST, &why),
                };
                let timeout = request.timeout;
                let outcome = match tokio::time::timeout(timeout, self.backend.eval(request)).await {
                    Ok(outcome) => outcome,
                    Err(_) => json!({ "ok": false, "error": "timeout" }),
                };
                respond(StatusCode::OK, &outcome)
            }
            (_, "/health") => method_not_allowed("GET"),
            (_, "/eval") => method_not_allowed("POST"),
            _ => error(StatusCode::NOT_FOUND, "not found"),
        }
    }
}

/// Accept connections until the process ends. Each connection is HTTP/1.1
/// with keep-alive, served on a task of its own.
pub async fn serve<B: Backend>(listener: tokio::net::TcpListener, server: Arc<Server<B>>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                // Out of file descriptors and the like: back off, don't spin.
                log_to_file(&format!("[automation] accept failed: {e}"));
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        // Small requests and replies, one after another on one connection:
        // without this, Nagle plus delayed ACKs adds ~40 ms to some calls.
        let _ = stream.set_nodelay(true);
        let server = Arc::clone(&server);
        tokio::spawn(async move {
            let service = service_fn(move |req| {
                let server = Arc::clone(&server);
                async move { Ok::<_, Infallible>(server.handle(req).await) }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
    }
}

/// Origin first (a browser page is refused whatever it sends), then the token.
fn gate(headers: &HeaderMap, token_digest: &[u8; 32]) -> Result<(), StatusCode> {
    if headers.contains_key(ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    if !token_matches(headers.get(AUTHORIZATION), token_digest) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

/// `Bearer <token>` (the scheme in any case) whose token is the expected one.
fn token_matches(header: Option<&HeaderValue>, expected_digest: &[u8; 32]) -> bool {
    let Some(value) = header.map(HeaderValue::as_bytes) else {
        return false;
    };
    const SCHEME: &[u8] = b"bearer ";
    if value.len() <= SCHEME.len() || !value[..SCHEME.len()].eq_ignore_ascii_case(SCHEME) {
        return false;
    }
    let given: [u8; 32] = Sha256::digest(&value[SCHEME.len()..]).into();
    constant_time_eq(&given, expected_digest)
}

/// Every byte compared, whatever the first difference.
fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let diff = a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// The body, at most [`MAX_BODY_BYTES`]: refused on its Content-Length before
/// reading, or as soon as a body without one runs past it.
async fn read_body(req: Request<Incoming>) -> Result<Bytes, StatusCode> {
    let declared = req
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if declared.is_some_and(|len| len > MAX_BODY_BYTES as u64) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    match Limited::new(req.into_body(), MAX_BODY_BYTES).collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(e) if e.downcast_ref::<LengthLimitError>().is_some() => Err(StatusCode::PAYLOAD_TOO_LARGE),
        Err(_) => Err(StatusCode::BAD_REQUEST),
    }
}

fn parse_eval(body: &[u8]) -> Result<EvalRequest, String> {
    let value: Value = serde_json::from_slice(body).map_err(|e| format!("body is not JSON: {e}"))?;
    let Value::Object(mut fields) = value else {
        return Err("body must be a JSON object".into());
    };
    let script = match fields.remove("script") {
        Some(Value::String(script)) => script,
        _ => return Err("`script` must be a string".into()),
    };
    let args = match fields.remove("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(args)) => args,
        Some(_) => return Err("`args` must be a JSON object".into()),
    };
    if let Some(name) = args.keys().find(|name| !is_arg_name(name)) {
        return Err(format!("`args` key {name:?} is not a JavaScript identifier"));
    }
    let timeout_ms = match fields.remove("timeoutMs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        Some(v) => match v.as_f64() {
            Some(ms) if ms.is_finite() && ms >= 1.0 => (ms as u64).min(MAX_TIMEOUT_MS),
            _ => return Err("`timeoutMs` must be a number of milliseconds, at least 1".into()),
        },
    };
    Ok(EvalRequest { script, args, timeout: Duration::from_millis(timeout_ms) })
}

/// A name `args` can bind in the script: an ASCII JavaScript identifier, and
/// not one of the wrapper's own (`__ni…`, webview.rs).
fn is_arg_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !name.starts_with("__ni_")
}

fn respond(status: StatusCode, body: &Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn error(status: StatusCode, why: &str) -> Response<Full<Bytes>> {
    let mut response = respond(status, &json!({ "ok": false, "error": why }));
    if status == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    }
    response
}

fn method_not_allowed(allow: &'static str) -> Response<Full<Bytes>> {
    let mut response = error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    response.headers_mut().insert(ALLOW, HeaderValue::from_static(allow));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    const TOKEN: &str = "test-token-0123456789abcdef-0123456789";

    /// A page that answers /health with fixed numbers, echoes /eval, and
    /// takes its time when the script says `sleep`.
    struct FakePage;

    impl Backend for FakePage {
        async fn health(&self) -> Result<Map<String, Value>, String> {
            let Value::Object(fields) = json!({
                "app": "ai.dial8.desktop",
                "version": "0.0.0",
                "url": "http://localhost:3000/",
                "webviewFrame": { "x": 0, "y": 0, "width": 1560, "height": 920 },
                "pageZoom": 1,
                "magnification": 1,
            }) else {
                unreachable!()
            };
            Ok(fields)
        }

        async fn eval(&self, request: EvalRequest) -> Value {
            if request.script == "sleep" {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            json!({ "ok": true, "value": { "script": request.script, "args": request.args } })
        }
    }

    async fn start() -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(serve(listener, Arc::new(Server::new(TOKEN, FakePage))));
        addr
    }

    struct Reply {
        status: u16,
        head: String,
        body: Value,
    }

    /// Read one response off the connection (Content-Length bodies only, which
    /// is all this server sends).
    async fn read_reply<R: AsyncRead + Unpin>(stream: &mut R) -> Reply {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            let n = stream.read(&mut chunk).await.expect("read");
            assert!(n > 0, "connection closed before a reply");
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).expect("status");
        let length: usize = head
            .lines()
            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
            .expect("content-length");
        while buf.len() < head_end + length {
            let n = stream.read(&mut chunk).await.expect("read");
            assert!(n > 0, "connection closed mid-body");
            buf.extend_from_slice(&chunk[..n]);
        }
        let body = serde_json::from_slice(&buf[head_end..head_end + length]).expect("JSON body");
        Reply { status, head: head.to_ascii_lowercase(), body }
    }

    fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Vec<u8> {
        let mut out = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        if !body.is_empty() || method == "POST" {
            out.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
        }
        out.push_str("\r\n");
        out.push_str(body);
        out.into_bytes()
    }

    async fn send(addr: SocketAddr, raw: Vec<u8>) -> Reply {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(&raw).await.expect("write");
        read_reply(&mut stream).await
    }

    fn bearer() -> String {
        format!("Bearer {TOKEN}")
    }

    // ── Token checking ──────────────────────────────────────────────────────

    #[test]
    fn token_check_accepts_only_the_token() {
        let digest: [u8; 32] = Sha256::digest(TOKEN.as_bytes()).into();
        let check = |v: &str| token_matches(Some(&HeaderValue::from_str(v).unwrap()), &digest);
        assert!(check(&format!("Bearer {TOKEN}")));
        assert!(check(&format!("bearer {TOKEN}")), "the scheme is case-insensitive");
        assert!(!check(&format!("Bearer {TOKEN}x")), "longer");
        assert!(!check(&format!("Bearer {}", &TOKEN[1..])), "shorter");
        assert!(!check(&format!("Bearer {}", TOKEN.replace('0', "1"))), "same length, different");
        assert!(!check(&format!("Basic {TOKEN}")), "another scheme");
        assert!(!check(TOKEN), "no scheme");
        assert!(!check("Bearer "), "no token");
        assert!(!token_matches(None, &digest), "no header");
    }

    #[tokio::test]
    async fn requests_without_the_token_are_refused() {
        let addr = start().await;
        let none = send(addr, request("GET", "/health", &[], "")).await;
        assert_eq!(none.status, 401);
        assert!(none.head.contains("www-authenticate: bearer"));
        assert_eq!(none.body, json!({ "ok": false, "error": "unauthorized" }));

        let wrong = send(addr, request("POST", "/eval", &[("Authorization", "Bearer nope-nope-nope-nope-nope-nope-nope")], r#"{"script":"return 1"}"#)).await;
        assert_eq!(wrong.status, 401);

        let ok = send(addr, request("GET", "/health", &[("Authorization", &bearer())], "")).await;
        assert_eq!(ok.status, 200);
        assert_eq!(ok.body["ok"], json!(true));
        assert_eq!(ok.body["bridge"], json!(1));
        assert_eq!(ok.body["app"], json!("ai.dial8.desktop"));
        assert_eq!(ok.body["webviewFrame"]["width"], json!(1560));
    }

    // ── Origin rejection ────────────────────────────────────────────────────

    #[tokio::test]
    async fn any_origin_is_refused_even_with_the_token() {
        let addr = start().await;
        for origin in ["http://localhost:3000", "https://dial8.ai", "null"] {
            let reply = send(addr, request("GET", "/health", &[("Authorization", &bearer()), ("Origin", origin)], "")).await;
            assert_eq!(reply.status, 403, "Origin {origin}");
            assert_eq!(reply.body, json!({ "ok": false, "error": "forbidden" }));
            assert!(!reply.head.contains("access-control-"), "no CORS header, ever");
        }
        // Without the token as well: a page learns nothing from the difference.
        let reply = send(addr, request("POST", "/eval", &[("Origin", "https://evil.example")], r#"{"script":"return 1"}"#)).await;
        assert_eq!(reply.status, 403);
        // And no CORS header on a normal reply either.
        let reply = send(addr, request("GET", "/health", &[("Authorization", &bearer())], "")).await;
        assert!(!reply.head.contains("access-control-"));
    }

    // ── Body limit ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn bodies_over_one_megabyte_are_refused() {
        let addr = start().await;
        let auth = bearer();

        // Declared too big: refused before a byte of it is read.
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let head = format!(
            "POST /eval HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        let reply = read_reply(&mut stream).await;
        assert_eq!(reply.status, 413);
        assert_eq!(reply.body["ok"], json!(false));

        // Chunked, no length up front: refused once it runs past the limit.
        // Not on Windows (the bridge never runs there): a server that closes
        // with unread bytes sends a reset, which drops the reply before the
        // client reads it.
        if cfg!(windows) {
            return;
        }
        let stream = TcpStream::connect(addr).await.unwrap();
        let (mut reader, mut writer) = stream.into_split();
        let head = format!(
            "POST /eval HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
        );
        writer.write_all(head.as_bytes()).await.unwrap();
        let writing = tokio::spawn(async move {
            let chunk = vec![b' '; 64 * 1024];
            for _ in 0..20 {
                let size = format!("{:x}\r\n", chunk.len());
                if writer.write_all(size.as_bytes()).await.is_err()
                    || writer.write_all(&chunk).await.is_err()
                    || writer.write_all(b"\r\n").await.is_err()
                {
                    return; // the server answered and stopped reading
                }
            }
            let _ = writer.write_all(b"0\r\n\r\n").await;
        });
        let reply = read_reply(&mut reader).await;
        assert_eq!(reply.status, 413);
        writing.abort();

        // Exactly 1 MB: read and run.
        let prefix = r#"{"script":"return 1","pad":""#;
        let suffix = r#""}"#;
        let body = format!("{prefix}{}{suffix}", "x".repeat(MAX_BODY_BYTES - prefix.len() - suffix.len()));
        assert_eq!(body.len(), MAX_BODY_BYTES);
        let reply = send(addr, request("POST", "/eval", &[("Authorization", &auth)], &body)).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body["value"]["script"], json!("return 1"));
    }

    // ── /eval ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_slow_script_times_out() {
        let addr = start().await;
        let started = std::time::Instant::now();
        let reply = send(addr, request("POST", "/eval", &[("Authorization", &bearer())], r#"{"script":"sleep","timeoutMs":50}"#)).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, json!({ "ok": false, "error": "timeout" }));
        assert!(started.elapsed() < Duration::from_secs(2), "answered at the timeout, not the script's end");
    }

    /// The recorder polls at ~10 Hz on one connection: requests after the
    /// first reuse it.
    #[tokio::test]
    async fn one_connection_serves_many_requests() {
        let addr = start().await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        for i in 0..20 {
            let body = json!({ "script": "return n", "args": { "n": i } }).to_string();
            stream.write_all(&request("POST", "/eval", &[("Authorization", &bearer())], &body)).await.unwrap();
            let reply = read_reply(&mut stream).await;
            assert_eq!(reply.status, 200);
            assert_eq!(reply.body["value"]["args"]["n"], json!(i));
        }
    }

    #[tokio::test]
    async fn unknown_paths_and_methods() {
        let addr = start().await;
        let auth = bearer();
        assert_eq!(send(addr, request("GET", "/nope", &[("Authorization", &auth)], "")).await.status, 404);
        let reply = send(addr, request("GET", "/eval", &[("Authorization", &auth)], "")).await;
        assert_eq!(reply.status, 405);
        assert!(reply.head.contains("allow: post"));
        assert_eq!(send(addr, request("POST", "/health", &[("Authorization", &auth)], "{}")).await.status, 405);
        assert_eq!(send(addr, request("POST", "/eval", &[("Authorization", &auth)], "not json")).await.status, 400);
    }

    #[test]
    fn eval_requests_are_checked() {
        let ok = parse_eval(br#"{"script":"return sel","args":{"sel":"button","$x":1,"_y":null}}"#).unwrap();
        assert_eq!(ok.script, "return sel");
        assert_eq!(ok.args.len(), 3);
        assert_eq!(ok.timeout, Duration::from_millis(DEFAULT_TIMEOUT_MS));

        assert_eq!(parse_eval(br#"{"script":"","timeoutMs":250}"#).unwrap().timeout, Duration::from_millis(250));
        assert_eq!(
            parse_eval(br#"{"script":"","timeoutMs":600000}"#).unwrap().timeout,
            Duration::from_millis(MAX_TIMEOUT_MS),
            "capped at the max"
        );
        assert!(parse_eval(br#"{"script":"","args":null}"#).unwrap().args.is_empty());

        for bad in [
            &br#"[]"#[..],
            br#"{}"#,
            br#"{"script":1}"#,
            br#"{"script":"","args":[1]}"#,
            br#"{"script":"","args":{"a-b":1}}"#,
            br#"{"script":"","args":{"1a":1}}"#,
            br#"{"script":"","args":{"":1}}"#,
            br#"{"script":"","args":{"__ni_value":1}}"#,
            br#"{"script":"","timeoutMs":0}"#,
            br#"{"script":"","timeoutMs":"10"}"#,
        ] {
            assert!(parse_eval(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }
}
