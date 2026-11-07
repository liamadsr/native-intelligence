/**
 * Where a live-agent turn's time goes, read off the eve events the route
 * already streams (readLiveTurn's onEvent): no extra DB read or write per tool
 * call, just a timestamp per event.
 *
 *   - tool_ms ................ per tool name, the total ms from the call's
 *                              `actions.requested` to its `action.result`
 *                              (the proxy round trip to the tool route plus the
 *                              tool's own run), and the count of timed calls.
 *                              A result whose request was never seen is not
 *                              timed. Capped at TOOL_MS_MAX_KEYS names, the
 *                              rest folded into '_other'. Every connected-app
 *                              lookup (`mcp__<server>__<tool>`) folds into one
 *                              'mcp' key: compact, and the person's server
 *                              names never land in usage metadata.
 *   - mcp_lookups ............ connected-app lookups that ran this turn (a
 *                              result that is not a refusal: time guard or
 *                              per-turn cap).
 *   - time_to_first_say_ms ... the first say_to_user that ran (not an error,
 *                              not dropped as stale), minus the turn's start.
 *   - stale_nudge_drops ...... say_to_user calls the tool route's time guard
 *                              dropped as stale.
 *   - held_nudge_drops ....... say_to_user calls a nudge.worth gate held
 *                              (`dropped: 'held'`). Always 0 today: the check
 *                              runs in shadow and never holds; plumbing for
 *                              the enforce PR.
 *   - time_up_refusals ....... read calls it refused past the research cutoff.
 *
 * Dependency-free: a structural event type, so tests feed plain objects.
 */

/** The tool names `tool_ms` keeps before folding the rest into '_other'. */
export const TOOL_MS_MAX_KEYS = 20

type TimedEvent =
  | {
      type: 'actions.requested'
      data: { actions: ReadonlyArray<{ kind: string; callId?: string; toolName?: string }> }
    }
  | {
      type: 'action.result'
      data: { result: { kind: string; callId?: string; toolName?: string; output?: unknown; isError?: boolean } }
    }
  | { type: string; data?: unknown }

export interface LiveTurnTimingSummary {
  tool_ms?: Record<string, { ms: number; n: number }>
  time_to_first_say_ms?: number
  stale_nudge_drops?: number
  held_nudge_drops?: number
  time_up_refusals?: number
  mcp_lookups?: number
}

/** The tool_ms key a tool's time is kept under (connected-app lookups fold into 'mcp'). */
function timingKey(toolName: string): string {
  return toolName.startsWith('mcp__') ? 'mcp' : toolName
}

export interface LiveTurnTiming {
  observe(ev: TimedEvent): void
  /** Only the fields that happened, so an ordinary turn adds little. */
  summary(): LiveTurnTimingSummary
}

function outputField(output: unknown, key: string): unknown {
  return output && typeof output === 'object' ? (output as Record<string, unknown>)[key] : undefined
}

/** A timer for one turn that started at `turnStartedAt` (epoch ms). */
export function createLiveTurnTiming(turnStartedAt: number, now: () => number = Date.now): LiveTurnTiming {
  const requestedAt = new Map<string, { toolName: string; at: number }>()
  const tools = new Map<string, { ms: number; n: number }>()
  let firstSayAt: number | null = null
  let staleDrops = 0
  let heldDrops = 0
  let timeUpRefusals = 0
  let mcpLookups = 0

  return {
    observe(ev) {
      if (ev.type === 'actions.requested') {
        const actions = (ev.data as { actions?: ReadonlyArray<{ kind: string; callId?: string; toolName?: string }> })
          ?.actions ?? []
        const at = now()
        for (const a of actions) {
          if (a.kind !== 'tool-call' && a.kind !== 'workflow-tool-call') continue
          if (!a.callId || !a.toolName || requestedAt.has(a.callId)) continue
          requestedAt.set(a.callId, { toolName: timingKey(a.toolName), at })
        }
      } else if (ev.type === 'action.result') {
        const r = (ev.data as { result?: { kind: string; callId?: string; toolName?: string; output?: unknown; isError?: boolean } })
          ?.result
        if (!r || r.kind !== 'tool-result') return
        const at = now()
        const req = r.callId ? requestedAt.get(r.callId) : undefined
        if (req && r.callId) {
          requestedAt.delete(r.callId)
          const slot = tools.get(req.toolName) ?? { ms: 0, n: 0 }
          slot.ms += Math.max(0, at - req.at)
          slot.n += 1
          tools.set(req.toolName, slot)
        }
        const toolName = r.toolName ?? req?.toolName
        const refused = outputField(r.output, 'refused')
        if (refused === 'time_up') timeUpRefusals++
        if (toolName !== undefined && timingKey(toolName) === 'mcp' && refused === undefined) mcpLookups++
        if (toolName === 'say_to_user' && !r.isError) {
          const dropped = outputField(r.output, 'dropped')
          if (dropped === 'stale') staleDrops++
          else if (dropped === 'held') heldDrops++
          else if (firstSayAt === null) firstSayAt = at
        }
      }
    },
    summary() {
      const out: LiveTurnTimingSummary = {}
      if (tools.size > 0) {
        const sorted = [...tools.entries()].sort((a, b) => b[1].ms - a[1].ms)
        const kept = sorted.slice(0, TOOL_MS_MAX_KEYS - (sorted.length > TOOL_MS_MAX_KEYS ? 1 : 0))
        const toolMs: Record<string, { ms: number; n: number }> = {}
        for (const [name, v] of kept) toolMs[name] = { ms: Math.round(v.ms), n: v.n }
        const rest = sorted.slice(kept.length)
        if (rest.length > 0) {
          toolMs._other = rest.reduce(
            (sum, [, v]) => ({ ms: sum.ms + Math.round(v.ms), n: sum.n + v.n }),
            { ms: 0, n: 0 },
          )
        }
        out.tool_ms = toolMs
      }
      if (firstSayAt !== null) out.time_to_first_say_ms = Math.max(0, firstSayAt - turnStartedAt)
      if (staleDrops > 0) out.stale_nudge_drops = staleDrops
      if (heldDrops > 0) out.held_nudge_drops = heldDrops
      if (timeUpRefusals > 0) out.time_up_refusals = timeUpRefusals
      if (mcpLookups > 0) out.mcp_lookups = mcpLookups
      return out
    },
  }
}
