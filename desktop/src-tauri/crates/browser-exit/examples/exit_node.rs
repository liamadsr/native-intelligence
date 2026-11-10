//! The exit node on its own, for the live check against a test sandbox
//! (web/scripts/cloud-browser/exit-check):
//!   cargo run --example exit_node -- --url wss://<hub>/exit --token <exit token> --key <server public key, base64 SPKI> --public-ip <this Mac's>
//! Checks the token as the app does, then holds the tunnel until Ctrl+C.

use browser_exit::node::{run, Event, Options};
use browser_exit::ticket::{public_key, verify};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == &format!("--{name}")).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (Some(url), Some(token), Some(key)) = (arg("url"), arg("token"), arg("key")) else {
        eprintln!("usage: exit_node --url wss://<hub>/exit --token <token> --key <spki>");
        std::process::exit(2);
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let claims = match public_key(&key).and_then(|key| verify(&token, &url, &key, now, true)) {
        Ok(claims) => claims,
        Err(e) => {
            eprintln!("refused: {e}");
            std::process::exit(1);
        }
    };
    let (events, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    let public_ips = arg("public-ip").and_then(|ip| ip.parse().ok()).into_iter().collect();
    tokio::spawn(run(Options::new(url, token, claims, public_ips), events, stop_rx));
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Some(Event::Ended { reason }) => { println!("ended: {reason:?}"); return; }
                Some(event) => println!("{event:?}"),
                None => return,
            },
            _ = tokio::signal::ctrl_c() => { let _ = stop.send(true); }
        }
    }
}
