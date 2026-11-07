//! The tunnel's frames, mux v1 (dial8-website `src/lib/cloud-browser/exit/mux.ts`
//! is the hub's side; the two must agree byte for byte).
//!
//! After the text handshake ([`crate::node`]), every WebSocket message is one
//! binary frame: `type: u8`, `stream: u32` (big-endian; 0 for the tunnel's own
//! frames), then the payload.
//!
//! | type | name    | way       | payload                                   |
//! |------|---------|-----------|-------------------------------------------|
//! | 1    | OPEN    | hub → Mac | `port: u16` + host (UTF-8, IPv6 unbracketed) |
//! | 2    | OPENED  | Mac → hub | —                                         |
//! | 3    | REFUSED | Mac → hub | `reason: u8` ([`Refusal`])                |
//! | 4    | DATA    | both      | bytes, at most [`MAX_DATA`]               |
//! | 5    | CREDIT  | both      | `bytes: u32`: that many more may be sent   |
//! | 6    | FIN     | both      | — (no more data this way)                 |
//! | 7    | RESET   | both      | — (the stream is gone)                    |
//! | 8    | PING    | both      | `nonce: u64`                              |
//! | 9    | PONG    | both      | the PING's nonce                          |
//!
//! Each side may have at most [`WINDOW`] bytes of a stream's DATA unanswered
//! by CREDIT, so one stalled stream never blocks the others.

/// Protocol version, in both hellos.
pub const VERSION: u32 = 1;
/// Per-stream, per-direction credit window.
pub const WINDOW: u32 = 512 * 1024;
/// Largest DATA payload in one frame.
pub const MAX_DATA: usize = 64 * 1024;
/// Most streams open at once.
pub const MAX_STREAMS: usize = 256;

pub const OPEN: u8 = 1;
pub const OPENED: u8 = 2;
pub const REFUSED: u8 = 3;
pub const DATA: u8 = 4;
pub const CREDIT: u8 = 5;
pub const FIN: u8 = 6;
pub const RESET: u8 = 7;
pub const PING: u8 = 8;
pub const PONG: u8 = 9;

/// Why the Mac refused a stream; the hub turns it into a SOCKS reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Refusal {
    /// A private, local or otherwise refused address ([`crate::policy`]).
    Blocked = 1,
    /// The name didn't resolve.
    Dns = 2,
    /// The connection failed or timed out.
    Connect = 3,
    /// Not port 80 or 443.
    Port = 4,
    /// [`MAX_STREAMS`] already open.
    Busy = 5,
}

impl Refusal {
    pub fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            1 => Self::Blocked,
            2 => Self::Dns,
            3 => Self::Connect,
            4 => Self::Port,
            5 => Self::Busy,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Open { stream: u32, host: String, port: u16 },
    Opened { stream: u32 },
    Refused { stream: u32, reason: Refusal },
    Data { stream: u32, bytes: Vec<u8> },
    Credit { stream: u32, bytes: u32 },
    Fin { stream: u32 },
    Reset { stream: u32 },
    Ping { nonce: u64 },
    Pong { nonce: u64 },
}

fn head(kind: u8, stream: u32, extra: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + extra);
    out.push(kind);
    out.extend_from_slice(&stream.to_be_bytes());
    out
}

impl Frame {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Frame::Open { stream, host, port } => {
                let mut out = head(OPEN, *stream, 2 + host.len());
                out.extend_from_slice(&port.to_be_bytes());
                out.extend_from_slice(host.as_bytes());
                out
            }
            Frame::Opened { stream } => head(OPENED, *stream, 0),
            Frame::Refused { stream, reason } => {
                let mut out = head(REFUSED, *stream, 1);
                out.push(*reason as u8);
                out
            }
            Frame::Data { stream, bytes } => {
                let mut out = head(DATA, *stream, bytes.len());
                out.extend_from_slice(bytes);
                out
            }
            Frame::Credit { stream, bytes } => {
                let mut out = head(CREDIT, *stream, 4);
                out.extend_from_slice(&bytes.to_be_bytes());
                out
            }
            Frame::Fin { stream } => head(FIN, *stream, 0),
            Frame::Reset { stream } => head(RESET, *stream, 0),
            Frame::Ping { nonce } => {
                let mut out = head(PING, 0, 8);
                out.extend_from_slice(&nonce.to_be_bytes());
                out
            }
            Frame::Pong { nonce } => {
                let mut out = head(PONG, 0, 8);
                out.extend_from_slice(&nonce.to_be_bytes());
                out
            }
        }
    }

    /// One frame, or None for anything malformed (the tunnel then closes).
    pub fn decode(raw: &[u8]) -> Option<Frame> {
        if raw.len() < 5 {
            return None;
        }
        let stream = u32::from_be_bytes(raw[1..5].try_into().ok()?);
        let body = &raw[5..];
        let empty = |frame: Frame| body.is_empty().then_some(frame);
        match raw[0] {
            OPEN => {
                if body.len() < 3 || body.len() > 2 + 255 {
                    return None;
                }
                let port = u16::from_be_bytes([body[0], body[1]]);
                let host = std::str::from_utf8(&body[2..]).ok()?.to_string();
                Some(Frame::Open { stream, host, port })
            }
            OPENED => empty(Frame::Opened { stream }),
            REFUSED if body.len() == 1 => Some(Frame::Refused { stream, reason: Refusal::from_u8(body[0])? }),
            DATA if body.len() <= MAX_DATA => Some(Frame::Data { stream, bytes: body.to_vec() }),
            CREDIT if body.len() == 4 => Some(Frame::Credit { stream, bytes: u32::from_be_bytes(body.try_into().ok()?) }),
            FIN => empty(Frame::Fin { stream }),
            RESET => empty(Frame::Reset { stream }),
            PING if body.len() == 8 && stream == 0 => Some(Frame::Ping { nonce: u64::from_be_bytes(body.try_into().ok()?) }),
            PONG if body.len() == 8 && stream == 0 => Some(Frame::Pong { nonce: u64::from_be_bytes(body.try_into().ok()?) }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The same vectors as the hub's mux.test.ts: a change on one side fails both.
    #[test]
    fn frames_match_the_hubs_bytes() {
        let cases = [
            (Frame::Open { stream: 7, host: "example.com".into(), port: 443 }, "010000000701bb6578616d706c652e636f6d"),
            (Frame::Opened { stream: 7 }, "0200000007"),
            (Frame::Refused { stream: 7, reason: Refusal::Blocked }, "030000000701"),
            (Frame::Data { stream: 1, bytes: b"hi".to_vec() }, "04000000016869"),
            (Frame::Credit { stream: 1, bytes: 65536 }, "050000000100010000"),
            (Frame::Fin { stream: 2 }, "0600000002"),
            (Frame::Reset { stream: 2 }, "0700000002"),
            (Frame::Ping { nonce: 42 }, "0800000000000000000000002a"),
            (Frame::Pong { nonce: 42 }, "0900000000000000000000002a"),
        ];
        for (frame, bytes) in cases {
            assert_eq!(hex(&frame.encode()), bytes, "{frame:?}");
            assert_eq!(Frame::decode(&frame.encode()), Some(frame));
        }
    }

    #[test]
    fn refuses_malformed_frames() {
        assert_eq!(Frame::decode(&[]), None);
        assert_eq!(Frame::decode(&[OPEN, 0, 0, 0, 1]), None, "no port or host");
        assert_eq!(Frame::decode(&[REFUSED, 0, 0, 0, 1, 99]), None, "unknown reason");
        assert_eq!(Frame::decode(&[PING, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]), None, "ping on a stream");
        assert_eq!(Frame::decode(&[OPENED, 0, 0, 0, 1, 0]), None, "payload where none goes");
        assert_eq!(Frame::decode(&[42, 0, 0, 0, 1]), None, "unknown type");
        let mut big = vec![DATA, 0, 0, 0, 1];
        big.resize(5 + MAX_DATA + 1, 0);
        assert_eq!(Frame::decode(&big), None, "oversized data");
    }
}
