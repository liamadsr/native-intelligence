//! Sidecar supervision shared by every local module: spawn the process, pump
//! protocol-v1 frames both ways, run the hello → configure → ready handshake,
//! and shut it down.
//!
//! The pumps work over any `AsyncRead`/`AsyncWrite` pair ([`Link::over`]), so
//! tests drive the handshake with in-memory pipes and only [`Sidecar::spawn`]
//! touches a real process.

use crate::sidecar::NoConsole;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::protocol::{read_frame, write_frame, Frame, PROTOCOL_MAJOR};

/// Frames queued toward the sidecar before `send` applies backpressure. Audio
/// callers use `try_send` and drop on full instead of blocking capture.
const TO_SIDECAR_CAPACITY: usize = 4096;
/// Frames read from the sidecar awaiting the consumer.
const FROM_SIDECAR_CAPACITY: usize = 1024;

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("sidecar executable not found")]
    NotFound,
    #[error("failed to start sidecar: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("sidecar did not answer {0} in time")]
    Timeout(&'static str),
    #[error("sidecar speaks protocol {got}, host speaks {PROTOCOL_MAJOR}")]
    Incompatible { got: u64 },
    #[error("sidecar identifies as {got:?}, expected {expected:?}")]
    WrongModule { got: String, expected: String },
    #[error("sidecar refused to start: {0}")]
    Rejected(String),
    #[error("sidecar exited before it was ready")]
    Exited,
}

/// What a sidecar says about itself in its `hello`, plus the `ready` message
/// that ended the handshake (module-specific fields, e.g. local-tts's voices).
#[derive(Debug, Clone)]
pub struct Hello {
    pub module: String,
    pub protocol: u64,
    pub version: String,
    pub ready: Value,
}

/// The two channel ends of a running sidecar. Dropping every `Sender` clone
/// closes the sidecar's stdin, which by protocol makes it exit. `rx` yields
/// `None` once the sidecar's stdout closes (exit, crash, or a protocol error).
pub struct Link {
    pub tx: mpsc::Sender<Frame>,
    pub rx: mpsc::Receiver<Frame>,
}

impl Link {
    /// Start the reader and writer pumps over an arbitrary byte stream pair.
    pub fn over<R, W>(label: String, reader: R, writer: W) -> Link
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (to_tx, mut to_rx) = mpsc::channel::<Frame>(TO_SIDECAR_CAPACITY);
        let (from_tx, from_rx) = mpsc::channel::<Frame>(FROM_SIDECAR_CAPACITY);

        let write_label = label.clone();
        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(frame) = to_rx.recv().await {
                if let Err(e) = write_frame(&mut writer, &frame).await {
                    crate::log_to_file(&format!("[module:{}] write to sidecar failed: {}", write_label, e));
                    break;
                }
            }
            // Dropping the writer here closes the sidecar's stdin → it exits.
        });

        tokio::spawn(async move {
            let mut reader = reader;
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(frame)) => {
                        if from_tx.send(frame).await.is_err() {
                            break; // consumer gone
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        crate::log_to_file(&format!("[module:{}] bad frame from sidecar: {}", label, e));
                        break;
                    }
                }
            }
            // Dropping from_tx makes the consumer's recv() return None.
        });

        Link { tx: to_tx, rx: from_rx }
    }

    /// Run the protocol handshake: wait for `hello`, check it, send
    /// `configure`, wait for `ready`. JSON frames of other types that arrive
    /// meanwhile are logged and dropped.
    pub async fn handshake(
        &mut self,
        expected_module: &str,
        configure: Value,
        timeout: Duration,
    ) -> Result<Hello, SidecarError> {
        let hello = tokio::time::timeout(timeout, self.wait_for("hello"))
            .await
            .map_err(|_| SidecarError::Timeout("hello"))??;

        let protocol = hello.get("protocol").and_then(|v| v.as_u64()).unwrap_or(0);
        if protocol != PROTOCOL_MAJOR as u64 {
            return Err(SidecarError::Incompatible { got: protocol });
        }
        let module = hello.get("module").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if module != expected_module {
            return Err(SidecarError::WrongModule {
                got: module,
                expected: expected_module.to_string(),
            });
        }
        let version = hello.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();

        let mut configure = configure;
        if let Some(obj) = configure.as_object_mut() {
            obj.insert("type".into(), json!("configure"));
        }
        self.tx
            .send(Frame::Json(configure))
            .await
            .map_err(|_| SidecarError::Exited)?;

        let ready = tokio::time::timeout(timeout, self.wait_for("ready"))
            .await
            .map_err(|_| SidecarError::Timeout("ready"))??;

        Ok(Hello { module, protocol, version, ready })
    }

    /// Wait for a JSON frame of `wanted` type. An `error` frame fails fast.
    async fn wait_for(&mut self, wanted: &str) -> Result<Value, SidecarError> {
        loop {
            match self.rx.recv().await {
                None => return Err(SidecarError::Exited),
                Some(Frame::Json(v)) => {
                    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if ty == wanted {
                        return Ok(v);
                    }
                    if ty == "error" {
                        let msg = v
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown error")
                            .to_string();
                        return Err(SidecarError::Rejected(msg));
                    }
                    crate::log_to_file(&format!("[modules] ignoring {:?} while waiting for {}", ty, wanted));
                }
                Some(Frame::Audio { .. }) => {}
            }
        }
    }
}

/// A spawned sidecar: its frame link plus the process handle. Split them to
/// keep talking while holding on to the process for [`SidecarProcess::reap`].
pub struct Sidecar {
    pub link: Link,
    pub process: SidecarProcess,
}

pub struct SidecarProcess {
    child: Child,
    label: String,
}

impl Sidecar {
    /// Spawn `exe` with `args`, piping stdin/stdout for protocol frames and
    /// routing stderr lines into the app log with a `[module:<label>]` prefix.
    pub fn spawn(label: &str, exe: &Path, args: &[String]) -> Result<Sidecar, SidecarError> {
        if !exe.exists() {
            return Err(SidecarError::NotFound);
        }
        let mut child = Command::new(exe)
            .no_console()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
        if let Some(stderr) = child.stderr.take() {
            let stderr_label = label.to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    crate::log_to_file(&format!("[module:{}] {}", stderr_label, line));
                }
            });
        }

        crate::log_to_file(&format!("[module:{}] spawned {} (pid {:?})", label, exe.display(), child.id()));
        Ok(Sidecar {
            link: Link::over(label.to_string(), stdout, stdin),
            process: SidecarProcess { child, label: label.to_string() },
        })
    }
}

impl SidecarProcess {
    /// Wait for the process to exit on its own, up to `grace`, then kill it.
    /// Callers drop the link (closing stdin — by protocol the sidecar exits)
    /// or send a module-specific "finish" before calling this.
    pub async fn reap(mut self, grace: Duration) {
        match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => {
                crate::log_to_file(&format!("[module:{}] exited: {}", self.label, status));
            }
            Ok(Err(e)) => {
                crate::log_to_file(&format!("[module:{}] wait failed: {}", self.label, e));
            }
            Err(_) => {
                crate::log_to_file(&format!("[module:{}] did not exit within {:?} — killing", self.label, grace));
                let _ = self.child.kill().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    /// Spin up a fake sidecar on in-memory pipes. `script` gets the sidecar's
    /// ends of the pipes.
    fn fake<F, Fut>(script: F) -> Link
    where
        F: FnOnce(tokio::io::DuplexStream, tokio::io::DuplexStream) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let (host_read, side_write) = duplex(64 * 1024);
        let (side_read, host_write) = duplex(64 * 1024);
        tokio::spawn(script(side_read, side_write));
        Link::over("test".into(), host_read, host_write)
    }

    async fn send(w: &mut tokio::io::DuplexStream, v: Value) {
        write_frame(w, &Frame::Json(v)).await.unwrap();
    }

    #[tokio::test]
    async fn happy_handshake_then_audio_flows_and_eof_closes() {
        let mut link = fake(|mut r, mut w| async move {
            send(&mut w, json!({"type":"hello","module":"local-stt","protocol":1,"version":"abc"})).await;
            let cfg = read_frame(&mut r).await.unwrap().unwrap();
            assert_eq!(cfg.message_type(), Some("configure"));
            if let Frame::Json(v) = &cfg {
                assert_eq!(v["model"], "x.gguf");
            }
            send(&mut w, json!({"type":"ready","voices":["aba"]})).await;
            // Echo one audio frame back as a JSON count, then exit on stdin EOF.
            let audio = read_frame(&mut r).await.unwrap().unwrap();
            if let Frame::Audio { samples, .. } = audio {
                send(&mut w, json!({"type":"count","n":samples.len()})).await;
            }
            assert!(read_frame(&mut r).await.unwrap().is_none(), "stdin should reach EOF");
        });
        let hello = link
            .handshake("local-stt", json!({"model":"x.gguf"}), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(hello.version, "abc");
        assert_eq!(hello.ready["voices"][0], "aba", "the ready message is handed back");
        link.tx
            .send(Frame::Audio { stream: 0, sample_rate: 16_000, samples: vec![0.0; 160] })
            .await
            .unwrap();
        let reply = link.rx.recv().await.unwrap();
        if let Frame::Json(v) = reply {
            assert_eq!(v["n"], 160);
        } else {
            panic!("expected json");
        }
        let Link { tx, mut rx } = link;
        drop(tx); // closes the fake's stdin
        assert!(rx.recv().await.is_none(), "stdout closes after the fake exits");
    }

    #[tokio::test]
    async fn protocol_mismatch_is_incompatible() {
        let mut link = fake(|_r, mut w| async move {
            send(&mut w, json!({"type":"hello","module":"local-stt","protocol":2})).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        let err = link.handshake("local-stt", json!({}), Duration::from_secs(2)).await.unwrap_err();
        assert!(matches!(err, SidecarError::Incompatible { got: 2 }), "{err}");
    }

    #[tokio::test]
    async fn wrong_module_is_rejected() {
        let mut link = fake(|_r, mut w| async move {
            send(&mut w, json!({"type":"hello","module":"local-tts","protocol":1})).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        let err = link.handshake("local-stt", json!({}), Duration::from_secs(2)).await.unwrap_err();
        assert!(matches!(err, SidecarError::WrongModule { .. }), "{err}");
    }

    #[tokio::test]
    async fn error_before_ready_is_rejected_with_message() {
        let mut link = fake(|mut r, mut w| async move {
            send(&mut w, json!({"type":"hello","module":"local-stt","protocol":1})).await;
            let _ = read_frame(&mut r).await;
            send(&mut w, json!({"type":"error","message":"model file missing","fatal":true})).await;
        });
        let err = link.handshake("local-stt", json!({}), Duration::from_secs(2)).await.unwrap_err();
        match err {
            SidecarError::Rejected(m) => assert_eq!(m, "model file missing"),
            other => panic!("unexpected {other}"),
        }
    }

    #[tokio::test]
    async fn silence_times_out() {
        let mut link = fake(|r, w| async move {
            let _keep_pipes_open = (r, w);
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let err = link.handshake("local-stt", json!({}), Duration::from_millis(100)).await.unwrap_err();
        assert!(matches!(err, SidecarError::Timeout("hello")), "{err}");
    }

    #[tokio::test]
    async fn exit_before_ready_is_exited() {
        let mut link = fake(|mut r, mut w| async move {
            send(&mut w, json!({"type":"hello","module":"local-stt","protocol":1})).await;
            let _ = read_frame(&mut r).await;
            // Drop both ends: the host sees EOF.
        });
        let err = link.handshake("local-stt", json!({}), Duration::from_secs(2)).await.unwrap_err();
        assert!(matches!(err, SidecarError::Exited), "{err}");
    }

    #[tokio::test]
    async fn garbage_on_stdout_closes_the_link() {
        let mut link = fake(|_r, mut w| async move {
            use tokio::io::AsyncWriteExt;
            w.write_all(&[7, 0, 0, 0, 0]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        let err = link.handshake("local-stt", json!({}), Duration::from_secs(2)).await.unwrap_err();
        assert!(matches!(err, SidecarError::Exited), "{err}");
    }
}
