//! The exit node: this Mac's end of the tunnel (dial8-website
//! docs/plans/cloud-browser.md, C4). An outbound WebSocket to the person's own
//! cloud browser hub (nothing listens on the Mac); the hub asks for streams,
//! and each one this Mac allows ([`crate::policy`]) becomes a TCP connection
//! from here.
//!
//! Handshake (text): this Mac sends `{"v":1,"token":"…"}`; the hub answers
//! `{"ok":true,"v":1,"ip":"<this Mac's public IP as it sees it>"}`, or closes
//! with 4401 (token refused), 4400 (version) or 4409 (another tunnel took its
//! place). Then binary frames ([`crate::mux`]).
//!
//! The hub pings every 5 s. With 20 s of silence this Mac drops the tunnel and
//! connects again (a sleep or a network change); the hub drops it after 15 s
//! and refuses the browser's streams meanwhile, so the browser never falls
//! back to the cloud's own address.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::mux::{Frame, Refusal, MAX_DATA, MAX_STREAMS, VERSION, WINDOW};
use crate::policy::{check_port, Blocklist};
use crate::ticket::Claims;

/// Silence after which this Mac gives the tunnel up and connects again.
const SILENCE: Duration = Duration::from_secs(20);
/// Connecting: TCP, TLS, the WebSocket upgrade and the hub's hello, together.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A stream's DNS lookup and connect, together.
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest wait between reconnects.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// One read from a site, at most.
const READ_CHUNK: u32 = 16 * 1024;

pub const CLOSE_UNAUTHORIZED: u16 = 4401;
pub const CLOSE_VERSION: u16 = 4400;
pub const CLOSE_REPLACED: u16 = 4409;

pub struct Options {
    /// `wss://<hub>/exit`, already checked against the token ([`crate::ticket::verify`]).
    pub url: String,
    pub token: String,
    pub claims: Claims,
    /// This Mac's public IPs as the app's own server saw them: refused as
    /// destinations (a router answers there), whatever the hub says.
    pub public_ips: Vec<IpAddr>,
    /// Silence after which the tunnel is given up ([`SILENCE`]).
    pub silence: Duration,
}

impl Options {
    pub fn new(url: String, token: String, claims: Claims, public_ips: Vec<IpAddr>) -> Self {
        Options { url, token, claims, public_ips, silence: SILENCE }
    }
}

/// What the app shows and logs. Hosts are names as the browser asked for
/// them, for the person's "sites today" list; never paths or contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Connecting,
    Up { public_ip: Option<IpAddr> },
    /// Lost; connecting again.
    Down { reason: String },
    Opened { host: String },
    Refused { host: String, reason: Refusal },
    /// Over for good: a fresh token (or the person) starts it again.
    Ended { reason: EndReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    Stopped,
    Unauthorized,
    Replaced,
    Expired,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Keep the tunnel up until `stop` turns true, the token expires, or the hub
/// refuses it; connect again (with backoff) whenever it drops.
pub async fn run(options: Options, events: mpsc::UnboundedSender<Event>, mut stop: watch::Receiver<bool>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        if *stop.borrow() {
            let _ = events.send(Event::Ended { reason: EndReason::Stopped });
            return;
        }
        if options.claims.exp <= now_ms() {
            let _ = events.send(Event::Ended { reason: EndReason::Expired });
            return;
        }
        let _ = events.send(Event::Connecting);
        let (end, was_up) = session(&options, &events, &mut stop).await;
        match end {
            SessionEnd::Stopped => {
                let _ = events.send(Event::Ended { reason: EndReason::Stopped });
                return;
            }
            SessionEnd::Closed(CLOSE_UNAUTHORIZED) => {
                let _ = events.send(Event::Ended { reason: EndReason::Unauthorized });
                return;
            }
            SessionEnd::Closed(CLOSE_REPLACED) => {
                let _ = events.send(Event::Ended { reason: EndReason::Replaced });
                return;
            }
            SessionEnd::Closed(code) => {
                let _ = events.send(Event::Down { reason: format!("closed ({code})") });
            }
            SessionEnd::Lost(reason) => {
                let _ = events.send(Event::Down { reason });
            }
        }
        if was_up {
            backoff = Duration::from_secs(1);
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = stop.changed() => {}
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

#[derive(Debug)]
enum SessionEnd {
    Stopped,
    Closed(u16),
    Lost(String),
}

/// One connection to the hub, until it ends. The bool: whether it got up.
async fn session(options: &Options, events: &mpsc::UnboundedSender<Event>, stop: &mut watch::Receiver<bool>) -> (SessionEnd, bool) {
    let url = match url::Url::parse(&options.url) {
        Ok(url) => url,
        Err(_) => return (SessionEnd::Lost("bad url".into()), false),
    };
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let connect = async {
        let tcp = TcpStream::connect((host.as_str(), port)).await.map_err(|e| e.to_string())?;
        tcp.set_nodelay(true).ok();
        if url.scheme() == "wss" {
            let tls = tls_connector().connect(server_name(&host)?, tcp).await.map_err(|e| e.to_string())?;
            let (ws, _) = tokio_tungstenite::client_async(options.url.as_str(), tls).await.map_err(|e| e.to_string())?;
            Ok::<_, String>(Either::Tls(ws))
        } else {
            let (ws, _) = tokio_tungstenite::client_async(options.url.as_str(), tcp).await.map_err(|e| e.to_string())?;
            Ok(Either::Plain(ws))
        }
    };
    let ws = tokio::select! {
        result = tokio::time::timeout(CONNECT_TIMEOUT, connect) => match result {
            Ok(Ok(ws)) => ws,
            Ok(Err(reason)) => return (SessionEnd::Lost(reason), false),
            Err(_) => return (SessionEnd::Lost("connect timed out".into()), false),
        },
        _ = stop.changed() => return (SessionEnd::Stopped, false),
    };
    match ws {
        Either::Tls(ws) => tunnel(ws, options, events, stop).await,
        Either::Plain(ws) => tunnel(ws, options, events, stop).await,
    }
}

enum Either<A, B> {
    Tls(A),
    Plain(B),
}

fn server_name(host: &str) -> Result<rustls::pki_types::ServerName<'static>, String> {
    rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|e| e.to_string())
}

fn tls_connector() -> tokio_rustls::TlsConnector {
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

/// What the streams hand the tunnel to send.
enum Out {
    Frame(Frame),
    /// The stream is over: forget it.
    Done(u32),
}

/// What the tunnel hands a stream.
enum Inbound {
    Data(Vec<u8>),
    Fin,
}

struct StreamEntry {
    to_socket: mpsc::UnboundedSender<Inbound>,
    window: Arc<Window>,
    /// DATA received and not yet credited back: the hub may never go past WINDOW.
    unacked: u32,
    task: JoinHandle<()>,
}

async fn tunnel<S>(mut ws: WebSocketStream<S>, options: &Options, events: &mpsc::UnboundedSender<Event>,
    stop: &mut watch::Receiver<bool>) -> (SessionEnd, bool)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Hello, and the hub's answer.
    let hello = serde_json::json!({ "v": VERSION, "token": options.token }).to_string();
    if let Err(e) = ws.send(Message::text(hello)).await {
        return (SessionEnd::Lost(e.to_string()), false);
    }
    let public_ip = match tokio::time::timeout(CONNECT_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            let answer: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
            if answer["ok"] != true || answer["v"] != VERSION {
                return (SessionEnd::Lost("unexpected hello".into()), false);
            }
            answer["ip"].as_str().and_then(|ip| ip.parse::<IpAddr>().ok())
        }
        Ok(Some(Ok(Message::Close(frame)))) => return (SessionEnd::Closed(close_code(frame.as_ref().map(|f| f.code))), false),
        Ok(Some(Ok(_))) => return (SessionEnd::Lost("unexpected hello".into()), false),
        Ok(Some(Err(e))) => return (SessionEnd::Lost(e.to_string()), false),
        Ok(None) => return (SessionEnd::Lost("closed before hello".into()), false),
        Err(_) => return (SessionEnd::Lost("no hello".into()), false),
    };
    let mut blocklist = Blocklist::of_this_mac();
    for ip in options.public_ips.iter().copied().chain(public_ip) {
        blocklist.add_public(ip);
    }
    let blocklist = Arc::new(blocklist);
    let _ = events.send(Event::Up { public_ip });

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
    let mut streams: HashMap<u32, StreamEntry> = HashMap::new();
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));

    let end = loop {
        tokio::select! {
            message = ws.next() => {
                last_seen = Instant::now();
                let message = match message {
                    Some(Ok(message)) => message,
                    Some(Err(e)) => break SessionEnd::Lost(e.to_string()),
                    None => break SessionEnd::Lost("closed".into()),
                };
                let raw = match message {
                    Message::Binary(raw) => raw,
                    Message::Close(frame) => break SessionEnd::Closed(close_code(frame.as_ref().map(|f| f.code))),
                    _ => continue,
                };
                let Some(frame) = Frame::decode(&raw) else { break SessionEnd::Lost("malformed frame".into()) };
                match frame {
                    Frame::Open { stream, host, port } => {
                        if stream == 0 || streams.contains_key(&stream) {
                            break SessionEnd::Lost("bad stream id".into());
                        }
                        if streams.len() >= MAX_STREAMS {
                            let _ = out_tx.send(Out::Frame(Frame::Refused { stream, reason: Refusal::Busy }));
                            continue;
                        }
                        let (to_socket, inbound) = mpsc::unbounded_channel();
                        let window = Arc::new(Window::new(WINDOW));
                        let task = tokio::spawn(run_stream(stream, host, port, blocklist.clone(), out_tx.clone(), inbound,
                            window.clone(), events.clone()));
                        streams.insert(stream, StreamEntry { to_socket, window, unacked: 0, task });
                    }
                    Frame::Data { stream, bytes } => match streams.get_mut(&stream) {
                        Some(entry) => {
                            entry.unacked = entry.unacked.saturating_add(bytes.len() as u32);
                            if entry.unacked > WINDOW {
                                // The hub went past its window: this stream is gone.
                                if let Some(entry) = streams.remove(&stream) { entry.task.abort(); }
                                let _ = out_tx.send(Out::Frame(Frame::Reset { stream }));
                            } else {
                                let _ = entry.to_socket.send(Inbound::Data(bytes));
                            }
                        }
                        None => { let _ = out_tx.send(Out::Frame(Frame::Reset { stream })); }
                    },
                    Frame::Credit { stream, bytes } => {
                        if let Some(entry) = streams.get(&stream) { entry.window.give(bytes); }
                    }
                    Frame::Fin { stream } => {
                        if let Some(entry) = streams.get(&stream) { let _ = entry.to_socket.send(Inbound::Fin); }
                    }
                    Frame::Reset { stream } => {
                        if let Some(entry) = streams.remove(&stream) { entry.task.abort(); }
                    }
                    Frame::Ping { nonce } => { let _ = out_tx.send(Out::Frame(Frame::Pong { nonce })); }
                    Frame::Pong { .. } | Frame::Opened { .. } | Frame::Refused { .. } => {}
                }
            }
            out = out_rx.recv() => {
                let Some(out) = out else { continue };
                let frame = match out {
                    Out::Done(stream) => { streams.remove(&stream); continue; }
                    Out::Frame(frame) => frame,
                };
                if let Frame::Credit { stream, bytes } = &frame {
                    if let Some(entry) = streams.get_mut(stream) { entry.unacked = entry.unacked.saturating_sub(*bytes); }
                }
                if let Err(e) = ws.send(Message::binary(frame.encode())).await {
                    break SessionEnd::Lost(e.to_string());
                }
            }
            _ = tick.tick() => {
                if last_seen.elapsed() > options.silence {
                    break SessionEnd::Lost("the hub went silent".into());
                }
            }
            _ = stop.changed() => {
                let _ = ws.close(None).await;
                break SessionEnd::Stopped;
            }
        }
    };
    for (_, entry) in streams.drain() {
        entry.task.abort();
    }
    (end, true)
}

fn close_code(code: Option<CloseCode>) -> u16 {
    code.map(u16::from).unwrap_or(1005)
}

/// A stream's send window: bytes this Mac may still send the hub.
struct Window {
    available: Mutex<u32>,
    more: Notify,
}

impl Window {
    fn new(bytes: u32) -> Self {
        Window { available: Mutex::new(bytes), more: Notify::new() }
    }

    /// Up to `max` bytes of window, waiting until there is some.
    async fn take(&self, max: u32) -> u32 {
        loop {
            {
                let mut available = self.available.lock().unwrap();
                if *available > 0 {
                    let n = (*available).min(max);
                    *available -= n;
                    return n;
                }
            }
            self.more.notified().await;
        }
    }

    fn give(&self, bytes: u32) {
        let mut available = self.available.lock().unwrap();
        // Never more than a window, whatever the hub says.
        *available = available.saturating_add(bytes).min(WINDOW);
        self.more.notify_one();
    }
}

/// Resolve here, check every address, connect to a checked one. Never resolves again.
async fn connect_checked(host: &str, port: u16, blocklist: &Blocklist) -> Result<TcpStream, Refusal> {
    // This Mac's networks as they are now, not as they were when the tunnel came up.
    let blocklist = &blocklist.refreshed();
    #[cfg(test)]
    let loose = tests::LOOSE_POLICY.load(std::sync::atomic::Ordering::SeqCst);
    #[cfg(not(test))]
    let loose = false;
    if !loose {
        check_port(port)?;
    }
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await.map_err(|_| Refusal::Dns)?.collect();
    if addresses.is_empty() {
        return Err(Refusal::Dns);
    }
    // Any refused address refuses the name: a site that resolves to a private
    // address too is one this Mac's network shouldn't be asked about.
    if !loose && addresses.iter().any(|address| blocklist.check_ip(address.ip()).is_err()) {
        return Err(Refusal::Blocked);
    }
    for address in &addresses {
        if let Ok(socket) = TcpStream::connect(address).await {
            socket.set_nodelay(true).ok();
            return Ok(socket);
        }
    }
    Err(Refusal::Connect)
}

#[allow(clippy::too_many_arguments)]
async fn run_stream(stream: u32, host: String, port: u16, blocklist: Arc<Blocklist>, out: mpsc::UnboundedSender<Out>,
    mut inbound: mpsc::UnboundedReceiver<Inbound>, window: Arc<Window>, events: mpsc::UnboundedSender<Event>) {
    let socket = match tokio::time::timeout(STREAM_CONNECT_TIMEOUT, connect_checked(&host, port, &blocklist)).await {
        Ok(Ok(socket)) => socket,
        failed => {
            let reason = match failed { Ok(Err(reason)) => reason, _ => Refusal::Connect };
            let _ = events.send(Event::Refused { host, reason });
            let _ = out.send(Out::Frame(Frame::Refused { stream, reason }));
            let _ = out.send(Out::Done(stream));
            return;
        }
    };
    let _ = events.send(Event::Opened { host });
    let _ = out.send(Out::Frame(Frame::Opened { stream }));
    let (mut rd, mut wr) = socket.into_split();

    // Site → hub, within the window the hub keeps open.
    let reader = {
        let out = out.clone();
        async move {
            let mut buf = vec![0u8; READ_CHUNK as usize];
            loop {
                let allowed = window.take(READ_CHUNK).await;
                let n = match rd.read(&mut buf[..allowed as usize]).await {
                    Ok(n) => n,
                    Err(_) => return false,
                };
                if (n as u32) < allowed {
                    window.give(allowed - n as u32);
                }
                if n == 0 {
                    let _ = out.send(Out::Frame(Frame::Fin { stream }));
                    return true;
                }
                for chunk in buf[..n].chunks(MAX_DATA) {
                    let _ = out.send(Out::Frame(Frame::Data { stream, bytes: chunk.to_vec() }));
                }
            }
        }
    };
    // Hub → site, crediting what the site took.
    let writer = {
        let out = out.clone();
        async move {
            while let Some(message) = inbound.recv().await {
                match message {
                    Inbound::Data(bytes) => {
                        if wr.write_all(&bytes).await.is_err() {
                            return false;
                        }
                        let _ = out.send(Out::Frame(Frame::Credit { stream, bytes: bytes.len() as u32 }));
                    }
                    Inbound::Fin => {
                        let _ = wr.shutdown().await;
                        return true;
                    }
                }
            }
            // The tunnel is gone.
            false
        }
    };
    tokio::pin!(reader);
    tokio::pin!(writer);
    let (mut read_done, mut write_done) = (false, false);
    while !(read_done && write_done) {
        tokio::select! {
            ok = &mut reader, if !read_done => {
                read_done = true;
                if !ok { let _ = out.send(Out::Frame(Frame::Reset { stream })); break; }
            }
            ok = &mut writer, if !write_done => {
                write_done = true;
                if !ok { let _ = out.send(Out::Frame(Frame::Reset { stream })); break; }
            }
        }
    }
    let _ = out.send(Out::Done(stream));
}

#[cfg(test)]
mod tests;
