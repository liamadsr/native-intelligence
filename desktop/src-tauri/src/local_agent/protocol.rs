//! The launcher's stdio protocol (l0-contract §1): one JSON object per line,
//! UTF-8, both ways.
//!
//! Rust → launcher (stdin): `start`, `resume`, `send`, `stop`, (L1) `token`,
//! a refreshed model relay token, and (teammate C3) `prompt_answer` `{ id,
//! allow }`, the person's answer to a `prompt` ([`start_line`] and friends;
//! serde escapes every newline, so one message is one line).
//!
//! Launcher → Rust (stdout): `ready`, `session`, `cursor`, `event`, `fatal`,
//! and (C3) `prompt` `{ id, kind: "push" | "fence", detail }`, a question
//! Rust asks the person natively ([`super::prompts`]) and answers exactly
//! once ([`parse_line`]). Anything else is logged and dropped, never fatal: an
//! unknown `type` is a newer launcher, a malformed line is a stray
//! `console.log` from a library. Lines are read with a hard cap
//! ([`read_capped_line`]) so a runaway line can't grow memory without bound;
//! the launcher already truncates tool input to 2 KB and output to 4 KB.

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// Longest stdout line read; longer ones are skipped whole.
pub const MAX_LINE_BYTES: usize = 256 * 1024;
/// Longest `sessionId` accepted.
const MAX_SESSION_ID: usize = 256;
/// Longest `fatal` message kept.
const MAX_FATAL: usize = 2_000;
/// Longest `prompt` id answered.
const MAX_PROMPT_ID: usize = 128;

/// What a `prompt` asks for (teammate C3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptKind {
    /// Push the edit job's branch and open a pull request (C5).
    Push,
    /// Widen the fence for this job: one more path, read or write.
    Fence,
    /// A kind this build doesn't know: answered `allow: false` at once.
    Other(String),
}

/// One line from the launcher's stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    Ready {
        port: u64,
        eve_version: Option<String>,
        /// A worker's adapter (L4): its `worker` and `workerVersion`.
        worker: Option<(String, Option<String>)>,
    },
    Session {
        session_id: String,
        stream_index: u64,
    },
    Cursor {
        stream_index: u64,
    },
    /// A `NormalizedEvent`: an object with a string `kind`. Kinds Rust doesn't
    /// know pass through to the page untouched.
    Event(Value),
    Fatal {
        message: String,
    },
    /// A question for the person; `detail` is checked by its kind's parser.
    Prompt {
        id: String,
        kind: PromptKind,
        detail: Value,
    },
    /// A coding agent's workspace tool call (board step 4,
    /// [`super::workspace_tools`]): never an event.
    ToolCall(super::workspace_tools::ToolCall),
    /// A `tool_call` line that failed its checks (the field named): dropped,
    /// logged once per run.
    BadToolCall(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub enum LineError {
    /// Not a JSON object with a string `type`.
    Malformed,
    /// A `type` this build doesn't know.
    Unknown(String),
    /// A known `type` missing a field or with a bad value.
    Invalid(&'static str),
}

pub fn parse_line(line: &str) -> Result<Inbound, LineError> {
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(line) else {
        return Err(LineError::Malformed);
    };
    let ty = match obj.get("type").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => return Err(LineError::Malformed),
    };
    match ty.as_str() {
        "ready" => Ok(Inbound::Ready {
            port: obj
                .get("port")
                .and_then(Value::as_u64)
                .ok_or(LineError::Invalid("ready.port"))?,
            eve_version: obj.get("eveVersion").and_then(Value::as_str).map(str::to_string),
            worker: obj.get("worker").and_then(Value::as_str).map(|w| {
                // Only ever logged: printable, short.
                let clean = |s: &str| s.chars().filter(|c| !c.is_control()).take(64).collect::<String>();
                let version = obj.get("workerVersion").and_then(Value::as_str);
                (clean(w), version.map(clean))
            }),
        }),
        "session" => {
            let session_id = obj
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= MAX_SESSION_ID)
                .ok_or(LineError::Invalid("session.sessionId"))?
                .to_string();
            Ok(Inbound::Session {
                session_id,
                stream_index: stream_index(&obj, "session.streamIndex")?,
            })
        }
        "cursor" => Ok(Inbound::Cursor {
            stream_index: stream_index(&obj, "cursor.streamIndex")?,
        }),
        "event" => match obj.remove("event") {
            Some(Value::Object(ev)) if ev.get("kind").is_some_and(Value::is_string) => {
                Ok(Inbound::Event(Value::Object(ev)))
            }
            _ => Err(LineError::Invalid("event.event")),
        },
        "fatal" => {
            let message = obj
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the launcher failed");
            Ok(Inbound::Fatal {
                message: truncate(message, MAX_FATAL),
            })
        }
        // Without a usable id there is nothing to answer: invalid. Anything
        // else wrong with it is answered `allow: false` by the actor.
        "prompt" => {
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| is_prompt_id(s))
                .ok_or(LineError::Invalid("prompt.id"))?
                .to_string();
            let kind = match obj.get("kind").and_then(Value::as_str) {
                Some("push") => PromptKind::Push,
                Some("fence") => PromptKind::Fence,
                Some(other) => PromptKind::Other(truncate(other, 64)),
                None => PromptKind::Other(String::new()),
            };
            Ok(Inbound::Prompt {
                id,
                kind,
                detail: obj.remove("detail").unwrap_or(Value::Null),
            })
        }
        "tool_call" => Ok(match super::workspace_tools::ToolCall::parse(&mut obj) {
            Ok(call) => Inbound::ToolCall(call),
            Err(field) => Inbound::BadToolCall(field),
        }),
        _ => Err(LineError::Unknown(ty)),
    }
}

/// 1 to [`MAX_PROMPT_ID`] printable ASCII characters, no spaces.
fn is_prompt_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_PROMPT_ID && s.bytes().all(|b| b.is_ascii_graphic())
}

fn stream_index(obj: &Map<String, Value>, field: &'static str) -> Result<u64, LineError> {
    obj.get("streamIndex")
        .and_then(Value::as_u64)
        .ok_or(LineError::Invalid(field))
}

/// `s` cut to at most `max` bytes, on a char boundary.
pub fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

// ─── Rust → launcher ────────────────────────────────────────────────────────

/// One protocol line. serde escapes `\n` and `\r`, but writes U+2028 and
/// U+2029 raw (valid JSON), and Node's readline splits lines on them too: a
/// request or message holding one would reach the launcher in fragments and
/// the job would hang in `starting`. They can only occur inside strings, where
/// the `\u2028` / `\u2029` escapes are the same JSON.
pub(super) fn to_line(v: Value) -> String {
    v.to_string()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

pub fn start_line(request: &str) -> String {
    to_line(json!({ "type": "start", "request": request }))
}

pub fn resume_line(session_id: &str, stream_index: u64) -> String {
    to_line(json!({ "type": "resume", "sessionId": session_id, "streamIndex": stream_index }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Steer,
    Queue,
}

impl Policy {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "steer" => Some(Policy::Steer),
            "queue" => Some(Policy::Queue),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Policy::Steer => "steer",
            Policy::Queue => "queue",
        }
    }
}

pub fn send_line(text: &str, policy: Policy) -> String {
    to_line(json!({ "type": "send", "text": text, "policy": policy.as_str() }))
}

/// A fresh model relay token for the running launcher (l1-contract C4).
pub fn token_line(model_token: &str) -> String {
    to_line(json!({ "type": "token", "modelToken": model_token }))
}

pub fn stop_line() -> String {
    to_line(json!({ "type": "stop" }))
}

/// The person's answer to the launcher's `prompt` `id` (C3).
pub fn prompt_answer_line(id: &str, allow: bool) -> String {
    to_line(json!({ "type": "prompt_answer", "id": id, "allow": allow }))
}

// ─── capped line reader ─────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum CappedLine {
    /// A whole line, without its `\n` (or `\r\n`); invalid UTF-8 replaced.
    Line(String),
    /// A line longer than the cap, skipped whole; its length in bytes.
    TooLong(usize),
    Eof,
}

/// Read one line of at most `cap` bytes. A longer line is consumed up to its
/// newline and reported as [`CappedLine::TooLong`]; nothing past `cap` is
/// ever buffered. A last line without a newline is still a line.
pub async fn read_capped_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    cap: usize,
) -> std::io::Result<CappedLine> {
    buf.clear();
    let mut total = 0usize;
    let mut overflow = false;
    let mut any = false;
    loop {
        let avail = reader.fill_buf().await?;
        if avail.is_empty() {
            if !any {
                return Ok(CappedLine::Eof);
            }
            break;
        }
        any = true;
        let newline = avail.iter().position(|b| *b == b'\n');
        let chunk = &avail[..newline.unwrap_or(avail.len())];
        total += chunk.len();
        if !overflow {
            if buf.len() + chunk.len() <= cap {
                buf.extend_from_slice(chunk);
            } else {
                overflow = true;
                buf.clear();
            }
        }
        let used = chunk.len() + usize::from(newline.is_some());
        reader.consume(used);
        if newline.is_some() {
            break;
        }
    }
    if overflow {
        return Ok(CappedLine::TooLong(total));
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    Ok(CappedLine::Line(String::from_utf8_lossy(buf).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_adapters_ready_line_names_it_and_its_cli() {
        assert_eq!(
            parse_line(r#"{"type":"ready","port":0,"worker":"claude-code","workerVersion":"2.0.14"}"#),
            Ok(Inbound::Ready {
                port: 0,
                eve_version: None,
                worker: Some(("claude-code".into(), Some("2.0.14".into()))),
            })
        );
        let Ok(Inbound::Ready { worker: Some((name, version)), .. }) =
            parse_line(&format!(r#"{{"type":"ready","port":0,"worker":"co\ndex{}"}}"#, "x".repeat(100)))
        else {
            panic!("a ready line")
        };
        assert!(!name.contains('\n') && name.chars().count() == 64, "{name:?}");
        assert_eq!(version, None);
    }

    #[test]
    fn parses_every_launcher_message() {
        assert_eq!(
            parse_line(r#"{"type":"ready","port":4123,"eveVersion":"0.79.1"}"#),
            Ok(Inbound::Ready {
                port: 4123,
                eve_version: Some("0.79.1".into()),
                worker: None,
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"session","sessionId":"ses_1","streamIndex":0}"#),
            Ok(Inbound::Session {
                session_id: "ses_1".into(),
                stream_index: 0
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"cursor","streamIndex":42}"#),
            Ok(Inbound::Cursor { stream_index: 42 })
        );
        assert_eq!(
            parse_line(r#"{"type":"event","event":{"kind":"text","delta":"hi"}}"#),
            Ok(Inbound::Event(json!({"kind":"text","delta":"hi"})))
        );
        assert_eq!(
            parse_line(r#"{"type":"fatal","message":"eve server did not start"}"#),
            Ok(Inbound::Fatal {
                message: "eve server did not start".into()
            })
        );
    }

    #[test]
    fn prompts_parse_with_their_kind_and_detail_and_answers_are_one_line() {
        assert_eq!(
            parse_line(r#"{"type":"prompt","id":"p-1","kind":"push","detail":{"title":"Fix it"}}"#),
            Ok(Inbound::Prompt {
                id: "p-1".into(),
                kind: PromptKind::Push,
                detail: json!({"title":"Fix it"}),
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"prompt","id":"p-2","kind":"fence","detail":{"path":"/x","access":"read"}}"#),
            Ok(Inbound::Prompt {
                id: "p-2".into(),
                kind: PromptKind::Fence,
                detail: json!({"path":"/x","access":"read"}),
            })
        );
        // Answerable, so parsed: the actor refuses them.
        assert_eq!(
            parse_line(r#"{"type":"prompt","id":"p-3","kind":"camera"}"#),
            Ok(Inbound::Prompt {
                id: "p-3".into(),
                kind: PromptKind::Other("camera".into()),
                detail: Value::Null,
            })
        );
        assert!(matches!(
            parse_line(r#"{"type":"prompt","id":"p-4"}"#),
            Ok(Inbound::Prompt { kind: PromptKind::Other(k), .. }) if k.is_empty()
        ));
        // No id to answer: invalid.
        for line in [
            r#"{"type":"prompt","kind":"push"}"#,
            r#"{"type":"prompt","id":"","kind":"push"}"#,
            r#"{"type":"prompt","id":"has space","kind":"push"}"#,
            r#"{"type":"prompt","id":7,"kind":"push"}"#,
        ] {
            assert_eq!(parse_line(line), Err(LineError::Invalid("prompt.id")), "{line}");
        }
        let long = format!(r#"{{"type":"prompt","id":"{}","kind":"push"}}"#, "x".repeat(129));
        assert_eq!(parse_line(&long), Err(LineError::Invalid("prompt.id")));

        let answer = prompt_answer_line("p-1", true);
        assert!(!answer.contains('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&answer).unwrap(),
            json!({"type":"prompt_answer","id":"p-1","allow":true})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&prompt_answer_line("p-2", false)).unwrap()["allow"],
            false
        );
    }

    #[test]
    fn unknown_kinds_pass_through_untouched() {
        let line = r#"{"type":"event","event":{"kind":"thinking","text":"hmm","extra":[1,2]}}"#;
        assert_eq!(
            parse_line(line),
            Ok(Inbound::Event(json!({"kind":"thinking","text":"hmm","extra":[1,2]})))
        );
    }

    #[test]
    fn unknown_types_are_reported_not_fatal() {
        assert_eq!(
            parse_line(r#"{"type":"heartbeat"}"#),
            Err(LineError::Unknown("heartbeat".into()))
        );
    }

    #[test]
    fn malformed_lines_are_rejected() {
        for line in [
            "",
            "not json",
            "Listening on http://127.0.0.1:4123",
            "[1,2,3]",
            r#""a string""#,
            r#"{"no":"type"}"#,
            r#"{"type":7}"#,
            r#"{"type":"ready","port":1"#,
        ] {
            assert_eq!(parse_line(line), Err(LineError::Malformed), "{line:?}");
        }
    }

    #[test]
    fn known_types_with_bad_fields_are_invalid() {
        for (line, why) in [
            (r#"{"type":"ready"}"#, "ready.port"),
            (r#"{"type":"ready","port":-1}"#, "ready.port"),
            (r#"{"type":"session","streamIndex":0}"#, "session.sessionId"),
            (
                r#"{"type":"session","sessionId":"","streamIndex":0}"#,
                "session.sessionId",
            ),
            (r#"{"type":"session","sessionId":"s"}"#, "session.streamIndex"),
            (r#"{"type":"cursor","streamIndex":-3}"#, "cursor.streamIndex"),
            (r#"{"type":"cursor","streamIndex":1.5}"#, "cursor.streamIndex"),
            (r#"{"type":"cursor","streamIndex":"4"}"#, "cursor.streamIndex"),
            (r#"{"type":"event"}"#, "event.event"),
            (r#"{"type":"event","event":"text"}"#, "event.event"),
            (r#"{"type":"event","event":{"delta":"no kind"}}"#, "event.event"),
            (r#"{"type":"event","event":{"kind":3}}"#, "event.event"),
        ] {
            assert_eq!(parse_line(line), Err(LineError::Invalid(why)), "{line}");
        }
        let long = format!(
            r#"{{"type":"session","sessionId":"{}","streamIndex":0}}"#,
            "x".repeat(300)
        );
        assert_eq!(parse_line(&long), Err(LineError::Invalid("session.sessionId")));
    }

    #[test]
    fn fatal_without_a_message_still_parses_and_long_ones_are_cut() {
        assert_eq!(
            parse_line(r#"{"type":"fatal"}"#),
            Ok(Inbound::Fatal {
                message: "the launcher failed".into()
            })
        );
        let long = format!(r#"{{"type":"fatal","message":"{}"}}"#, "é".repeat(2_000));
        let Ok(Inbound::Fatal { message }) = parse_line(&long) else {
            panic!()
        };
        assert!(message.len() <= 2_000 && message.chars().all(|c| c == 'é'));
    }

    #[test]
    fn outbound_lines_are_single_json_lines() {
        let start = start_line("line one\nline two \"quoted\"");
        assert!(!start.contains('\n'));
        let v: Value = serde_json::from_str(&start).unwrap();
        assert_eq!(v, json!({"type":"start","request":"line one\nline two \"quoted\""}));
        assert_eq!(
            serde_json::from_str::<Value>(&resume_line("ses_1", 7)).unwrap(),
            json!({"type":"resume","sessionId":"ses_1","streamIndex":7})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&send_line("also check tests", Policy::Steer)).unwrap(),
            json!({"type":"send","text":"also check tests","policy":"steer"})
        );
        assert_eq!(Policy::parse("queue"), Some(Policy::Queue));
        assert_eq!(Policy::parse("now"), None);
        assert_eq!(
            serde_json::from_str::<Value>(&stop_line()).unwrap(),
            json!({"type":"stop"})
        );
        let token = token_line("tok.part-2_x");
        assert!(!token.contains('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&token).unwrap(),
            json!({"type":"token","modelToken":"tok.part-2_x"})
        );
    }

    #[test]
    fn line_and_paragraph_separators_are_escaped_so_node_sees_one_line() {
        let text = "one\u{2028}two\u{2029}three\r\nfour";
        for line in [start_line(text), send_line(text, Policy::Queue)] {
            // Node's readline line endings: \n, \r, U+2028, U+2029.
            assert!(!line.contains(['\n', '\r', '\u{2028}', '\u{2029}']), "{line:?}");
            assert!(line.contains("\\u2028") && line.contains("\\u2029"));
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(
                v[if v["type"] == "start" { "request" } else { "text" }],
                text,
                "same JSON value"
            );
        }
    }

    async fn lines(input: &[u8], cap: usize) -> Vec<CappedLine> {
        // A tiny buffer, so lines span several fill_buf calls.
        let mut r = tokio::io::BufReader::with_capacity(4, input);
        let mut buf = Vec::new();
        let mut out = Vec::new();
        loop {
            let l = read_capped_line(&mut r, &mut buf, cap).await.unwrap();
            let eof = l == CappedLine::Eof;
            out.push(l);
            if eof {
                return out;
            }
        }
    }

    #[tokio::test]
    async fn capped_reader_splits_lines_and_skips_long_ones_whole() {
        let got = lines(b"{\"a\":1}\r\n\nthis line is far too long\nok\nlast", 10).await;
        assert_eq!(
            got,
            vec![
                CappedLine::Line("{\"a\":1}".into()),
                CappedLine::Line(String::new()),
                CappedLine::TooLong(25),
                CappedLine::Line("ok".into()),
                CappedLine::Line("last".into()),
                CappedLine::Eof,
            ]
        );
        assert_eq!(lines(b"", 10).await, vec![CappedLine::Eof]);
        assert_eq!(
            lines(&[0xff, b'x', b'\n'], 10).await,
            vec![CappedLine::Line("\u{fffd}x".into()), CappedLine::Eof],
            "invalid UTF-8 is replaced, not fatal"
        );
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate("héllo", 2), "h");
        assert_eq!(truncate("héllo", 3), "hé");
        assert_eq!(truncate("abc", 10), "abc");
    }
}
