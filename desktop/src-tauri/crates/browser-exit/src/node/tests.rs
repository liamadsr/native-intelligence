//! The exit node against a stand-in hub on loopback: the handshake, a stream
//! end to end, the credit window, the policy's refusals, the hub's resets,
//! silence, and the closes that end it for good.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Mutex as AsyncMutex};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::*;

/// Lets streams reach loopback on any port, for the stand-in sites. Off in
/// every test that checks the policy itself.
pub(crate) static LOOSE_POLICY: AtomicBool = AtomicBool::new(false);
/// Tests that flip LOOSE_POLICY run one at a time.
static POLICY_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

fn claims() -> Claims {
    Claims { aud: "browser-exit".into(), user_id: "u1".into(), workspace_id: "w1".into(), sandbox: "browser-a".into(),
        device_id: None, hub: "127.0.0.1".into(), exp: now_ms() + 600_000 }
}

/// A hub that answers the hello, then hands its socket to the test.
async fn hub() -> (String, mpsc::UnboundedReceiver<(String, WebSocketStream<TcpStream>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/exit", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let hello = match ws.next().await { Some(Ok(Message::Text(text))) => text.to_string(), _ => continue };
            let _ = tx.send((hello, ws));
        }
    });
    (url, rx)
}

async fn ok(ws: &mut WebSocketStream<TcpStream>) {
    ws.send(Message::text(r#"{"ok":true,"v":1,"ip":"93.184.216.34"}"#)).await.unwrap();
}

async fn send(ws: &mut WebSocketStream<TcpStream>, frame: Frame) {
    ws.send(Message::binary(frame.encode())).await.unwrap();
}

/// The next frame that isn't a PONG.
async fn frame(ws: &mut WebSocketStream<TcpStream>) -> Frame {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("a frame in time").unwrap().unwrap();
        if let Message::Binary(raw) = message {
            let frame = Frame::decode(&raw).unwrap();
            if !matches!(frame, Frame::Pong { .. }) {
                return frame;
            }
        }
    }
}

fn start(url: String, silence: Duration) -> (mpsc::UnboundedReceiver<Event>, watch::Sender<bool>) {
    let (events, rx) = mpsc::unbounded_channel();
    let (stop, stop_rx) = watch::channel(false);
    let mut options = Options::new(url, "the-token".into(), claims(), vec!["8.8.4.4".parse().unwrap()]);
    options.silence = silence;
    tokio::spawn(run(options, events, stop_rx));
    (rx, stop)
}

async fn until(events: &mut mpsc::UnboundedReceiver<Event>, want: impl Fn(&Event) -> bool) -> Event {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv()).await.expect("the event in time").unwrap();
        if want(&event) {
            return event;
        }
    }
}

/// A site that echoes what it gets, upper-cased, then closes when the client does.
async fn echo_site() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = tcp.read(&mut buf).await {
                    if n == 0 { break; }
                    let _ = tcp.write_all(&buf[..n].to_ascii_uppercase()).await;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn says_hello_with_its_token_and_reports_its_public_ip() {
    let (url, mut hubs) = hub().await;
    let (mut events, stop) = start(url, Duration::from_secs(20));
    let (hello, mut ws) = hubs.recv().await.unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&hello).unwrap(), serde_json::json!({ "v": 1, "token": "the-token" }));
    ok(&mut ws).await;
    assert_eq!(until(&mut events, |e| matches!(e, Event::Up { .. })).await, Event::Up { public_ip: Some("93.184.216.34".parse().unwrap()) });
    send(&mut ws, Frame::Ping { nonce: 9 }).await;
    let pong = loop {
        if let Some(Ok(Message::Binary(raw))) = ws.next().await { break Frame::decode(&raw).unwrap(); }
    };
    assert_eq!(pong, Frame::Pong { nonce: 9 });
    stop.send(true).unwrap();
    assert_eq!(until(&mut events, |e| matches!(e, Event::Ended { .. })).await, Event::Ended { reason: EndReason::Stopped });
}

#[tokio::test]
async fn carries_a_stream_both_ways_and_half_closes() {
    let _lock = POLICY_LOCK.lock().await;
    LOOSE_POLICY.store(true, Ordering::SeqCst);
    let site = echo_site().await;
    let (url, mut hubs) = hub().await;
    let (mut events, _stop) = start(url, Duration::from_secs(20));
    let (_, mut ws) = hubs.recv().await.unwrap();
    ok(&mut ws).await;
    send(&mut ws, Frame::Open { stream: 1, host: "127.0.0.1".into(), port: site }).await;
    assert_eq!(frame(&mut ws).await, Frame::Opened { stream: 1 });
    assert_eq!(until(&mut events, |e| matches!(e, Event::Opened { .. })).await, Event::Opened { host: "127.0.0.1".into() });
    send(&mut ws, Frame::Data { stream: 1, bytes: b"hello".to_vec() }).await;
    let mut got = Vec::new();
    let mut credited = 0;
    while got.len() < 5 || credited < 5 {
        match frame(&mut ws).await {
            Frame::Data { stream: 1, bytes } => got.extend(bytes),
            Frame::Credit { stream: 1, bytes } => credited += bytes,
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(got, b"HELLO");
    // The hub is done sending: the site sees EOF, closes, and the Mac says FIN.
    send(&mut ws, Frame::Fin { stream: 1 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Fin { stream: 1 });
    LOOSE_POLICY.store(false, Ordering::SeqCst);
}

#[tokio::test]
async fn never_sends_more_than_the_window_until_credited() {
    let _lock = POLICY_LOCK.lock().await;
    LOOSE_POLICY.store(true, Ordering::SeqCst);
    // A site that sends 2 MB at once.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let site = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let _ = tcp.write_all(&vec![7u8; 2 * 1024 * 1024]).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    let (url, mut hubs) = hub().await;
    let (_events, _stop) = start(url, Duration::from_secs(20));
    let (_, mut ws) = hubs.recv().await.unwrap();
    ok(&mut ws).await;
    send(&mut ws, Frame::Open { stream: 3, host: "127.0.0.1".into(), port: site }).await;
    assert_eq!(frame(&mut ws).await, Frame::Opened { stream: 3 });
    let mut received = 0usize;
    loop {
        match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(Message::Binary(raw)))) => {
                if let Some(Frame::Data { bytes, .. }) = Frame::decode(&raw) { received += bytes.len(); }
            }
            Ok(_) => {}
            Err(_) => break, // quiet: the window is used up
        }
    }
    assert_eq!(received, WINDOW as usize);
    send(&mut ws, Frame::Credit { stream: 3, bytes: 100_000 }).await;
    let mut more = 0usize;
    while more < 100_000 {
        if let Frame::Data { bytes, .. } = frame(&mut ws).await { more += bytes.len(); }
    }
    assert_eq!(more, 100_000);
    LOOSE_POLICY.store(false, Ordering::SeqCst);
}

#[tokio::test]
async fn refuses_this_macs_own_network_and_other_ports() {
    let _lock = POLICY_LOCK.lock().await;
    let (url, mut hubs) = hub().await;
    let (mut events, _stop) = start(url, Duration::from_secs(20));
    let (_, mut ws) = hubs.recv().await.unwrap();
    ok(&mut ws).await;
    send(&mut ws, Frame::Open { stream: 1, host: "127.0.0.1".into(), port: 443 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Refused { stream: 1, reason: Refusal::Blocked });
    send(&mut ws, Frame::Open { stream: 2, host: "localhost".into(), port: 80 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Refused { stream: 2, reason: Refusal::Blocked });
    send(&mut ws, Frame::Open { stream: 3, host: "169.254.169.254".into(), port: 80 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Refused { stream: 3, reason: Refusal::Blocked });
    send(&mut ws, Frame::Open { stream: 4, host: "93.184.216.34".into(), port: 443 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Refused { stream: 4, reason: Refusal::Blocked }, "its own public IP");
    send(&mut ws, Frame::Open { stream: 7, host: "8.8.4.4".into(), port: 443 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Refused { stream: 7, reason: Refusal::Blocked }, "its public IP as the app's server saw it");
    send(&mut ws, Frame::Open { stream: 5, host: "example.com".into(), port: 22 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Refused { stream: 5, reason: Refusal::Port });
    send(&mut ws, Frame::Open { stream: 6, host: "no-such-host.invalid".into(), port: 443 }).await;
    assert_eq!(frame(&mut ws).await, Frame::Refused { stream: 6, reason: Refusal::Dns });
    assert!(matches!(until(&mut events, |e| matches!(e, Event::Refused { .. })).await, Event::Refused { .. }));
}

#[tokio::test]
async fn drops_a_silent_hub_and_connects_again() {
    let (url, mut hubs) = hub().await;
    let (mut events, _stop) = start(url, Duration::from_secs(1));
    let (_, mut first) = hubs.recv().await.unwrap();
    ok(&mut first).await;
    until(&mut events, |e| matches!(e, Event::Up { .. })).await;
    // Say nothing more: the Mac gives up after its silence and comes back.
    let down = until(&mut events, |e| matches!(e, Event::Down { .. })).await;
    assert_eq!(down, Event::Down { reason: "the hub went silent".into() });
    let (hello, mut second) = tokio::time::timeout(Duration::from_secs(5), hubs.recv()).await.unwrap().unwrap();
    assert!(hello.contains("the-token"));
    ok(&mut second).await;
    until(&mut events, |e| matches!(e, Event::Up { .. })).await;
    drop(first);
}

#[tokio::test]
async fn stops_for_good_when_the_hub_refuses_the_token_or_another_tunnel_takes_over() {
    for (code, reason) in [(CLOSE_UNAUTHORIZED, EndReason::Unauthorized), (CLOSE_REPLACED, EndReason::Replaced)] {
        let (url, mut hubs) = hub().await;
        let (mut events, _stop) = start(url, Duration::from_secs(20));
        let (_, mut ws) = hubs.recv().await.unwrap();
        ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() })).await.unwrap();
        assert_eq!(until(&mut events, |e| matches!(e, Event::Ended { .. })).await, Event::Ended { reason });
        assert!(tokio::time::timeout(Duration::from_secs(2), hubs.recv()).await.is_err(), "no second try");
    }
}

#[tokio::test]
async fn a_hub_reset_closes_the_site_connection() {
    let _lock = POLICY_LOCK.lock().await;
    LOOSE_POLICY.store(true, Ordering::SeqCst);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let site = listener.local_addr().unwrap().port();
    let (closed_tx, mut closed) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 16];
        let n = tcp.read(&mut buf).await.unwrap_or(0);
        let _ = closed_tx.send(n);
    });
    let (url, mut hubs) = hub().await;
    let (_events, _stop) = start(url, Duration::from_secs(20));
    let (_, mut ws) = hubs.recv().await.unwrap();
    ok(&mut ws).await;
    send(&mut ws, Frame::Open { stream: 1, host: "127.0.0.1".into(), port: site }).await;
    assert_eq!(frame(&mut ws).await, Frame::Opened { stream: 1 });
    send(&mut ws, Frame::Reset { stream: 1 }).await;
    assert_eq!(tokio::time::timeout(Duration::from_secs(3), closed.recv()).await.unwrap(), Some(0), "the site sees the close");
    LOOSE_POLICY.store(false, Ordering::SeqCst);
}
