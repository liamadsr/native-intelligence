/**
 * Typed IPC bridge for communicating with the Tauri Rust backend.
 * Only functional when running inside the Tauri desktop app.
 */

import { isDesktopApp } from "./platform";
import { disposeAll, listenScoped, toSafeUnlisten } from "./tauri-unlisten";
import type { NudgeKind } from "./live-agent/nudge-channel";

// ── Types matching Rust audio::types ────────────────────────────

// ── Input device priority ───────────────────────────────────────
// The desktop owns an ordered list of every mic it has seen (settings.json
// store). When `customised`, the highest connected entry is used; otherwise
// the Mac's default input. A "for now" override (never saved) beats both
// until it's cleared, its mic is unplugged, or Native Intelligence quits. The web only
// renders the list, reorders it and sets or clears the override.

/** How an input device is connected (Rust `input_devices::Transport`). */
export type InputTransport =
  | "builtIn"
  | "bluetooth"
  | "usb"
  | "virtual"
  | "aggregate"
  | "continuity"
  | "display"
  | "other";

export interface InputDevice {
  /** CoreAudio device UID. */
  id: string;
  name: string;
  transport: InputTransport;
  /** Connected now. */
  available: boolean;
  /** The Mac's default input. */
  isDefault: boolean;
  /** The device in use while a stream runs, else the one the next start
   *  would pick (the override when one is set). At most one row. */
  active: boolean;
  /** A stream (meeting capture or voice session) is capturing on it now. */
  live: boolean;
  /** RFC 3339 UTC. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** Connected (`available` stays true) but can't hear: `lid_closed` is a
   *  MacBook's built-in mic while the lid is shut. Absent otherwise, and on
   *  desktops that predate it. */
  unavailableReason?: InputUnavailableReason;
}

/** Why a connected mic can't be used now (InputDevice.unavailableReason). */
export type InputUnavailableReason = "lid_closed";

export interface InputDevicesSnapshot {
  customised: boolean;
  /** The mic chosen "for now" (`set_input_override`), only while it's set
   *  and connected; null when there's none (or the desktop predates it). It
   *  never changes the order. Always one of `devices`. */
  overrideId: string | null;
  /** Priority order when customised; otherwise the default first, then
   *  other connected devices, then disconnected ones. */
  devices: InputDevice[];
}

export const INPUT_DEVICES_CHANGED_EVENT = "audio://input-devices-changed";

const INPUT_TRANSPORTS: readonly InputTransport[] = [
  "builtIn",
  "bluetooth",
  "usb",
  "virtual",
  "aggregate",
  "continuity",
  "display",
  "other",
];

/** One raw snapshot → typed, or null when it isn't one. Rows without an id
 *  are dropped; an unknown transport reads as "other"; at most one row keeps
 *  `active`; an `overrideId` that isn't a string naming one of the rows (or
 *  is absent: an older desktop) reads as null; an `unavailableReason` other
 *  than `lid_closed` is dropped. */
export function toInputDevicesSnapshot(raw: unknown): InputDevicesSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.customised !== "boolean" || !Array.isArray(r.devices)) return null;
  const devices: InputDevice[] = [];
  const seen = new Set<string>();
  let activeSeen = false;
  for (const d of r.devices) {
    if (!d || typeof d !== "object") continue;
    const v = d as Record<string, unknown>;
    if (typeof v.id !== "string" || !v.id || seen.has(v.id)) continue;
    seen.add(v.id);
    const active = v.active === true && !activeSeen;
    if (active) activeSeen = true;
    const device: InputDevice = {
      id: v.id,
      name: typeof v.name === "string" && v.name ? v.name : v.id,
      transport: INPUT_TRANSPORTS.includes(v.transport as InputTransport)
        ? (v.transport as InputTransport)
        : "other",
      available: v.available === true,
      isDefault: v.isDefault === true,
      active,
      live: active && v.live === true,
      firstSeenAt: typeof v.firstSeenAt === "string" ? v.firstSeenAt : "",
      lastSeenAt: typeof v.lastSeenAt === "string" ? v.lastSeenAt : "",
    };
    // Only a reason this web knows; anything else reads as none.
    if (v.unavailableReason === "lid_closed") device.unavailableReason = "lid_closed";
    devices.push(device);
  }
  const overrideId =
    typeof r.overrideId === "string" && seen.has(r.overrideId) ? r.overrideId : null;
  return { customised: r.customised, overrideId, devices };
}

/** Thrown when the desktop answers something that isn't a snapshot. */
class InputDevicesMalformedError extends Error {
  constructor(cmd: string) {
    super(`${cmd}: malformed input-devices snapshot`);
    this.name = "InputDevicesMalformedError";
  }
}

/** An input-devices command this desktop build doesn't have (Tauri's
 *  "Command <cmd> not found", or "not allowed" under an ACL): an older
 *  desktop, not a refusal. */
export class InputDevicesCommandMissingError extends Error {
  readonly command: string;
  constructor(command: string, detail: string) {
    super(detail);
    this.name = "InputDevicesCommandMissingError";
    this.command = command;
  }
}

/** A newer signed desktop build ([`tauriBridge.checkForUpdate`]). */
export interface BinaryUpdate {
  available: true
  version: string
  /** Download, verify and install it; the person restarts to apply. */
  install: () => Promise<void>
  /**
   * 'rust': this build's own commands; a rejection means nothing was installed.
   * 'plugin': a build from before them; its install can reject yet still have
   * installed (the plugin's known quirk), so a rejection there isn't final.
   */
  via: 'rust' | 'plugin'
}

function isMissingCommand(cmd: string, err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return text.includes(cmd) && /\bnot (found|allowed)\b/i.test(text) ? text : null;
}

async function invokeInputDevices(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<InputDevicesSnapshot> {
  if (!isDesktopApp()) throw new Error("input devices: not in the desktop app");
  let raw: unknown;
  try {
    raw = await invoke<unknown>(cmd, args);
  } catch (e) {
    const missing = isMissingCommand(cmd, e);
    throw missing ? new InputDevicesCommandMissingError(cmd, missing) : e;
  }
  const snap = toInputDevicesSnapshot(raw);
  if (!snap) throw new InputDevicesMalformedError(cmd);
  return snap;
}

/**
 * Outcome of the system-audio stream for a session. Mirrors the Rust
 * `SystemAudioStatus` enum (serde camelCase). Lets the UI warn the user when a
 * meeting is recording mic-only instead of silently dropping other
 * participants' audio.
 * - `capturing`        — system audio is recording normally
 * - `disabled`         — user chose mic-only; system audio not requested
 * - `permissionDenied` — requested, but the System Audio Recording (Audio
 *                        Capture) permission is missing
 * - `unavailable`      — requested, but the capture backend is missing/stale
 * - `failed`           — requested and available, but capture failed to start
 */
export type SystemAudioStatus =
  | "capturing"
  | "disabled"
  | "permissionDenied"
  | "unavailable"
  | "failed";

/** Speech-to-text engine for a recording session. */
export type TranscriptionEngine = "deepgram" | "local";

export interface RecordingSession {
  sessionId: string;
  startedAt: string;
  /** The name of the mic the desktop picked, or null for the system default. */
  micDevice: string | null;
  capturingSystemAudio: boolean;
  systemAudioStatus: SystemAudioStatus;
  /** The engine the desktop actually started. Only desktops with Local
   *  Modules send it — missing means "deepgram". `local` is answered only
   *  when `transcription: 'local'` was requested and the module is ready. */
  transcriptionEngine?: TranscriptionEngine;
  /** Why a requested local engine was not used (e.g. module not ready). */
  transcriptionFallbackReason?: string | null;
}

// ── Local modules (bridge contract v1) ──────────────────────────
// On-device sidecars the desktop can download and run (local-stt first).
// Every command is optional on the web side: the website deploys ahead of the
// desktop, and a build without Local Modules must read as "no modules".

/** 'unavailable' = the module's sidecar binary is missing from this build. */
export type LocalModuleState =
  | "off"
  | "downloading"
  | "verifying"
  | "warming"
  | "ready"
  | "error"
  | "unavailable";

export interface LocalModuleInfo {
  /** e.g. 'local-stt' */
  id: string;
  /** Sidecar / upstream version label. */
  version: string;
  /** Persisted device-local setting. */
  enabled: boolean;
  state: LocalModuleState;
  /** 0..1 while downloading, else null. */
  progress: number | null;
  /** Total asset size in bytes (for "~800 MB"). */
  downloadBytes: number;
  /** Verified assets are on disk. */
  assetsPresent: boolean;
  error: string | null;
}

/** `system_info` (desktop 0.2.73+): the Mac the app runs on. Each field is
 *  null when the desktop can't read it. */
export interface DesktopSystemInfo {
  /** e.g. "15.6.1" (kern.osproductversion). */
  macosVersion: string | null;
  /** e.g. "Apple M2 Max" (machdep.cpu.brand_string). */
  chip: string | null;
  /** The architecture the app runs as: "aarch64" or "x86_64". */
  arch: string;
  /** Physical memory in bytes (hw.memsize). */
  memoryBytes: number | null;
  /** The app runs translated by Rosetta 2. */
  rosetta: boolean;
}

// Every stt:// payload carries `session` — the RecordingSession.sessionId of
// the recording it belongs to — so a previous session's late events can never
// land in the next one. Optional on the type only for tolerance.

/** `stt://message` — a Deepgram-shaped live message from the local engine
 *  (`Results` | `SpeechStarted` | `UtteranceEnd`); speaker is a 0-based index,
 *  times are seconds on that stream's audio clock. */
export interface SttMessagePayload {
  session?: string;
  stream: "mic" | "system";
  message: unknown;
}

/** `stt://engine-changed` — the local engine failed (didn't load, or crashed);
 *  transcribe the rest of the session with Deepgram. */
export interface SttEngineChangedPayload {
  session?: string;
  engine: "deepgram";
  reason: string;
}

/** `stt://finished` — the session's transcript tail is out after a stop. */
export interface SttFinishedPayload {
  session?: string;
}

// ── Read anywhere: the desktop's system-wide read-selection hotkey ──────
// Select text in any app and press the hotkey to hear it in the local-tts
// voice (desktop/src-tauri/src/read_selection.rs). Off until turned on
// in Settings → Voice → Read anywhere, which is also the only place Native Intelligence asks
// for the Accessibility permission it needs (no other feature uses it).

export interface ReadSelectionHotkey {
  id: string;
  /** e.g. "⌃⌥R" */
  label: string;
}

/** `read-selection://convert`: Read anywhere's text from a chat or mail app,
 *  for the web to read as who said what (lib/read-aloud/read-anywhere-chat.ts). */
export interface ReadSelectionConvertPayload {
  /** The press it belongs to; send it back with the sentences. */
  run: number;
  text: string;
  /** The app's bundle id, e.g. "com.microsoft.teams2". */
  app: string;
}

/** Dictate anywhere's settings and permission state (desktop `dictate_status`). */
export interface DictateStatus {
  /** This desktop build has it (macOS). */
  supported: boolean;
  enabled: boolean;
  /** The Accessibility permission: watching right ⌥, reading the field. */
  accessibility: boolean;
  /** macOS lets Native Intelligence post ⌘V. */
  keystrokes: boolean;
  /** On, but right ⌥ can't be watched: "needs_permission" or "no_event_tap". */
  error: string | null;
}

/** `dictate://toggle`: what the dictation panel should do for press `run`
 *  (desktop dictate.rs `Act`): listen (`start`, or `start_agent` for words that
 *  go to the agent), `to_agent` (the press became a hold), `stop` (paste),
 *  `send` (to the agent), `cancel`, or `close` (the conversation's circle). */
export type DictateAction = "start" | "start_agent" | "to_agent" | "tapped" | "stop" | "send" | "cancel" | "close";
const DICTATE_ACTIONS: readonly DictateAction[] = ["start", "start_agent", "to_agent", "tapped", "stop", "send", "cancel", "close"];
export interface DictateTogglePayload {
  run: number;
  action: DictateAction;
}

/** The agent's progress on words sent from the panel (`dictate://agent`,
 *  relayed from the main window's `talk_state`). */
export type TalkAgentState = "thinking" | "speaking" | "done" | "failed";
const TALK_AGENT_STATES: readonly TalkAgentState[] = ["thinking", "speaking", "done", "failed"];

/** Where the dictated words went: pasted, or left on the clipboard and why. */
export interface DictatePasteResult {
  pasted: boolean;
  /** "secure_input" (a password field), "focus_changed", "no_keys", "stale". */
  reason: string | null;
}

const DICTATE_UNSUPPORTED: DictateStatus = { supported: false, enabled: false, accessibility: false, keystrokes: false, error: null };

export interface ReadSelectionStatus {
  /** This desktop build can read selections (macOS, 0.2.82+). */
  supported: boolean;
  enabled: boolean;
  /** macOS has granted the Accessibility permission: reading selections.
   *  The feature can't be turned on without it. */
  accessibility: boolean;
  /** macOS lets Native Intelligence send ⌘C, which reads terminals like Warp. The same
   *  System Settings switch grants it. */
  keystrokes: boolean;
  /** A preset id from `hotkeys`, or "custom" for the recorded shortcut. */
  hotkey: string;
  /** The current shortcut, e.g. "⌃⌥R". */
  hotkeyLabel: string;
  hotkeys: ReadSelectionHotkey[];
  /** The recorded shortcut's label, kept while a preset is picked. */
  customHotkeyLabel: string | null;
  /** null: the catalogue default voice. */
  voice: string | null;
  /** The hotkey is on but another app holds it. */
  hotkeyError: string | null;
}

const READ_SELECTION_UNSUPPORTED: ReadSelectionStatus = {
  supported: false,
  enabled: false,
  accessibility: false,
  keystrokes: false,
  hotkey: "",
  hotkeyLabel: "",
  hotkeys: [],
  customHotkeyLabel: null,
  voice: null,
  hotkeyError: null,
};

/** Why recording a shortcut (`readSelectionRecordHotkey`) didn't take. The
 *  rejection is `code` or `code:label` (the keys pressed). */
export type ReadSelectionHotkeyRefusal =
  | "unknown_key"
  | "needs_modifier"
  | "option_only"
  | "taken"
  | "cancelled"
  | "timeout"
  | "no_tap";

// ── Read-aloud: the local-tts module (docs/plans/local-modules.md §3.4) ──
// Optional like the rest of the bridge: a desktop without the tts_* commands
// (or the browser) reads as "unsupported", never as an error.

/** Why the desktop refused `tts_speak`. `unavailable` also covers a desktop
 *  build without the command. `text_too_long`: this one sentence is over the
 *  desktop's size limit (4,000 bytes); the next one can still be spoken. */
export type TtsRefusal = "recording" | "not_ready" | "unavailable" | "text_too_long";

/** One utterance's lifecycle on `tts://state`. `done` fires after its audio
 *  actually finished playing. */
export type TtsUtteranceState = "queued" | "speaking" | "done" | "cancelled" | "error";

export interface TtsStatePayload {
  /** The id the web gave `tts_speak`. */
  id: string;
  state: TtsUtteranceState;
  error?: string;
}

/** A voice compiled into the desktop's local-tts sidecar. */
export interface TtsVoice {
  id: string;
  name: string;
  description: string;
  /** The catalogue default (used when `tts_speak` gets no voice). */
  default: boolean;
}

/** `tts_speak` was refused (or can't run on this build). */
export class TtsRefusedError extends Error {
  readonly code: TtsRefusal;
  constructor(code: TtsRefusal, detail?: string) {
    super(detail && detail !== code ? `${code}: ${detail}` : code);
    this.name = "TtsRefusedError";
    this.code = code;
  }
}

const TTS_REFUSALS: readonly TtsRefusal[] = ["recording", "not_ready", "unavailable", "text_too_long"];
const TTS_STATES: readonly TtsUtteranceState[] = ["queued", "speaking", "done", "cancelled", "error"];

/** A rejected tts_speak → its refusal code; anything unrecognised (e.g.
 *  "command tts_speak not found" on an older desktop) → unavailable. */
function ttsRefusal(err: unknown): TtsRefusedError {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code = TTS_REFUSALS.find((c) => text === c || text.startsWith(`${c}:`)) ?? "unavailable";
  return new TtsRefusedError(code, text || undefined);
}

function toTtsVoice(raw: unknown): TtsVoice | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;
  return {
    id: v.id,
    name: typeof v.name === "string" && v.name ? v.name : v.id,
    description: typeof v.description === "string" ? v.description : "",
    default: v.default === true,
  };
}

// ── Local agents: our eve agent on the Mac ────────────────────────
// docs/plans/local-agents.md §8, L0 contract §4, L1 contract C. The desktop
// runs one launcher process per job and relays its NormalizedEvents on
// `local-agent://event`; the main window's relay (src/lib/local-agent/
// relay-core.ts) carries them to the server. A desktop without local agents
// (or the browser) answers `unavailable` instead of throwing.

export const LOCAL_AGENT_EVENT = "local-agent://event";

/** A job's lifecycle (Rust state.json). `waiting`: the turn ended and the
 *  agent is idle, waiting for a message. `interrupted`: the launcher exited
 *  (app quit, crash) with the session left to resume. */
export type LocalAgentJobStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** How a message reaches a running turn: `steer` lands mid-turn, `queue`
 *  waits for the turn to end. Idle, either one starts a new turn. */
export type LocalAgentPolicy = "steer" | "queue";

export type LocalAgentMode = "read" | "edit";

/** A folder the person granted through the native picker. */
export interface LocalAgentGrant {
  id: string;
  /** realpath */
  path: string;
  /** basename */
  label: string;
  /** `edit` only from the native "Allow changes" confirm, for a git repo
   *  root (l1-contract C2); anything else is `read`. */
  mode: LocalAgentMode;
  addedAt: string;
  /** The folder is the root of a git work tree (refreshed on every status). */
  isGit: boolean;
}

export interface LocalAgentJob {
  id: string;
  grantId: string;
  request: string;
  /** What the job runs as: at most its grant's mode. */
  mode: LocalAgentMode;
  /** The eve session, once the launcher created or attached it. */
  sessionId: string | null;
  streamIndex: number | null;
  status: LocalAgentJobStatus;
  /** A launcher process runs for it now, or one is being got ready (its
   *  worktree, or a coding agent's confirm on the Mac). It can outlive a
   *  terminal status (`failed`), so Stop and send go by this, not by `status`. */
  live: boolean;
  /** The coding agent it runs on (`claude-code`, `codex`): its launches wait
   *  for the person's yes on the Mac. Absent: Native Intelligence's agent, or an older desktop. */
  worker?: string | null;
  /** Its coding agent's confirm is up on the Mac: another one's launch would
   *  be refused for now. */
  asking?: boolean;
  /** The highest event seq the desktop holds for it; null (or 0 on an L1
   *  desktop) before any. */
  lastSeq: number | null;
  /** The launcher process running it now, or the last one (l1-contract C6). */
  runId: string | null;
  /** Edit jobs: the branch, and the last commit the desktop made on it. */
  branch: string | null;
  commit: string | null;
  createdAt: string;
  endedAt: string | null;
}

/** `local_agent_device`: this Mac for the server's device registry. The id is
 *  a uuid the desktop made once; `name` is the Mac's own name. */
export interface LocalAgentDevice {
  deviceId: string;
  name: string;
  platform: string;
  appVersion: string;
}

/** The server's record of a job's eve session, for a start when the desktop
 *  has no record of its own (state loss). */
export interface LocalAgentResumeArgs {
  eveSessionId: string;
  streamIndex: number;
}

/** `local_agent_start` (l1-contract C3). The folder always comes from the
 *  grant, and the model relay URL from the app's own origin, never from here. */
export interface LocalAgentStartArgs {
  grantId: string;
  request: string;
  /** The server's session uuid; absent, the desktop makes a local id. */
  jobId?: string;
  /** At most the grant's mode; absent, read. */
  mode?: LocalAgentMode;
  /** The model relay's token for this session (≤ 2 KB, opaque). */
  modelToken?: string | null;
  resume?: LocalAgentResumeArgs | null;
  /** The model the server recorded this session on (teammate plan): the desktop
   *  launches on it, or refuses. Absent: an older server. */
  localModel?: boolean | null;
  /** An edit job's base branch (environments E3): a local branch name the
   *  desktop resolves itself (`refs/heads/<name>`, exact, no symref, a commit)
   *  and branches from, naming it in the push prompt. Absent or null: HEAD.
   *  Sent only to a desktop whose status says `baseBranch: true`. */
  baseBranch?: string | null;
}

/** What start and resume answer: the job and the launcher process now running
 *  it. `runId` is null only on an L0 desktop, which has none. */
export interface LocalAgentRun {
  jobId: string;
  runId: string | null;
}

/** `local_agent_status`. `available: false` (with a reason) on a release
 *  build, without dev.json, on a desktop without the command, or outside it. */
export interface LocalAgentStatus {
  available: boolean;
  reason: string | null;
  node: string | null;
  agentDir: string | null;
  /** `.output/server/index.mjs` exists (the agent was built). */
  built: boolean;
  grants: LocalAgentGrant[];
  jobs: LocalAgentJob[];
  /** This Mac runs its jobs on a model on the Mac (Ollama, LM Studio), not the
   *  Native Intelligence relay (teammate plan, L4). Absent: a desktop that doesn't say. The
   *  relay passes it with a claim; C1 narrows the tools by it. */
  localModel?: boolean;
  /** This desktop resolves an edit job's base branch itself (environments E3,
   *  `local_agent_status`'s top-level `baseBranch: true`). The relay tells the
   *  server in its heartbeat (`capabilities`). Absent: an older desktop, which
   *  branches from HEAD. */
  baseBranch?: boolean;
}

/** The launcher's NormalizedEvent (contract §1), plus the desktop's own
 *  `status` with a `reason` when the process exits, and its own `branch`
 *  after it commits an edit job's changes (l1-contract C5). `input` /
 *  `output` are JSON text, truncated by the launcher (2 KB / 4 KB). A kind
 *  this build doesn't know passes through as `other`, with the event as the
 *  desktop sent it in `raw` (the relay uploads that as is). */
export type LocalAgentEvent =
  | { kind: "status"; status: LocalAgentJobStatus; reason?: string }
  | { kind: "text"; delta: string }
  | { kind: "message"; text: string }
  | { kind: "tool"; callId: string; name: string; input: string }
  | { kind: "tool_result"; callId: string; name: string; ok: boolean; output: string }
  | { kind: "report"; text: string }
  | { kind: "ask"; question: string }
  | { kind: "finish"; summary: string }
  | { kind: "error"; message: string }
  | {
      kind: "branch";
      branch: string;
      commit: string;
      filesChanged: number;
      insertions: number;
      deletions: number;
    }
  | { kind: "other"; name: string; raw: Record<string, unknown> };

/** One event of one job; `seq` is monotonic per job (the desktop's ring)
 *  within an app run, across the job's runs. `runId` is the launcher process
 *  it came from (l1-contract C6); absent on an L0 desktop. */
export interface LocalAgentEventEnvelope {
  jobId: string;
  seq: number;
  runId?: string;
  event: LocalAgentEvent;
}

/** A local_agent_* call's outcome; never a rejection. `unavailable`: not in
 *  the desktop, a build without the command, or the desktop says local
 *  agents are off. Otherwise `error` is the desktop's refusal or a malformed
 *  answer. */
export type LocalAgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: boolean; error: string };

export const LOCAL_AGENT_OFF_DESKTOP = "local agents run only in the Native Intelligence desktop app";

const LOCAL_AGENT_JOB_STATUSES: readonly LocalAgentJobStatus[] = [
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

function isLocalAgentJobStatus(v: unknown): v is LocalAgentJobStatus {
  return LOCAL_AGENT_JOB_STATUSES.includes(v as LocalAgentJobStatus);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** RFC 3339 passes through; epoch seconds or ms become ISO; else "". */
function toLocalAgentTimestamp(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const ms = v < 1e11 ? v * 1000 : v;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** Tool input / output as text: strings pass, anything else as JSON. */
function toLocalAgentJsonText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

export function toLocalAgentGrant(raw: unknown): LocalAgentGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = nonEmptyString(r.id);
  const path = nonEmptyString(r.path);
  if (!id || !path) return null;
  return {
    id,
    path,
    label: nonEmptyString(r.label) ?? path.split("/").filter(Boolean).pop() ?? path,
    mode: r.mode === "edit" ? "edit" : "read",
    addedAt: toLocalAgentTimestamp(r.addedAt),
    isGit: r.isGit === true,
  };
}

function localAgentCount(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export function toLocalAgentJob(raw: unknown): LocalAgentJob | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = nonEmptyString(r.id);
  if (!id || !isLocalAgentJobStatus(r.status)) return null;
  return {
    id,
    grantId: typeof r.grantId === "string" ? r.grantId : "",
    request: typeof r.request === "string" ? r.request : "",
    mode: r.mode === "edit" ? "edit" : "read",
    sessionId: nonEmptyString(r.sessionId),
    streamIndex: localAgentCount(r.streamIndex),
    status: r.status,
    live: r.live === true,
    lastSeq: localAgentCount(r.lastSeq),
    runId: nonEmptyString(r.runId),
    ...(nonEmptyString(r.worker) ? { worker: nonEmptyString(r.worker) } : {}),
    ...(r.asking === true ? { asking: true } : {}),
    branch: nonEmptyString(r.branch),
    commit: nonEmptyString(r.commit),
    createdAt: toLocalAgentTimestamp(r.createdAt),
    endedAt: r.endedAt == null ? null : toLocalAgentTimestamp(r.endedAt) || null,
  };
}

/** `local_agent_device`'s answer → typed, or null without an id. */
export function toLocalAgentDevice(raw: unknown): LocalAgentDevice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const deviceId = nonEmptyString(r.deviceId);
  if (!deviceId) return null;
  return {
    deviceId,
    name: nonEmptyString(r.name) ?? "Mac",
    platform: nonEmptyString(r.platform) ?? "macos",
    appVersion: typeof r.appVersion === "string" ? r.appVersion : "",
  };
}

/** start / resume's `{ jobId, runId }`. An L0 desktop's resume answers null
 *  and its start has no runId: both read as `runId: null`. */
function toLocalAgentRun(raw: unknown, fallbackJobId?: string): LocalAgentRun | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const jobId = nonEmptyString(r.jobId) ?? fallbackJobId ?? null;
  return jobId ? { jobId, runId: nonEmptyString(r.runId) } : null;
}

function unavailableLocalAgentStatus(reason: string): LocalAgentStatus {
  return { available: false, reason, node: null, agentDir: null, built: false, grants: [], jobs: [] };
}

/** One raw status → typed, or null when it isn't one. Malformed grants and
 *  jobs are dropped, duplicates (by id) keep the first. */
export function toLocalAgentStatus(raw: unknown): LocalAgentStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.available !== "boolean") return null;
  const dedupe = <T extends { id: string }>(list: unknown, to: (v: unknown) => T | null): T[] => {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of list) {
      const v = to(item);
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
    return out;
  };
  return {
    available: r.available,
    reason: nonEmptyString(r.reason),
    node: nonEmptyString(r.node),
    agentDir: nonEmptyString(r.agentDir),
    built: r.built === true,
    grants: dedupe(r.grants, toLocalAgentGrant),
    jobs: dedupe(r.jobs, toLocalAgentJob),
    ...localModelOf(r),
    ...(r.baseBranch === true ? { baseBranch: true } : {}),
  };
}

/** `localModel: true|false` or `model: { kind: "local" | "relay" }`, when the desktop says. */
function localModelOf(r: Record<string, unknown>): { localModel?: boolean } {
  if (typeof r.localModel === "boolean") return { localModel: r.localModel };
  const kind = r.model && typeof r.model === "object" ? (r.model as Record<string, unknown>).kind : undefined;
  return kind === "local" ? { localModel: true } : kind === "relay" ? { localModel: false } : {};
}

/** One raw NormalizedEvent → typed; null for a known kind with a field of
 *  the wrong type, or no kind at all. An unknown kind passes through as
 *  `other` (a newer desktop's event must still reach the server). */
export function toLocalAgentEvent(raw: unknown): LocalAgentEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "status": {
      if (!isLocalAgentJobStatus(r.status)) return null;
      const reason = nonEmptyString(r.reason);
      return reason ? { kind: "status", status: r.status, reason } : { kind: "status", status: r.status };
    }
    case "text":
      return typeof r.delta === "string" ? { kind: "text", delta: r.delta } : null;
    case "message":
      return typeof r.text === "string" ? { kind: "message", text: r.text } : null;
    case "tool": {
      const callId = nonEmptyString(r.callId);
      if (!callId || typeof r.name !== "string") return null;
      return { kind: "tool", callId, name: r.name, input: toLocalAgentJsonText(r.input) };
    }
    case "tool_result": {
      const callId = nonEmptyString(r.callId);
      if (!callId || typeof r.ok !== "boolean") return null;
      return {
        kind: "tool_result",
        callId,
        name: typeof r.name === "string" ? r.name : "",
        ok: r.ok,
        output: toLocalAgentJsonText(r.output),
      };
    }
    case "report":
      return typeof r.text === "string" ? { kind: "report", text: r.text } : null;
    case "ask":
      return typeof r.question === "string" ? { kind: "ask", question: r.question } : null;
    case "finish":
      return typeof r.summary === "string" ? { kind: "finish", summary: r.summary } : null;
    case "error":
      return typeof r.message === "string" ? { kind: "error", message: r.message } : null;
    case "branch": {
      const branch = nonEmptyString(r.branch);
      const commit = nonEmptyString(r.commit);
      if (!branch || !commit) return null;
      return {
        kind: "branch",
        branch,
        commit,
        filesChanged: localAgentCount(r.filesChanged) ?? 0,
        insertions: localAgentCount(r.insertions) ?? 0,
        deletions: localAgentCount(r.deletions) ?? 0,
      };
    }
    default: {
      const name = nonEmptyString(r.kind);
      return name ? { kind: "other", name, raw: { ...r } } : null;
    }
  }
}

/** `{ jobId, seq, runId, event }` → typed, or null. `local_agent_events` rows
 *  carry no jobId: pass the one asked for as `jobId`. */
export function toLocalAgentEnvelope(raw: unknown, jobId?: string): LocalAgentEventEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = jobId ?? nonEmptyString(r.jobId);
  if (!id) return null;
  if (typeof r.seq !== "number" || !Number.isSafeInteger(r.seq) || r.seq < 0) return null;
  const event = toLocalAgentEvent(r.event);
  if (!event) return null;
  const runId = nonEmptyString(r.runId);
  return runId ? { jobId: id, seq: r.seq, runId, event } : { jobId: id, seq: r.seq, event };
}

const LOCAL_AGENT_MALFORMED = Symbol("malformed");

function localAgentErrorText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : "";
}

/** invoke for local_agent_*: never rejects (see LocalAgentResult). `parse`
 *  answers LOCAL_AGENT_MALFORMED for a reply it can't read. */
async function invokeLocalAgent<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  parse: (raw: unknown) => T | typeof LOCAL_AGENT_MALFORMED,
): Promise<LocalAgentResult<T>> {
  if (!isDesktopApp()) return { ok: false, unavailable: true, error: LOCAL_AGENT_OFF_DESKTOP };
  let raw: unknown;
  try {
    raw = await invoke<unknown>(cmd, args);
  } catch (e) {
    const missing = isMissingCommand(cmd, e);
    if (missing) return { ok: false, unavailable: true, error: missing };
    const text = localAgentErrorText(e);
    return { ok: false, unavailable: /^unavailable\b/i.test(text), error: text || `${cmd} failed` };
  }
  // Without dev.json every command answers `{ available: false, reason }`.
  if (raw && typeof raw === "object" && (raw as { available?: unknown }).available === false) {
    const reason = nonEmptyString((raw as { reason?: unknown }).reason);
    return { ok: false, unavailable: true, error: reason ?? "local agents are unavailable" };
  }
  const value = parse(raw);
  if (value === LOCAL_AGENT_MALFORMED) return { ok: false, unavailable: false, error: `${cmd}: malformed answer` };
  return { ok: true, value };
}

const ignoreLocalAgentReply = (): void => undefined;

/** This Mac's exit for the agent's cloud browser (browser_exit.rs), as the desktop reports it. */
export interface BrowserExitStatus {
  state: "off" | "connecting" | "up" | "down";
  /** The tunnel ended with its token: ask the server for a fresh one if the browser still runs. */
  needsToken: boolean;
  sitesToday: { host: string; count: number }[];
}

export function toBrowserExitStatus(raw: unknown): BrowserExitStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const state = r.state === "connecting" || r.state === "up" || r.state === "down" ? r.state : "off";
  const sites = Array.isArray(r.sitesToday) ? r.sitesToday : [];
  return {
    state,
    needsToken: r.needsToken === true,
    sitesToday: sites
      .filter((site): site is { host: string; count: number } =>
        !!site && typeof (site as { host?: unknown }).host === "string" && typeof (site as { count?: unknown }).count === "number")
      .map(({ host, count }) => ({ host, count })),
  };
}

/** A browser_exit_* command: its status, or null on a desktop without them. `rethrow`: the desktop's refusal as an Error. */
async function invokeBrowserExit(cmd: string, args?: Record<string, unknown>, rethrow = false): Promise<BrowserExitStatus | null> {
  if (!isDesktopApp()) return null;
  try {
    return toBrowserExitStatus(await invoke<unknown>(cmd, args));
  } catch (e) {
    if (isMissingCommand(cmd, e) || !rethrow) return null;
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} failed`);
  }
}

// ── Chat voice: dictation and voice mode (docs/plans/chat-voice.md §3.3) ──
// Optional like read-aloud: a desktop without `voice_status` (or the browser)
// reads as unavailable and the web renders no voice control at all.

/** One local module's state as `voice_status` reports it. */
export type VoiceModuleState = "ready" | "missing" | "downloading" | "unsupported" | "error";

export interface VoiceStatus {
  /** This desktop build has chat voice at all. False hides every control. */
  available: boolean;
  /** Dictation can start now (local-stt ready). */
  dictation: boolean;
  /** Voice mode can start now (local-stt and local-tts ready). */
  conversation: boolean;
  stt: VoiceModuleState;
  tts: VoiceModuleState;
  reason?: string;
  /** The `noiseProfile`s voice_start understands; absent before 0.2.46. The
   *  web asks for "quiet" only (lib/voice/settings.ts VOICE_NOISE_PROFILE). */
  noiseProfiles?: string[];
  /** `voice://state` carries `ready` (absent before 0.2.46): the start sounds
   *  follow it instead of inferring readiness from the state. */
  readyFlag?: boolean;
  /** This desktop runs Interactive mode's session (`voice_start` mode
   *  `interactive`, `voice_set_barge`). Absent on older desktops: Interactive
   *  then only reads (components/read-aloud/interactive-voice-host.tsx). */
  interactive?: boolean;
  /** `voice_start` takes `speechAudio` and the session then sends each run's
   *  first seconds of speech as `voice://speech` (Voice focus,
   *  lib/voice/voice-focus.ts), and `voice_log` exists. Absent on older
   *  desktops. */
  speechAudio?: boolean;
}

/** `interactive`: Interactive mode's background session (listen mode that
 *  listens for the assistant's name). It never idle-ends, emits every end of
 *  turn as `voice://turn` and goes straight back to listening (no reply wait),
 *  and starts with the barge policy `wake`. */
export type VoiceMode = "dictation" | "conversation" | "interactive";

/** What user speech over audible agent speech does (`voice_set_barge`):
 *  `speech` cancels the speech (`voice://interrupted`) and the turn goes on,
 *  as in voice mode; `wake` opens a turn that is transcribed and emitted but
 *  leaves the speech playing (the web decides: on the assistant's name it
 *  pauses the reading itself); `off` opens no turn. */
export type VoiceBargePolicy = "speech" | "wake" | "off";

/** How voice mode and dictation filter background speech (voice_start
 *  `noiseProfile`). `auto` starts quiet and switches to noisy when it hears
 *  voices in the background; a desktop that doesn't know a value runs quiet. */
export type VoiceNoiseProfile = "auto" | "quiet" | "noisy";

/** The room a session runs now (`voice://state` `noiseMode`): under auto,
 *  `quiet` until it switches. */
export type VoiceNoiseMode = "quiet" | "noisy";

/** Why the desktop refused `voice_start`. `unavailable` also covers a desktop
 *  build without the command. */
export type VoiceRefusal = "recording" | "busy" | "not_ready" | "mic_denied" | "unavailable";

export type VoiceSessionState =
  | "starting"
  | "listening"
  | "user_speaking"
  | "processing"
  | "agent_speaking"
  | "muted";

export type VoiceEchoState = "cancelling" | "converging" | "half_duplex" | "headphones";

export type VoiceEndReason = "stopped" | "cancelled" | "recording" | "page" | "idle" | "device" | "error";

/** Every `voice://*` event, tagged by its name (the payload minus sessionId). */
export type VoiceEvent =
  | {
      type: "state";
      state: VoiceSessionState;
      echo: VoiceEchoState;
      /** local-stt is ready and the DSP is up. Only from a desktop whose
       *  voice_status has `readyFlag`; absent means infer it from `state`
       *  (isVoiceReadyState). */
      ready?: boolean;
      /** The background-noise room running now. Only from a desktop with
       *  auto; absent otherwise. */
      noiseMode?: VoiceNoiseMode;
    }
  | { type: "transcript"; turnId: string; text: string; final: boolean }
  | { type: "turn"; turnId: string; text: string }
  | { type: "interrupted"; turnId: string }
  | { type: "level"; mic: number; agent: number }
  | { type: "ended"; reason: VoiceEndReason; text?: string; error?: string }
  | VoiceSpeechEvent;

/** `voice://speech` (only for a session started with `speechAudio`): a run
 *  of the user's speech, as ~500 ms chunks of its first 8 s (`pcm`: base64
 *  Int16 LE mono at 16 kHz), then a closing event. A run that becomes a turn
 *  closes with `outcome: 'turn'` BEFORE that turn's `voice://turn` (same
 *  `turnId`); one that never does closes `abandoned`. */
export type VoiceSpeechEvent =
  | { type: "speech"; turnId: string; seq: number; end: false; startMs: number; sampleRate: 16000; pcm: string }
  | { type: "speech"; turnId: string; seq: number; end: true; outcome: VoiceSpeechOutcome };

export type VoiceSpeechOutcome = "turn" | "abandoned";

/** `voice_start` was refused (or can't run on this build). */
export class VoiceRefusedError extends Error {
  readonly code: VoiceRefusal;
  constructor(code: VoiceRefusal, detail?: string) {
    super(detail && detail !== code ? `${code}: ${detail}` : code);
    this.name = "VoiceRefusedError";
    this.code = code;
  }
}

const VOICE_REFUSALS: readonly VoiceRefusal[] = ["recording", "busy", "not_ready", "mic_denied", "unavailable"];
const VOICE_MODULE_STATES: readonly VoiceModuleState[] = ["ready", "missing", "downloading", "unsupported", "error"];
const VOICE_SESSION_STATES: readonly VoiceSessionState[] = [
  "starting",
  "listening",
  "user_speaking",
  "processing",
  "agent_speaking",
  "muted",
];
const VOICE_ECHO_STATES: readonly VoiceEchoState[] = ["cancelling", "converging", "half_duplex", "headphones"];
const VOICE_END_REASONS: readonly VoiceEndReason[] = [
  "stopped",
  "cancelled",
  "recording",
  "page",
  "idle",
  "device",
  "error",
];

/** What a browser, or a desktop without `voice_status`, reads as. */
export const VOICE_UNAVAILABLE: VoiceStatus = Object.freeze({
  available: false,
  dictation: false,
  conversation: false,
  stt: "unsupported",
  tts: "unsupported",
}) as VoiceStatus;

/** A rejected voice_start → its refusal code; anything unrecognised (e.g.
 *  "command voice_start not found" on an older desktop) → unavailable. */
function voiceRefusal(err: unknown): VoiceRefusedError {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code = VOICE_REFUSALS.find((c) => text === c || text.startsWith(`${c}:`)) ?? "unavailable";
  return new VoiceRefusedError(code, text || undefined);
}

function toVoiceModuleState(raw: unknown): VoiceModuleState {
  return VOICE_MODULE_STATES.includes(raw as VoiceModuleState) ? (raw as VoiceModuleState) : "error";
}

/** A `voice_status` answer, cleaned up. The mode flags are only ever true when
 *  the desktop says so AND voice is available. */
function toVoiceStatus(raw: unknown): VoiceStatus {
  if (!raw || typeof raw !== "object") return VOICE_UNAVAILABLE;
  const v = raw as Record<string, unknown>;
  const available = v.available === true;
  const status: VoiceStatus = {
    available,
    dictation: available && v.dictation === true,
    conversation: available && v.conversation === true,
    stt: toVoiceModuleState(v.stt),
    tts: toVoiceModuleState(v.tts),
  };
  if (typeof v.reason === "string" && v.reason) status.reason = v.reason;
  if (Array.isArray(v.noiseProfiles)) {
    status.noiseProfiles = v.noiseProfiles.filter((p): p is string => typeof p === "string");
  }
  if (v.readyFlag === true) status.readyFlag = true;
  if (available && v.interactive === true) status.interactive = true;
  if (available && v.speechAudio === true) status.speechAudio = true;
  return status;
}

/** `voice_log`'s longest line. */
const VOICE_LOG_MAX = 400;

const unit = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** One raw `voice://<name>` payload → a typed event, or null when malformed. */
function toVoiceEvent(name: string, p: Record<string, unknown>): VoiceEvent | null {
  switch (name) {
    case "state": {
      if (!VOICE_SESSION_STATES.includes(p.state as VoiceSessionState)) return null;
      const state: VoiceEvent = {
        type: "state",
        state: p.state as VoiceSessionState,
        echo: VOICE_ECHO_STATES.includes(p.echo as VoiceEchoState) ? (p.echo as VoiceEchoState) : "converging",
      };
      if (typeof p.ready === "boolean") state.ready = p.ready;
      if (p.noiseMode === "quiet" || p.noiseMode === "noisy") state.noiseMode = p.noiseMode;
      return state;
    }
    case "transcript":
      if (typeof p.text !== "string") return null;
      return { type: "transcript", turnId: String(p.turnId ?? ""), text: p.text, final: p.final === true };
    case "turn":
      if (typeof p.text !== "string") return null;
      return { type: "turn", turnId: String(p.turnId ?? ""), text: p.text };
    case "interrupted":
      return { type: "interrupted", turnId: String(p.turnId ?? "") };
    case "level":
      return { type: "level", mic: unit(p.mic), agent: unit(p.agent) };
    case "ended": {
      const reason = VOICE_END_REASONS.includes(p.reason as VoiceEndReason) ? (p.reason as VoiceEndReason) : "error";
      const ended: VoiceEvent = { type: "ended", reason };
      if (typeof p.text === "string") ended.text = p.text;
      if (typeof p.error === "string") ended.error = p.error;
      return ended;
    }
    case "speech":
      return toVoiceSpeechEvent(p);
    default:
      return null;
  }
}

/** Base64: whole 4-character groups only. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** `voice://speech`, strictly: anything off-contract is dropped whole. */
function toVoiceSpeechEvent(p: Record<string, unknown>): VoiceSpeechEvent | null {
  const { turnId, seq } = p;
  if (typeof turnId !== "string" || !turnId) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
  if (p.end === true) {
    if (p.outcome !== "turn" && p.outcome !== "abandoned") return null;
    return { type: "speech", turnId, seq, end: true, outcome: p.outcome };
  }
  if (p.end !== false) return null;
  const { startMs, pcm } = p;
  if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) return null;
  if (p.sampleRate !== 16000) return null;
  if (typeof pcm !== "string" || !pcm || !BASE64.test(pcm)) return null;
  return { type: "speech", turnId, seq, end: false, startMs, sampleRate: 16000, pcm };
}

const VOICE_EVENT_NAMES = ["state", "transcript", "turn", "interrupted", "level", "ended", "speech"] as const;

export interface RecordingResult {
  sessionId: string;
  micFile: string | null;
  systemFile: string | null;
  durationSeconds: number;
}

export interface AudioLevelPayload {
  micLevel: number;
  systemLevel: number;
  timestamp: number;
}

export type RecordingStatus = "inactive" | "recording" | "paused";

export interface DetectedApp {
  bundleId: string;
  displayName: string;
  pid: number;
}

export interface MeetingDetectionStatus {
  state: "disabled" | "monitoring" | "detected" | "recording";
  detectedApp: DetectedApp | null;
  isAutoRecord: boolean;
  isEnabled: boolean;
}

export interface ExchangeCalendarInfo {
  id: string;
  title: string;
  accountName: string;
  color: string;
}

export interface LocalCalendarStatus {
  hasAccess: boolean;
  exchangeCalendars: ExchangeCalendarInfo[];
}

export interface LocalCalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  calendarId: string;
  calendarName: string | null;
  location: string | null;
  attendees: string[];
  organizer: string | null;
  conferenceUrl: string | null;
  hasRecurrence: boolean;
  source: string;
}

/**
 * OS notification authorization, mirroring the Rust
 * `notification_permission_state` vocabulary.
 * - `granted`     — banners will show
 * - `denied`      — the user said no; nothing will show
 * - `prompt`      — not asked yet; `requestNotificationPermission` will ask
 * - `unsupported` — the notification backend can't initialize here (e.g. an
 *                   unbundled dev binary on macOS). Not an error — just no
 *                   native notifications.
 */
export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "unsupported";

// ── Dynamic imports (only resolve inside Tauri) ─────────────────

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  const unlisten = await tauriListen<T>(event, (e) => handler(e.payload));
  // Never throws, and survives an unlisten that lands before the webview's
  // listener entry does (see tauri-unlisten.ts).
  return toSafeUnlisten(unlisten);
}

/**
 * Like `listen`, but scoped to THIS webview window.
 *
 * The global `listen` above registers with `EventTarget::Any`, which receives
 * broadcasts AND every window-targeted event — so with several dashboard
 * windows open, one window-targeted emit would be delivered to all of them.
 * `getCurrentWebviewWindow().listen(...)` registers a label-matched target, so
 * only the window Rust addressed reacts. The Rust side is the other half of
 * this pairing: it delivers with `emit_to(EventTarget::labeled(label), ...)`
 * rather than a broadcast `emit`.
 */
async function listenOnThisWindow<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  const unlisten = await getCurrentWebviewWindow().listen<T>(event, (e) =>
    handler(e.payload),
  );
  return toSafeUnlisten(unlisten);
}

/**
 * This webview window's Tauri label ("main" for the primary dashboard,
 * "workspace-<id>" for pop-outs), or null outside the desktop shell.
 *
 * Needed because several Rust events are BROADCAST but semantically belong to
 * one window (e.g. `main-focus-changed` describes only the main window; tray /
 * deep-link one-shots should be handled by exactly one dashboard). Handlers use
 * the label to decide whether a broadcast applies to them.
 */
export async function getThisWebviewLabel(): Promise<string | null> {
  if (!isDesktopApp()) return null;
  try {
    const { getCurrentWebviewWindow } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

// ── Presence (docs/plans/reach-follows-you.md §1) ───────────────

/** What the desktop's `presence_state` command answers (commands/system.rs):
 *  seconds since the last input anywhere on the Mac, and whether the screen
 *  is locked (or another user is on the console). */
export interface DesktopPresence {
  idleSeconds: number;
  locked: boolean;
}

export function toDesktopPresence(raw: unknown): DesktopPresence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.idleSeconds !== "number" || !Number.isFinite(r.idleSeconds) || r.idleSeconds < 0) return null;
  if (typeof r.locked !== "boolean") return null;
  return { idleSeconds: r.idleSeconds, locked: r.locked };
}

/** Set once this desktop answered that it has no `presence_state` (an older
 *  build) or can't read one (off macOS): neither changes while it runs, so
 *  it isn't asked again. */
let presenceStateUnavailable = false;

/**
 * The Mac's idle time and lock, for the presence client (lib/presence/
 * client.ts) in the desktop's main window. The web turns it into a state
 * (lib/presence/presence.ts desktopState), so the thresholds can change
 * without a desktop release.
 *
 * Null outside the desktop, on a build without the command, off macOS (the
 * command fails with "unsupported"), and on any other failure or malformed
 * answer: the client then falls back to the web's own focus-and-input rule.
 */
export async function presenceState(): Promise<DesktopPresence | null> {
  if (!isDesktopApp() || presenceStateUnavailable) return null;
  try {
    return toDesktopPresence(await invoke<unknown>("presence_state"));
  } catch (e) {
    const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    if (isMissingCommand("presence_state", e) || text === "unsupported") presenceStateUnavailable = true;
    return null;
  }
}

// ── macOS audio health + Mic Mode ───────────────────────────────

/** Is macOS's audio daemon (coreaudiod) answering? It can deadlock (an Apple
 *  bug): every app's audio stops and Native Intelligence can't record until it's restarted.
 *  The desktop probes it (audio/health.rs). `unknown` before the first
 *  verdict, and on desktop builds without the command. */
export type AudioHealth = "unknown" | "responsive" | "unresponsive";

export const AUDIO_HEALTH_EVENT = "audio://health";

/** Across the desktop's windows: a capture's attachments changed. */
export const CAPTURE_ATTACHMENTS_DESKTOP_EVENT = "capture-attachments-changed";

export const INPUT_SILENT_EVENT = "audio://input-silent";

/** `audio://input-silent`: the mic in use (`deviceId`, null when the desktop
 *  can't name it) sends nothing but digital zeros (`silent`), or recovered. */
export interface InputSilentEvent {
  deviceId: string | null;
  name: string;
  silent: boolean;
}

export function toInputSilentEvent(raw: unknown): InputSilentEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.silent !== "boolean" || typeof r.name !== "string") return null;
  if (r.deviceId !== null && typeof r.deviceId !== "string") return null;
  return { deviceId: r.deviceId, name: r.name, silent: r.silent };
}

/** The `audio://health` payload (`{ health }`) or `get_audio_health`'s bare
 *  string; null for anything else. */
export function toAudioHealth(raw: unknown): AudioHealth | null {
  const value =
    raw && typeof raw === "object" && "health" in raw
      ? (raw as { health: unknown }).health
      : raw;
  return value === "unknown" || value === "responsive" || value === "unresponsive"
    ? value
    : null;
}

/** Native Intelligence's macOS Mic Mode (Control Center → Mic Mode), which macOS applies to
 *  Native Intelligence's mic. `unknown` on desktop builds without the command. */
export type MicMode = "standard" | "wide-spectrum" | "voice-isolation" | "unknown";

export function toMicMode(raw: unknown): MicMode {
  return raw === "standard" || raw === "wide-spectrum" || raw === "voice-isolation"
    ? raw
    : "unknown";
}

// ── Public API ──────────────────────────────────────────────────

export const tauriBridge = {
  /** True when running inside the Tauri desktop shell. */
  isAvailable: isDesktopApp,

  /** macOS's audio daemon (see AudioHealth). */
  audioHealth: {
    /** The desktop's last verdict; `unknown` on builds without it. */
    get: async (): Promise<AudioHealth> => {
      if (!isDesktopApp()) return "unknown";
      try {
        return toAudioHealth(await invoke<unknown>("get_audio_health")) ?? "unknown";
      } catch {
        return "unknown";
      }
    },
    /** Subscribe to `audio://health`. Returns the unsubscribe function
     *  synchronously; the listener attaches in the background and is dropped
     *  if unsubscribed first. Malformed payloads are dropped. */
    onChanged: (cb: (health: AudioHealth) => void): (() => void) => {
      if (!isDesktopApp()) return () => {};
      return listenScoped((gate) =>
        listen<unknown>(AUDIO_HEALTH_EVENT, gate((payload) => {
          const health = toAudioHealth(payload);
          if (health) cb(health);
        })),
      );
    },
    /** Restart coreaudiod: macOS asks for an administrator's password.
     *  Resolves once it's done (the recovery arrives as `audio://health`);
     *  rejects with "cancelled" when the user dismisses the prompt. */
    restart: () => invoke<void>("restart_core_audio"),
  },

  /** A capture's attachments changed in another window (the agent HUD takes
   *  files dropped on it for the call's capture): every window's panels for
   *  that capture refetch. A broadcast; no Rust side. */
  captureAttachments: {
    announce: async (captureId: string): Promise<void> => {
      if (!isDesktopApp()) return;
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit(CAPTURE_ATTACHMENTS_DESKTOP_EVENT, { captureId });
      } catch {
        /* the other windows refetch on their next open */
      }
    },
    onChanged: (cb: (captureId: string) => void): (() => void) => {
      if (!isDesktopApp()) return () => {};
      return listenScoped((gate) =>
        listen<unknown>(CAPTURE_ATTACHMENTS_DESKTOP_EVENT, gate((payload) => {
          const id = (payload as { captureId?: unknown } | null)?.captureId;
          if (typeof id === "string" && id) cb(id);
        })),
      );
    },
  },

  /** Native Intelligence's macOS Mic Mode (see MicMode). */
  micMode: {
    /** A preference read on the desktop, never the microphone. */
    get: async (): Promise<MicMode> => {
      if (!isDesktopApp()) return "unknown";
      try {
        return toMicMode(await invoke<unknown>("get_mic_mode"));
      } catch {
        return "unknown";
      }
    },
    /** Open macOS's Mic Mode menu. macOS lists Native Intelligence there only while it's
     *  using the microphone, so offer it during a recording. */
    openPicker: () => invoke<void>("open_mic_mode_picker"),
  },

  // ── Input device priority ──────────────────────────────────
  //
  // VERSION SKEW: desktops up to 0.2.45 have none of these commands, so
  // `list()` rejects ("command not found"). Callers MUST treat that as "this
  // build has no device priority" and render nothing. Builds with the list
  // but before `set_input_override` reject `setOverride` with
  // InputDevicesCommandMissingError. Every call also rejects outside the
  // desktop shell and on a malformed answer.
  inputDevices: {
    /** The list, in priority order. Rejects on builds without it. */
    list: () => invokeInputDevices("list_input_devices"),

    /** Save a new order (ids highest first) and mark it customised. Unknown
     *  ids are ignored; known ids left out keep their order after these. */
    setPriority: (ids: string[]) =>
      invokeInputDevices("set_input_priority", { ids }),

    /** Back to the Mac's default input. The list is kept. */
    reset: () => invokeInputDevices("reset_input_priority"),

    /** Drop a disconnected device from the list. Rejects for a connected one. */
    forget: (id: string) => invokeInputDevices("forget_input_device", { id }),

    /** Use `id` for now without changing the order (never saved); null goes
     *  back to the order. Rejects with InputDevicesCommandMissingError on a
     *  desktop without the command. */
    setOverride: (id: string | null) =>
      invokeInputDevices("set_input_override", { id }),

    /** Subscribe to `audio://input-devices-changed` (plug/unplug, default
     *  input change, mic start/stop/switch, and after each setter). Returns
     *  the unsubscribe function synchronously; the listener attaches in the
     *  background and is dropped if unsubscribed first. Malformed payloads
     *  are dropped. */
    onChanged: (cb: (snapshot: InputDevicesSnapshot) => void): (() => void) => {
      if (!isDesktopApp()) return () => {};
      return listenScoped((gate) =>
        listen<unknown>(INPUT_DEVICES_CHANGED_EVENT, gate((payload) => {
          const snap = toInputDevicesSnapshot(payload);
          if (snap) cb(snap);
        })),
      );
    },
  },

  /** Start a recording session. Audio PCM will stream via events.
   *  The desktop picks the mic from its input-device priority list.
   *  `transcription: 'local'` asks the desktop to transcribe on-device (the
   *  caller must already be subscribed to the stt:// events); the answer's
   *  `transcriptionEngine` says which engine it actually started. */
  startRecording: (opts: {
    captureSystemAudio: boolean;
    transcription?: TranscriptionEngine;
  }) =>
    invoke<RecordingSession>("start_recording", {
      captureSystemAudio: opts.captureSystemAudio,
      // Sent only when requested, so a Deepgram start keeps today's exact args
      // (an older desktop ignores the unknown field either way).
      ...(opts.transcription ? { transcription: opts.transcription } : {}),
    }),

  /** Stop the active recording session. */
  stopRecording: () => invoke<RecordingResult>("stop_recording"),

  /** Pause recording. */
  pauseRecording: () => invoke<void>("pause_recording"),

  /** Resume recording. */
  resumeRecording: () => invoke<void>("resume_recording"),

  /** Get current recording status. */
  getStatus: () => invoke<RecordingStatus>("get_recording_status"),

  /** Rebuild the mic stream after a fault (device disconnect), on the next
   *  device in the priority list (older desktops: the default). Called in response to the `audio://mic-fault` event. */
  recoverMic: () => invoke<void>("recover_mic"),

  // ── Meeting Detection ────────────────────────────────────────

  /** Enable or disable meeting detection. */
  enableMeetingDetection: (enabled: boolean) =>
    invoke<void>("enable_meeting_detection", { enabled }),

  /** Enable or disable auto-record when meeting detected. */
  setAutoRecord: (enabled: boolean) =>
    invoke<void>("set_auto_record", { enabled }),

  /** Dismiss current meeting detection notification. */
  dismissMeetingDetection: () =>
    invoke<void>("dismiss_meeting_detection"),

  /** Hide the floating meeting detection HUD window. */
  hideMeetingHud: () => invoke<void>("hide_meeting_hud"),

  // ── Live-agent "talk back" HUD ────────────────────────────────
  // A second floating window (separate from the meeting-detection HUD): the live
  // agent's heads-up display. Opened while a live meeting runs with the agent on;
  // each say_to_user message is relayed here via pushAgentNudge.

  /** Show the live-agent HUD window (idempotent). */
  showAgentHud: () => invoke<void>("show_agent_hud"),

  /** Make sure the live-agent HUD is up, whatever became of it mid-call: the
   *  desktop rebuilds a missing window, waits out a close in flight, or brings
   *  a hidden / minimized / off-screen one back, and leaves one that's up
   *  alone (it never takes focus then). `captureId` keeps that call's buffered
   *  nudges on a rebuilt window. Resolves to what it did: "visible",
   *  "restored", "created" or "recreating". Rejects on a desktop build older
   *  than the command. */
  ensureAgentHud: (reason: string, captureId: string) =>
    invoke<string>("ensure_agent_hud", { reason, captureId }),

  /** Hide (CLOSE) the live-agent HUD window — meeting end only. Destroys the
   *  webview and clears the Rust nudge buffer. */
  hideAgentHud: () => invoke<void>("hide_agent_hud"),

  /** Transiently hide the live-agent HUD WITHOUT destroying it — the "user
   *  refocused Native Intelligence" case. The webview + nudge buffer survive, so a later
   *  showAgentHud brings the same window back with its history, no reload. */
  hideAgentHudTransient: () => invoke<void>("hide_agent_hud_transient"),

  // ── The live-agent HUD in screen shares ──────────────────────
  // The HUD window is hidden from screen sharing and recording (macOS content
  // protection) unless the user opens it up for a demo: the HUD header's eye.
  // Back to hidden with every fresh window (every meeting); a transient
  // hide→show of the same window keeps the choice.
  //
  // VERSION SKEW: desktops before these commands reject them ("command not
  // found"). `get` reads that (and anything else that isn't a boolean) as
  // null, and the HUD then shows no eye.
  agentHudCapture: {
    /** Whether the HUD shows in screen shares and recordings; null off the
     *  desktop app or on a build without the command. */
    get: async (): Promise<boolean | null> => {
      if (!isDesktopApp()) return null;
      try {
        const visible = await invoke<unknown>("get_agent_hud_capture_visible");
        return typeof visible === "boolean" ? visible : null;
      } catch {
        return null;
      }
    },
    /** Show the HUD in screen shares and recordings (true) or hide it (false).
     *  Resolves to the state it's in now; rejects when the HUD window is gone
     *  (or off the desktop app). */
    set: async (visible: boolean): Promise<boolean> => {
      if (!isDesktopApp()) throw new Error("agent HUD: not in the desktop app");
      const next = await invoke<unknown>("set_agent_hud_capture_visible", { visible });
      return typeof next === "boolean" ? next : visible;
    },
  },

  /** Subscribe to the MAIN window's focus state (true = focused). Emitted by
   *  the Rust window-event handler; the reliable "user switched away from
   *  Native Intelligence" signal (fires on cmd-tab even when Native Intelligence stays partially visible,
   *  unlike the page Visibility API), and it suppresses focus handed to our own
   *  HUD/popout windows. Returns an unlisten fn. */
  onMainFocusChanged: (cb: (focused: boolean) => void) =>
    listen<boolean>("main-focus-changed", cb),

  /** Relay one agent nudge to the HUD window (no-op if it isn't open). */
  pushAgentNudge: (nudge: {
    id: string
    message: string
    kind: NudgeKind
    captureId: string
    ts: number
  }) => invoke<void>("push_agent_nudge", { nudge }),

  /** Get the tray's cached calendar events for today. */
  getCachedCalendarEvents: () =>
    invoke<TrayCalendarEvent[]>("get_cached_calendar_events"),

  /** Get current meeting detection state. */
  getMeetingDetectionState: () =>
    invoke<MeetingDetectionStatus>("get_meeting_detection_state"),

  // ── Live session queries ─────────────────────────────────────

  /** Get current audio levels (mic + system). */
  getAudioLevels: () =>
    invoke<AudioLevelPayload>("get_audio_levels"),

  /** Get persisted audio preferences. */
  getAudioPreferences: () =>
    invoke<{ captureSystemAudio: boolean }>("get_audio_preferences"),

  // ── Echo cancellation in captures ─────────────────────────────
  //
  // When on (the native default), a capture that records system audio uses
  // it to clean the other participants' voices out of the mic before the
  // mic is transcribed (local-stt, and audio://mic → Deepgram and Voice ID).
  // The mic WAV stays raw. Read by the desktop at every capture start.
  //
  // VERSION SKEW: the getter rejects ("command not found") on a desktop build
  // without it. Callers MUST treat a rejection as "this build has no echo
  // cancellation" and render no control.

  /** Current setting. Rejects on binaries without the command. */
  getEchoCancellationInCaptures: () =>
    invoke<boolean>("get_echo_cancellation_in_captures"),

  /** Persist the setting (takes effect at the next capture start). */
  setEchoCancellationInCaptures: (enabled: boolean) =>
    invoke<void>("set_echo_cancellation_in_captures", { enabled }),

  /** Request speech recognition permission (opens System Settings). */
  requestSpeechPermission: () =>
    invoke<string>("request_speech_permission"),

  /** LEGACY fallback — prefer checkSystemAudioPermission /
   *  requestSystemAudioPermission, and call this only when those reject (a
   *  desktop build that predates them). It probes by creating a Core Audio
   *  tap, and on those older builds the tap is created even with the
   *  permission switched off (it just records silence), so it answers
   *  "granted" and can never observe a denial — never present its "granted"
   *  as a verified grant. Truthful on builds that also ship the new commands.
   *  "granted" | "denied" | "unavailable" | "not_applicable". */
  requestScreenCapturePermission: () =>
    invoke<string>("request_screen_capture_permission"),

  /** System Audio Recording ("Audio Capture" TCC) status without prompting —
   *  passive, never shows a prompt, cheap enough to poll (~1.5s).
   *  "granted" | "denied" | "not-determined" | "unavailable" (the private TCC
   *  query is missing on this macOS) | "unsupported" (macOS < 14.4, no Core
   *  Audio taps) | "not_applicable".
   *  Rejects on desktop builds older than this change (command not registered). */
  checkSystemAudioPermission: () =>
    invoke<string>("check_system_audio_permission"),

  /** Request System Audio Recording permission. Shows the real OS prompt only
   *  while the status is not-determined; once denied, macOS never re-prompts,
   *  so this opens the Screen & System Audio Recording Settings pane instead
   *  ("opened-settings").
   *  "granted" | "denied" | "opened-settings" | "unsupported" | "not_applicable".
   *  Rejects on desktop builds older than this change (command not registered). */
  requestSystemAudioPermission: () =>
    invoke<string>("request_system_audio_permission"),

  /** Microphone TCC status without prompting.
   *  "granted" | "not-determined" | "denied" | "restricted" | "not_applicable".
   *  Rejects on desktop builds older than 0.2.41 (command not registered). */
  checkMicPermission: () =>
    invoke<string>("check_mic_permission"),

  /** Request microphone permission. Shows the real system prompt while the
   *  status is not-determined (blocks until answered); once denied, macOS
   *  never re-prompts, so this opens the Settings mic pane instead.
   *  "granted" | "denied" | "opened-settings" | "not_applicable". */
  requestMicPermission: () =>
    invoke<string>("request_mic_permission"),

  // ── Local modules ─────────────────────────────────────────────
  // Contract v1 (see LocalModuleInfo). VERSION SKEW: a desktop build without
  // Local Modules has no `modules_list`, so the list resolves [] instead of
  // rejecting — it is the capability probe, and [] hides every local-module
  // surface. The per-module commands only run behind a successful list.

  /** Installed local modules and their state; [] on builds without them. */
  modulesList: async (): Promise<LocalModuleInfo[]> => {
    try {
      const list = await invoke<LocalModuleInfo[]>("modules_list");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },

  /** Persist enabled=true and start download → verify → warm-up; progress
   *  arrives via onModuleStatus. */
  moduleEnable: (id: string) => invoke<LocalModuleInfo>("module_enable", { id }),

  /** Persist enabled=false, stop any running process and cancel an in-flight
   *  download (keeps downloaded assets). */
  moduleDisable: (id: string) => invoke<LocalModuleInfo>("module_disable", { id }),

  /** Disable the module and delete its downloaded assets. */
  moduleRemoveAssets: (id: string) =>
    invoke<LocalModuleInfo>("module_remove_assets", { id }),

  /** Subscribe to `module://status` (every module; filter on `id`). */
  onModuleStatus: (cb: (info: LocalModuleInfo) => void) =>
    listen<LocalModuleInfo>("module://status", cb),

  // ── Diagnostics (speech-diagnostics.ts) ───────────────────────
  // VERSION SKEW: system_info and module_log_tail arrive with desktop 0.2.73,
  // and older builds reject both. The app version comes from Tauri's own app
  // plugin (core:app:default), which every build has.

  /** The desktop app's version, e.g. "0.2.72". */
  appVersion: () => invoke<string>("plugin:app|version"),

  /** This Mac: macOS version, chip, memory, arch. Rejects on older builds. */
  systemInfo: () => invoke<DesktopSystemInfo>("system_info"),

  /** The last lines a module logged (the desktop's module manager and the
   *  sidecar's own output), oldest first. Rejects on older builds. */
  moduleLogTail: (id: string) => invoke<string[]>("module_log_tail", { id }),

  // ── Read-aloud (local-tts) ────────────────────────────────────
  // VERSION SKEW: the web ships ahead of the desktop, so every wrapper is
  // inert without the commands: speak rejects TtsRefusedError('unavailable'),
  // voices resolves [], cancel/prepare resolve, and the state listener is a
  // no-op. Outside the desktop none of them touches Tauri at all.

  /** Queue one sentence. Resolves once queued; rejects TtsRefusedError with
   *  `recording` / `not_ready` / `unavailable` / `text_too_long`. The desktop
   *  normalizes numbers and symbols. */
  ttsSpeak: async (args: { id: string; text: string; voice?: string }): Promise<void> => {
    if (!isDesktopApp()) throw new TtsRefusedError("unavailable");
    const payload: Record<string, unknown> = { id: args.id, text: args.text };
    if (args.voice) payload.voice = args.voice;
    try {
      await invoke<void>("tts_speak", payload);
    } catch (err) {
      throw ttsRefusal(err);
    }
  },

  /** Stop the sound now and drop the queue. Never rejects. */
  ttsCancel: async (): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("tts_cancel");
    } catch {
      /* nothing to cancel on this build */
    }
  },

  /** Start the engine early (a reply is about to be read). Never rejects. */
  ttsPrepare: async (): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("tts_prepare");
    } catch {
      /* no engine on this build */
    }
  },

  /** The compiled-in voice catalogue; [] on builds without it. */
  ttsVoices: async (): Promise<TtsVoice[]> => {
    if (!isDesktopApp()) return [];
    try {
      const list = await invoke<unknown>("tts_voices");
      return Array.isArray(list) ? list.map(toTtsVoice).filter((v): v is TtsVoice => v !== null) : [];
    } catch {
      return [];
    }
  },

  /** The Speed setting, 0.5–4 (1 = normal), for everything the desktop
   *  speaks; null on a build without it. */
  ttsRate: async (): Promise<number | null> => {
    if (!isDesktopApp()) return null;
    try {
      const rate = await invoke<unknown>("tts_rate");
      return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
    } catch {
      return null;
    }
  },

  /** Sets the Speed from the next sentence on; resolves to it as clamped. */
  ttsSetRate: (rate: number) => invoke<number>("tts_set_rate", { rate }),

  /** Subscribe to `tts://state` (every utterance; filter on `id`). Returns
   *  the unsubscribe function synchronously; the listener attaches in the
   *  background and is dropped if unsubscribed first. */
  onTtsState: (cb: (payload: TtsStatePayload) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    // No tts events on this build: the subscribe rejects and listenScoped
    // swallows it.
    return listenScoped((gate) =>
      listen<TtsStatePayload>("tts://state", gate((p) => {
        if (!p || typeof p.id !== "string" || !TTS_STATES.includes(p.state)) return;
        cb(p);
      })),
    );
  },

  /** `tts://word`: the word now being said (read-along, a moment before it's heard). */
  onTtsWord: (cb: (payload: { id: string; index: number; count: number; word: string }) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<{ id: string; index: number; count: number; word: string }>("tts://word", gate((p) => {
        if (!p || typeof p.id !== "string" || typeof p.word !== "string" || typeof p.index !== "number") return;
        cb(p);
      })),
    );
  },

  /** Read anywhere asking for sentences: text selected in a chat or mail app
   *  (`app` is its bundle id). Answer with `readSelectionSentences`. No-op in
   *  the browser and on a desktop that never asks. */
  onReadSelectionConvert: (cb: (payload: ReadSelectionConvertPayload) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<ReadSelectionConvertPayload>("read-selection://convert", gate((p) => {
        if (!p || typeof p.run !== "number" || typeof p.text !== "string") return;
        cb({ run: p.run, text: p.text, app: typeof p.app === "string" ? p.app : "" });
      })),
    );
  },

  /** The sentences for Read anywhere's request `run` ([] reads the text as
   *  the desktop would on its own). Never rejects. */
  readSelectionSentences: async (run: number, sentences: string[]): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("read_selection_sentences", { run, sentences });
    } catch {
      // A desktop without the command never asked.
    }
  },

  // ── Local agents (see LocalAgentResult) ───────────────────────
  // Args are camelCase: Tauri maps them to the commands' snake_case params.
  // Nothing here rejects; outside the desktop none of it touches Tauri.
  localAgent: {
    /** Node, agent dir, built, grants and jobs. `available: false` with a
     *  reason when local agents can't run here; never rejects. */
    status: async (): Promise<LocalAgentStatus> => {
      const cmd = "local_agent_status";
      if (!isDesktopApp()) return unavailableLocalAgentStatus(LOCAL_AGENT_OFF_DESKTOP);
      let raw: unknown;
      try {
        raw = await invoke<unknown>(cmd);
      } catch (e) {
        return unavailableLocalAgentStatus(
          isMissingCommand(cmd, e) ?? (localAgentErrorText(e) || `${cmd} failed`),
        );
      }
      return toLocalAgentStatus(raw) ?? unavailableLocalAgentStatus(`${cmd}: malformed answer`);
    },

    /** The desktop's native folder picker; the new grant, or null when the
     *  person cancelled. The desktop refuses `/`, HOME and system folders. */
    pickFolder: () =>
      invokeLocalAgent<LocalAgentGrant | null>("local_agent_pick_folder", undefined, (raw) =>
        raw == null ? null : (toLocalAgentGrant(raw) ?? LOCAL_AGENT_MALFORMED),
      ),

    removeGrant: (grantId: string) =>
      invokeLocalAgent("local_agent_remove_grant", { grantId }, ignoreLocalAgentReply),

    /** This Mac for the server's device registry (l1-contract C1). A release
     *  build without local agents answers unavailable. */
    device: () =>
      invokeLocalAgent<LocalAgentDevice>("local_agent_device", undefined, (raw) =>
        toLocalAgentDevice(raw) ?? LOCAL_AGENT_MALFORMED,
      ),

    /** Start a job in a granted folder (l1-contract C3). The desktop takes the
     *  folder from the grant and the model relay URL from the app's origin,
     *  never from here. Starting a job that is already live answers its
     *  current run (and passes a new token on). The positional form is the
     *  L0 dev page's. */
    start: (args: LocalAgentStartArgs | string, request?: string) => {
      const a: LocalAgentStartArgs =
        typeof args === "string" ? { grantId: args, request: request ?? "" } : args;
      const payload: Record<string, unknown> = { grantId: a.grantId, request: a.request };
      if (a.jobId) payload.jobId = a.jobId;
      if (a.mode) payload.mode = a.mode;
      if (a.modelToken) payload.modelToken = a.modelToken;
      if (typeof a.localModel === "boolean") payload.localModel = a.localModel;
      if (typeof a.baseBranch === "string" && a.baseBranch) payload.baseBranch = a.baseBranch;
      if (a.resume) {
        payload.resume = { eveSessionId: a.resume.eveSessionId, streamIndex: a.resume.streamIndex };
      }
      return invokeLocalAgent<LocalAgentRun>("local_agent_start", payload, (raw) =>
        raw && typeof raw === "object" ? (toLocalAgentRun(raw) ?? LOCAL_AGENT_MALFORMED) : LOCAL_AGENT_MALFORMED,
      );
    },

    /** A refreshed model relay token for a job: the desktop writes it to the
     *  running launcher and keeps it for the job's next launch. */
    setModelToken: (jobId: string, modelToken: string) =>
      invokeLocalAgent("local_agent_set_model_token", { jobId, modelToken }, ignoreLocalAgentReply),

    /** A message to the running or idle agent. */
    send: (jobId: string, text: string, policy: LocalAgentPolicy) =>
      invokeLocalAgent("local_agent_send", { jobId, text, policy }, ignoreLocalAgentReply),

    /** Cancel the current turn; the launcher then exits. */
    stop: (jobId: string) => invokeLocalAgent("local_agent_stop", { jobId }, ignoreLocalAgentReply),

    /** Respawn the launcher on the job's stored session and stream cursor;
     *  `modelToken` replaces the one it had. Answers the new run. `message`:
     *  the one the resume is for, which the desktop sends itself once the
     *  launcher is back (a coding agent's confirm on the Mac shows it). */
    resume: (
      jobId: string,
      modelToken?: string | null,
      localModel?: boolean | null,
      message?: { text: string; policy: LocalAgentPolicy } | null,
    ) =>
      invokeLocalAgent<LocalAgentRun>(
        "local_agent_resume",
        {
          jobId,
          ...(modelToken ? { modelToken } : {}),
          ...(typeof localModel === "boolean" ? { localModel } : {}),
          ...(message ? { message: { text: message.text, policy: message.policy } } : {}),
        },
        (raw) => toLocalAgentRun(raw, jobId) ?? LOCAL_AGENT_MALFORMED,
      ),

    /** The job's buffered events after `sinceSeq` (the desktop keeps its last
     *  500), in seq order, each with its `runId`; malformed rows are dropped.
     *  A reloaded page rebuilds from `events(jobId, 0)`. */
    events: (jobId: string, sinceSeq: number) =>
      invokeLocalAgent<LocalAgentEventEnvelope[]>("local_agent_events", { jobId, sinceSeq }, (raw) => {
        if (!Array.isArray(raw)) return LOCAL_AGENT_MALFORMED;
        return raw
          .map((row) => toLocalAgentEnvelope(row, jobId))
          .filter((row): row is LocalAgentEventEnvelope => row !== null)
          .sort((a, b) => a.seq - b.seq);
      }),

    /** Subscribe to `local-agent://event` (every job; filter on `jobId`).
     *  Returns the unsubscribe function synchronously; the listener attaches
     *  in the background and is dropped if unsubscribed first. Malformed
     *  payloads are dropped. */
    onEvent: (cb: (envelope: LocalAgentEventEnvelope) => void): (() => void) => {
      if (!isDesktopApp()) return () => {};
      return listenScoped((gate) =>
        listen<unknown>(LOCAL_AGENT_EVENT, gate((payload) => {
          const envelope = toLocalAgentEnvelope(payload);
          if (envelope) cb(envelope);
        })),
      );
    },
  },

  // ── The cloud browser's Mac exit (browser_exit_*; docs/plans/cloud-browser.md C4) ──
  // VERSION SKEW: an older desktop has none of the commands; every call then
  // resolves null (no Mac exit on that desktop).
  browserExit: {
    /** Whether this Mac carries the agent's browser's traffic now. */
    status: () => invokeBrowserExit("browser_exit_status"),
    /** Connect this Mac's exit to the hub `url` with `token`. The desktop checks the
     *  token itself (it names the hub, and must be the signed-in account's); it throws
     *  its reason when it refuses (another hub or account, an expired token). */
    start: (url: string, token: string) => invokeBrowserExit("browser_exit_start", { url, token }, true),
    stop: () => invokeBrowserExit("browser_exit_stop"),
    /** `browser-exit://status`, on every change (connected, lost, sites). */
    onStatus: (cb: (status: BrowserExitStatus) => void): (() => void) => {
      if (!isDesktopApp()) return () => {};
      return listenScoped((gate) =>
        listen<unknown>("browser-exit://status", gate((payload) => {
          const status = toBrowserExitStatus(payload);
          if (status) cb(status);
        })),
      );
    },
  },

  // ── Read anywhere (read_selection_*) ──────────────────────────
  // VERSION SKEW: an older desktop has none of the commands; status then
  // resolves unsupported and the setters reject.

  /** The feature's settings and permission state; unsupported outside the
   *  desktop or on a build without it. */
  readSelectionStatus: async (): Promise<ReadSelectionStatus> => {
    if (!isDesktopApp()) return READ_SELECTION_UNSUPPORTED;
    try {
      return await invoke<ReadSelectionStatus>("read_selection_status");
    } catch {
      return READ_SELECTION_UNSUPPORTED;
    }
  },

  /** On: registers the hotkey; rejects `needs_permission` without the
   *  Accessibility permission. Off: unregisters it and stops a reading. */
  readSelectionSetEnabled: (enabled: boolean) =>
    invoke<ReadSelectionStatus>("read_selection_set_enabled", { enabled }),

  /** One of `status.hotkeys`' ids, or "custom" for the recorded shortcut. */
  readSelectionSetHotkey: (hotkey: string) =>
    invoke<ReadSelectionStatus>("read_selection_set_hotkey", { hotkey }),

  /** Waits for the user to press a shortcut anywhere (the desktop watches
   *  the keyboard, so fn works too) and switches to it. Rejects with a
   *  `ReadSelectionHotkeyRefusal` (`code` or `code:label`); the previous
   *  shortcut stays. */
  readSelectionRecordHotkey: () => invoke<ReadSelectionStatus>("read_selection_record_hotkey"),

  /** Stops a recording: it rejects with "cancelled". */
  readSelectionCancelRecord: () => invoke<void>("read_selection_cancel_record"),

  /** A `ttsVoices` id; null for the default. */
  readSelectionSetVoice: (voice: string | null) =>
    invoke<ReadSelectionStatus>("read_selection_set_voice", { voice }),

  /** System Settings → Privacy & Security → Accessibility. */
  readSelectionOpenAccessibilitySettings: () =>
    invoke<void>("read_selection_open_accessibility_settings"),

  /** "Allow access": macOS's prompt (once ever), else the Settings pane;
   *  with Accessibility granted, asks for (and repairs) the ⌘C grant. */
  readSelectionRequestAccess: () =>
    invoke<ReadSelectionStatus>("read_selection_request_access"),

  /** Quit and reopen Native Intelligence, for a grant macOS honors only after a relaunch. */
  readSelectionRelaunch: () => invoke<void>("read_selection_relaunch"),

  // ── Dictate anywhere (dictate_*) ──────────────────────────────
  // Tap right ⌥, talk, tap it again: pasted where the cursor is, in any app
  // (desktop/src-tauri/src/dictate.rs; docs/plans/dictate-anywhere.md).
  // VERSION SKEW: an older desktop has none of the commands; status then
  // resolves unsupported, and the panel's calls resolve without effect.

  dictateStatus: async (): Promise<DictateStatus> => {
    if (!isDesktopApp()) return DICTATE_UNSUPPORTED;
    try {
      return await invoke<DictateStatus>("dictate_status");
    } catch {
      return DICTATE_UNSUPPORTED;
    }
  },

  /** On: watches right ⌥; rejects `needs_permission` without Accessibility. */
  dictateSetEnabled: (enabled: boolean) => invoke<DictateStatus>("dictate_set_enabled", { enabled }),

  /** The panel, on load: is a dictation (or words for the agent) waiting to start? */
  dictateState: async (): Promise<{ armed: boolean; agent: boolean; run: number }> => {
    if (!isDesktopApp()) return { armed: false, agent: false, run: 0 };
    try {
      const s = await invoke<{ armed: boolean; agent?: boolean; run: number }>("dictate_state");
      return { armed: s.armed, agent: !!s.agent, run: s.run };
    } catch {
      return { armed: false, agent: false, run: 0 };
    }
  },

  /** The panel's progress for tap `run`: "listening", or "idle" when done. Never rejects. */
  dictatePhase: async (run: number, phase: "listening" | "idle"): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("dictate_phase", { run, phase });
    } catch {
      /* an older desktop */
    }
  },

  /** The words, into the app that was in front at the first tap. Never rejects. */
  dictatePaste: async (run: number, text: string): Promise<DictatePasteResult> => {
    if (!isDesktopApp()) return { pasted: false, reason: "no_keys" };
    try {
      return await invoke<DictatePasteResult>("dictate_paste", { run, text });
    } catch {
      return { pasted: false, reason: "no_keys" };
    }
  },

  /** The panel's card size as its words grow (the window follows, growing up
   *  and out from the bottom centre). Never rejects. */
  dictatePanelSize: async (width: number, height: number, radius?: number): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("dictate_panel_size", { width, height, radius: radius ?? null });
    } catch {
      /* an older desktop: the card keeps its size */
    }
  },

  /** `dictate://edit`: words the person swapped in a paste (what was heard → what they typed). */
  onDictateEdit: (cb: (edits: Array<{ heard: string; typed: string }>) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<{ edits?: Array<{ heard?: unknown; typed?: unknown }> }>("dictate://edit", gate((p) => {
        const edits = (p?.edits ?? []).filter(
          (e): e is { heard: string; typed: string } => typeof e?.heard === "string" && typeof e?.typed === "string",
        );
        if (edits.length) cb(edits);
      })),
    );
  },

  /** Show the panel a moment, to say what it learned (`on`), or let it go. */
  dictateFlash: async (on: boolean): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("dictate_flash", { on });
    } catch {
      /* an older desktop: nothing shown */
    }
  },

  /** Follow the pointer for the panel (the agent's face in the circle looks at it), or stop. */
  dictateWatchPointer: async (on: boolean): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("dictate_watch_pointer", { on });
    } catch {
      /* an older desktop: the face looks ahead */
    }
  },

  /** `dictate://pointer`: the pointer in the panel page's own CSS px, while watched. */
  onDictatePointer: (cb: (x: number, y: number) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<{ x: number; y: number }>("dictate://pointer", gate((p) => {
        if (!p || typeof p.x !== "number" || typeof p.y !== "number") return;
        cb(p.x, p.y);
      })),
    );
  },

  /** `dictate://toggle`, for the dictation panel. */
  onDictateToggle: (cb: (payload: DictateTogglePayload) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<DictateTogglePayload>("dictate://toggle", gate((p) => {
        if (!p || typeof p.run !== "number" || !DICTATE_ACTIONS.includes(p.action)) return;
        cb({ run: p.run, action: p.action });
      })),
    );
  },

  /** `dictate://agent`, for the dictation panel: the agent's progress on run `run`. */
  /** The mouse over Dictate anywhere's panel (true) or off it (false). */
  onDictateHover: (cb: (inside: boolean) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<boolean>("dictate://hover", gate((inside) => {
        if (typeof inside === "boolean") cb(inside);
      })),
    );
  },

  onDictateAgent: (cb: (payload: { run: number; state: TalkAgentState }) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<{ run: number; state: TalkAgentState }>("dictate://agent", gate((p) => {
        if (!p || typeof p.run !== "number" || !TALK_AGENT_STATES.includes(p.state)) return;
        cb({ run: p.run, state: p.state });
      })),
    );
  },

  // ── Talk anywhere (talk_*; docs/plans/talk-anywhere.md) ─────────────────
  // The panel's words for the agent travel through the desktop to the main
  // window, which sends them to the home thread and reports back.

  /** The panel: words for the agent (run `run`). Never rejects. */
  talkSend: async (run: number, text: string): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("talk_send", { run, text });
    } catch {
      /* an older desktop */
    }
  },

  /** The main window: how run `run` is going. Never rejects. */
  talkState: async (run: number, state: TalkAgentState): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("talk_state", { run, state });
    } catch {
      /* an older desktop */
    }
  },

  /** The main window: words from the panel for the home thread. */
  onTalkAsk: (cb: (payload: { run: number; text: string }) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<{ run: number; text: string }>("talk://ask", gate((p) => {
        if (!p || typeof p.run !== "number" || typeof p.text !== "string") return;
        cb({ run: p.run, text: p.text });
      })),
    );
  },

  /** The main window: cut run `run`'s reply short (a new hold, or Esc on the circle). */
  onTalkInterrupt: (cb: (payload: { run: number }) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<{ run: number }>("talk://interrupt", gate((p) => {
        if (!p || typeof p.run !== "number") return;
        cb({ run: p.run });
      })),
    );
  },

  // ── Chat voice (dictation + voice mode) ───────────────────────
  // VERSION SKEW: like read-aloud, every wrapper is inert without the
  // commands: status resolves unavailable, start rejects
  // VoiceRefusedError('unavailable'), stop/cancel/mute resolve, and the event
  // listener is a no-op. Outside the desktop none of them touches Tauri.

  /** What voice can do on this desktop right now. Never rejects. */
  voiceStatus: async (): Promise<VoiceStatus> => {
    if (!isDesktopApp()) return VOICE_UNAVAILABLE;
    try {
      return toVoiceStatus(await invoke<unknown>("voice_status"));
    } catch {
      return VOICE_UNAVAILABLE;
    }
  },

  /** Start a session. The web picks `sessionId` and should subscribe to its
   *  events first. Rejects VoiceRefusedError with `recording` / `busy` /
   *  `not_ready` / `mic_denied` / `unavailable` (`unavailable: lid_closed`:
   *  the mic it would use is a MacBook's, lid shut). */
  voiceStart: async (args: {
    sessionId: string;
    mode: VoiceMode;
    endSilenceMs?: number;
    bargeIn?: boolean;
    /** Absent or unknown → the desktop's quiet room; 0.2.45 ignores it. */
    noiseProfile?: VoiceNoiseProfile;
    /** Send `voice://speech` (voice_status `speechAudio`). Sent only when true. */
    speechAudio?: boolean;
  }): Promise<void> => {
    if (!isDesktopApp()) throw new VoiceRefusedError("unavailable");
    const payload: Record<string, unknown> = { sessionId: args.sessionId, mode: args.mode };
    if (typeof args.endSilenceMs === "number") payload.endSilenceMs = args.endSilenceMs;
    if (typeof args.bargeIn === "boolean") payload.bargeIn = args.bargeIn;
    if (typeof args.noiseProfile === "string") payload.noiseProfile = args.noiseProfile;
    if (args.speechAudio === true) payload.speechAudio = true;
    try {
      await invoke<void>("voice_start", payload);
    } catch (err) {
      throw voiceRefusal(err);
    }
  },

  /** End a session gracefully (dictation: finalize, then `voice://ended` with
   *  the text). A no-op for an unknown or finished session. Never rejects. */
  voiceStop: async (sessionId: string): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("voice_stop", { sessionId });
    } catch {
      /* no voice on this build */
    }
  },

  /** End a session now, discarding what it heard. Never rejects. */
  voiceCancel: async (sessionId: string): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("voice_cancel", { sessionId });
    } catch {
      /* no voice on this build */
    }
  },

  /** Gate the mic (no VAD, no transcription); the session stays open. */
  voiceSetMuted: async (sessionId: string, muted: boolean): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("voice_set_muted", { sessionId, muted });
    } catch {
      /* no voice on this build */
    }
  },

  /** The agent speech about to play is an aside (voice mode's greeting), with
   *  its `text`: on headphones the user may talk over it before echo
   *  cancellation allows barge-in, and the desktop keeps the aside's own
   *  words (its echo on the mic) out of the user's turn. `false` takes that
   *  back. A desktop without the command (0.2.45) ignores it: the greeting
   *  then plays like any reply. */
  voiceSetAside: async (sessionId: string, aside: boolean, text?: string): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("voice_set_aside", text === undefined ? { sessionId, aside } : { sessionId, aside, text });
    } catch {
      /* no voice_set_aside on this build */
    }
  },

  /** Interactive mode's barge policy for a live session (VoiceBargePolicy):
   *  `speech` while the agent's reply is spoken and in the follow-up window
   *  after it, `wake` the rest of the time. Works for conversation and
   *  interactive sessions. A desktop without the command (or an unknown
   *  session) is ignored. Never rejects. */
  voiceSetBarge: async (sessionId: string, policy: VoiceBargePolicy): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("voice_set_barge", { sessionId, policy });
    } catch {
      /* no voice_set_barge on this build, or the session is gone */
    }
  },

  /** Write `[voice-focus] <sessionId> <line>` into the desktop's debug log
   *  (ids and numbers only; `line` is cut to 400 characters). A desktop
   *  without `voice_log` rejects it: never surfaces. */
  voiceLog: async (sessionId: string, line: string): Promise<void> => {
    if (!isDesktopApp()) return;
    try {
      await invoke<void>("voice_log", { sessionId, line: line.slice(0, VOICE_LOG_MAX) });
    } catch {
      /* no voice_log on this build */
    }
  },

  /** Subscribe to one session's `voice://*` events (the six in §3.3, and
   *  `speech` for a session started with `speechAudio`; other sessions'
   *  events and malformed payloads are dropped). Returns the
   *  unsubscribe function synchronously; listeners attach in the background
   *  and are dropped if unsubscribed first.
   *
   *  A null `sessionId` takes every session's events: the desktop overlay's
   *  bot bubble glows with the main window's voice session without knowing
   *  its id (the desktop runs one session at a time, and the bubble listens
   *  only while the main window says its talk is live). `only` listens to
   *  just those of the six (default: all). */
  onVoiceEvent: (
    sessionId: string | null,
    cb: (event: VoiceEvent) => void,
    only?: readonly VoiceEvent["type"][],
  ): (() => void) => {
    if (!isDesktopApp()) return () => {};
    // One import for the listeners. A build without voice events rejects
    // each subscribe; listenScoped swallows it (and unlistens safely).
    const names = only ? VOICE_EVENT_NAMES.filter((name) => only.includes(name)) : VOICE_EVENT_NAMES;
    const tauriEvent = import("@tauri-apps/api/event");
    return disposeAll(
      ...names.map((name) =>
        listenScoped((gate) =>
          tauriEvent.then(({ listen: tauriListen }) =>
            tauriListen<Record<string, unknown>>(`voice://${name}`, gate((e) => {
              const p = e.payload;
              if (!p || typeof p !== "object") return;
              if (sessionId !== null && p.sessionId !== sessionId) return;
              const event = toVoiceEvent(name, p);
              if (event) cb(event);
            })),
          ),
        ),
      ),
    );
  },

  /** Subscribe to the local engine's Deepgram-shaped transcript messages. */
  onSttMessage: (cb: (payload: SttMessagePayload) => void) =>
    listen<SttMessagePayload>("stt://message", cb),

  /** Subscribe to local-engine failure (start-up or mid-session): the web
   *  falls back to Deepgram for the rest of the session. */
  onSttEngineChanged: (cb: (payload: SttEngineChangedPayload) => void) =>
    listen<SttEngineChangedPayload>("stt://engine-changed", cb),

  /** Subscribe to `stt://finished`: after stop_recording in a local session
   *  the sidecar flushes its last utterance, then this fires once those finals
   *  have been emitted (immediately if the recording stopped before the engine
   *  finished loading). An engine failure emits engine-changed instead. */
  onSttFinished: (cb: (payload: SttFinishedPayload) => void) =>
    listen<SttFinishedPayload>("stt://finished", cb),

  /** Subscribe to one stream's raw PCM (16 kHz mono Int16 LE bytes) — the
   *  same `audio://mic` / `audio://system` events Deepgram forwards. */
  onAudioPcm: (stream: "mic" | "system", cb: (bytes: number[]) => void) =>
    listen<number[]>(`audio://${stream}`, cb),

  // ── Event listeners ───────────────────────────────────────────

  /** Subscribe to real-time audio level updates (~10Hz). */
  onAudioLevel: (cb: (level: AudioLevelPayload) => void) =>
    listen<AudioLevelPayload>("audio-level", cb),

  /** Subscribe to `audio://input-silent`: the mic in use has sent pure
   *  digital silence for 3 s (`silent: true`), or sound again (`false`).
   *  Returns the unsubscribe function synchronously; malformed payloads are
   *  dropped, and a desktop without the event never calls back. */
  onInputSilent: (cb: (event: InputSilentEvent) => void): (() => void) => {
    if (!isDesktopApp()) return () => {};
    return listenScoped((gate) =>
      listen<unknown>(INPUT_SILENT_EVENT, gate((payload) => {
        const event = toInputSilentEvent(payload);
        if (event) cb(event);
      })),
    );
  },

  /** Subscribe to mic-stream fault events (device disconnect). The handler
   *  should call `recoverMic()` to rebuild the stream on the default device. */
  onMicFault: (cb: () => void) =>
    listen<void>("audio://mic-fault", () => cb()),

  /** Subscribe to meeting detected events. */
  onMeetingDetected: (cb: (app: DetectedApp) => void) =>
    listen<DetectedApp>("meeting-detected", cb),

  /** Subscribe to meeting auto-start events. */
  onMeetingAutoStart: (cb: (app: DetectedApp) => void) =>
    listen<DetectedApp>("meeting-detected-auto-start", cb),

  /** Subscribe to meeting ended events. */
  onMeetingEnded: (cb: () => void) =>
    listen<void>("meeting-ended", () => cb()),

  /** Request capture start from the meeting HUD window (routed through Rust for cross-window delivery). */
  requestCaptureFromHud: (event?: TrayCalendarEvent | null) =>
    invoke<void>("request_capture_from_hud", { event: event ?? null }),

  /** Listen for capture requests from the meeting HUD window. */
  onStartCaptureFromHud: (cb: (event: TrayCalendarEvent | null) => void) =>
    listen<TrayCalendarEvent | null>("start-capture-from-hud", cb),

  /** Listen for event re-linking from the HUD dropdown while a capture is running. */
  onHudLinkEvent: (cb: (event: TrayCalendarEvent | null) => void) =>
    listen<TrayCalendarEvent | null>("hud-link-event", cb),

  // ── Local Exchange Calendar (EventKit) ─────────────────────────

  /** Request EventKit calendar access (triggers macOS permission dialog). */
  requestCalendarAccess: () =>
    invoke<LocalCalendarStatus>("request_calendar_access"),

  /** Check EventKit access status without triggering permission dialog. */
  getLocalCalendarStatus: () =>
    invoke<LocalCalendarStatus>("get_local_calendar_status"),

  /** Fetch Exchange calendar events from macOS Calendar.app. */
  getLocalExchangeEvents: (opts: { timeMin: string; timeMax: string }) =>
    invoke<LocalCalendarEvent[]>("get_local_exchange_events", {
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
    }),

  /** Create a new event in a local Exchange calendar. */
  createLocalExchangeEvent: (opts: {
    calendarId: string;
    title: string;
    start: string;
    end: string;
    isAllDay?: boolean;
    location?: string;
    notes?: string;
  }) =>
    invoke<{ success: boolean; eventId?: string; error?: string }>(
      "create_local_exchange_event",
      opts,
    ),

  /** Update an existing event in a local Exchange calendar. */
  updateLocalExchangeEvent: (opts: {
    eventId: string;
    title?: string;
    start?: string;
    end?: string;
    location?: string;
    notes?: string;
  }) =>
    invoke<{ success: boolean; eventId?: string; error?: string }>(
      "update_local_exchange_event",
      opts,
    ),

  /** Delete an event from a local Exchange calendar. */
  deleteLocalExchangeEvent: (eventId: string) =>
    invoke<{ success: boolean; eventId?: string; error?: string }>(
      "delete_local_exchange_event",
      { eventId },
    ),

  // ── System Tray ─────────────────────────────────────────────────

  /** Send Supabase auth token to Rust for API calls (calendar tray). */
  setAuthToken: (token: string) =>
    invoke<void>("set_auth_token", { token }),

  /**
   * Subscribe to "Start Capture" clicks from the system tray.
   * Payload is the full CalendarEvent (matching state.rs CalendarEvent shape).
   */
  onStartCaptureFromEvent: (cb: (event: TrayCalendarEvent) => void) =>
    listen<TrayCalendarEvent>("start-capture-from-event", cb),

  /**
   * Save bytes to disk via the native save panel. The WKWebView has no
   * download handler, so anchor `download` clicks are silently dropped —
   * file saving must round-trip through Rust. Returns the chosen path, or
   * null if the user cancelled.
   */
  saveFile: (fileName: string, contents: number[]) =>
    invoke<string | null>("save_file", { fileName, contents }),

  // ── App Updates ──────────────────────────────────────────────

  /**
   * Check for a newer signed build. Null when up to date. `install()` downloads,
   * verifies and installs it; the person restarts to apply.
   *
   * Since the 2026-10-31 security review (P0-3) the decision is Rust's: the
   * capability no longer grants the updater plugin to the web, and
   * `app_update_check` / `app_update_install` refuse a downgrade and any bundle
   * whose own version isn't the manifest's (src-tauri/src/app_update.rs). A
   * binary from before that has no such commands but still grants the plugin:
   * there it falls back to the plugin, so older apps keep updating (which is
   * how they get this fix).
   */
  checkForUpdate: async (): Promise<BinaryUpdate | null> => {
    try {
      const found = await invoke<{ available: boolean; version: string | null }>('app_update_check')
      if (!found.available || !found.version) return null
      const version = found.version
      return {
        available: true,
        version,
        install: () => invoke<string>('app_update_install', { expected: version }).then(() => undefined),
        via: 'rust',
      }
    } catch (err) {
      if (!isMissingCommand('app_update_check', err)) throw err
    }
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update || !update.available) return null
    return { available: true, version: update.version, install: () => update.downloadAndInstall(), via: 'plugin' }
  },

  /** Relaunch the app (used after update install). */
  relaunch: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    return relaunch()
  },

  /**
   * The person's "Restart now" after `install()`: Rust's `app_update_apply`.
   * macOS restarts into the new app already in place; Windows runs the
   * verified installer, which closes Native Intelligence and opens the new one (its install
   * only staged it, so a scheduled check never closes the app mid-meeting).
   * A binary without the command restarts as before.
   */
  applyUpdate: async () => {
    try {
      await invoke<void>('app_update_apply')
      return
    } catch (err) {
      if (!isMissingCommand('app_update_apply', err)) throw err
    }
    const { relaunch } = await import('@tauri-apps/plugin-process')
    return relaunch()
  },

  /** Listen for "check-for-updates" events from the tray menu. */
  onCheckForUpdates: (cb: () => void) =>
    listen<void>('check-for-updates', () => cb()),

  // ── Native OS notifications ──────────────────────────────────
  //
  // Native banners (macOS Notification Center / Windows toast) raised when the
  // app window is NOT focused. The Rust side is deliberately payload-agnostic:
  // it displays `title`/`body` verbatim and carries `payload` back opaquely on
  // click, so new notification types need zero native changes.
  //
  // VERSION SKEW: the web app deploys ahead of the native binary, so
  // every one of these can reject with "command not found" on an older shell.
  // Callers MUST treat any rejection as "native notifications unavailable" and
  // fall back to the in-app toast.

  /**
   * Raise one native OS notification. `id` is the Native Intelligence notification row UUID —
   * Rust dedupes on it (multi-window workspaces each run their own realtime
   * subscription and would otherwise each fire). `payload` is an opaque JSON
   * string echoed back by `onNotificationClicked`.
   *
   * RESOLVED VALUE (three cases, all non-error):
   * - `true`             — the banner was shown.
   * - `false`            — the native side deliberately SKIPPED it because a
   *                        Native Intelligence window is currently focused (the app is
   *                        frontmost, so an in-app toast is the right surface).
   *                        The caller MUST toast. This is not a failure and
   *                        must not disable the native path.
   * - `undefined`/`null` — an OLD native binary whose command returns unit.
   *                        Treat as shown.
   * A rejection still means "native unavailable" (missing command, permission
   * denied, backend error) and is the only signal that disables the path.
   *
   * A bot's banner (bots v3, phase 7) adds three optional extras: `threadId`
   * (Notification Center stacks banners sharing it: the bot's teammate id),
   * `subtitle` (the workspace) and `image` (the bot's still, a PNG data URL).
   * They're only sent when set, and a binary that predates them ignores them
   * (Tauri reads only the args a command names), so the call is the same on
   * every shell.
   */
  showNativeNotification: (opts: {
    id: string;
    title: string;
    body?: string;
    payload?: string;
    threadId?: string;
    subtitle?: string;
    image?: string;
  }) =>
    invoke<boolean | void>("show_native_notification", {
      id: opts.id,
      title: opts.title,
      body: opts.body ?? null,
      payload: opts.payload ?? null,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.subtitle ? { subtitle: opts.subtitle } : {}),
      ...(opts.image ? { image: opts.image } : {}),
    }),

  /**
   * Take notification row `id`'s delivered banner out of Notification Center
   * (its item was opened, or the notice read). Resolves true when the OS was
   * asked, false when this build or platform can't remove.
   *
   * VERSION SKEW: an older binary has no such command and rejects. That means
   * "can't remove" ONLY: callers must never let it disable the banner path
   * (see removeDeliveredBanners in native-notification-path.ts).
   */
  removeDeliveredNotification: (id: string) =>
    invoke<boolean>("remove_delivered_notification", { id }),

  /** Current OS notification authorization, without prompting. */
  notificationPermissionState: () =>
    invoke<NotificationPermissionState>("notification_permission_state"),

  /** Trigger the OS permission prompt (only meaningful in the "prompt" state);
   *  resolves with the resulting state. */
  requestNotificationPermission: () =>
    invoke<NotificationPermissionState>("request_notification_permission"),

  /** Subscribe to native-notification clicks. `payload` is null when the click
   *  arrived without recoverable user-info (cold start) — treat that as "just
   *  open the Inbox". Returns an unlisten fn.
   *
   *  WINDOW-TARGETED on purpose (see `listenOnThisWindow`): Rust delivers a
   *  click to the ONE window that raised the notification via
   *  `emit_to(EventTarget::labeled(label), ...)`. The global `listen` helper
   *  registers as `EventTarget::Any`, which receives every window's targeted
   *  events too — with two dashboard windows open, a single click would then
   *  navigate both of them. */
  onNotificationClicked: (
    cb: (e: { id: string; payload: string | null }) => void,
  ) =>
    listenOnThisWindow<{ id: string; payload: string | null }>(
      "notification-clicked",
      cb,
    ),

  /** Tell Rust this webview's click listener is registered so it can flush any
   *  clicks buffered during startup (mirrors the agent-HUD ready handshake). */
  notifyNotificationClickListenerReady: () =>
    invoke<void>("notification_click_listener_ready"),

  /** Tell Rust this webview's click listener is GONE, so it stops treating this
   *  window as a live click target (a stale entry silently swallows clicks).
   *  Covers the SPA-unmount edge; Rust's own `on_page_load` hook covers hard
   *  navigations and reloads. Rejects on older binaries — ignore. */
  notifyNotificationClickListenerGone: () =>
    invoke<void>("notification_click_listener_gone"),

  // ── Close-to-tray ────────────────────────────────────────────
  //
  // When enabled (the native default), closing the main window hides it
  // instead of quitting: the process, tray, and realtime subscription keep
  // running so native notifications still arrive.
  //
  // VERSION SKEW: the web app ships ahead of the native binary, so the getter
  // rejects with "command not found" on an older shell. Callers MUST treat a
  // rejection as "this build has no close-to-tray" and render no control.

  /** Current close-to-tray setting. Rejects on binaries without the command. */
  getCloseToTray: () => invoke<boolean>("get_close_to_tray"),

  /** Persist the close-to-tray setting and update the native cache. */
  setCloseToTray: (enabled: boolean) =>
    invoke<void>("set_close_to_tray", { enabled }),

  // ── Desktop bots (retired) ────────────────────────────────
  //
  // The roaming bots' desktop overlay is gone from the web app. An older
  // native build may still have its window open from before: this closes it
  // (desktop-shell startup, components/desktop/close-stale-bots-overlay.tsx).
  // REMOVE once the native overlay removal has shipped. Rejects on a shell
  // without the command; callers ignore that.
  hideDesktopBots: () => invoke<void>("hide_desktop_bots"),

  // ── Multi-Window Workspaces ─────────────────────────────────

  /**
   * Open a workspace in a new window with its own isolated browsing context.
   * Each window gets separate cookies, localStorage, and sessionStorage.
   * If a window for this workspace already exists, it will be focused.
   */
  openWorkspaceWindow: (workspaceId: string, workspaceName: string) =>
    invoke<void>("open_workspace_window", { workspaceId, workspaceName }),

  /**
   * Sign in through the desktop's web authentication session
   * (ASWebAuthenticationSession): a sign-in sheet over the Native Intelligence window that
   * hands the callback straight back. Resolves with the
   * `dial8desktop://auth/callback?…` URL it ended on, `'cancelled'` when the
   * user closed it, or `'unavailable'` on a build without the command.
   * Rejects on any other failure.
   */
  authWebSession: async (
    url: string,
  ): Promise<{ kind: "callback"; url: string } | { kind: "cancelled" } | { kind: "unavailable" }> => {
    if (!isDesktopApp()) return { kind: "unavailable" };
    try {
      const callback = await invoke<string>("auth_web_session_cmd", { url });
      return { kind: "callback", url: callback };
    } catch (e) {
      if (isMissingCommand("auth_web_session_cmd", e)) return { kind: "unavailable" };
      const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
      if (text === "cancelled") return { kind: "cancelled" };
      throw e instanceof Error ? e : new Error(text || "sign-in failed");
    }
  },
};

/** Shape of CalendarEvent as serialized from Rust (camelCase via serde rename_all). */
export interface TrayCalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  calendarName: string | null;
  location: string | null;
  description: string | null;
  conferenceUrl: string | null;
  htmlLink: string | null;
  attendees: string[];
  organizer: string | null;
  hasRecurrence: boolean;
  source: string | null;
}
