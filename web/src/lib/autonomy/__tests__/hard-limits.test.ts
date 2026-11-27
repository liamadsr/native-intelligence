/**
 * The hard limits (docs/plans/earned-autonomy.md §4): every never-listed tool,
 * run through the whole graduation path with a perfect record and a stored
 * grant, stays at ask and is never offered; only the allowlist can graduate;
 * a connected app's tool fails closed; and each call to a new recipient is
 * limited even on a graduatable kind.
 */
import { describe, expect, it } from 'vitest'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { callHitsHardLimit, GRADUATABLE_TOOLS, HARD_LIMIT_WORDS, hardLimitOfKind, type HardLimit } from '../hard-limits'
import { kindOfCall, type AutonomyKind } from '../kind'
import { evaluateKind, type OutcomeEvent } from '../rules'

const TOOL_REGISTRY = TOOL_CATEGORIES.flatMap((c) => c.tools)
const NOW = new Date('2026-11-27T12:00:00Z')
const perfect: OutcomeEvent[] = Array.from({ length: 60 }, (_, i) => ({ outcome: 'approved', at: new Date(NOW.getTime() - (i + 1) * 12 * 3_600_000).toISOString() }))

function kind(tool: string, channel: AutonomyKind['channel'] = 'email', audience: AutonomyKind['audience'] = 'one'): AutonomyKind {
  return { tool, channel, audience, key: `${tool}|${channel}|${audience}`, recipients: audience === 'none' ? [] : ['dana@example.com'] }
}

/** The whole path: the kind's limit, then the rules with a perfect record and a stored grant. */
function staysAsk(k: AutonomyKind): void {
  const limited = hardLimitOfKind(k) !== null
  expect(limited).toBe(true)
  for (const decisions of [{}, { level: 'tell' as const, grantedAt: '2026-10-01T00:00:00Z' }, { level: 'quiet' as const, grantedAt: '2026-10-01T00:00:00Z' }]) {
    const r = evaluateKind(perfect, decisions, NOW, limited)
    expect(r.level).toBe('ask')
    expect(r.eligible).toBeNull()
  }
}

const NEVER: Array<[string, HardLimit]> = [
  ['send_payment_link', 'spends_money'],
  ['generate_studio_shot', 'spends_money'],
  ['generate_studio_narration', 'spends_money'],
  ['generate_studio_revoice', 'spends_money'],
  ['generate_studio_sound_effect', 'spends_money'],
  ['generate_studio_music', 'spends_money'],
  ['delete_calendar_event', 'deletes'],
  ['delete_action', 'deletes'],
  ['discard_email_draft', 'deletes'],
  ['send_quote', 'commitment'],
  ['accept_time_offer', 'commitment'],
  ['book_poll_time', 'commitment'],
  ['launch_campaign', 'mass_send'],
  ['launch_sequence', 'mass_send'],
  ['enroll_contacts_in_sequence', 'mass_send'],
  ['publish_prospect_list', 'mass_send'],
  ['post_team_chat_poll', 'mass_send'],
  ['connect', 'permissions'],
  ['unsubscribe_thread', 'irreversible'],
  ['publish_post', 'irreversible'],
  ['schedule_post', 'irreversible'],
  ['open_browser', 'irreversible'],
  ['run_browser_task', 'irreversible'],
  ['answer_guest', 'irreversible'],
  ['ask_agent', 'irreversible'],
  ['cancel_booking', 'irreversible'],
  ['move_booking', 'irreversible'],
]

describe('never, whatever the record says', () => {
  it.each(NEVER)('%s → %s, and a perfect record with a grant stays at ask', (tool, limit) => {
    const k = kind(tool)
    expect(hardLimitOfKind(k)).toBe(limit)
    staysAsk(k)
  })

  it('every registry tool classed delete never graduates', () => {
    const deletes = TOOL_REGISTRY.filter((t) => t.sideEffect === 'delete').map((t) => t.name)
    expect(deletes.length).toBeGreaterThan(10)
    for (const name of deletes) staysAsk(kind(name))
  })

  it('nothing outside the allowlist graduates: every other registry tool is limited', () => {
    for (const t of TOOL_REGISTRY) {
      if (GRADUATABLE_TOOLS.has(t.name)) continue
      expect(hardLimitOfKind(kind(t.name)), t.name).not.toBeNull()
    }
  })

  it('a tool nobody has decided on (not in the registry) cannot graduate', () => {
    expect(hardLimitOfKind(kind('send_rocket'))).toBe('not_graduatable')
  })

  it('a mass send (more than 3 people) never graduates, even on an allowlisted tool', () => {
    staysAsk(kind('create_calendar_event', 'calendar', 'many'))
    expect(hardLimitOfKind(kind('create_calendar_event', 'calendar', 'many'))).toBe('mass_send')
  })

  it('a channel the code cannot read never graduates', () => {
    expect(hardLimitOfKind(kind('book_quote', 'unknown'))).toBe('unknown_channel')
  })
})

describe('the allowlist', () => {
  it('names the plan\'s first list (decision 3)', () => {
    expect([...GRADUATABLE_TOOLS].sort()).toEqual(
      ['book_quote', 'create_calendar_event', 'nudge_time_offer', 'offer_times', 'push_action_to_asana', 'push_action_to_jira', 'push_action_to_linear', 'update_calendar_event'].sort(),
    )
  })

  it('every allowlisted tool is in the registry, and none is a delete', () => {
    const names = new Map(TOOL_REGISTRY.map((t) => [t.name, t.sideEffect]))
    for (const tool of GRADUATABLE_TOOLS) {
      expect(names.has(tool), tool).toBe(true)
      expect(names.get(tool), tool).not.toBe('delete')
    }
  })

  it('an allowlisted kind may graduate (it still has to earn it)', () => {
    const k = kind('book_quote', 'customer', 'one')
    expect(hardLimitOfKind(k)).toBeNull()
    expect(evaluateKind(perfect, {}, NOW, false).eligible).toBe('tell')
  })
})

describe('a connected app\'s tools fail closed', () => {
  const mcp = (name: string) => kind(`mcp__gmail__${name}`, 'app', 'none')

  it('graduatable only when the app says it is not destructive', () => {
    expect(hardLimitOfKind(mcp('label_thread'))).toBe('not_graduatable')
    expect(hardLimitOfKind(mcp('label_thread'), { destructive: true })).toBe('not_graduatable')
    expect(hardLimitOfKind(mcp('label_thread'), { destructive: false })).toBeNull()
  })

  it.each([
    ['trash_thread', 'deletes'],
    ['delete_label', 'deletes'],
    ['archive_message', 'deletes'],
    ['create_invoice', 'spends_money'],
    ['refund_charge', 'spends_money'],
    ['share_file', 'permissions'],
    ['invite_member', 'permissions'],
    ['sign_envelope', 'commitment'],
    ['bulk_send', 'mass_send'],
  ] as const)('%s → %s, even when the app calls it not destructive', (name, limit) => {
    expect(hardLimitOfKind(mcp(name), { destructive: false })).toBe(limit)
    staysAsk(mcp(name))
  })
})

describe('each call: never to someone new', () => {
  const call = kindOfCall({ tool: 'create_calendar_event', input: { attendees: ['Dana@Example.com', 'lee@example.com'] } })

  it('every recipient known → no limit', () => {
    expect(callHitsHardLimit(call, new Set(['dana@example.com', 'lee@example.com']))).toBeNull()
  })

  it('one new recipient → new_recipient', () => {
    expect(callHitsHardLimit(call, new Set(['dana@example.com']))).toBe('new_recipient')
  })

  it('a lookup that found nothing (empty known set) → every recipient is new', () => {
    expect(callHitsHardLimit(call, new Set())).toBe('new_recipient')
  })

  it('a call to nobody passes the recipient check', () => {
    expect(callHitsHardLimit(kindOfCall({ tool: 'push_action_to_linear', input: { action_id: 'a1' } }), new Set())).toBeNull()
  })

  it('a limited kind is limited on every call, known recipients or not', () => {
    const pay = kindOfCall({ tool: 'send_payment_link', input: { to: 'dana@example.com' } })
    expect(callHitsHardLimit(pay, new Set(['dana@example.com']))).not.toBeNull()
  })
})

it('every limit has the words the Settings list shows', () => {
  for (const words of Object.values(HARD_LIMIT_WORDS)) expect(words.length).toBeGreaterThan(10)
})
