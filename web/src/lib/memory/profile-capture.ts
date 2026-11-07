/**
 * Queue one capture pass (always-on plan §3b, slice A2c): the memory route's
 * `op: 'capture'` (at compaction) and the nightly catch-up both land here.
 *
 *   1. Idempotent by eve's operationId (or the catch-up's own): the operation
 *      is recorded in `chat_memory_op` (op 'capture') before the event goes
 *      out, and a replay finds it and queues nothing.
 *   2. The slice is stored on that row, and also rides the event when it fits
 *      comfortably in an Inngest payload; the job reads the row otherwise.
 *   3. The session's epoch row records how far the conversation was captured
 *      (`captured_through_seq` / `_at`) and when (`last_capture_at`), which the
 *      nightly catch-up reads.
 *   4. It answers as soon as the event is sent: the model call is the job's.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MEMORY_CAPTURE_EVENT } from './capture-pass'
import { sliceHasPersonText, type SliceMessage } from './capture-slice'
import { loadProfileFacts } from './profile-facts'
import { snapshotHash } from './profile-recall'

/** How long past its expiry a run token may still CAPTURE (idle compaction runs on the last turn's token). */
export const CAPTURE_TOKEN_GRACE_MS = 2 * 60 * 60 * 1000

/** A slice whose JSON is at most this many bytes rides the event; bigger ones go by reference. */
export const CAPTURE_EVENT_INLINE_MAX_BYTES = 180_000

export type CapturePhase = 'compaction.requested' | 'nightly'

export interface QueueCaptureArgs {
  userId: string
  workspaceId: string
  conversationId: string | null
  sessionId: string
  operationId: string
  phase: CapturePhase
  /** The turn sequence the capture reached (eve's), when known. */
  sequence: number | null
  /** The newest message the slice holds (the catch-up's), else now. */
  capturedThroughAt?: string | null
  slice: SliceMessage[]
}

/** The Inngest event's data: ids, and the slice inline or by reference. */
export interface MemoryCaptureEventData {
  operationId: string
  sessionId: string
  userId: string
  workspaceId: string
  conversationId: string | null
  /** Absent when the slice went by reference: read it off the chat_memory_op row. */
  slice?: SliceMessage[]
}

export type QueueCaptureOutcome =
  | { ok: true; queued: boolean; replayed: boolean }
  | { ok: false; status: 403 | 409; error: string }

export type SendCaptureEvent = (event: { id: string; name: typeof MEMORY_CAPTURE_EVENT; data: MemoryCaptureEventData }) => Promise<unknown>

/** The event id: Inngest dedupes a second send of the same operation. */
export function captureEventId(operationId: string): string {
  return `memory-capture-${createHash('sha256').update(operationId).digest('hex').slice(0, 40)}`
}

interface EpochRow {
  session_id: string
  user_id: string
  workspace_id: string
}

export async function queueProfileCapture(supabase: SupabaseClient, args: QueueCaptureArgs, send: SendCaptureEvent): Promise<QueueCaptureOutcome> {
  const [memoRead, epochRead] = await Promise.all([
    supabase.from('chat_memory_op').select('session_id, user_id, op').eq('operation_id', args.operationId).maybeSingle<{ session_id: string; user_id: string; op: string }>(),
    supabase.from('chat_memory_epoch').select('session_id, user_id, workspace_id').eq('session_id', args.sessionId).maybeSingle<EpochRow>(),
  ])
  if (memoRead.error) throw new Error(`memo read: ${memoRead.error.message}`)
  if (epochRead.error) throw new Error(`epoch read: ${epochRead.error.message}`)
  const memo = memoRead.data
  if (memo) {
    if (memo.session_id !== args.sessionId || memo.user_id !== args.userId || memo.op !== 'capture') {
      return { ok: false, status: 409, error: 'operationId belongs to another session or operation' }
    }
    return { ok: true, queued: false, replayed: true }
  }
  const epoch = epochRead.data
  if (epoch && (epoch.user_id !== args.userId || epoch.workspace_id !== args.workspaceId)) {
    return { ok: false, status: 403, error: 'this session belongs to another person or workspace' }
  }

  const hasText = sliceHasPersonText(args.slice)
  const { data: claimed, error: claimError } = await supabase
    .from('chat_memory_op')
    .upsert(
      {
        operation_id: args.operationId,
        session_id: args.sessionId,
        user_id: args.userId,
        op: 'capture',
        phase: args.phase,
        result: hasText
          ? { status: 'queued', workspaceId: args.workspaceId, conversationId: args.conversationId, slice: args.slice }
          : { status: 'empty' },
      },
      { onConflict: 'operation_id', ignoreDuplicates: true },
    )
    .select('operation_id')
  if (claimError) throw new Error(`memo write: ${claimError.message}`)
  if (!claimed || claimed.length === 0) return { ok: true, queued: false, replayed: true }

  if (hasText) {
    const inline = Buffer.byteLength(JSON.stringify(args.slice), 'utf8') <= CAPTURE_EVENT_INLINE_MAX_BYTES
    try {
      await send({
        id: captureEventId(args.operationId),
        name: MEMORY_CAPTURE_EVENT,
        data: {
          operationId: args.operationId,
          sessionId: args.sessionId,
          userId: args.userId,
          workspaceId: args.workspaceId,
          conversationId: args.conversationId,
          ...(inline ? { slice: args.slice } : {}),
        },
      })
    } catch (err) {
      // Not queued: free the operation so a retry (or the nightly catch-up) can queue it.
      await supabase.from('chat_memory_op').delete().eq('operation_id', args.operationId).eq('op', 'capture')
      throw err
    }
  }

  await recordCaptured(supabase, args, !!epoch)
  return { ok: true, queued: hasText, replayed: false }
}

/** The session's capture bookkeeping; a session with no epoch yet gets one (as its first recall would). */
async function recordCaptured(supabase: SupabaseClient, args: QueueCaptureArgs, hasEpoch: boolean): Promise<void> {
  const now = new Date().toISOString()
  const through = args.capturedThroughAt && Number.isFinite(Date.parse(args.capturedThroughAt)) ? new Date(args.capturedThroughAt).toISOString() : now
  const bookkeeping = {
    ...(args.sequence !== null ? { captured_through_seq: args.sequence } : {}),
    captured_through_at: through,
    last_capture_at: now,
    updated_at: now,
  }
  if (!hasEpoch) {
    const snapshot = await loadProfileFacts(supabase, args.userId)
    const { error } = await supabase.from('chat_memory_epoch').upsert(
      {
        session_id: args.sessionId,
        user_id: args.userId,
        workspace_id: args.workspaceId,
        conversation_id: args.conversationId,
        snapshot,
        snapshot_hash: snapshotHash(snapshot),
        epoch_at: now,
        ...bookkeeping,
      },
      { onConflict: 'session_id', ignoreDuplicates: true },
    )
    if (error) throw new Error(`epoch write: ${error.message}`)
  }
  const { error } = await supabase.from('chat_memory_epoch').update(bookkeeping).eq('session_id', args.sessionId).eq('user_id', args.userId)
  if (error) throw new Error(`epoch write: ${error.message}`)
}
