/**
 * The profile memory slot's logic (memory/profile.ts; docs/plans/always-on-agent.md
 * §3, slice A2a, decision 4): facts about the person, recalled through the
 * app's POST /api/internal/chat/memory, which owns the store, the epochs and
 * the memo by operationId (src/lib/memory/profile-recall.ts).
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * `[userId, workspaceId]` from `auth.initiator`, the caller who created the
 * session: it stays right during idle compaction, where `auth.current` is the
 * stale last turn's principal (or the server principal). Two initiators count:
 *   - the person (`principalType: 'user'`: the browser's app principal, or a
 *     device ask);
 *   - the SERVER principal (`principalType: 'service'`, `authenticator:
 *     'server'`): a home thread's session is created parked by the server
 *     (home-turn-server.ts ensureHomeSession → auth.ts serverCreatePrincipal),
 *     whose `principalId` is the userId of a VERIFIED home-turn token for that
 *     person's own home thread, with the token's workspace in its attributes.
 *     eve pins the initiator for the session's life, so without this the home
 *     chat had no memory at all (2026-10-15 → 10-18).
 * Null (the slot is off) when there is no signed-in person (local dev, any
 * other service principal) and for a teammate chat, which keeps its own memory. The teammate check reads the
 * initiator's run token WITHOUT verifying it, with spec-client's "only ever
 * LESS" contract: a forged claim can only switch memory off for the forger's
 * own chat. The app verifies the token, and that the scope names its own
 * user and workspace, on every call. A device ask recalls like the main chat.
 *
 * ── Never throws ────────────────────────────────────────────────────────────
 * A throwing `turn.started` recall fails the turn, and a replay that returns
 * different bytes fails it too. So every handler catches everything:
 *   - a result already returned for this operationId (in this process) is
 *     returned again, byte for byte;
 *   - else the route's result (the route memoizes by operationId, so a replay
 *     on another instance gets the same bytes);
 *   - on any failure, the last good result for this session, else nothing,
 *     pinned at the app for this operation (op 'pin'); when the app already
 *     stored a result for it (a timeout here, a success there), that stored
 *     result wins and is returned instead, so a replay always matches.
 *
 * ── Capture (A2c) ───────────────────────────────────────────────────────────
 * Right before compaction, captureProfile posts a text-only slice of what was
 * said since the last checkpoint (captureSlice) for the capture pass. It never
 * throws either: a throw there aborts eve's compaction.
 */
import type {
  MemoryOperationContext,
  MemoryRecallResult,
  MemoryScopeContext,
} from 'eve/memory'
import { personText } from './person-messages.js'
import { guestFromRunToken, postChatMemory, runTokenFromAuth, teammateFromRunToken } from './spec-client.js'

export type ProfileRecallPhase = 'turn.started' | 'compaction.completed'

/** What a failed recall returns when nothing good is cached: no records. */
const NOTHING: { messages: [] } = { messages: [] }

/** In-process caches, bounded (oldest dropped first). */
const OP_CACHE_MAX = 512
const SESSION_CACHE_MAX = 256
const byOperation = new Map<string, { messages: Array<{ id: string; content: string }> }>()
const bySession = new Map<string, { messages: Array<{ id: string; content: string }> }>()

function keep<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Test-only: forget every cached result. */
export function resetProfileMemoryCachesForTests(): void {
  byOperation.clear()
  bySession.clear()
}

/**
 * Whether a session's initiator may own profile memory: the person, or the
 * server principal that creates a home thread's parked session (see the module
 * note). Never another service principal. The app re-checks the scope against
 * the verified run token on every call, so this only ever turns memory OFF.
 */
function isMemoryInitiator(who: { principalType?: unknown; authenticator?: unknown }): boolean {
  if (who.principalType === 'user') return true
  return who.principalType === 'service' && who.authenticator === 'server'
}

/** The slot's scope: `[userId, workspaceId]` of the session's initiator, or null (see the module note). */
export function profileMemoryScope(ctx: Pick<MemoryScopeContext, 'session'>): [string, string] | null {
  const who = ctx.session.auth.initiator
  if (!who || !isMemoryInitiator(who)) return null
  const userId = who.principalId
  const workspaceId = who.attributes?.workspaceId
  const token = who.attributes?.chatRunToken
  if (typeof userId !== 'string' || !userId) return null
  if (typeof workspaceId !== 'string' || !workspaceId) return null
  // No run token: not a chat the app minted (local dev's principal).
  if (typeof token !== 'string' || !token) return null
  if (teammateFromRunToken(token)) return null
  // A guest's conversation (428): the owner's memory is never theirs to read or write.
  if (guestFromRunToken(token)) return null
  return [userId, workspaceId]
}

/** A route result, shape-guarded: a list of { id, content } with non-blank content. Null otherwise. */
export function validRecall(value: unknown): { messages: Array<{ id: string; content: string }> } | null {
  if (!value || typeof value !== 'object') return null
  const messages = (value as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return null
  const out: Array<{ id: string; content: string }> = []
  const ids = new Set<string>()
  for (const m of messages) {
    if (!m || typeof m !== 'object') return null
    const { id, content } = m as { id?: unknown; content?: unknown }
    if (typeof id !== 'string' || !id || id.length > 1024 || ids.has(id)) return null
    if (typeof content !== 'string' || content.trim().length === 0) return null
    ids.add(id)
    out.push({ id, content })
  }
  return { messages: out }
}

type RecallContext = Pick<MemoryOperationContext, 'operationId' | 'session' | 'memory'>

// ── Capture at compaction (A2c) ─────────────────────────────────────────────
//
// Twins of src/lib/memory/capture-slice.ts's limits (this eve root cannot
// import the app; profile-memory-drift.test.ts keeps them equal).
export const CAPTURE_SLICE_MAX_CHARS = 40_000
export const CAPTURE_MESSAGE_MAX_CHARS = 6_000
export const CAPTURE_SLICE_MAX_MESSAGES = 400

/**
 * eve's framework message kinds (harness/messages.js isFrameworkMessageKind):
 * the turn context and expertise (`context.instruction`), state, the last
 * checkpoint's summary (`context.compaction`, captured when it was made),
 * recalled memory records (`memory.load`) and execution notices. None of them
 * is something the person or the agent said.
 */
const FRAMEWORK_KINDS = new Set([
  'context.instruction',
  'context.state',
  'context.compaction',
  'memory.load',
  'execution.background_task',
  'execution.continuation',
  'execution.retry',
])

/** Text the app injects as a user message, in case one ever arrives without its kind. */
const INJECTED_PREFIX_RE = /^\s*<(turn-context|expertise|memory|remembered)\b/i

export interface CaptureSliceMessage {
  role: 'user' | 'assistant'
  text: string
}

/** One message's text, tidied, a long one clipped to its TAIL (where the person's own words are). */
function clip(text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return clean.length > CAPTURE_MESSAGE_MAX_CHARS ? `…${clean.slice(-(CAPTURE_MESSAGE_MAX_CHARS - 1))}` : clean
}

/** A message's text parts (a string content is one text part). Tool calls, results, files and reasoning drop out. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map((p) => (p as { text: string }).text)
    .join('\n')
}

/**
 * Whether `message` is eve's checkpoint marker: the `context.compaction` user
 * message right before the summary (an assistant message). eve writes a
 * checkpoint as that pair (harness/compaction.js); checkpointText reads it.
 */
function isCompactionMarker(message: unknown): boolean {
  const m = message as { role?: unknown; kind?: unknown } | null
  return !!m && typeof m === 'object' && m.role === 'user' && m.kind === 'context.compaction'
}

/**
 * What was said since the last capture, from eve's history at
 * compaction.requested: the person's and the agent's text only, oldest first,
 * the newest kept within CAPTURE_SLICE_MAX_CHARS. History before the last
 * checkpoint is already gone, replaced by that checkpoint: its marker (a
 * `context.compaction` message) and its summary, an ASSISTANT message right
 * after it. The summary is eve's, not something the agent said, so it is
 * skipped with its marker, and this is what was said since the last
 * compaction. Pure; never throws.
 */
export function captureSlice(messages: readonly unknown[]): CaptureSliceMessage[] {
  const said: CaptureSliceMessage[] = []
  let afterMarker = false
  for (const m of Array.isArray(messages) ? messages : []) {
    // The checkpoint's summary: the assistant message right after its marker.
    const summary = afterMarker && !!m && typeof m === 'object' && (m as { role?: unknown }).role === 'assistant'
    afterMarker = isCompactionMarker(m)
    if (summary) continue
    if (!m || typeof m !== 'object') continue
    const { role, kind, content } = m as { role?: unknown; kind?: unknown; content?: unknown }
    if (role !== 'user' && role !== 'assistant') continue
    // eve classifies every user-role message: only `user` is the person's.
    if (role === 'user' && typeof kind === 'string' && kind !== 'user') continue
    if (typeof kind === 'string' && FRAMEWORK_KINDS.has(kind)) continue
    const raw = textOf(content)
    // The person's own words only: no history primer, no seeded UI send.
    const text = role === 'user' ? personText(raw) : raw
    if (!text || !text.trim() || (role === 'user' && INJECTED_PREFIX_RE.test(text))) continue
    said.push({ role, text })
  }
  const out: CaptureSliceMessage[] = []
  let left = CAPTURE_SLICE_MAX_CHARS
  for (let i = said.length - 1; i >= 0 && out.length < CAPTURE_SLICE_MAX_MESSAGES; i--) {
    const text = clip(said[i].text)
    if (!text) continue
    if (text.length > left) break
    out.push({ role: said[i].role, text })
    left -= text.length
  }
  return out.reverse()
}

type CaptureContext = Pick<MemoryOperationContext, 'operationId' | 'session' | 'memory' | 'messages'> & {
  turn?: { sequence?: number } | null
}

/**
 * The run token a capture posts with. A compaction carries no auth of its
 * own (re-checked in eve 0.79.1: channel/session.js `compact()` dispatches
 * `{ command: { kind: 'compact' } }` with no principal; harness/compaction/
 * step.js maybeCompact receives the session's stored `auth`, used only for
 * the summary call's provider options), so `auth.current` stays the LAST
 * TURN's caller (the person, with that turn's token), never the server
 * principal that asked for an idle compaction. That
 * token is what the route's 2-hour capture grace is for. Should `auth.current`
 * ever carry no token, the initiator's is tried (the route still refuses one
 * past the grace).
 */
export function captureToken(auth: MemoryOperationContext['session']['auth']): string {
  const current = runTokenFromAuth(auth)
  if (current) return current
  const initiator = auth?.initiator?.attributes?.chatRunToken
  return typeof initiator === 'string' ? initiator : ''
}

/**
 * capture['compaction.requested']: post the slice to the memory route, which
 * queues the capture pass (Inngest → the utility agent) and answers at once.
 * NEVER throws: a throw here aborts eve's compaction. Any failure is logged,
 * and the conversation simply goes uncaptured until the nightly catch-up.
 */
export async function captureProfile(ctx: CaptureContext): Promise<void> {
  try {
    const slice = captureSlice(ctx.messages)
    if (!slice.some((m) => m.role === 'user')) return
    const sequence = typeof ctx.turn?.sequence === 'number' ? ctx.turn.sequence : null
    await postChatMemory(captureToken(ctx.session.auth), {
      op: 'capture',
      phase: 'compaction.requested',
      operationId: ctx.operationId,
      sessionId: ctx.session.id,
      scope: ctx.memory.scope.value,
      sequence,
      messages: slice,
    })
  } catch (err) {
    console.error(`[chat-agent] profile memory capture skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── The checkpoint, for the home thread's re-prime (A3) ─────────────────────
//
// Twin of src/lib/chat/home-thread.ts HOME_CHECKPOINT_MAX_CHARS (this eve root
// cannot import the app; profile-memory-drift.test.ts keeps them equal).
export const CHECKPOINT_MAX_CHARS = 16_000

/**
 * The text of eve's newest checkpoint in `messages`: eve writes a checkpoint as
 * a `context.compaction` user message (its marker, "Summary of our
 * conversation so far:") followed by the summary as an assistant message
 * (harness/compaction.js). So: the assistant message right after the last
 * `context.compaction` message, its text parts, capped to its head (a summary
 * leads with the gist). Null when there is none. Pure; never throws.
 */
export function checkpointText(messages: readonly unknown[]): string | null {
  const list = Array.isArray(messages) ? messages : []
  let at = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (isCompactionMarker(list[i])) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const next = list[at + 1] as { role?: unknown; content?: unknown } | undefined
  if (!next || typeof next !== 'object' || next.role !== 'assistant') return null
  const text = textOf(next.content).replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  return text.length > CHECKPOINT_MAX_CHARS ? `${text.slice(0, CHECKPOINT_MAX_CHARS - 1)}…` : text
}

/**
 * recall['compaction.completed'] also hands the app the new checkpoint's text
 * (op 'checkpoint'), stored on the conversation as checkpoint_summary /
 * checkpoint_at, so a home thread whose session must restart re-primes from
 * it (renderHomePrimer). It runs beside the recall and changes nothing the
 * recall returns, so a replayed step returns the same bytes; the app's store
 * is idempotent on the text. NEVER throws, and never delays the recall past
 * the route's own timeout. Posted with the capture's token (captureToken): an
 * idle compaction carries the last turn's token, which the route accepts
 * within the capture grace.
 */
export async function postCheckpoint(ctx: CaptureContext): Promise<void> {
  try {
    const text = checkpointText(ctx.messages)
    if (!text) return
    await postChatMemory(captureToken(ctx.session.auth), {
      op: 'checkpoint',
      phase: 'compaction.completed',
      operationId: ctx.operationId,
      sessionId: ctx.session.id,
      scope: ctx.memory.scope.value,
      text,
    })
  } catch (err) {
    console.error(`[chat-agent] checkpoint post skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * recall['compaction.completed']: the recall, with the checkpoint posted beside
 * it. Returns exactly what recallProfile returns.
 */
export async function recallAfterCompaction(ctx: RecallContext & Pick<MemoryOperationContext, 'messages'>): Promise<MemoryRecallResult> {
  const [result] = await Promise.all([recallProfile('compaction.completed', ctx), postCheckpoint(ctx)])
  return result
}

/** One recall for `phase`. Never throws (see the module note). */
export async function recallProfile(phase: ProfileRecallPhase, ctx: RecallContext): Promise<MemoryRecallResult> {
  try {
    const cached = byOperation.get(ctx.operationId)
    if (cached) return cached
    const sessionId = ctx.session.id
    const runToken = runTokenFromAuth(ctx.session.auth)
    const ids = { phase, operationId: ctx.operationId, sessionId, scope: ctx.memory.scope.value }
    let result: { messages: Array<{ id: string; content: string }> }
    try {
      const valid = validRecall(await postChatMemory(runToken, { op: 'recall', ...ids }))
      if (!valid) throw new Error('malformed recall result')
      result = valid
      keep(bySession, sessionId, result, SESSION_CACHE_MAX)
    } catch (err) {
      console.error(`[chat-agent] profile memory ${phase} fell back: ${err instanceof Error ? err.message : String(err)}`)
      result = bySession.get(sessionId) ?? NOTHING
      // Pin the fallback, so a replay that reaches the app gets these same
      // bytes. If the app already stored a result for this operation (the
      // recall timed out here but finished there), the stored one wins and is
      // what this turn gets. Best effort: an unreachable app keeps the fallback.
      try {
        const pinned = validRecall(await postChatMemory(runToken, { op: 'pin', ...ids, result }))
        if (pinned) result = pinned
      } catch (pinErr) {
        console.error(`[chat-agent] profile memory ${phase} pin failed: ${pinErr instanceof Error ? pinErr.message : String(pinErr)}`)
      }
    }
    keep(byOperation, ctx.operationId, result, OP_CACHE_MAX)
    return result
  } catch (err) {
    console.error(`[chat-agent] profile memory ${phase} failed: ${err instanceof Error ? err.message : String(err)}`)
    return NOTHING
  }
}
