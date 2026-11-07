/**
 * The bridge between a call's GPT-Live session and Dial8 (the spike;
 * docs/plans/text-and-calling.md Phase 4). Once the webhook route accepts a
 * call, this attaches to the session's sideband WebSocket for the length of
 * the call:
 *
 *   - `session.input_transcript.delta` / `session.output_transcript.delta`:
 *     the live transcript (./transcript.ts), fragments with no turn ends;
 *   - `session.delegation.created`: GPT-Live hands a request to us. It carries
 *     no task text, so the request is what the caller said before its
 *     `offset_ms` that no earlier hand-off took. One at a time, in order: each
 *     is a call turn in the person's home thread (./call-turn-server.ts), and
 *     its answer goes back as `session.commentary.append` (GPT-Live says it,
 *     in its own words). A notice goes the same way; a hand-off with nothing
 *     to say gets a silent `session.thinking.append` (which also cancels the
 *     waiting filler);
 *   - `session.closed` (or the socket closing): the call is over.
 *
 * Nothing cancels a hand-off: "interrupting the spoken conversation leaves
 * backend work running", so a turn always runs to its end. A slow one is
 * told to the caller and finished in the background, and the bridge waits
 * for that (and for the turn still running when the call ended, whose answer
 * is dropped) up to INFLIGHT_GRACE_MS, so the thread gets its reply and the
 * lease is let go. A call is closed after CALL_MAX_MS, and a call the bridge
 * loses (cap, dropped socket) is hung up, so GPT-Live never talks on with
 * nobody behind it. One `[live-call]` line per call: counts and outcomes,
 * never a word.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { hangUpLiveCall, liveAttachUrl } from './live-api'
import { CallTranscript } from './transcript'
import { runCallTurn, type CallTurnResult } from './call-turn-server'
import type { CallCaller } from './caller'

/**
 * The longest call the spike keeps open (a cost cap): then it closes the
 * session. With INFLIGHT_GRACE_MS it stays under the webhook route's
 * maxDuration (800 s), which the bridge runs inside.
 */
export const CALL_MAX_MS = 10 * 60_000

/**
 * How a hand-off waits for the caller's last words before it reads them: at
 * least HANDOFF_SETTLE_MS, then until no fragment of theirs has arrived for
 * HANDOFF_QUIET_MS, and never past HANDOFF_SETTLE_MAX_MS.
 */
export const HANDOFF_SETTLE_MS = 500
export const HANDOFF_QUIET_MS = 300
export const HANDOFF_SETTLE_MAX_MS = 1_500

/**
 * How far past a hand-off's `offset_ms` the caller's words still belong to it.
 * GPT-Live can hand off before they finish ("what's on my calendar for…" then
 * "tomorrow"); the next request starts only after it has answered, well
 * later than this.
 */
export const HANDOFF_WORD_GRACE_MS = 1_500

/** The most one commentary append carries (GPT-Live's cap is 500 tokens). */
export const COMMENTARY_MAX_CHARS = 1_200

/** The sideband socket, as the bridge uses it (a seam for the tests). */
export interface LiveSocket {
  send(data: string): void
  close(): void
  onMessage(fn: (text: string) => void): void
  onClose(fn: () => void): void
}

/** Attach to a call's sideband WebSocket. Rejects when the attach fails. */
export function openLiveSocket(url: string, apiKey: string): Promise<LiveSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10_000 })
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`attach refused (${res.statusCode ?? 0})`))
      ws.terminate()
    })
    ws.once('error', (err) => reject(err))
    ws.once('open', () => {
      // After the open, an error is followed by close: the bridge ends the call there.
      ws.on('error', () => {})
      resolve({
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data)
        },
        close: () => ws.close(),
        onMessage: (fn) => ws.on('message', (data, isBinary) => {
          if (!isBinary) fn(data.toString())
        }),
        onClose: (fn) => ws.on('close', () => fn()),
      })
    })
  })
}

/**
 * The reply as words to say: no markdown emphasis, headings, bullets, code
 * marks or URLs (a link's own words stay). Plain text passes through.
 */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The answer in appends of at most `max` characters, split at sentence ends where it can be. */
export function commentaryChunks(text: string, max = COMMENTARY_MAX_CHARS): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [text]
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const sentence of sentences) {
    let rest = sentence
    // A single sentence past the cap is cut at the cap.
    while (rest.length > max) {
      flush()
      chunks.push(rest.slice(0, max).trim())
      rest = rest.slice(max)
    }
    if (current.length + rest.length > max) flush()
    current += rest
  }
  flush()
  return chunks.filter(Boolean)
}

/** How a call went, for the log line. */
export interface LiveCallSummary {
  handoffs: number
  replies: number
  notices: number
  quiet: number
  empty: number
  errors: number
  closed: string
  ms: number
  callerChars: number
  agentChars: number
  /** Every event type the sideband sent, with its count (names only): what GPT-Live actually emits. */
  types: Record<string, number>
}

/** Seams for the tests. */
export interface LiveCallDeps {
  supabase: SupabaseClient
  connect?: (url: string, apiKey: string) => Promise<LiveSocket>
  runTurn?: (args: { caller: CallCaller; sessionId: string; delegationId: string; words: string }, background: (work: Promise<void>) => void) => Promise<CallTurnResult>
  hangUp?: (sessionId: string) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  maxMs?: number
  settleMs?: number
  settleMaxMs?: number
  inflightGraceMs?: number
}

/** How long a call that ended waits for turns still running (they finish writing the thread and let the lease go). */
export const INFLIGHT_GRACE_MS = 150_000

/** The silent note for a hand-off Dial8 has nothing to say to (it also cancels the waiting filler). */
export const NOTHING_TO_ADD = 'Dial8 has nothing to add to this. Carry on with the caller.'
/** The silent note for a hand-off that reached Dial8 with no new words from the caller. */
export const NO_NEW_WORDS = "Dial8 didn't receive what the caller just asked. Ask them to say it again."

/**
 * Bridge one accepted call to Dial8 until it ends. Resolves with the call's
 * summary (and logs it); never rejects once attached. Rejects when the
 * attach itself fails.
 */
export async function runLiveCall(
  args: { sessionId: string; caller: CallCaller; apiKey: string; /** What GPT-Live says first, sent once attached. */ greeting?: string },
  deps: LiveCallDeps,
): Promise<LiveCallSummary> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const runTurn = deps.runTurn ?? ((a, background) => runCallTurn(deps.supabase, a, { background }))
  const hangUp = deps.hangUp ?? ((sessionId: string) => hangUpLiveCall(sessionId, { apiKey: args.apiKey }))
  const startedAt = now()
  const socket = await (deps.connect ?? openLiveSocket)(liveAttachUrl(args.sessionId), args.apiKey)

  const transcript = new CallTranscript()
  const summary: LiveCallSummary = { handoffs: 0, replies: 0, notices: 0, quiet: 0, empty: 0, errors: 0, closed: 'unknown', ms: 0, callerChars: 0, agentChars: 0, types: {} }
  const queue: Array<{ id: string; offsetMs: number | null }> = []
  let lastCallerFragmentAt = 0
  let pumping: Promise<void> | null = null
  const background = new Set<Promise<void>>()
  const keep = (work: Promise<void>) => {
    const tracked = work.catch(() => {}).finally(() => background.delete(tracked))
    background.add(tracked)
  }
  let closed = false
  let sent = 0
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => (resolveDone = resolve))

  const send = (event: Record<string, unknown>) => {
    if (closed) return
    socket.send(JSON.stringify({ ...event, event_id: `dial8_${++sent}` }))
  }
  const end = (reason: string) => {
    if (closed) return
    closed = true
    summary.closed = reason
    resolveDone()
  }

  const handOff = async (delegationId: string, offsetMs: number | null) => {
    summary.handoffs++
    const settleStart = now()
    await sleep(deps.settleMs ?? HANDOFF_SETTLE_MS)
    // Then until they've stopped (no fragment for a moment), within a cap.
    while (!closed && now() - lastCallerFragmentAt < HANDOFF_QUIET_MS && now() - settleStart < (deps.settleMaxMs ?? HANDOFF_SETTLE_MAX_MS)) await sleep(50)
    // What they said before this hand-off, and words begun just after it (it
    // can come before they finish: "…for" then "tomorrow"). But when GPT-Live
    // made another hand-off within that grace, the words after this offset
    // were that one's own request ("…Tokyo?" then "And London?"): stop at the
    // offset. With nothing before it and no hand-off behind it, whatever is
    // untaken (in case the offset is off).
    const next = queue[0]?.offsetMs
    const graceEnd = offsetMs != null ? offsetMs + HANDOFF_WORD_GRACE_MS : null
    const cut =
      offsetMs != null && graceEnd != null && (transcript.hasCallerWordsBefore(offsetMs) || queue.length > 0)
        ? next != null && next > offsetMs && next <= graceEnd
          ? offsetMs
          : graceEnd
        : null
    const words = transcript.takeCallerWords(cut)
    if (!words) {
      summary.empty++
      send({ type: 'session.thinking.append', delegation_id: delegationId, content: NO_NEW_WORDS })
      return
    }
    const logged = (result: CallTurnResult) => {
      // One line per hand-off: what the turn came to (codes only, never a word).
      console.info(`[live-call] session=${args.sessionId} handoff=${summary.handoffs} result=${result.kind} outcome=${result.outcome}${result.rowId ? ` row=${result.rowId}` : ''}`)
      return result
    }
    const turn = runTurn({ caller: args.caller, sessionId: args.sessionId, delegationId, words }, keep).then(logged)
    // Nothing cancels a hand-off: one the caller hung up on still runs (its
    // words and answer land in the thread); there is just nobody to say it to.
    if (closed) {
      keep(turn.then(() => {}))
      return
    }
    const result = await turn
    if (closed) return
    if (result.kind === 'quiet') {
      summary.quiet++
      send({ type: 'session.thinking.append', delegation_id: delegationId, content: NOTHING_TO_ADD })
      return
    }
    const text = result.kind === 'reply' ? speakable(result.text) : result.text
    if (!text) {
      // A reply that was only a link (or markup) has nothing to say aloud.
      summary.quiet++
      send({ type: 'session.thinking.append', delegation_id: delegationId, content: NOTHING_TO_ADD })
      return
    }
    if (result.kind === 'reply') summary.replies++
    else summary.notices++
    for (const chunk of commentaryChunks(text)) send({ type: 'session.commentary.append', delegation_id: delegationId, content: chunk })
  }

  const pump = () => {
    if (pumping) return
    pumping = (async () => {
      // Drained even once the call ended: a hand-off it got still runs (handOff speaks only while it's up).
      while (queue.length > 0) {
        const next = queue.shift()!
        try {
          await handOff(next.id, next.offsetMs)
        } catch {
          summary.errors++
        }
      }
    })().finally(() => {
      pumping = null
    })
  }

  socket.onMessage((text) => {
    let event: { type?: unknown; [key: string]: unknown }
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    const type = typeof event.type === 'string' ? event.type.slice(0, 80) : 'unknown'
    summary.types[type] = (summary.types[type] ?? 0) + 1
    switch (event.type) {
      case 'session.input_transcript.delta':
        transcript.addInput(event.delta, event.start_ms, event.end_ms)
        lastCallerFragmentAt = now()
        break
      case 'session.output_transcript.delta':
        transcript.addOutput(event.delta, event.start_ms, event.end_ms)
        break
      case 'session.delegation.created': {
        const id = (event.delegation as { id?: unknown } | undefined)?.id
        if (typeof id === 'string' && id) {
          queue.push({ id, offsetMs: typeof event.offset_ms === 'number' && Number.isFinite(event.offset_ms) ? event.offset_ms : null })
          pump()
        }
        break
      }
      case 'session.closed':
        end(typeof event.reason === 'string' ? event.reason : 'closed')
        break
      case 'error': {
        summary.errors++
        const code = (event.error as { code?: unknown } | undefined)?.code
        console.warn(`[live-call] session=${args.sessionId} error=${typeof code === 'string' ? code : 'unknown'}`)
        break
      }
    }
  })
  socket.onClose(() => end('connection_lost'))

  // GPT-Live waits for the caller unless it is given words to open with.
  if (args.greeting) send({ type: 'session.commentary.append', delegation_id: null, content: args.greeting })

  const cap = setTimeout(() => {
    send({ type: 'session.close' })
    end('max_duration')
  }, deps.maxMs ?? CALL_MAX_MS)
  cap.unref?.()

  await done
  clearTimeout(cap)
  socket.close()
  // The bridge lost the call (capped, or the socket dropped): hang up, or GPT-Live talks on alone.
  if (summary.closed === 'max_duration' || summary.closed === 'connection_lost') await hangUp(args.sessionId).catch(() => {})
  // Turns still running finish writing the thread and let the lease go; their answers are dropped.
  // Waited for until none is left (a hand-off still in its first read may hand a finish on after this starts), or the grace runs out.
  let graceOver = false
  const grace = sleep(deps.inflightGraceMs ?? INFLIGHT_GRACE_MS).then(() => {
    graceOver = true
  })
  while (!graceOver && (pumping || background.size > 0)) {
    await Promise.race([Promise.all([...(pumping ? [pumping] : []), ...background]), grace])
  }
  const counts = transcript.counts()
  summary.ms = now() - startedAt
  summary.callerChars = counts.callerChars
  summary.agentChars = counts.agentChars
  console.info(liveCallLogLine(args.sessionId, args.caller, summary))
  return summary
}

/** The one log line per call. Counts and ids only (never a number or a word said). */
export function liveCallLogLine(sessionId: string, caller: Pick<CallCaller, 'via'>, s: LiveCallSummary): string {
  return (
    `[live-call] session=${sessionId} via=${caller.via} handoffs=${s.handoffs} replies=${s.replies} notices=${s.notices} quiet=${s.quiet} ` +
    `empty=${s.empty} errors=${s.errors} closed=${s.closed} ms=${s.ms} caller_chars=${s.callerChars} agent_chars=${s.agentChars} ` +
    `types=${Object.entries(s.types)
      .map(([type, n]) => `${type}:${n}`)
      .join(',')}`
  )
}
