/**
 * Work with no bot you can see is the Assistant's (docs/plans/bots-v4.md,
 * "Work with no teammate"; Liam, 2026-10-08). The ONE rule, in one place, for
 * every reader that groups work by bot: the shared source on the client
 * (AgentWorkProvider, and through it the bubble, the bot's page and the crew)
 * and the server (GET /api/account/agent-work
 * `?light=1` and `?teammate=`, and the main agent's list_bot_work and
 * get_bot_item, bot-work-server.ts).
 *
 * A ledger row's bot:
 *   - its teammate (`ai_team_member_id`), when the viewer can reach it in the
 *     row's workspace, or when the viewer's facts can't say (below);
 *   - no teammate: the workspace's Assistant (the `ai_team_member` with
 *     `system_key = 'assistant'`, seeded one per workspace by migration 310).
 *     That's an older row written before its writer named one, a deleted
 *     bot's (`tracked_job.ai_team_member_id` is `on delete set null`), or a
 *     writer whose lookup failed soft. The row is marked
 *     `source.teammate_routed`: the Assistant fronts it for attribution only,
 *     so a run's chat stays the person's own ("Your run's chat", decision 20);
 *   - a teammate the viewer can't reach (behind a private team they aren't
 *     on: decision 17 hides that bot from them; or no teammate of that
 *     workspace): also the Assistant, so nothing they own is lost, but marked
 *     `source.owner_fallback`, NOT `teammate_routed`. The run was that bot's,
 *     on its ceiling: every run-chat path refuses its chat (item-run-chat.ts,
 *     bubble-items.ts rowHasRunChat, bot-relay.ts) and talking about it goes
 *     to the Assistant's own thread.
 * A pending card's bot (`payload.raised_by_ai_member_id` is JSON, no foreign
 * key, so a raiser can be deleted): the raiser when the viewer can reach it;
 * a raiser they can't reach (deleted, or behind a private team): the
 * Assistant; no raiser: the run that wrote it (its ledger row, matched on
 * `source_flow_run_id`, whose bot is the row rule's), else the Assistant.
 *
 * Whose facts. "Can't reach" needs to know the teammate. The server reads
 * every teammate the rows and cards name (bot-owner-server.ts loadBotOwners),
 * so its facts are complete: a named teammate it can't read is deleted or
 * hidden by RLS (a private team's), out of reach either way. The client reads
 * them off its roster, which is capped (ROSTER_LIMIT): when the roster is at
 * the cap, a teammate missing from it is UNKNOWN, and its work doesn't move.
 * A failed reach read (`reachable: null`) moves nothing either.
 *
 * An area face's row (one face, docs/plans/always-on-agent.md §2c, decision
 * 11): the system teammates keyed by an area (Captures, Mail, Prospecting,
 * Evals, CRM; migration 318) are attribution only and no longer drawn, so
 * their work shows with the workspace's Assistant, as the agent's own: marked
 * `source.teammate_routed` (its run's chat stays offered, the person's own,
 * as for a row with no teammate) and `source.face_area` (the area it came
 * from, for the area label on its card). A card an area face raised is the
 * Assistant's likewise, with `payload.raised_by_area`.
 *
 * The one exception: sequence sends (`sequence_enrolment`) keep the Sequences
 * page and their own notices, and stay without a bot (KINDS_WITHOUT_BOT).
 * A workspace with no Assistant known keeps today's behaviour: its work stays
 * where it was (a lane, or no bot).
 *
 * Applied where the work is READ, never written: `withBotOwners` and
 * `withCardOwners` hand back the rows and cards as if they had been written
 * with their bot, so every grouping after them (ownerOf, cardOwnerKeys,
 * countByOwner, the bubble's lists) reads the answer without knowing the rule.
 * Write time already names the Assistant for new work that has no bot of its
 * own (system-teammates.ts); this covers what write time can't fix.
 *
 * Pure (no server imports), so the client and the server share it.
 */
import type { WorkTeammate } from './types'
import { isAreaFaceKey, type AreaFaceKey } from './work-area'

/** Work that keeps no bot: sequence sends stay on the Sequences page, with their own notices. */
export const KINDS_WITHOUT_BOT: ReadonlySet<string> = new Set(['sequence_enrolment'])

/** The Assistant's system key (migration 310). */
export const ASSISTANT_SYSTEM_KEY = 'assistant'

/** How many teammates a roster read holds (agent-roster.ts): at the cap, one missing from it is unknown. */
export const ROSTER_LIMIT = 200

/** What the rule reads of a teammate: a roster entry (agent-roster.ts) is one. */
export interface OwnerTeammateFacts {
  id: string
  workspace_id: string
  name?: string | null
  is_system?: boolean | null
  system_key?: string | null
  role?: string | null
  bot_character?: string | null
  /**
   * The viewer may reach it (the private-team rule). Only an explicit `false`
   * is out of reach: `null` (the reach read failed) and absent keep their own
   * work, so a hiccup never moves a bot's work to the Assistant.
   */
  reachable?: boolean | null
}

/** Who owns what, for one viewer: each workspace's Assistant, and the teammates they can and can't reach. */
export interface BotOwners {
  /** Per workspace, its Assistant as a row's teammate embed. */
  readonly assistants: ReadonlyMap<string, WorkTeammate>
  /** Every teammate the viewer can reach, by id, with its workspace. */
  readonly reachable: ReadonlyMap<string, string>
  /** Every teammate read that the viewer can't reach (behind a private team), by id, with its workspace. */
  readonly unreachable: ReadonlyMap<string, string>
  /** Every area face read (migration 318), by id: its workspace and its area. Their work shows with the Assistant. */
  readonly areaFaces: ReadonlyMap<string, { workspaceId: string; area: AreaFaceKey }>
  /**
   * Whether a teammate missing from both maps is out of reach (deleted, or
   * hidden by RLS: the facts asked for every teammate named) or unknown (a
   * capped roster: its work doesn't move).
   */
  readonly complete: boolean
}

/** No owners known (no roster yet): nothing falls back. */
export const NO_BOT_OWNERS: BotOwners = { assistants: new Map(), reachable: new Map(), unreachable: new Map(), areaFaces: new Map(), complete: false }

/**
 * The owners these teammates say. `complete`: they are every teammate the
 * work names (the server's read), or a roster under the cap; false for a
 * roster at ROSTER_LIMIT (botOwnersFromRoster).
 */
export function botOwners(teammates: Iterable<OwnerTeammateFacts>, opts: { complete: boolean }): BotOwners {
  const assistants = new Map<string, WorkTeammate>()
  const reachable = new Map<string, string>()
  const unreachable = new Map<string, string>()
  const areaFaces = new Map<string, { workspaceId: string; area: AreaFaceKey }>()
  for (const t of teammates) {
    if (!t?.id || !t.workspace_id) continue
    if (t.reachable === false) unreachable.set(t.id, t.workspace_id)
    else reachable.set(t.id, t.workspace_id)
    if (t.is_system === true && isAreaFaceKey(t.system_key)) areaFaces.set(t.id, { workspaceId: t.workspace_id, area: t.system_key })
    if (t.system_key === ASSISTANT_SYSTEM_KEY && !assistants.has(t.workspace_id)) {
      assistants.set(t.workspace_id, {
        id: t.id,
        name: t.name?.trim() || 'Assistant',
        is_system: true,
        system_key: ASSISTANT_SYSTEM_KEY,
        role: null,
        bot_character: t.bot_character ?? null,
      })
      // A system teammate: everyone reaches it.
      unreachable.delete(t.id)
      reachable.set(t.id, t.workspace_id)
    }
  }
  return { assistants, reachable, unreachable, areaFaces, complete: opts.complete }
}

/** A roster's owners (the client's, the light read's): complete only while the roster is under its cap. */
export function botOwnersFromRoster(roster: readonly OwnerTeammateFacts[]): BotOwners {
  return botOwners(roster, { complete: roster.length < ROSTER_LIMIT })
}

/** The workspace's Assistant's id, or null when none is known. */
export function assistantIdOf(owners: BotOwners, workspaceId: string | null | undefined): string | null {
  return (workspaceId && owners.assistants.get(workspaceId)?.id) || null
}

/**
 * Whether the viewer can reach `teammateId` as a teammate of `workspaceId`:
 * yes, no (a private team's, another workspace's, or, with complete facts,
 * one that can't be read: deleted or hidden), or unknown (a capped roster).
 */
export function teammateReach(owners: BotOwners, teammateId: string, workspaceId: string): 'yes' | 'no' | 'unknown' {
  const reached = owners.reachable.get(teammateId)
  if (reached !== undefined) return reached === workspaceId ? 'yes' : 'no'
  if (owners.unreachable.has(teammateId)) return 'no'
  return owners.complete ? 'no' : 'unknown'
}

/** What the rule reads of a ledger row. */
export interface OwnedRowFacts {
  workspace_id: string
  kind: string
  ai_team_member_id?: string | null
}

/**
 * Why the Assistant shows a row: it names no teammate (`routed`), an area
 * face of its workspace (`area`: the agent's own work, one face), or one the
 * viewer can't reach (`fallback`).
 */
export type AssistantTakes = 'routed' | 'area' | 'fallback'

/** The area face `teammateId` is in `workspaceId`, or null for any other teammate (or another workspace's). */
export function areaFaceOf(owners: BotOwners, teammateId: string | null | undefined, workspaceId: string): AreaFaceKey | null {
  const face = teammateId ? owners.areaFaces.get(teammateId) : undefined
  return face && face.workspaceId === workspaceId ? face.area : null
}

/** Whether, and why, the workspace's Assistant shows this row (see the module note); null when it keeps its own. */
export function assistantTakes(row: OwnedRowFacts, owners: BotOwners): AssistantTakes | null {
  if (KINDS_WITHOUT_BOT.has(row.kind) || !assistantIdOf(owners, row.workspace_id)) return null
  const named = row.ai_team_member_id ?? null
  if (!named) return 'routed'
  if (named === assistantIdOf(owners, row.workspace_id)) return null
  if (areaFaceOf(owners, named, row.workspace_id)) return 'area'
  return teammateReach(owners, named, row.workspace_id) === 'no' ? 'fallback' : null
}

/** The bot a ledger row shows with (see the module note): its own teammate, the Assistant, or null for none. */
export function rowOwnerId(row: OwnedRowFacts, owners: BotOwners): string | null {
  return assistantTakes(row, owners) ? assistantIdOf(owners, row.workspace_id) : (row.ai_team_member_id ?? null)
}

type OwnedRow = OwnedRowFacts & { teammate?: WorkTeammate | null; source?: object | null }

/**
 * The row as if it had been written with its bot (rowOwnerId): the same
 * object when it keeps its own, else a copy naming the Assistant, with its
 * teammate embed, marked `source.teammate_routed` (no teammate, or an area
 * face's: its run's chat stays the person's own, own-run.ts; an area face's
 * also `source.face_area`, its area) or `source.owner_fallback` (a teammate
 * out of reach: no run chat at all).
 */
export function withBotOwner<T extends OwnedRow>(row: T, owners: BotOwners): T {
  const takes = assistantTakes(row, owners)
  const assistant = owners.assistants.get(row.workspace_id)
  if (!takes || !assistant) return row
  const source = (row.source as Record<string, unknown> | null | undefined) ?? {}
  return {
    ...row,
    ai_team_member_id: assistant.id,
    teammate: assistant,
    source: {
      ...source,
      ...(takes === 'fallback' ? { owner_fallback: true } : { teammate_routed: true }),
      ...(takes === 'area' ? { face_area: owners.areaFaces.get(row.ai_team_member_id ?? '')?.area } : {}),
    },
  } as T
}

/** The area face a row came from, when the owner rule moved it to the Assistant (withBotOwner `face_area`); else null. */
export function faceAreaOf(row: { source?: Record<string, unknown> | object | null }): AreaFaceKey | null {
  const area = (row.source as Record<string, unknown> | null | undefined)?.face_area
  return isAreaFaceKey(area) ? area : null
}

/** Every row as withBotOwner has it; the same array when none changes. */
export function withBotOwners<T extends OwnedRow>(rows: readonly T[], owners: BotOwners): T[] {
  let out: T[] | null = null
  for (let i = 0; i < rows.length; i++) {
    const owned = withBotOwner(rows[i], owners)
    if (owned !== rows[i] && !out) out = rows.slice(0, i)
    out?.push(owned)
  }
  return out ?? (rows as T[])
}

/** A row the Assistant shows for a bot the viewer can't reach (withBotOwner): its run's chat is never offered. */
export function isOwnerFallback(row: { source?: Record<string, unknown> | object | null }): boolean {
  return (row.source as Record<string, unknown> | null | undefined)?.owner_fallback === true
}

/** What the rule reads of a pending card. */
export interface OwnedCardFacts {
  workspace_id: string
  source_flow_run_id?: string | null
  payload?: {
    raised_by_ai_member_id?: string | null
    fallback_owner_ai_member_id?: string | null
    raised_by_area?: string | null
  } | null
}

/**
 * The card as its owner rule needs it (see the module note): the same object
 * when its raiser stands (reachable, or unknown); raised by an area face of
 * its workspace, raised by its Assistant, with `payload.raised_by_area` (one
 * face); with a raiser the viewer can't reach, raised by its workspace's
 * Assistant; with no raiser,
 * `payload.fallback_owner_ai_member_id` set to the Assistant, which
 * cardOwnerKeys reads only when no run row of the card's names a bot
 * (agent-work-lanes.ts). Unchanged when the workspace has no Assistant known.
 */
export function withCardOwner<T extends OwnedCardFacts>(card: T, owners: BotOwners): T {
  const assistant = assistantIdOf(owners, card.workspace_id)
  if (!assistant) return card
  const payload = card.payload ?? {}
  const raisedBy = typeof payload.raised_by_ai_member_id === 'string' && payload.raised_by_ai_member_id ? payload.raised_by_ai_member_id : null
  if (raisedBy) {
    const area = areaFaceOf(owners, raisedBy, card.workspace_id)
    if (area) return { ...card, payload: { ...payload, raised_by_ai_member_id: assistant, raised_by_area: area } } as T
    if (raisedBy === assistant || teammateReach(owners, raisedBy, card.workspace_id) !== 'no') return card
    return { ...card, payload: { ...payload, raised_by_ai_member_id: assistant } } as T
  }
  if (payload.fallback_owner_ai_member_id === assistant) return card
  return { ...card, payload: { ...payload, fallback_owner_ai_member_id: assistant } } as T
}

/** Every card as withCardOwner has it; the same array when none changes. */
export function withCardOwners<T extends OwnedCardFacts>(cards: readonly T[], owners: BotOwners): T[] {
  let out: T[] | null = null
  for (let i = 0; i < cards.length; i++) {
    const owned = withCardOwner(cards[i], owners)
    if (owned !== cards[i] && !out) out = cards.slice(0, i)
    out?.push(owned)
  }
  return out ?? (cards as T[])
}

/** The teammate ids a set of rows and cards name: what the server's owner facts read (bot-owner-server.ts). */
export function namedTeammateIds(
  rows: Iterable<{ ai_team_member_id?: string | null }>,
  cards: Iterable<{ payload?: { raised_by_ai_member_id?: string | null } | null }> = [],
): string[] {
  const ids = new Set<string>()
  for (const r of rows) if (r.ai_team_member_id) ids.add(r.ai_team_member_id)
  for (const c of cards) {
    const id = c.payload?.raised_by_ai_member_id
    if (typeof id === 'string' && id) ids.add(id)
  }
  return [...ids]
}
