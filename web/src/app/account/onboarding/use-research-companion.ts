'use client'

/**
 * useResearchCompanion — the client half of the onboarding research companion
 * (Phase 1 of docs/plans/eve-migration-plan.md).
 *
 * WHAT IT DOES
 * ------------
 * 1. Kicks off the durable `onboarding-researcher` eve session exactly ONCE per
 *    wizard lifetime (fire-and-forget; POST is idempotent server-side, so a
 *    reload / re-mount returns the same sessionId). Failures are swallowed —
 *    onboarding must NEVER block or error because of research.
 * 2. Consumes the session's NDJSON lifecycle stream and projects it into a small
 *    set of friendly one-liner "activities" the wizard can render. Raw model
 *    text (message.appended/completed) is deliberately NOT surfaced mid-run —
 *    only tool-call labels and the terminal state.
 * 3. Reconciles the DURABLE result from GET /api/account/onboarding — which
 *    carries the warm first-person `brief`, final `status`, and `companyFound`
 *    — on every turn-boundary stream event (session.completed / session.failed
 *    / session.waiting / turn.completed), on stream close or error, AND on a
 *    light poll armed alongside the stream. The durable read is the source of
 *    truth; the stream is only an accelerant and is never trusted to close or
 *    to speak a particular event vocabulary (a conversation-parked run once
 *    held it open forever — the launch-eve "Wrapping up…" spinner bug).
 *
 * WHY A HAND-ROLLED NDJSON READER (not useEveAgent)
 * -------------------------------------------------
 * useEveAgent is built to OWN a session and SEND turns; the wizard is
 * consume-only (it never sends a follow-up). It also needs to attach to an
 * ALREADY-RUNNING durable session by id — a session the SERVER created and
 * registered, arriving asynchronously after the kickoff POST resolves — which
 * is not useEveAgent's happy path (its `agent`/`initialSession` config is read
 * once at store creation, forcing a key-remount once the id lands). A tiny
 * reader over the documented stream route, plus a durable-read reconcile, is
 * genuinely simpler here and gives us the exact "degrade to polling, never show
 * an error" resilience the experience calls for.
 *
 * STREAM ROUTE (same-origin, cookies auto-sent):
 *   GET /eve/onboarding-researcher/v1/session/<id>/stream?startIndex=<n>
 * Named agents mount at `/eve/<name>/v1/*` (eve 0.58+); see the kickoff route
 * header and next.config.mjs.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DOCUMENT_SCOPE_HEADERS } from './hard-navigate'
import {
  labelForToolCall,
  phaseForToolCall,
  companyNameFromToolCall,
  WORKING_PHASES,
  type WorkingPhaseIndex,
} from '@/lib/onboarding/research-activity-labels'

// Re-export the label/phase helpers from their canonical home so existing
// importers (and the companion's own tests) keep resolving them here. The pure
// logic now lives in src/lib/onboarding/research-activity-labels.ts, mirrored by
// the researcher agent tree so the SAME lines land in durable message history.
export {
  labelForToolCall,
  phaseForToolCall,
  companyNameFromToolCall,
  WORKING_PHASES,
  type WorkingPhaseIndex,
}

// ─── Public shape ────────────────────────────────────────────

export type ResearchStatus = 'idle' | 'running' | 'done' | 'skipped' | 'failed'

/** One friendly, render-ready line derived from a stream event. */
export interface ResearchActivity {
  /** Stable key for React lists (call id when available, else a counter). */
  id: string
  /** The tool that produced it (for icon/label choice), or a lifecycle marker. */
  kind: string
  /** The friendly one-liner to show. */
  label: string
}

/**
 * What the researcher seeded during onboarding (project + starter actions +
 * optional workspace rename), written to the durable state by finish_research.
 * Lets the wizard's ready step name what was set up instead of a generic line.
 */
export interface SeededSummary {
  projectName: string
  actionCount: number
  workspaceRenamed?: string
}

export interface ResearchCompanion {
  /** 'running' while the agent works; terminal once reconciled. 'idle' before kickoff resolves. */
  status: ResearchStatus
  /** Most recent friendly activity, or null. Drives the compact live strip. */
  latest: ResearchActivity | null
  /** All activities seen this session, oldest→newest (deduped by id). */
  activities: ResearchActivity[]
  /** The warm, first-person brief once research finished ('done'). */
  brief: string | null
  /** Whether company enrichment produced a profile. */
  companyFound: boolean
  /** What the researcher seeded (project + actions + optional rename), or null. */
  seededSummary: SeededSummary | null
  /** True from the moment kickoff is attempted until a terminal state. */
  active: boolean
  /**
   * The company name once a seeding tool-call revealed it (from
   * save_company_profile / save_starter_content), or null. Lets the working step
   * swap "Setting up your workspace" → "Setting up {Company}" before terminal.
   * Never guessed — null until a real name lands.
   */
  companyName: string | null
  /**
   * Highest plan phase (0-2) reached from the streamed tool-calls, monotonic, or
   * null before any phase-bearing tool fires. Drives the working step's ghost
   * plan: rows below it settle, the row at it is active, rows above stay ghosts.
   */
  activePhase: WorkingPhaseIndex | null
}

// ─── Constants ───────────────────────────────────────────────

const AGENT_MOUNT = '/eve/onboarding-researcher'
const KICKOFF_URL = '/api/account/onboarding/research'
const DURABLE_URL = '/api/account/onboarding'
/** Light poll cadence for the degraded (stream-failed) path. */
const POLL_INTERVAL_MS = 4000
/**
 * A durable 'starting' claim older than this will never advance on its own —
 * its kickoff died before persisting a sessionId, and the server only
 * re-claims it on a later kickoff POST (this hook never re-fires one). Matches
 * the kickoff route's STALE_STARTING_MS so client and server agree on when a
 * claim is dead. The same ceiling bounds a durable 'running' with no terminal:
 * a one-shot research run finishes within one server invocation, so past this age the
 * run died without writing its outcome.
 */
const STALE_STARTING_MS = 10 * 60 * 1000

// ─── Durable-read shape (mirrors research-progress.ts ResearchState) ──

interface DurableResearch {
  // 'starting' is a transient claim placeholder the kickoff route writes before
  // the eve session exists; 'error' is a terminal-but-re-claimable failed start.
  // Both are non-'done'/'skipped', so they never surface a brief.
  sessionId?: string
  status?: 'starting' | 'running' | 'done' | 'skipped' | 'error'
  startedAt?: string
  finishedAt?: string
  brief?: string
  companyFound?: boolean
  // Written by finish_research when it seeds starter content this run.
  seededSummary?: SeededSummary
}

// The tool-call → friendly-label mapping (labelForToolCall / phaseForToolCall /
// companyNameFromToolCall / WORKING_PHASES) now lives in the shared, pure module
// src/lib/onboarding/research-activity-labels.ts and is re-exported at the top of
// this file. The researcher's visible tool calls arrive here as
// `actions.requested` events, each action a `{ kind:'tool-call', toolName, input }`.

// ─── Minimal stream-event shapes we read (narrowed from eve's union) ──
//
// Kept local + loose on purpose: the reader must survive unknown event types
// from a preview SDK. We only *read* the handful of fields we map.

interface ToolCallAction {
  kind?: string
  toolName?: string
  callId?: string
  input?: unknown
}

interface StreamEvent {
  type?: string
  data?: {
    actions?: ToolCallAction[]
    [key: string]: unknown
  }
}

// ─── The hook ────────────────────────────────────────────────

export interface UseResearchCompanionOptions {
  /**
   * Pre-existing durable research state read on the server (from the wizard's
   * initial GET /api/account/onboarding). Lets the companion rehydrate a
   * mid-wizard reload without waiting for a round-trip: if research already
   * finished, we render the brief immediately and never open a stream.
   */
  initial?: DurableResearch | null
  /**
   * Set false to hold off kickoff (e.g. before the wizard's own data has
   * loaded). Kickoff fires as soon as this flips true, still only once.
   */
  enabled?: boolean
}

/**
 * All network calls go through the global `fetch`, resolved at call time, so a
 * test can stub `globalThis.fetch` and drive every path (kickoff, stream,
 * durable reconcile, poll) without mocking a module.
 */
export function useResearchCompanion(
  options: UseResearchCompanionOptions = {},
): ResearchCompanion {
  const { initial = null, enabled = true } = options

  // Seed terminal state straight from the durable read so a reload that lands
  // AFTER research finished shows the brief with zero flicker and no stream.
  const initialTerminal =
    initial?.status === 'done' || initial?.status === 'skipped'

  const [status, setStatus] = useState<ResearchStatus>(() => {
    if (initialTerminal) return initial!.status as ResearchStatus
    if (initial?.sessionId) return 'running'
    return 'idle'
  })
  const [activities, setActivities] = useState<ResearchActivity[]>([])
  const [brief, setBrief] = useState<string | null>(initial?.brief ?? null)
  const [companyFound, setCompanyFound] = useState<boolean>(
    initial?.companyFound ?? false,
  )
  const [seededSummary, setSeededSummary] = useState<SeededSummary | null>(
    initial?.seededSummary ?? null,
  )
  // Company name + plan phase are derived purely from the streamed tool-calls
  // (the durable read carries only companyFound, not a name), so they seed empty
  // and fill in as events arrive. A rehydrated finished run may never stream —
  // the working step falls back to its generic headline, which is correct.
  const [companyName, setCompanyName] = useState<string | null>(
    initial?.seededSummary?.workspaceRenamed ?? null,
  )
  const [activePhase, setActivePhase] = useState<WorkingPhaseIndex | null>(null)

  // Refs that must survive re-renders without re-triggering effects.
  const kickedOffRef = useRef(false)
  const sessionIdRef = useRef<string | null>(initial?.sessionId ?? null)
  const activityCounterRef = useRef(0)
  const seenActivityIdsRef = useRef<Set<string>>(new Set())
  const terminalRef = useRef(initialTerminal)
  const abortRef = useRef<AbortController | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // When we first observed a durable non-terminal ('starting'/'running') with
  // no usable startedAt — bounds total polling so a malformed or orphaned row
  // can't keep us waiting forever.
  const startingSeenAtRef = useRef<number | null>(null)
  // Latest status/session in refs so async callbacks read fresh values without
  // being re-created (which would restart the stream).
  const statusRef = useRef(status)
  statusRef.current = status

  const pushActivity = useCallback((kind: string, label: string, rawId?: string) => {
    // Stable dedup id: a tool call's callId is unique, so re-delivery on
    // reconnect (startIndex replays from 0) never double-inserts.
    const id = rawId ?? `local-${activityCounterRef.current++}`
    if (seenActivityIdsRef.current.has(id)) return
    seenActivityIdsRef.current.add(id)
    setActivities((prev) => [...prev, { id, kind, label }])
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  /**
   * Reconcile the DURABLE result. Called on any terminal stream event, on any
   * stream error (before falling back to polling), and on each poll tick. Reads
   * GET /api/account/onboarding and applies research.{status,brief,companyFound}.
   * Returns true once a terminal status was observed so callers can stop.
   */
  const reconcileDurable = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(DURABLE_URL, {
        cache: 'no-store',
        headers: DOCUMENT_SCOPE_HEADERS,
      })
      if (!res.ok) return false
      const data = (await res.json()) as {
        member?: { onboardingProgress?: { research?: DurableResearch } }
      }
      const research = data.member?.onboardingProgress?.research
      if (!research) return false

      if (research.brief) setBrief(research.brief)
      if (typeof research.companyFound === 'boolean') {
        setCompanyFound(research.companyFound)
      }
      if (research.seededSummary) setSeededSummary(research.seededSummary)
      if (research.status === 'done' || research.status === 'skipped') {
        terminalRef.current = true
        setStatus(research.status)
        // The durable truth is in; a still-open stream has nothing more to
        // offer and may never close on its own (a proxy can hold it silently,
        // and a conversation-parked run holds it by design) — drop it.
        abortRef.current?.abort()
        return true
      }
      // A failed start (eve session never began) is terminal for the UI: stop
      // the spinner and fall quiet. It's re-claimable server-side, but the
      // companion never blocks onboarding, so it surfaces as a quiet 'failed'.
      if (research.status === 'error') {
        terminalRef.current = true
        setStatus('failed')
        abortRef.current?.abort()
        return true
      }
      // 'starting' is the kickoff's pre-session claim placeholder — in-flight
      // like 'running' while fresh. But a claim whose kickoff died never
      // advances on its own (the server only re-claims it on a later kickoff
      // POST), so past the same staleness threshold the server uses we stop
      // waiting and fall to the same quiet 'failed' as `error` — never an
      // infinite request loop, never a blocked onboarding.
      //
      // 'running' gets the SAME ceiling: a one-shot run must finish within
      // one server invocation (minutes, not tens of minutes), so a 'running'
      // that old means the run died without writing a terminal (killed
      // instance, crash before finish_research's error path). Without this
      // bound that row would spin the wizard and poll for the whole page
      // lifetime. Age from the durable startedAt when parseable; otherwise
      // cap from when WE first observed the non-terminal state.
      if (research.status === 'starting' || research.status === 'running') {
        const parsed = research.startedAt ? Date.parse(research.startedAt) : NaN
        if (Number.isNaN(parsed) && startingSeenAtRef.current === null) {
          startingSeenAtRef.current = Date.now()
        }
        const since = Number.isNaN(parsed) ? startingSeenAtRef.current! : parsed
        if (Date.now() - since > STALE_STARTING_MS) {
          terminalRef.current = true
          setStatus('failed')
          abortRef.current?.abort()
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }, [])

  /** Poll the durable read until terminal, then clear. */
  const startPolling = useCallback(() => {
    if (pollRef.current || terminalRef.current) return
    pollRef.current = setInterval(async () => {
      // Terminal may have landed through another path (stream event, a local
      // 'failed' mark) since the last tick — stop without another fetch.
      if (terminalRef.current) {
        stopPolling()
        return
      }
      const done = await reconcileDurable()
      if (done) stopPolling()
    }, POLL_INTERVAL_MS)
  }, [reconcileDurable, stopPolling])

  // Event handler kept in a ref so `consumeStream` never lists it as a dep
  // (which would tear down and re-open the stream on every render). Reassigned
  // each render so it always closes over the latest setters/refs.
  const handleEventRef = useRef<(evt: StreamEvent) => void>(() => {})
  handleEventRef.current = (evt: StreamEvent) => {
    if (!evt || typeof evt.type !== 'string') return
    switch (evt.type) {
      case 'actions.requested': {
        const actions = evt.data?.actions
        if (!Array.isArray(actions)) return
        for (const action of actions) {
          if (action?.kind !== 'tool-call' || !action.toolName) continue
          const label = labelForToolCall(action.toolName, action.input)
          pushActivity(action.toolName, label, action.callId)
          // Advance the ghost-plan phase monotonically.
          const phase = phaseForToolCall(action.toolName)
          if (phase !== null) {
            setActivePhase((prev) => (prev === null || phase > prev ? phase : prev))
          }
          // Surface a real company name the moment a seeding call reveals one —
          // never guessed, first real value wins.
          const name = companyNameFromToolCall(action.toolName, action.input)
          if (name) setCompanyName((prev) => prev ?? name)
        }
        return
      }
      case 'turn.completed':
      case 'turn.failed':
      case 'session.waiting':
      case 'session.completed':
      case 'session.failed': {
        // Turn-boundary events. Since eve 0.67 removed run modes, a finished
        // run ends its turn (`turn.completed`, or `turn.failed` for a
        // recoverable failure) and parks at `session.waiting`, holding the
        // stream open; only a failure that ends the session still reports
        // `session.failed`. Every boundary means "the durable result may exist
        // now", so reconcile; if the durable write is still landing, poll
        // until it does (never trust the stream to say more).
        void reconcileDurable().then((done) => {
          if (done) {
            stopPolling()
            return
          }
          // No durable terminal yet. A hard session failure before
          // finish_research never produces one — mark failed locally so the
          // UI stops the spinner; brief stays null.
          if ((evt.type === 'session.failed' || evt.type === 'turn.failed') && !terminalRef.current) {
            terminalRef.current = true
            setStatus('failed')
            abortRef.current?.abort()
            stopPolling()
            return
          }
          startPolling()
        })
        return
      }
      default:
        // message.appended / message.completed / reasoning.* / step.* / turn.* —
        // deliberately ignored. We never render raw model narration mid-run.
        return
    }
  }

  /**
   * Open the NDJSON stream for a session and consume it. Any read failure or
   * non-ok response degrades to polling — never surfaces an error.
   */
  const consumeStream = useCallback(
    async (sessionId: string) => {
      const controller = new AbortController()
      abortRef.current = controller
      const url = `${AGENT_MOUNT}/v1/session/${encodeURIComponent(sessionId)}/stream`

      try {
        const res = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          // Session may not be streamable yet / ACL hiccup — degrade quietly.
          startPolling()
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        // NDJSON: newline-delimited JSON objects. Mirrors eve's own framing.
        for (;;) {
          const { done, value } = await reader.read()
            if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl = buffer.indexOf('\n')
          while (nl !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line) handleEventRef.current(safeParse(line))
            nl = buffer.indexOf('\n')
          }
        }
        // Flush a trailing partial line, if any.
        const tail = buffer.trim()
        if (tail) handleEventRef.current(safeParse(tail))

        // Stream closed. If we never saw a terminal marker (e.g. the socket was
        // cut before session.completed), reconcile once; if still not terminal,
        // fall back to polling.
        if (!terminalRef.current) {
          const done = await reconcileDurable()
          if (!done) startPolling()
        }
      } catch (err) {
        // Aborted on unmount is expected; anything else → degrade to polling.
        if ((err as Error)?.name !== 'AbortError' && !terminalRef.current) {
          const done = await reconcileDurable()
          if (!done) startPolling()
        }
      }
    },
    // handleEventRef is a ref (stable); deps intentionally minimal so the stream
    // isn't torn down on every render.
    [reconcileDurable, startPolling],
  )

  // ── Kickoff (once) + attach ────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    if (kickedOffRef.current) return
    // Already finished per the durable read — nothing to stream.
    if (terminalRef.current) return
    kickedOffRef.current = true

    let cancelled = false

    async function begin() {
      let sessionId = sessionIdRef.current

      // Kick off if we don't already have a session from the durable read. The
      // POST is idempotent: a re-mount / reload returns the SAME sessionId.
      if (!sessionId) {
        try {
          const res = await fetch(KICKOFF_URL, {
            method: 'POST',
            headers: DOCUMENT_SCOPE_HEADERS,
          })
          if (res.ok) {
            const body = (await res.json()) as {
              sessionId?: string
              status?: string
            }
            sessionId = body.sessionId ?? null
            if (body.status === 'skipped') {
              // Personal-email fast path (if the backend ever answers this way):
              // reconcile to pick up the durable 'skipped' state.
              terminalRef.current = true
              setStatus('skipped')
            }
          }
        } catch {
          // Kickoff failed — stay quiet. Try the durable read in case a prior
          // attempt (another tab) already started a run.
        }
      }

      if (cancelled) return

      if (sessionId) {
        sessionIdRef.current = sessionId
        if (statusRef.current === 'idle') setStatus('running')
        void consumeStream(sessionId)
        // Poll the durable read ALONGSIDE the stream, not only after it dies.
        // The stream is the fast path but must never be the ONLY path: a
        // proxy (or a mis-moded run) can hold it open silently forever, and
        // the pre-fix wizard did exactly that — spinner with no exit. Polling
        // stops itself on the first terminal observation.
        startPolling()
      } else if (!terminalRef.current) {
        // No session id at all — we can't stream. Poll the durable read; if a
        // run exists (started elsewhere) it'll surface, otherwise we sit idle.
        startPolling()
      }
    }

    void begin()

    return () => {
      cancelled = true
      abortRef.current?.abort()
      stopPolling()
      // This cleanup tore down the stream and polling, so the next run of the
      // effect (Strict Mode's remount, or a dep change) must attach again
      // rather than exit on the once-guard. The kickoff POST is idempotent.
      kickedOffRef.current = false
    }
  }, [enabled, consumeStream, startPolling, stopPolling])

  const latest = activities.length > 0 ? activities[activities.length - 1] : null
  const active = status === 'running'

  return {
    status,
    latest,
    activities,
    brief,
    companyFound,
    seededSummary,
    active,
    companyName,
    activePhase,
  }
}

/** Parse one NDJSON line, tolerating malformed frames (return an empty event). */
function safeParse(line: string): StreamEvent {
  try {
    return JSON.parse(line) as StreamEvent
  } catch {
    return {}
  }
}
