/**
 * The server's copy of a chat reply: the pure fold behind the reply-backup
 * hook (../hooks/reply-backup.ts).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The browser was the only writer of an eve chat turn, and only at its end
 * (POST /api/account/chat/eve-persist). A page that died mid-turn (a WebKit
 * crash, a reload, a quit) lost the turn from history, although eve finished
 * it and its tools ran (2026-10-19: update_sequence rewrote a sequence the
 * thread never showed). So the chat-agent keeps its own copy of the reply as
 * the turn runs and, at each turn end, posts it to /api/internal/chat/reply,
 * which writes it under the id the browser renders: a provisional row the
 * browser's own persist replaces (src/lib/chat/reply-backup.ts).
 *
 * ── What it keeps ───────────────────────────────────────────────────────────
 * Only the events the shared reducer (src/lib/chat/eve-turn-parts.ts
 * applyEveTurnEvent) turns into parts, and only the fields it reads.
 * Consecutive text (and reasoning) deltas merge into one, which the reducer
 * reads the same way, so the state is about the size of the stored message,
 * never one object per streamed delta. A tool payload past the display bound
 * is cut here exactly as the reducer would cut it ({@link boundToolPayload},
 * the twin of truncateToolOutput, pinned by reply-backup-drift.test.ts), and
 * a turn past {@link REPLY_BACKUP_MAX_CHARS} keeps its text but drops later
 * payloads, so the post stays under the function body limit.
 *
 * ── Keyed by reply id ───────────────────────────────────────────────────────
 * The transport names the reply each send starts or continues
 * (`x-chat-reply-id`, stamped on the principal by ../channels/eve.ts). A HITL
 * answer continues the same reply under the same id, so the fold carries
 * across the park the way the browser's message does. Another id (a new
 * message, a steer) starts a fresh fold. No id (a device ask, a server-written
 * home turn, an older client) folds nothing and drops what was kept: that
 * reply was already posted at its turn's end.
 *
 * Everything here is JSON-serializable (it lives in eve state) and total: a
 * malformed event is skipped, never a throw.
 */

/** A kept event: the reducer's input, with only the fields it reads. */
export type BackupEvent = { type: string; data?: Record<string, unknown> }

export interface ReplyBackupState {
  /** The reply the kept events belong to, or null when nothing is kept. */
  replyId: string | null
  events: BackupEvent[]
  /** Approximate size of the kept payloads and text (characters). */
  chars: number
}

/** A turn's kept events stop taking tool payloads past this (characters): the post stays under 4.5 MB. */
export const REPLY_BACKUP_MAX_CHARS = 1_500_000

/** What a dropped payload reads as once the turn is past REPLY_BACKUP_MAX_CHARS. */
export const REPLY_BACKUP_OMITTED = '[omitted from the server copy: the reply was too large]'

// Twins of src/lib/chat/eve/tool-output-truncation.ts (the eve runtime cannot
// import Next-side modules); reply-backup-drift.test.ts keeps them equal.
export const BACKUP_TOOL_OUTPUT_MAX_SERIALIZED_CHARS = 64_000
export const BACKUP_TOOL_OUTPUT_HEAD_CHARS = 8_000
export const BACKUP_TOOL_OUTPUT_TAIL_CHARS = 2_000
export const BACKUP_MODEL_ONLY_TOOL_FIELDS: readonly string[] = ['__expertise']

export function emptyReplyBackup(): ReplyBackupState {
  return { replyId: null, events: [], chars: 0 }
}

/** The stored state, or an empty one when the slot holds anything unexpected. */
export function saneReplyBackup(s: unknown): ReplyBackupState {
  const r = rec(s)
  if (!r || !Array.isArray(r.events)) return emptyReplyBackup()
  return {
    replyId: typeof r.replyId === 'string' && r.replyId ? r.replyId : null,
    events: r.events as BackupEvent[],
    chars: typeof r.chars === 'number' && Number.isFinite(r.chars) ? r.chars : 0,
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Serialized size, as truncateToolOutput measures it (a string is its own length). */
function serializedOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  try {
    const s = JSON.stringify(value)
    return typeof s === 'string' ? s : null
  } catch {
    return null
  }
}

/**
 * A tool payload bounded the way truncateToolOutput bounds it for display:
 * untouched when its serialized form fits, else the same head … tail string.
 * The reducer's own truncateToolOutput then leaves it as is.
 */
export function boundToolPayload(value: unknown): unknown {
  const serialized = serializedOf(value)
  if (serialized === null || serialized.length <= BACKUP_TOOL_OUTPUT_MAX_SERIALIZED_CHARS) return value
  const totalKb = Math.round(serialized.length / 1024)
  const head = serialized.slice(0, BACKUP_TOOL_OUTPUT_HEAD_CHARS)
  const tail = serialized.slice(-BACKUP_TOOL_OUTPUT_TAIL_CHARS)
  return `${head}\n\n[output truncated for display — ${totalKb} KB total]\n\n${tail}`
}

/** The output without the fields only the model reads (stripModelOnlyToolFields' twin). */
function stripModelOnly(output: unknown): unknown {
  const r = rec(output)
  if (!r || !BACKUP_MODEL_ONLY_TOOL_FIELDS.some((f) => f in r)) return output
  const rest = { ...r }
  for (const f of BACKUP_MODEL_ONLY_TOOL_FIELDS) delete rest[f]
  return rest
}

/** A payload as kept: bounded, or dropped once the turn is past the cap. Returns it and its size. */
function admit(state: ReplyBackupState, value: unknown): { value: unknown; chars: number } {
  if (value === undefined) return { value, chars: 0 }
  const bounded = boundToolPayload(value)
  const chars = serializedOf(bounded)?.length ?? 0
  if (state.chars + chars > REPLY_BACKUP_MAX_CHARS) return { value: REPLY_BACKUP_OMITTED, chars: REPLY_BACKUP_OMITTED.length }
  return { value: bounded, chars }
}

/** Events kept with no data: the reducer reads only their type. */
const BARE_EVENTS = new Set(['message.completed', 'turn.completed', 'turn.cancelled', 'session.failed'])

/** The kept form of one stream event (and its size), or null when the reducer makes nothing of it. */
function keep(state: ReplyBackupState, event: unknown): { event: BackupEvent; chars: number } | null {
  const e = rec(event)
  const type = str(e?.type)
  if (!e || !type) return null
  const data = rec(e.data) ?? {}
  if (BARE_EVENTS.has(type)) return { event: { type }, chars: 0 }
  switch (type) {
    case 'reasoning.appended': {
      const delta = str(data.reasoningDelta)
      return delta ? { event: { type, data: { reasoningDelta: delta } }, chars: delta.length } : null
    }
    case 'message.appended': {
      const delta = str(data.messageDelta)
      return delta ? { event: { type, data: { messageDelta: delta } }, chars: delta.length } : null
    }
    case 'actions.requested': {
      if (!Array.isArray(data.actions)) return null
      let chars = 0
      const actions: Record<string, unknown>[] = []
      for (const raw of data.actions) {
        const a = rec(raw)
        const callId = str(a?.callId)
        if (!a || !callId) continue
        const input = admit({ ...state, chars: state.chars + chars }, a.input)
        chars += input.chars
        actions.push({
          kind: str(a.kind),
          callId,
          ...(str(a.toolName) ? { toolName: a.toolName } : {}),
          ...(str(a.subagentName) ? { subagentName: a.subagentName } : {}),
          input: input.value,
        })
      }
      // Kept even with no actions: the reducer still closes the open text there.
      return { event: { type, data: { actions } }, chars }
    }
    case 'action.result': {
      const r = rec(data.result)
      const kind = str(r?.kind)
      const callId = str(r?.callId)
      if (!r || !callId || (kind !== 'tool-result' && kind !== 'subagent-result')) return null
      const isError = r.isError === true
      // The reducer strips model-only fields from a result it draws (not an error's).
      const output = admit(state, isError ? r.output : stripModelOnly(r.output))
      return {
        event: {
          type,
          data: {
            result: {
              kind,
              callId,
              ...(str(r.toolName) ? { toolName: r.toolName } : {}),
              ...(str(r.subagentName) ? { subagentName: r.subagentName } : {}),
              ...(isError ? { isError: true } : {}),
              ...(output.value !== undefined ? { output: output.value } : {}),
            },
          },
        },
        chars: output.chars,
      }
    }
    case 'input.requested': {
      if (!Array.isArray(data.requests)) return null
      let chars = 0
      const requests: Record<string, unknown>[] = []
      for (const raw of data.requests) {
        const q = rec(raw)
        const requestId = str(q?.requestId)
        if (!q || !requestId) continue
        const action = rec(q.action)
        const input = action ? admit({ ...state, chars: state.chars + chars }, action.input) : null
        const options = q.options === undefined ? null : admit({ ...state, chars: state.chars + chars }, q.options)
        chars += (input?.chars ?? 0) + (options?.chars ?? 0)
        requests.push({
          requestId,
          ...(action
            ? {
                action: {
                  ...(str(action.callId) ? { callId: action.callId } : {}),
                  ...(str(action.toolName) ? { toolName: action.toolName } : {}),
                  ...(input && input.value !== undefined ? { input: input.value } : {}),
                },
              }
            : {}),
          ...(str(q.prompt) ? { prompt: q.prompt } : {}),
          ...(options ? { options: options.value } : {}),
        })
      }
      return requests.length ? { event: { type, data: { requests } }, chars } : null
    }
    case 'step.failed':
    case 'turn.failed':
      return { event: { type, data: { message: str(data.message) ?? '' } }, chars: 0 }
    default:
      return null
  }
}

/** The delta field a mergeable event carries, or null. */
function deltaKey(type: string): 'messageDelta' | 'reasoningDelta' | null {
  if (type === 'message.appended') return 'messageDelta'
  if (type === 'reasoning.appended') return 'reasoningDelta'
  return null
}

/**
 * Fold one stream event into the kept reply. `replyId` is the reply the
 * turn's current send names ('' or null when none). Returns the next state;
 * never throws.
 */
export function foldReplyBackup(state: ReplyBackupState, replyId: string | null, event: unknown): ReplyBackupState {
  if (!replyId) return state.replyId ? emptyReplyBackup() : state
  const base = state.replyId === replyId ? state : { replyId, events: [], chars: 0 }
  const kept = keep(base, event)
  if (!kept) return base
  const key = deltaKey(kept.event.type)
  const last = base.events[base.events.length - 1]
  if (key && last && last.type === kept.event.type) {
    // A delta right after one of its own kind: one longer delta reads the same.
    const merged: BackupEvent = { type: last.type, data: { [key]: `${String(last.data?.[key] ?? '')}${String(kept.event.data?.[key] ?? '')}` } }
    return { replyId, events: [...base.events.slice(0, -1), merged], chars: base.chars + kept.chars }
  }
  return { replyId, events: [...base.events, kept.event], chars: base.chars + kept.chars }
}

/** Whether the kept reply has anything a message would show (text, reasoning, a tool, a question). */
export function hasReplyContent(state: ReplyBackupState): boolean {
  return state.events.some(
    (e) =>
      e.type === 'message.appended' ||
      e.type === 'reasoning.appended' ||
      e.type === 'action.result' ||
      e.type === 'input.requested' ||
      (e.type === 'actions.requested' && Array.isArray(e.data?.actions) && e.data.actions.length > 0),
  )
}
