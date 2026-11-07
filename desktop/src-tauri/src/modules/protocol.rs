//! Protocol v1 — the framing every local-module sidecar speaks on stdin/stdout.
//!
//! ```text
//! frame   = kind:u8  length:u32le  payload[length]
//! kind 1  = JSON message (UTF-8)
//! kind 2  = audio: stream_id:u8  sample_rate:u32le  samples:f32le[]
//! ```
//!
//! stderr is human-readable logs only. A sidecar must exit when its stdin
//! reaches EOF, so it can never outlive the app (a crashed or killed app
//! closes the pipe).
//!
//! Framed rather than JSON lines because audio is 16 kHz f32 on two streams;
//! base64-in-JSON would cost CPU and allocations for nothing.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Current major version. Bump only on a breaking change; the host refuses a
/// sidecar that reports a different major.
pub const PROTOCOL_MAJOR: u32 = 1;

const KIND_JSON: u8 = 1;
const KIND_AUDIO: u8 = 2;

/// Upper bound on one frame's payload. Real frames are a few KB; anything this
/// large means the stream is desynchronised or the peer is not speaking v1.
const MAX_FRAME_BYTES: u32 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Json(serde_json::Value),
    Audio {
        stream: u8,
        sample_rate: u32,
        samples: Vec<f32>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame of {0} bytes exceeds the {MAX_FRAME_BYTES}-byte limit")]
    TooLarge(u32),
    #[error("unknown frame kind {0}")]
    UnknownKind(u8),
    #[error("malformed {0} frame")]
    Malformed(&'static str),
    #[error("invalid JSON frame: {0}")]
    Json(#[from] serde_json::Error),
}

impl Frame {
    /// Serialize to wire bytes.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Frame::Json(value) => {
                let payload = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
                let mut out = Vec::with_capacity(5 + payload.len());
                out.push(KIND_JSON);
                out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
                out.extend_from_slice(&payload);
                out
            }
            Frame::Audio {
                stream,
                sample_rate,
                samples,
            } => {
                let len = 1 + 4 + samples.len() * 4;
                let mut out = Vec::with_capacity(5 + len);
                out.push(KIND_AUDIO);
                out.extend_from_slice(&(len as u32).to_le_bytes());
                out.push(*stream);
                out.extend_from_slice(&sample_rate.to_le_bytes());
                for s in samples {
                    out.extend_from_slice(&s.to_le_bytes());
                }
                out
            }
        }
    }

    /// The `type` field of a JSON frame, if any.
    pub fn message_type(&self) -> Option<&str> {
        match self {
            Frame::Json(v) => v.get("type").and_then(|t| t.as_str()),
            Frame::Audio { .. } => None,
        }
    }
}

/// Read one frame. `Ok(None)` = clean EOF at a frame boundary; EOF inside a
/// frame is an error.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Frame>, ProtocolError> {
    let mut header = [0u8; 5];
    // Distinguish a clean EOF (no bytes of a new frame) from a truncated one.
    let first = reader.read(&mut header[..1]).await?;
    if first == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..]).await?;

    let kind = header[0];
    let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]);
    if len > MAX_FRAME_BYTES {
        return Err(ProtocolError::TooLarge(len));
    }
    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload).await?;

    match kind {
        KIND_JSON => Ok(Some(Frame::Json(serde_json::from_slice(&payload)?))),
        KIND_AUDIO => {
            if payload.len() < 5 || (payload.len() - 5) % 4 != 0 {
                return Err(ProtocolError::Malformed("audio"));
            }
            let stream = payload[0];
            let sample_rate = u32::from_le_bytes([payload[1], payload[2], payload[3], payload[4]]);
            let samples = payload[5..]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            Ok(Some(Frame::Audio {
                stream,
                sample_rate,
                samples,
            }))
        }
        other => Err(ProtocolError::UnknownKind(other)),
    }
}

/// Write one frame and flush it.
pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) -> std::io::Result<()> {
    writer.write_all(&frame.encode()).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn roundtrip(frame: Frame) -> Frame {
        let bytes = frame.encode();
        let mut cursor = std::io::Cursor::new(bytes);
        read_frame(&mut cursor).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn json_roundtrip() {
        let f = Frame::Json(json!({"type": "hello", "module": "local-stt", "protocol": 1}));
        assert_eq!(roundtrip(f.clone()).await, f);
        assert_eq!(f.message_type(), Some("hello"));
    }

    #[tokio::test]
    async fn audio_roundtrip() {
        let f = Frame::Audio {
            stream: 1,
            sample_rate: 16_000,
            samples: vec![0.0, -1.0, 0.5, 1.0e-6],
        };
        assert_eq!(roundtrip(f.clone()).await, f);
        assert_eq!(f.message_type(), None);
    }

    #[tokio::test]
    async fn empty_audio_roundtrip() {
        let f = Frame::Audio {
            stream: 0,
            sample_rate: 16_000,
            samples: vec![],
        };
        assert_eq!(roundtrip(f.clone()).await, f);
    }

    #[tokio::test]
    async fn clean_eof_is_none() {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        assert!(read_frame(&mut cursor).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn several_frames_then_eof() {
        let mut bytes = Frame::Json(json!({"type": "ready"})).encode();
        bytes.extend(Frame::Audio { stream: 0, sample_rate: 16_000, samples: vec![0.25] }.encode());
        let mut cursor = std::io::Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).await.unwrap().unwrap().message_type(), Some("ready"));
        assert!(matches!(read_frame(&mut cursor).await.unwrap(), Some(Frame::Audio { .. })));
        assert!(read_frame(&mut cursor).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn truncated_frame_is_error() {
        let mut bytes = Frame::Json(json!({"type": "ready"})).encode();
        bytes.truncate(bytes.len() - 2);
        let mut cursor = std::io::Cursor::new(bytes);
        assert!(read_frame(&mut cursor).await.is_err());
    }

    #[tokio::test]
    async fn oversized_frame_is_rejected_without_allocating() {
        let mut bytes = vec![KIND_JSON];
        bytes.extend_from_slice(&(MAX_FRAME_BYTES + 1).to_le_bytes());
        let mut cursor = std::io::Cursor::new(bytes);
        assert!(matches!(read_frame(&mut cursor).await, Err(ProtocolError::TooLarge(_))));
    }

    #[tokio::test]
    async fn unknown_kind_is_error() {
        let bytes = vec![9u8, 0, 0, 0, 0];
        let mut cursor = std::io::Cursor::new(bytes);
        assert!(matches!(read_frame(&mut cursor).await, Err(ProtocolError::UnknownKind(9))));
    }

    #[tokio::test]
    async fn malformed_audio_is_error() {
        // 5-byte audio header + 3 stray bytes (not a whole f32).
        let mut bytes = vec![KIND_AUDIO];
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0x80, 0x3e, 0, 0, 1, 2, 3]);
        let mut cursor = std::io::Cursor::new(bytes);
        assert!(matches!(read_frame(&mut cursor).await, Err(ProtocolError::Malformed(_))));
    }
}
