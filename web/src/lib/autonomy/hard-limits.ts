/**
 * What never graduates (docs/plans/earned-autonomy.md §4). Two layers, both
 * deterministic, both fail closed:
 *
 *   (a) an ALLOWLIST: a kind can graduate only if its tool is named in
 *       GRADUATABLE_TOOLS (or, for a connected app's tool, the app marks it
 *       as not destructive and its name passes the deny patterns). A tool that
 *       ships without a decision can't graduate, the reason the reviewer
 *       reviews an unclassified tool;
 *   (b) a NEVER list, whatever the record says: money, deletes, commitments,
 *       mass sends, permissions and sharing, the irreversible and the public;
 *       and, on every call (not on the kind), any recipient the person has not
 *       corresponded with.
 *
 * Pure: the per-call recipient check takes the known set from its caller.
 */
import { getToolSideEffect } from '@/lib/ai/tool-registry'
import { bareToolName } from '@/lib/mcp/tool-names'
import type { AutonomyKind } from './kind'

/**
 * The tools a kind can graduate on at all (§4a; the owner's list to confirm,
 * decision 3). Each reaches at most the few people its input names, through a
 * path the outward gate already cards, and each has a compensating undo or a
 * send the undo window can stop.
 */
export const GRADUATABLE_TOOLS: ReadonlySet<string> = new Set([
  'book_quote',
  'create_calendar_event',
  'update_calendar_event',
  'offer_times',
  'nudge_time_offer',
  'push_action_to_linear',
  'push_action_to_jira',
  'push_action_to_asana',
])

export type HardLimit =
  | 'not_graduatable'
  | 'spends_money'
  | 'deletes'
  | 'commitment'
  | 'mass_send'
  | 'permissions'
  | 'irreversible'
  | 'unknown_channel'
  | 'new_recipient'

/** Money: payment links, the Studio's paid generations. */
const MONEY_TOOLS: ReadonlySet<string> = new Set([
  'send_payment_link',
  'generate_studio_shot',
  'generate_studio_narration',
  'generate_studio_revoice',
  'generate_studio_sound_effect',
  'generate_studio_music',
  'import_stripe_customers',
])
/** Commitments someone else can hold the person to. */
const COMMITMENT_TOOLS: ReadonlySet<string> = new Set(['send_quote', 'accept_time_offer', 'record_time_offer_answer', 'book_poll_time'])
/** Sends to many at once. */
const MASS_TOOLS: ReadonlySet<string> = new Set(['launch_campaign', 'launch_sequence', 'enroll_contacts_in_sequence', 'publish_prospect_list', 'post_team_chat_poll'])
/** Who can reach what. */
const PERMISSION_TOOLS: ReadonlySet<string> = new Set(['connect', 'disconnect'])
/** Can't be taken back, public, or open-ended. */
const IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
  'unsubscribe_thread',
  'publish_post',
  'schedule_post',
  'publish_draft',
  'open_browser',
  'run_browser_task',
  'answer_guest',
  'ask_agent',
  'cancel_booking',
  'move_booking',
  'cancel_offered_meeting',
  'complete_job',
])

/** A connected app's tool name, by what it does (matched on its own words, case-insensitive). */
const MCP_DENY_PATTERNS: ReadonlyArray<[HardLimit, RegExp]> = [
  ['spends_money', /pay|charge|refund|invoice|purchase|order|checkout|transfer|subscri/i],
  ['deletes', /delete|remove|trash|destroy|archive|purge|cancel|revoke|erase/i],
  ['commitment', /sign|contract|agreement|envelope|accept|approve/i],
  ['permissions', /share|permission|invite|grant|role|access|member|owner|collaborat/i],
  ['mass_send', /bulk|batch|broadcast|campaign|blast|mass/i],
]

/** What a connected app says about its tool (MCP annotations), when the door has it. */
export interface ConnectedToolMeta {
  /** MCP's destructiveHint. Unknown (undefined) is treated as destructive. */
  destructive?: boolean
}

/**
 * Why this kind can never graduate, or null when it may (it still has to
 * earn it, and each call still meets callHitsHardLimit).
 */
export function hardLimitOfKind(kind: Pick<AutonomyKind, 'tool' | 'channel' | 'audience'>, meta?: ConnectedToolMeta): HardLimit | null {
  if (kind.audience === 'many') return 'mass_send'
  if (kind.channel === 'unknown') return 'unknown_channel'
  if (kind.tool.startsWith('mcp__')) {
    const own = kind.tool.split('__').slice(2).join('__')
    for (const [limit, pattern] of MCP_DENY_PATTERNS) if (pattern.test(own)) return limit
    // Fail closed: graduatable only when the app says it isn't destructive.
    return meta?.destructive === false ? null : 'not_graduatable'
  }
  const name = bareToolName(kind.tool)
  if (MONEY_TOOLS.has(name)) return 'spends_money'
  if (getToolSideEffect(name) === 'delete') return 'deletes'
  if (COMMITMENT_TOOLS.has(name)) return 'commitment'
  if (MASS_TOOLS.has(name)) return 'mass_send'
  if (PERMISSION_TOOLS.has(name)) return 'permissions'
  if (IRREVERSIBLE_TOOLS.has(name)) return 'irreversible'
  if (!GRADUATABLE_TOOLS.has(name)) return 'not_graduatable'
  return null
}

/**
 * The per-call limits on top of the kind's: every recipient must be known
 * (`known` holds the lower-cased addresses, numbers and `quote:`/`poll:` refs
 * the caller verified: the person's mail history, workspace members, a
 * customer who wrote in). An empty `known` with recipients is all-new. A call
 * whose kind is limited is limited.
 */
export function callHitsHardLimit(kind: AutonomyKind, known: ReadonlySet<string>, meta?: ConnectedToolMeta): HardLimit | null {
  const ofKind = hardLimitOfKind(kind, meta)
  if (ofKind) return ofKind
  for (const r of kind.recipients) if (!known.has(r.trim().toLowerCase())) return 'new_recipient'
  return null
}

/** The sentence the Settings list shows for a kind that always asks. */
export const HARD_LIMIT_WORDS: Record<HardLimit, string> = {
  not_graduatable: 'Always asks: not on the list of work the agent can take over',
  spends_money: 'Always asks: it spends money',
  deletes: 'Always asks: it deletes or cancels something',
  commitment: 'Always asks: it commits you to something',
  mass_send: 'Always asks: it reaches many people at once',
  permissions: 'Always asks: it changes who can see or do what',
  irreversible: "Always asks: it can't be taken back",
  unknown_channel: "Always asks: Native Intelligence can't tell how it leaves",
  new_recipient: "Always asks when it reaches someone you haven't been in touch with",
}
