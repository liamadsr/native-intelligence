/**
 * The live agent on a call's capture, run by the server as the words arrive
 * (one recorder per call, phase 2; migration 655). A person's own capture
 * gets its live notes from their app, which sends the live agent its recent
 * transcript every so often. A call's capture is filled by the call recorder
 * on the server, and nobody's device records it, so nothing ran the agent
 * during the call. Now the capture feed's hook (src/lib/capture-feed/
 * hooks.ts) offers a turn after each batch of words the capture takes, and
 * the turn runs on Inngest, as the capture's owner, through the live agent's
 * own route (POST /api/ai/live-agent): the same prompt, tools, model, usage
 * row and auto-apply gate as the owner's own app gets. Whoever is in the
 * call, the owner included, nothing depends on them being there.
 *
 * Settings (an empty value counts as unset):
 *   TEAM_CALL_LIVE_AGENT=on  turns run during calls (and the in-call notes
 *                            show). Needs the call recorder on
 *                            (TEAM_CALL_RECORDER, ./recorder.ts). Off unless
 *                            set.
 *
 * The cadence, matched to the owner's own app (src/lib/live-agent/
 * transcript-gate.ts: a window of about 1,200 characters, or 60 s at most,
 * one turn at a time), a little quicker so the notes keep up with the call:
 * a turn starts when at least READY_CHARS new characters arrived, or at least
 * MIN_CHARS and QUIET_SECONDS since the last turn; never within
 * MIN_INTERVAL_SECONDS of the last one's start; one at a time per capture
 * across every app process (655, held in the database). A turn has two
 * stages: queued (the claim hands it to Inngest; nothing more is offered for
 * the capture while it waits, and nothing is counted) and running (its run
 * started: only now does it hold the lease, count toward the bound, and
 * start the throttle's clock). Inngest runs a handful at once across the
 * server, so with more calls than that the queue backs up: a turn that
 * waited past QUEUE_SECONDS is stale when it starts, skipped, never a
 * failure, never a turn, and the next claim queues the same words again. The
 * notes get slower under load; they never stop for it. A turn reads
 * everything said since the last turn that went through (at most
 * MAX_WINDOW_CHARS, oldest first), so a slow or failed turn is caught up by
 * the next one, never skipped. After a turn, one more look QUIET_SECONDS
 * later sends what was said at its end even when nobody speaks again.
 *
 * The bound: at most MAX_TURNS turns per call capture (about one every 36 s
 * over the 3 hours a call's notes may run), each with the live tick's own
 * budget (src/lib/live-agent/turn-budget.ts: 8 steps, 8,000 output tokens,
 * 120 s). MAX_FAILURES_IN_ROW failed turns in a row stop the agent for the
 * call, as does the owner's usage running out. The end-of-meeting pass
 * still runs on the whole call when it ends, as before.
 *
 * Whose turn it is: the capture's owner's (the meeting's host, else the
 * call's starter: 588's owner rule), on their plan and credits; one usage row
 * per turn, as their own app's turns have. No device drives turns on a
 * call's capture: the live agent's route takes a live turn on one only with
 * the capture's call-turn key, which only the server makes
 * (src/lib/live-agent/call-turn-key.ts), so nothing is charged twice and no
 * second agent writes it. An owner who may no longer read the conversation,
 * or who left the workspace, stops the agent (655).
 *
 * What the turn is: the paired note-taker's turn (`live_role: 'notes'`), the
 * existing switch for a turn that writes the record and never talks (no
 * say_to_user, ask_user, call playbooks or relay, no talk riders), on a call's
 * capture also fenced to what writing the shared notes needs
 * (src/lib/live-agent/call-capture-fence.ts): what anyone says in the call
 * cannot make it read the owner's own mail, calendar, documents or earlier
 * meetings into notes the whole conversation reads, nor act.
 *
 * Privacy: logs carry ids, counts and outcomes, never words or names.
 */
import 'server-only'
import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { appUrl } from '@/lib/app-url'
import { withOwnerRunToken } from '@/lib/captures/owner-run-token'
import type { FeedAppendHook } from '@/lib/capture-feed/hooks'
import { inngest } from '@/lib/inngest/client'
import { callTurnKey } from '@/lib/live-agent/call-turn-key'
import { teamCallRecorderOn } from './recorder'

/** Turns run during calls: TEAM_CALL_LIVE_AGENT=on, with the call recorder on. */
export function teamCallLiveAgentOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEAM_CALL_LIVE_AGENT?.trim().toLowerCase() === 'on' && teamCallRecorderOn(env)
}

export const LIVE_TURN_MIN_INTERVAL_SECONDS = 20
export const LIVE_TURN_MIN_CHARS = 60
export const LIVE_TURN_READY_CHARS = 600
export const LIVE_TURN_QUIET_SECONDS = 30
export const LIVE_TURN_MAX_TURNS = 300
/**
 * How long a queued turn may wait for its run to start before it is stale
 * (skipped, never counted; the next claim queues the same words again). Long
 * on purpose: a queue that backs up makes the notes slower, never stops them.
 */
export const LIVE_TURN_QUEUE_SECONDS = 600
/**
 * How long a queued turn holds off a fresh claim. A mark older than this may
 * be an event Inngest will never run (lost, or a function not yet registered
 * after a deploy): the next claim queues a fresh one, the old one staying
 * valid beside it (655), so a lost event costs this long, while a slow queue
 * is never starved (its event still begins the turn when it runs).
 */
export const LIVE_TURN_SUPERSEDE_SECONDS = 120
/** A running turn's lease: past its own wall clock (the tick's 120 s, a retry, the route's start, this wait). */
export const LIVE_TURN_LEASE_SECONDS = 300
export const LIVE_TURN_MAX_WINDOW_CHARS = 16_000
/** The lines before the window, as the owner's app sends its two earlier windows. */
export const LIVE_TURN_CONTEXT_CHARS = 2_400
export const LIVE_TURN_MAX_FAILURES_IN_ROW = 3
/** How long the turn's request is waited on (under the lease, and the step's own 300 s). */
export const LIVE_TURN_WAIT_MS = 200_000

export const CALL_LIVE_TURN_EVENT = 'team-calls/live-turn' as const

export type LiveTurnClaimOutcome = 'queued' | 'busy' | 'too_soon' | 'too_few_words' | 'waiting' | 'notes_off' | 'stopped' | 'not_a_call'

export interface LiveTurnClaim {
  outcome: LiveTurnClaimOutcome
  /** The queued turn's mark (its lease once it runs), when queued. */
  lease: string | null
  /** Turns that ran so far. */
  turn: number
}

/** May a turn be queued now (655's team_call_live_turn_claim)? Throws on a failed read. */
export async function claimLiveTurn(svc: SupabaseClient, captureId: string): Promise<LiveTurnClaim> {
  const { data, error } = await svc.rpc('team_call_live_turn_claim', {
    target_capture: captureId,
    min_interval_seconds: LIVE_TURN_MIN_INTERVAL_SECONDS,
    min_chars: LIVE_TURN_MIN_CHARS,
    ready_chars: LIVE_TURN_READY_CHARS,
    quiet_seconds: LIVE_TURN_QUIET_SECONDS,
    max_turns: LIVE_TURN_MAX_TURNS,
    queue_seconds: LIVE_TURN_QUEUE_SECONDS,
    supersede_seconds: LIVE_TURN_SUPERSEDE_SECONDS,
  })
  if (error) throw new Error(`live turns: claim failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; lease?: string | null; turn_no?: number } | undefined
  return { outcome: (row?.outcome as LiveTurnClaimOutcome) ?? 'not_a_call', lease: row?.lease ?? null, turn: row?.turn_no ?? 0 }
}

export type LiveTurnBegin = 'running' | 'stale' | 'stopped'

/** The queued turn's run starts (655's team_call_live_turn_begin): it runs and counts once, or it is stale. */
export async function beginLiveTurn(svc: SupabaseClient, captureId: string, lease: string): Promise<{ outcome: LiveTurnBegin; turn: number }> {
  const { data, error } = await svc.rpc('team_call_live_turn_begin', {
    target_capture: captureId,
    queued: lease,
    lease_seconds: LIVE_TURN_LEASE_SECONDS,
    max_turns: LIVE_TURN_MAX_TURNS,
  })
  if (error) throw new Error(`live turns: begin failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; turn_no?: number } | undefined
  const outcome: LiveTurnBegin = row?.outcome === 'running' || row?.outcome === 'stopped' ? row.outcome : 'stale'
  return { outcome, turn: row?.turn_no ?? 0 }
}

/** A queued turn that was never handed over: its mark taken back, nothing counted (655's team_call_live_turn_unqueue). */
export async function unqueueLiveTurn(svc: SupabaseClient, captureId: string, lease: string): Promise<boolean> {
  const { data, error } = await svc.rpc('team_call_live_turn_unqueue', { target_capture: captureId, queued: lease })
  if (error) throw new Error(`live turns: unqueue failed: ${error.message}`)
  return data === true
}

export interface LiveTurnWindow {
  fromOffset: number
  toOffset: number
  context: string
  words: string
}

/** The words the running turn holding `lease` sends (655's team_call_live_turn_window); null when it may send none. */
export async function liveTurnWindow(svc: SupabaseClient, captureId: string, lease: string): Promise<LiveTurnWindow | null> {
  const { data, error } = await svc.rpc('team_call_live_turn_window', {
    target_capture: captureId,
    turn_lease: lease,
    max_chars: LIVE_TURN_MAX_WINDOW_CHARS,
    context_chars: LIVE_TURN_CONTEXT_CHARS,
  })
  if (error) throw new Error(`live turns: window read failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { from_offset?: number; to_offset?: number; context?: string | null; words?: string | null } | undefined
  if (!row || typeof row.to_offset !== 'number') return null
  return { fromOffset: row.from_offset ?? 0, toOffset: row.to_offset, context: row.context ?? '', words: row.words ?? '' }
}

/** 'unknown': the turn's answer never came back (the route may still be writing). */
export type LiveTurnRelease = 'ok' | 'unknown' | 'failed' | 'stopped'

/** The running turn is over (655's team_call_live_turn_release): the agent's state after it, or 'stale'. */
export async function releaseLiveTurn(
  svc: SupabaseClient,
  captureId: string,
  lease: string,
  outcome: LiveTurnRelease,
  opts: { sentTo?: number; reason?: string } = {},
): Promise<string> {
  const { data, error } = await svc.rpc('team_call_live_turn_release', {
    target_capture: captureId,
    turn_lease: lease,
    turn_outcome: outcome,
    sent_to: opts.sentTo ?? null,
    reason: opts.reason ?? null,
    max_failures_in_row: LIVE_TURN_MAX_FAILURES_IN_ROW,
  })
  if (error) throw new Error(`live turns: release failed: ${error.message}`)
  return typeof data === 'string' ? data : 'unknown'
}

/** Is a turn RUNNING on this capture now (655's team_call_live_turn_busy)? A queued one is not. */
export async function liveTurnBusy(svc: SupabaseClient, captureId: string): Promise<boolean> {
  const { data, error } = await svc.rpc('team_call_live_turn_busy', { target_capture: captureId })
  if (error) throw new Error(`live turns: busy read failed: ${error.message}`)
  return data === true
}

export interface LiveTurnDeps {
  send?: (event: { name: typeof CALL_LIVE_TURN_EVENT; id: string; data: { captureId: string; lease: string } }) => Promise<unknown>
}

/**
 * Queue a turn if one may be queued now: the claim, then the turn handed to
 * Inngest. A send that fails takes the mark back (no failure, nothing
 * counted: its words wait for the next). Never throws. Returns the claim's
 * outcome.
 */
export async function offerLiveTurn(svc: SupabaseClient, captureId: string, deps: LiveTurnDeps = {}): Promise<LiveTurnClaimOutcome | 'error'> {
  let claim: LiveTurnClaim
  try {
    claim = await claimLiveTurn(svc, captureId)
  } catch (err) {
    console.warn(`[call-live-turns] capture=${captureId} not offered:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return 'error'
  }
  if (claim.outcome !== 'queued' || !claim.lease) return claim.outcome
  const lease = claim.lease
  try {
    const send = deps.send ?? ((event) => inngest.send(event))
    await send({ name: CALL_LIVE_TURN_EVENT, id: `call-live-turn-${captureId}-${lease}`, data: { captureId, lease } })
    console.info(`[call-live-turns] capture=${captureId} turns=${claim.turn} outcome=queued`)
  } catch (err) {
    console.warn(`[call-live-turns] capture=${captureId} not sent:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    await unqueueLiveTurn(svc, captureId, lease).catch(() => undefined)
  }
  return claim.outcome
}

/**
 * Work after the response, where the request has one (the feed's segments
 * route must answer the recorder at once: its next batch waits on it);
 * outside a request scope (a test, a script) it simply runs on.
 */
function deferred(work: () => Promise<unknown>): void {
  try {
    after(work)
  } catch {
    void work()
  }
}

/**
 * The capture feed's hook (src/lib/capture-feed/hooks.ts): after a batch of
 * words, offer a turn. Returns at once: the claim and the hand-off run after
 * the segments route has answered.
 */
export const callLiveTurnsHook: FeedAppendHook = async (svc, appended) => {
  if (!teamCallLiveAgentOn()) return
  deferred(() => offerLiveTurn(svc, appended.captureId))
}

export type LiveTurnResult = 'ok' | 'unknown' | 'failed' | 'stopped' | 'stale' | 'empty'

/** What the live agent's route answered: its status, or that no answer came back in time. */
export type LiveTurnPost = number | 'timeout'

export interface RunLiveTurnDeps {
  /** POST the live agent's route as the owner. */
  postTurn?: (args: { captureId: string; lease: string; ownerId: string; workspaceId: string; recentChunks: string[] }) => Promise<LiveTurnPost>
}

/**
 * One queued turn's run (the Inngest function's work): it begins (once: a
 * mark that waited too long, or a run started twice, is stale and skipped,
 * never counted, never a failure), reads its words, runs the live agent's
 * route as the capture's owner, and gives the lease back with what became of
 * it. A turn that fails is logged and skipped (its words stay unread, so the
 * next turn sends them). One whose answer never came back counts its words
 * as sent (never twice) and keeps its lease to its end, as the route may
 * still be writing. A usage wall or a refusal stops the agent for the call.
 * Never throws.
 */
export async function runLiveTurn(svc: SupabaseClient, input: { captureId: string; lease: string }, deps: RunLiveTurnDeps = {}): Promise<LiveTurnResult> {
  const { captureId, lease } = input
  const release = async (outcome: LiveTurnRelease, opts: { sentTo?: number; reason?: string } = {}): Promise<LiveTurnResult> => {
    try {
      const state = await releaseLiveTurn(svc, captureId, lease, outcome, opts)
      return state === 'stale' ? 'stale' : outcome
    } catch (err) {
      // The lease runs out by itself (655): the next turn starts from the same words.
      console.warn(`[call-live-turns] capture=${captureId} release failed:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
      return 'failed'
    }
  }
  let began: { outcome: LiveTurnBegin; turn: number }
  try {
    began = await beginLiveTurn(svc, captureId, lease)
  } catch (err) {
    // Not begun: nothing counted, the mark runs out by itself.
    console.warn(`[call-live-turns] capture=${captureId} not begun:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return 'stale'
  }
  if (began.outcome !== 'running') {
    console.info(`[call-live-turns] capture=${captureId} outcome=${began.outcome} at=begin`)
    return began.outcome
  }
  try {
    const window = await liveTurnWindow(svc, captureId, lease)
    // No words: the call is over (655 stopped the agent, so the release is stale).
    if (!window) {
      const out = await release('failed', { reason: 'no_window' })
      console.info(`[call-live-turns] capture=${captureId} outcome=${out === 'stale' ? 'stopped' : out} reason=no_window`)
      return out === 'stale' ? 'stopped' : out
    }
    if (!window.words.trim()) {
      await release('ok', { sentTo: window.toOffset })
      return 'empty'
    }
    const { data: cap, error } = await svc.from('captures').select('user_id, workspace_id').eq('id', captureId).maybeSingle<{ user_id: string | null; workspace_id: string }>()
    if (error) throw new Error(error.message)
    if (!cap?.user_id) return await release('stopped', { reason: 'owner_out' })

    // As the owner's own app sends it: earlier lines first (already read), the new words last.
    const recentChunks = [window.context, window.words].filter((c) => c.trim().length > 0)
    const post = deps.postTurn ?? ((args: Parameters<typeof postTurnAsOwner>[1]) => postTurnAsOwner(svc, args))
    const status = await post({ captureId, lease, ownerId: cap.user_id, workspaceId: cap.workspace_id, recentChunks })
    if (status === 'timeout') {
      const out = await release('unknown', { sentTo: window.toOffset })
      console.warn(`[call-live-turns] capture=${captureId} turn=${began.turn} outcome=${out} reason=no_answer`)
      return out
    }
    if (status >= 200 && status < 300) {
      const out = await release('ok', { sentTo: window.toOffset })
      console.info(`[call-live-turns] capture=${captureId} turn=${began.turn} outcome=${out} chars=${window.toOffset - window.fromOffset}`)
      return out
    }
    // The owner's usage ran out (429/402), or the route refused them (no longer a member: 403).
    if (status === 402 || status === 429 || status === 403) {
      const out = await release('stopped', { reason: status === 403 ? 'refused' : 'usage' })
      console.warn(`[call-live-turns] capture=${captureId} outcome=${out} status=${status}`)
      return out
    }
    const out = await release('failed', { reason: `status_${status}` })
    console.warn(`[call-live-turns] capture=${captureId} outcome=${out} status=${status}`)
    return out
  } catch (err) {
    console.warn(`[call-live-turns] capture=${captureId} turn failed:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return release('failed', { reason: 'error' })
  }
}

/**
 * The live agent's route, as the owner, the paired note-taker's turn (it
 * writes the record, never talks), signed with the call-turn key of this
 * capture and this running turn's lease (the route takes no other live turn on
 * a call's capture, and none after the lease ends). 'timeout' when no
 * answer came back in LIVE_TURN_WAIT_MS.
 */
async function postTurnAsOwner(svc: SupabaseClient, args: { captureId: string; lease: string; ownerId: string; workspaceId: string; recentChunks: string[] }): Promise<LiveTurnPost> {
  const key = callTurnKey(args.captureId, args.lease)
  if (!key) throw new Error('live turns: no internal secret to sign the turn')
  return withOwnerRunToken(
    svc,
    { ownerId: args.ownerId, workspaceId: args.workspaceId, name: `Call notes ${args.captureId.slice(0, 8)}`, ttlMs: 10 * 60_000 },
    async (token): Promise<LiveTurnPost> => {
      try {
        const res = await fetch(`${appUrl()}/api/ai/live-agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            capture_id: args.captureId,
            recent_chunks: args.recentChunks,
            mode: 'live',
            live_role: 'notes',
            call_turn_lease: args.lease,
            call_turn_key: key,
          }),
          signal: AbortSignal.timeout(LIVE_TURN_WAIT_MS),
        })
        // Read to the end, so the route's finalize (usage, auto-apply) is not cut short by a closed socket.
        await res.text().catch(() => '')
        return res.status
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') return 'timeout'
        throw err
      }
    },
  )
}
