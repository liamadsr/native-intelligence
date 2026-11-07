/**
 * Whose a live arrival is, for the sound it plays (bots-v2 Phase 6, ./triggers
 * teammateArrivalSound): the ledger rows (`tracked_job`) this window has seen
 * go by on its realtime channel, each remembered as the AI teammate that runs
 * it (`ai_team_member_id`).
 *
 *   noteWorkRow(payload.new)               the shared source's ledger channel (use-agent-work.ts), on every INSERT / UPDATE
 *   workRowOwner(notification.target_id)   the notification path
 *   cardTeammateId(card)                   the attention card path
 *
 * Why a memory: a `work_needs_you` notification names only its row
 * (`target_id`), and a card arriving names only its fire (`run_key`) or the
 * teammate it proposes for the work; the teammate is on the row.
 * NotificationProvider sits above AgentWorkProvider in the shell, so the
 * notification path can't read the shared rows either.
 *
 * The row comes first. The recorder writes a row's move into needs_input /
 * needs_review and only then its notification (src/lib/work/recorder.ts
 * `transition`), a loop's row is inserted as its fire starts, before any card
 * (src/lib/inngest/flow-functions.ts `startFlowWork`), and realtime delivers in
 * commit order. A window that missed the row (its channel was down) plays the
 * sound it always played, under the same key, so an arrival is still one sound.
 *
 * One fire can fan out to several loops (flow-functions.ts runs every flow the
 * event matches, one step after another, each with its own row), and a card
 * carries only the bare fire, not its flow. So a fire is only attributed while
 * every loop row seen for it has the same owner: once a second owner shows up
 * (a person's own loop beside a teammate's, or two teammates), the fire is
 * MIXED and its cards fall back to today's sound rather than guess.
 *
 * Per window (module state), bounded, and read for nothing but a sound.
 */

/** What the memory reads off a ledger row (a realtime payload is the whole row). */
export interface OwnedWorkRow {
  id?: string
  kind?: string | null
  run_key?: string | null
  flow_run_id?: string | null
  ai_team_member_id?: string | null
}

export interface WorkRowOwner {
  /** The AI teammate that runs it; null for a row with none (a person's own loop, a lane's run). */
  teammateId: string | null
}

/** What a card arriving carries that can name its teammate (an AttentionItem is one). */
export interface OwnedCardLike {
  /** The fire that wrote it. Not in the client type; the realtime payload is the whole row. */
  run_key?: unknown
  source_flow_run_id?: string | null
  /** Who raised it is read; the teammate a proposal names to do the work (`assignee_ai_member_id`) is not (decision 9). */
  payload?: { raised_by_ai_member_id?: string | null; assignee_ai_member_id?: string | null } | null
}

/** Bound on each map (least recently written goes first), like the ledger hook's status memory. */
const MAX_ENTRIES = 500

/** The loop pipeline's ledger kind (WORK_KINDS.flowRun). */
const LOOP_FIRE_KIND = 'flow_run'

const rows = new Map<string, WorkRowOwner>()
/**
 * A loop fire → whose its rows are: the one owner seen so far (a teammate id,
 * or null for a person's own loop) and the row it was first seen on, or
 * `mixed` once a DIFFERENT row with another owner has been seen (see the
 * header). A later payload of the same row replaces its owner instead.
 */
const fires = new Map<string, { owner: string | null; rowId: string; mixed: boolean }>()
/** A teammate's flow_run → that teammate. */
const flowRuns = new Map<string, string>()

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * The fire a loop row is keyed on. A loop fire's row has run_key
 * `<fire id>:<flow id>` (flow-functions.ts `startFlowWork`), and the cards the
 * fire surfaces carry the fire id alone (run-skill.ts hands it to
 * verdict-apply.ts as `runKey`).
 */
export function fireOfLoopRunKey(runKey: string): string | null {
  const cut = runKey.lastIndexOf(':')
  return cut > 0 ? runKey.slice(0, cut) : null
}

/** Remember whose a ledger row is. Every realtime payload of the row may call it. */
export function noteWorkRow(row: OwnedWorkRow | null | undefined): void {
  const id = idOf(row?.id)
  if (!row || !id) return
  const teammateId = idOf(row.ai_team_member_id)
  remember(rows, id, { teammateId })
  // Every loop row counts toward its fire's owner, a person's own included:
  // that is how a mixed fire is told apart from a teammate's.
  const runKey = idOf(row.run_key)
  const fire = row.kind === LOOP_FIRE_KIND && runKey ? fireOfLoopRunKey(runKey) : null
  if (fire) {
    const seen = fires.get(fire)
    if (!seen || (!seen.mixed && seen.rowId === id)) remember(fires, fire, { owner: teammateId, rowId: id, mixed: false })
    else if (!seen.mixed && seen.owner !== teammateId) remember(fires, fire, { owner: null, rowId: seen.rowId, mixed: true })
  }
  if (!teammateId) return
  const flowRunId = idOf(row.flow_run_id)
  if (flowRunId) remember(flowRuns, flowRunId, teammateId)
}

/** Whose the row is, or null when this window hasn't seen it. */
export function workRowOwner(id: string | null | undefined): WorkRowOwner | null {
  return id ? (rows.get(id) ?? null) : null
}

/**
 * The AI teammate a card arriving is attributable to, or null: the teammate
 * that raised it (`payload.raised_by_ai_member_id`, stamped at insert; bots v3
 * 1a), else the teammate whose run wrote it (its back-filled
 * `source_flow_run_id`, or its fire while every loop row of that fire is the
 * teammate's). The owner agent-work-lanes.ts `cardOwnerKeys` gives the bots
 * (the raiser only, bots-v4.md decision 9), read at the moment the card
 * arrives, when its run link is usually not back-filled yet. The teammate a
 * work proposal names to do the work owns nothing, so it names no one here
 * either. A mixed fire names no one.
 */
export function cardTeammateId(card: OwnedCardLike | null | undefined): string | null {
  if (!card) return null
  const raisedBy = idOf(card.payload?.raised_by_ai_member_id)
  if (raisedBy) return raisedBy
  const flowRunId = idOf(card.source_flow_run_id)
  const byRun = flowRunId ? flowRuns.get(flowRunId) : undefined
  if (byRun) return byRun
  const fire = idOf(card.run_key)
  const byFire = fire ? fires.get(fire) : undefined
  if (byFire && !byFire.mixed && byFire.owner) return byFire.owner
  return null
}

/** Tests only. */
export function __resetTeammateWorkForTests(): void {
  rows.clear()
  fires.clear()
  flowRuns.clear()
}
