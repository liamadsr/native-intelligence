//! Board step 4: the person's own coding agent gets Native Intelligence's
//! workspace tools (read its card, comment, make follow-up cards, link a
//! pull request). Only for a job that has a worker: our own agent's
//! launches are exactly as before.
//!
//! The agent is fenced and its adapter holds no credential, so only the
//! desktop talks to the server, with the job's token (the one the pull
//! request route takes, [`super::push`]) and the app's own origin (the
//! launch config's, never one from the job or the agent). The adapter's
//! side is `web/agents/local-agent/workers/lib/workspace-tools.ts`, its
//! contract in that folder's README.
//!
//! 1. **The list**, at every launch of such a job (start, resume): `GET
//!    <origin>/api/local-agent/agent/tools` with the bearer, [`LIST_TIMEOUT`]
//!    at most, [`LIST_MAX`] bytes at most. A 200 whose body parses as JSON
//!    is written unchanged to `<app data>/local-agent/tools/<jobId>.json`
//!    (mode 0600, one per job, [`write_list`]) and handed over as
//!    `LOCAL_AGENT_TOOLS_FILE`. Anything else: no variable, the job runs as
//!    before, one log line (never the token). The file goes when the run
//!    ends, and at the app's start with the fence sweep.
//! 2. **A call**: the adapter's `tool_call` line ([`ToolCall::parse`]) is
//!    posted to `<origin>/api/local-agent/agent/tool` ([`call`], at most
//!    [`CALL_TIMEOUT`]; `callId`, `turnId` and `sessionId`, the job's id);
//!    a 200's `output` field is the answer, a refusal's `{ error, code }`
//!    is passed on; the answer is one `tool_result` line on its stdin,
//!    always under the adapter's [`RESULT_LINE_MAX`] (an output that doesn't
//!    fit is an `ok: false` saying so, never a cut JSON value).
//! 3. **Bounds** (the actor's, [`super::Actor`]): [`MAX_IN_FLIGHT`] calls per
//!    job (more are answered `BUSY`), only while the run is live and not
//!    stopping, the freshest token the job holds at each call; a stop or the
//!    run's end aborts the requests and writes nothing more. These lines are
//!    never events: the agent's own updates show each call already.
//!
//! Nothing here is platform-specific (HTTPS, stdio, a file in the app's data
//! folder); the file's 0600 mode is set on unix only.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Map, Value};

/// The list's request, at most.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(5);
/// The list's body, at most (the adapter's own cap).
pub const LIST_MAX: usize = 1024 * 1024;
/// One call's request, at most (the adapter waits 320 s).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(310);
/// A `tool_call` line, at most (the adapter's own cap).
pub const CALL_LINE_MAX: usize = 1024 * 1024;
/// A `tool_result` line is kept under this (the adapter's stdin cap for it).
pub const RESULT_LINE_MAX: usize = 4 * 1024 * 1024;
/// Calls with the server at once, per job.
pub const MAX_IN_FLIGHT: usize = 4;
/// The longest error sentence passed on (the adapter cuts to the same).
const MAX_ERROR: usize = 2_000;

/// What a coding agent's job posts as `sessionId`: the job's own id on the
/// server (the one the pull request route's URL names, [`super::push`]).
pub fn session_id_for(job_id: &str) -> Option<String> {
    Some(job_id.to_string())
}

/// This Mac's IANA zone for `timeZone`: the launch path has no way to get
/// one yet, so it is left out.
pub fn time_zone() -> Option<String> {
    None
}

pub fn list_url(origin: &str) -> String {
    format!("{}/api/local-agent/agent/tools", origin.trim_end_matches('/'))
}

pub fn call_url(origin: &str) -> String {
    format!("{}/api/local-agent/agent/tool", origin.trim_end_matches('/'))
}

/// `<root>/tools`: the app's own data folder, nothing the agent can write.
pub fn dir(root: &Path) -> PathBuf {
    root.join("tools")
}

pub fn list_path(root: &Path, job_id: &str) -> PathBuf {
    dir(root).join(format!("{job_id}.json"))
}

/// Read at most `max` bytes of `resp`'s body: `None` past it.
async fn body_within(mut resp: reqwest::Response, max: usize) -> Result<Option<Vec<u8>>, reqwest::Error> {
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Ok(None);
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if body.len() + chunk.len() > max {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

/// The tools list for a job's launch, as the server gave it, or why not
/// (a sentence for the log: never the token).
pub async fn fetch_list(origin: &str, token: Option<&str>) -> Result<Vec<u8>, String> {
    let token = token.ok_or("the job has no Native Intelligence token yet")?;
    let client = reqwest::Client::builder()
        .timeout(LIST_TIMEOUT)
        .build()
        .map_err(|_| "no HTTP client".to_string())?;
    let resp = client
        .get(list_url(origin))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "the list took over 5 s".to_string() } else { "Native Intelligence couldn't be reached".to_string() })?;
    let status = resp.status();
    if status != reqwest::StatusCode::OK {
        return Err(format!("the server answered HTTP {}", status.as_u16()));
    }
    let body = body_within(resp, LIST_MAX)
        .await
        .map_err(|e| if e.is_timeout() { "the list took over 5 s".to_string() } else { "the list couldn't be read".to_string() })?
        .ok_or_else(|| format!("the list is over {LIST_MAX} bytes"))?;
    serde_json::from_slice::<Value>(&body).map_err(|_| "the list isn't JSON".to_string())?;
    Ok(body)
}

/// Write the list for `job_id` (replacing any earlier one): its folder
/// 0700, the file 0600, whole or not at all.
pub fn write_list(root: &Path, job_id: &str, list: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let dir = dir(root);
    super::state::create_private_dir(&dir)?;
    let path = list_path(root, job_id);
    let tmp = dir.join(format!("{job_id}.json.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut f = open.open(&tmp)?;
    f.write_all(list)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// The job's list file goes (its run ended, or a launch has none).
pub fn remove_list(root: &Path, job_id: &str) {
    let _ = std::fs::remove_file(list_path(root, job_id));
    let _ = std::fs::remove_file(dir(root).join(format!("{job_id}.json.tmp")));
}

/// Every list file goes (the app's start: no run is live).
pub fn clear_lists(root: &Path) {
    let Ok(entries) = std::fs::read_dir(dir(root)) else { return };
    for e in entries.flatten() {
        if e.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// `^[A-Za-z0-9_-]{8,64}$`: a call's id and a turn's.
fn is_call_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`: a board tool's name, or one of
/// the person's connected MCP tools' (through `call_tool`). It only ever
/// goes into the request body's `toolName`.
fn is_tool_name(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=128).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(c))
}

/// `^[A-Z0-9_]{1,64}$`: a refusal's code.
fn is_code(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// One `tool_call` line from a coding agent's adapter.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Map<String, Value>,
    pub turn: String,
}

impl ToolCall {
    /// The line's fields, checked; why not, for a log line.
    pub fn parse(obj: &mut Map<String, Value>) -> Result<ToolCall, &'static str> {
        let text = |obj: &Map<String, Value>, k: &str| obj.get(k).and_then(Value::as_str).map(str::to_string);
        let id = text(obj, "id").filter(|s| is_call_id(s)).ok_or("id")?;
        let name = text(obj, "name").filter(|s| is_tool_name(s)).ok_or("name")?;
        let turn = text(obj, "turn").filter(|s| is_call_id(s)).ok_or("turn")?;
        let Some(Value::Object(input)) = obj.remove("input") else {
            return Err("input");
        };
        Ok(ToolCall { id, name, input, turn })
    }
}

/// `{"type":"tool_result","id","ok":true,"output"}`, or, when that line
/// would not fit the adapter's cap, an `ok: false` saying so.
pub fn ok_line(id: &str, output: Value) -> String {
    let line = super::protocol::to_line(json!({ "type": "tool_result", "id": id, "ok": true, "output": output }));
    if line.len() < RESULT_LINE_MAX {
        return line;
    }
    err_line(
        id,
        &format!("The tool's result was too large to pass to the agent ({} bytes).", line.len()),
        Some("RESULT_TOO_LARGE"),
    )
}

/// `{"type":"tool_result","id","ok":false,"error","code"?}`.
pub fn err_line(id: &str, error: &str, code: Option<&str>) -> String {
    let error = error.trim();
    let error: String = error.chars().filter(|c| !c.is_control()).take(MAX_ERROR).collect();
    let mut v = json!({ "type": "tool_result", "id": id, "ok": false, "error": error });
    if let Some(code) = code.filter(|c| is_code(c)) {
        v["code"] = Value::String(code.to_string());
    }
    super::protocol::to_line(v)
}

/// The JSON body the route reads.
pub fn call_body(call: &ToolCall, session_id: Option<String>, time_zone: Option<String>) -> Value {
    let mut body = json!({
        "toolName": call.name,
        "input": Value::Object(call.input.clone()),
        "callId": call.id,
        "turnId": call.turn,
    });
    if let Some(s) = session_id {
        body["sessionId"] = Value::String(s);
    }
    if let Some(tz) = time_zone {
        body["timeZone"] = Value::String(tz);
    }
    body
}

/// Post one call and make its answer line. Every failure is an answer
/// (the token never in it).
pub async fn call(origin: &str, token: &str, call: &ToolCall, body: Value) -> String {
    let unavailable = |why: &str| err_line(&call.id, why, Some("UNAVAILABLE"));
    let Ok(client) = reqwest::Client::builder().timeout(CALL_TIMEOUT).build() else {
        return unavailable("Native Intelligence couldn't be reached to run the tool.");
    };
    let resp = match client.post(call_url(origin)).bearer_auth(token).json(&body).send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => {
            return unavailable(&format!(
                "Native Intelligence didn't answer within {} s; the tool may still have run.",
                CALL_TIMEOUT.as_secs()
            ))
        }
        Err(_) => return unavailable("Native Intelligence couldn't be reached to run the tool."),
    };
    let status = resp.status();
    let raw = match body_within(resp, RESULT_LINE_MAX).await {
        Ok(Some(raw)) => raw,
        Ok(None) => {
            return err_line(
                &call.id,
                "The tool's result was too large to pass to the agent.",
                Some("RESULT_TOO_LARGE"),
            )
        }
        Err(_) => return unavailable("Native Intelligence's answer couldn't be read."),
    };
    let parsed: Option<Value> = serde_json::from_slice(&raw).ok();
    if status.is_success() {
        // `{ "output": <value> }`: the value is the answer (a tool's own
        // failure is inside it, and passed on as it is).
        return match parsed {
            Some(Value::Object(mut b)) if b.contains_key("output") => {
                ok_line(&call.id, b.remove("output").unwrap_or(Value::Null))
            }
            Some(_) => err_line(
                &call.id,
                "Native Intelligence answered without the tool's result.",
                Some("UNAVAILABLE"),
            ),
            None => unavailable("Native Intelligence's answer wasn't JSON."),
        };
    }
    let error = parsed
        .as_ref()
        .and_then(|b| b.get("error"))
        .and_then(Value::as_str)
        .filter(|e| !e.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Native Intelligence couldn't run the tool (HTTP {}).", status.as_u16()));
    let code = parsed.as_ref().and_then(|b| b.get("code")).and_then(Value::as_str);
    err_line(&call.id, &error, code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_call_line_is_checked_field_by_field() {
        let mut ok = json!({"type":"tool_call","id":"abcd1234","name":"get_action","input":{"id":"GEN-1"},"turn":"turn_0001"});
        let call = ToolCall::parse(ok.as_object_mut().unwrap()).unwrap();
        assert_eq!((call.id.as_str(), call.name.as_str(), call.turn.as_str()), ("abcd1234", "get_action", "turn_0001"));
        assert_eq!(call.input["id"], "GEN-1");
        // A connected MCP tool's name, through call_tool.
        for name in ["linear:create_issue", "Notion.search-pages", "1tool", &"x".repeat(128)] {
            let mut line = json!({"id":"abcd1234","name":name,"input":{},"turn":"turn_0001"});
            assert_eq!(ToolCall::parse(line.as_object_mut().unwrap()).unwrap().name, name);
        }
        for (bad, why) in [
            (json!({"id":"short","name":"x","input":{},"turn":"turn_0001"}), "id"),
            (json!({"id":"abcd 1234","name":"x","input":{},"turn":"turn_0001"}), "id"),
            (json!({"id":"a".repeat(65),"name":"x","input":{},"turn":"turn_0001"}), "id"),
            (json!({"id":"abcd1234","name":"_x","input":{},"turn":"turn_0001"}), "name"),
            (json!({"id":"abcd1234","name":"a b","input":{},"turn":"turn_0001"}), "name"),
            (json!({"id":"abcd1234","name":"a/b","input":{},"turn":"turn_0001"}), "name"),
            (json!({"id":"abcd1234","name":"x".repeat(129),"input":{},"turn":"turn_0001"}), "name"),
            (json!({"id":"abcd1234","name":"","input":{},"turn":"turn_0001"}), "name"),
            (json!({"id":"abcd1234","name":"x","input":[],"turn":"turn_0001"}), "input"),
            (json!({"id":"abcd1234","name":"x","turn":"turn_0001"}), "input"),
            (json!({"id":"abcd1234","name":"x","input":{}}), "turn"),
        ] {
            let mut bad = bad;
            assert_eq!(ToolCall::parse(bad.as_object_mut().unwrap()), Err(why), "{bad}");
        }
    }

    #[test]
    fn answer_lines_keep_to_the_contract() {
        let ok = ok_line("abcd1234", json!({"output": "done"}));
        assert_eq!(serde_json::from_str::<Value>(&ok).unwrap(), json!({"type":"tool_result","id":"abcd1234","ok":true,"output":{"output":"done"}}));
        let err = err_line("abcd1234", "  No such card.\n ", Some("NOT_FOUND"));
        assert_eq!(serde_json::from_str::<Value>(&err).unwrap(), json!({"type":"tool_result","id":"abcd1234","ok":false,"error":"No such card.","code":"NOT_FOUND"}));
        let odd = err_line("abcd1234", "x", Some("not-a-code"));
        assert!(serde_json::from_str::<Value>(&odd).unwrap().get("code").is_none());
        // Too big for the adapter's line: an ok:false, never a cut value.
        let big = ok_line("abcd1234", Value::String("x".repeat(RESULT_LINE_MAX)));
        assert!(big.len() < 1_000, "{}", big.len());
        let v: Value = serde_json::from_str(&big).unwrap();
        assert_eq!((v["ok"].clone(), v["code"].clone()), (json!(false), json!("RESULT_TOO_LARGE")));
        assert!(v["error"].as_str().unwrap().contains("too large"));
        // One line, whatever the text holds.
        let sep = ok_line("abcd1234", json!("a\u{2028}b\nc"));
        assert!(!sep.contains('\n') && !sep.contains('\u{2028}'));
    }

    #[test]
    fn the_body_is_what_the_route_reads() {
        let mut line = json!({"id":"abcd1234","name":"comment","input":{"text":"hi"},"turn":"turn_0001"});
        let call = ToolCall::parse(line.as_object_mut().unwrap()).unwrap();
        assert_eq!(
            call_body(&call, None, None),
            json!({"toolName":"comment","input":{"text":"hi"},"callId":"abcd1234","turnId":"turn_0001"})
        );
        let full = call_body(&call, Some("s".into()), Some("Europe/Paris".into()));
        assert_eq!((full["sessionId"].clone(), full["timeZone"].clone()), (json!("s"), json!("Europe/Paris")));
        assert_eq!(session_id_for("job-1"), Some("job-1".to_string()), "the job's own id");
    }

    #[test]
    fn the_list_file_is_private_and_goes_with_the_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_list(dir.path(), "job-1", br#"{"version":1}"#).unwrap();
        assert_eq!(path, dir.path().join("tools/job-1.json"));
        assert_eq!(std::fs::read(&path).unwrap(), br#"{"version":1}"#);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(dir.path().join("tools")).unwrap().permissions().mode() & 0o777, 0o700);
        }
        write_list(dir.path(), "job-1", b"[]").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"[]", "replaced whole");
        write_list(dir.path(), "job-2", b"[]").unwrap();
        remove_list(dir.path(), "job-1");
        assert!(!path.exists());
        clear_lists(dir.path());
        assert!(!list_path(dir.path(), "job-2").exists());
    }
}
