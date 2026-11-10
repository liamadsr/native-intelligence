/**
 * The attended-only tools (bots v3 Phase 5: settle_card, revise_email_draft,
 * undo_extraction_pass; bots-v4 Phase A1: list_bot_work, get_bot_item; Phase
 * A2: settle_work_item, send_work_answer; remember, update_now, read_card; the
 * A1b loop builders; the skill writers create_skill, update_skill) are NEVER granted in
 * an unattended run. The plan's test is "missing in
 * unattended runs"; this file pins every unattended surface at once, plus the
 * four registries every new tool lands in.
 *
 *   unattended (never):  skill runs (any config, inherit-all included), work
 *                        runs (every origin, and a resume token), the live
 *                        agent, the device ask, a run's MCP token
 *   attended (by grant): a work run's follow-up CHAT turn holds its bot's grant
 *                        (ceilingForWorkRunTurn), capped by the edition and by
 *                        a delegating chat's bound; a person's own MCP connector
 *                        holds settle_card, revise_email_draft, the four
 *                        bot-work tools, remember, the loop builders and the
 *                        skill writers (a run's token holds none of them, nor
 *                        the hand-registered ni_*_skill and ni_*_agent
 *                        writers)
 *   the bot-work tools:  no bot is granted them, so no bot's chat, bot
 *                        conversation or run chat holds them either
 *                        (src/lib/ai/tools/__tests__/bot-work.test.ts pins those ceilings)
 *   the one exception:   the Now file's check-in (a home turn, reason
 *                        'check_in', in a fresh session of its own) holds
 *                        update_now, and only it, through the tool route's
 *                        one grant (docs/plans/now-file.md "Who may write the note")
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALL_CATEGORY_IDS,
  ATTENDED_ONLY_TOOL_NAMES,
  NON_CHAT_TOOL_NAMES,
  TOOL_REGISTRY_MAP,
  getMutatingToolNames,
  getToolDefinition,
  getToolSideEffect,
  isReadShapedToolName,
} from '../tool-registry'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import {
  ceilingForWorkRun,
  ceilingForWorkRunTurn,
  computeDraftingCeiling,
  computeWorkRunCeiling,
  followThroughWithinChatBound,
  type WorkRunRow,
} from '@/lib/agent-run/run-work-spec-rebuild'
import { EDITIONS, computeEditionToolCeiling, withEffectiveSurface } from '@/lib/editions'
import { offOverrides } from '@/test/editions'
import { computeLiveAgentCeiling, LIVE_AGENT_TURN_TYPES } from '@/lib/live-agent/ceiling'
import { LIVE_AGENT_READ_TOOLS } from '@/lib/live-agent/read-tool-names'
import { SURFACE_EXCLUDED_TOOLS, serverTurnMayCall } from '@/lib/chat/chat-ceiling'
import { callerMayCall } from '@/lib/safety/caller'
import { checkInNowGrant } from '@/lib/now/now-context'
import { followThroughFor } from '@/lib/chat/follow-through'
import { SYSTEM_TEAMMATE_KEYS } from '@/lib/work/system-teammates'
import { mcpWithheldAttendedTools } from '@/lib/mcp/attended-tools'

const ATTENDED = [...ATTENDED_ONLY_TOOL_NAMES]
/** The bots v3 Phase 5 writes. */
const WRITES = ['settle_card', 'revise_email_draft', 'undo_extraction_pass']
/** The main agent's reads of the bots' work (bots-v4 Phase A1). */
const BOT_WORK_READS = ['list_bot_work', 'get_bot_item']
/** The main agent's writes on the bots' work (bots-v4 Phase A2). */
const BOT_WORK_WRITES = ['settle_work_item', 'send_work_answer']
/** The main agent manages the agents themselves (GEN-1168): rename, delete and merge, the last two from the person's card. */
const BOT_MANAGERS = ['rename_bot', 'delete_bot', 'merge_bots']
/** The main agent's memory (one-agent plan Part 3, migration 317). */
const MEMORY = ['remember']
/** The person's Now file, the main agent's sketchpad (docs/plans/now-file.md, migration 440). */
const NOW = ['update_now']
/** Getting started (docs/plans/getting-started-skill.md): only the person's own turn ends it. */
const GETTING_STARTED = ['finish_getting_started']
/** The card reader (pages in the chat): what a card on the person's screen shows now. */
const CARD_READS = ['read_card']
/** The loop builders (A1b review H1): no unattended run builds, re-aims, switches on or deletes a loop. */
const LOOP_BUILDERS = ['create_flow', 'update_flow', 'delete_flow', 'transfer_flow_owner', 'request_flow_takeover', 'test_flow']
/** The skill writers: no unattended run saves injected text as a skill the main agent later follows. */
const SKILL_WRITERS = ['create_skill', 'update_skill']
/** Documents phase 1: putting an earlier version of a document back; canon D2: undoing one edit of it. */
const DOCUMENT_RESTORE = ['restore_document_revision', 'revert_section_edit']
/** GEN-1169: deleting a document for good, only on the person's card (an unattended run archives instead). */
const DOCUMENT_DELETE = ['delete_document']
/** Flows-connectors F2: the person's connections, in the core Skills & Agents group. */
const CONNECTIONS = ['list_connections', 'connect', 'disconnect', 'set_tool_access']
/**
 * Content C0: the fresh-eyes review of a post, whose writer only the chat's
 * envelope names. In the NEW content category, granted to the main chat by the
 * core feature; no persona needs it (a teammate chat checks posts with
 * lint_post, which needs no grant).
 */
const POST_REVIEW = ['review_post']
/** C2a (P9): posting through the person's Typefully, only on their approval card. */
const POST_SEND = ['publish_post', 'schedule_post']
/**
 * GEN-1166: the inbox triage. update_email_thread sorts the person's own
 * mailbox (reversible) while they look; unsubscribe_thread goes out only on
 * their approval card.
 */
const MAIL_TRIAGE = ['update_email_thread', 'unsubscribe_thread']
/** GEN-1165: discarding drafts Native Intelligence wrote, from the mailbox and Native Intelligence, at the person's word (no bot is granted it). */
const DRAFT_DISCARD = ['discard_email_draft']
/** Roadmap B: what the business's customers are told, and its website form's secret link, change only at the person's word. */
const BUSINESS_SETUP = ['update_business_profile', 'create_quote_form_link']
const root = join(__dirname, '..', '..', '..', '..')

describe('the attended-only set', () => {
  it('is exactly the three Phase 5 writes, the two A1 reads, the two A2 writes, remember, update_now, the card reader, the loop builders, the skill writers and the document restore, each a registry tool in an EXISTING category (no persona-grant migration)', () => {
    expect([...ATTENDED].sort()).toEqual(
      [...WRITES, ...BOT_WORK_READS, ...BOT_WORK_WRITES, ...BOT_MANAGERS, ...MEMORY, ...NOW, ...GETTING_STARTED, ...CARD_READS, ...LOOP_BUILDERS, ...SKILL_WRITERS, ...DOCUMENT_RESTORE, ...DOCUMENT_DELETE, ...CONNECTIONS, ...POST_REVIEW, ...POST_SEND, ...MAIL_TRIAGE, ...DRAFT_DISCARD, ...BUSINESS_SETUP].sort(),
    )
    for (const name of BUSINESS_SETUP) {
      expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('contacts')
      expect(getToolSideEffect(name), name).toBe('internal-write')
    }
    for (const name of MAIL_TRIAGE) {
      expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('emails')
      expect(getMutatingToolNames().has(name), name).toBe(true)
    }
    expect(getToolSideEffect('update_email_thread')).toBe('internal-write')
    // External: the outward gate (which holds it as the person's card) only sees risky calls.
    expect(getToolSideEffect('unsubscribe_thread')).toBe('external-write')
    // A delete (the mailbox's draft and Native Intelligence's row), read as a write by name.
    expect(TOOL_REGISTRY_MAP.get('discard_email_draft')?.category.id).toBe('emails')
    expect(getToolSideEffect('discard_email_draft')).toBe('delete')
    expect(getMutatingToolNames().has('discard_email_draft')).toBe(true)
    expect(isReadShapedToolName('discard_email_draft')).toBe(false)
    for (const name of POST_REVIEW) {
      expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('content')
      expect(getToolSideEffect(name), name).toBe('read')
    }
    for (const name of POST_SEND) {
      expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('content')
      expect(getToolSideEffect(name), name).toBe('external-write')
      expect(getMutatingToolNames().has(name), name).toBe(true)
    }
    for (const name of CONNECTIONS) expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('library')
    for (const name of DOCUMENT_RESTORE) {
      expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('documents')
      expect(getToolSideEffect(name), name).toBe('internal-write')
      expect(getToolDefinition(name)?.writeTarget, name).toBe('artifact')
      expect(getMutatingToolNames().has(name), name).toBe(true)
    }
    for (const name of DOCUMENT_DELETE) {
      expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('documents')
      expect(getToolSideEffect(name), name).toBe('delete')
      expect(getMutatingToolNames().has(name), name).toBe(true)
    }
    for (const name of LOOP_BUILDERS) expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('flows')
    for (const name of SKILL_WRITERS) expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('library')
    // In the core Skills & Agents group, so no edition or persona loses it, and of no area (calling it loads no pack).
    expect(TOOL_REGISTRY_MAP.get('remember')?.category.id).toBe('library')
    expect(TOOL_REGISTRY_MAP.get('update_now')?.category.id).toBe('library')
    expect(TOOL_REGISTRY_MAP.get('read_card')?.category.id).toBe('dashboard')
    expect(getToolSideEffect('read_card')).toBe('read')
    expect(TOOL_REGISTRY_MAP.get('settle_card')?.category.id).toBe('actions')
    for (const name of [...BOT_WORK_READS, ...BOT_WORK_WRITES, ...BOT_MANAGERS]) expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('actions')
    expect(TOOL_REGISTRY_MAP.get('revise_email_draft')?.category.id).toBe('emails')
    expect(TOOL_REGISTRY_MAP.get('undo_extraction_pass')?.category.id).toBe('captures')
  })

  it('each write is classified as the write it is, and read as a write by name (report mode can never reach one)', () => {
    expect(getToolSideEffect('settle_card')).toBe('automation-write')
    expect(getToolSideEffect('revise_email_draft')).toBe('internal-write')
    expect(getToolSideEffect('undo_extraction_pass')).toBe('delete')
    const mutating = getMutatingToolNames()
    for (const name of WRITES) {
      expect(mutating.has(name), name).toBe(true)
      expect(isReadShapedToolName(name), name).toBe(false)
    }
  })

  it('the agent managers are writes: a rename an automation write, a delete and a merge deletes; each by name too', () => {
    expect(getToolSideEffect('rename_bot')).toBe('automation-write')
    expect(getToolSideEffect('delete_bot')).toBe('delete')
    expect(getToolSideEffect('merge_bots')).toBe('delete')
    const mutating = getMutatingToolNames()
    for (const name of BOT_MANAGERS) {
      expect(mutating.has(name), name).toBe(true)
      expect(isReadShapedToolName(name), name).toBe(false)
    }
  })

  it('the two A2 writes are writes: by class (an internal write to the person\'s own ledger row; a resume that runs staged work) and by name', () => {
    expect(getToolSideEffect('settle_work_item')).toBe('internal-write')
    expect(getToolDefinition('settle_work_item')?.writeTarget).toBe('board')
    expect(getToolSideEffect('send_work_answer')).toBe('automation-write')
    const mutating = getMutatingToolNames()
    for (const name of BOT_WORK_WRITES) {
      expect(mutating.has(name), name).toBe(true)
      expect(isReadShapedToolName(name), name).toBe(false)
    }
  })

  it('remember is an artifact write (the note, reviewed in its editor), and read as a write though its name has no write verb', () => {
    expect(getToolSideEffect('remember')).toBe('internal-write')
    expect(getToolDefinition('remember')?.writeTarget).toBe('artifact')
    expect(getMutatingToolNames().has('remember')).toBe(true)
    expect(isReadShapedToolName('remember')).toBe(false)
  })

  it('update_now is an artifact write (the person’s private note, with its history), and a write by name (update_)', () => {
    expect(getToolSideEffect('update_now')).toBe('internal-write')
    expect(getToolDefinition('update_now')?.writeTarget).toBe('artifact')
    expect(getToolDefinition('update_now')?.label).toBe('Now')
    expect(getMutatingToolNames().has('update_now')).toBe(true)
    expect(isReadShapedToolName('update_now')).toBe(false)
  })

  it('the skill writers are automation writes, by class and by name; the library reads stay reads and stay unattended-reachable', () => {
    const mutating = getMutatingToolNames()
    for (const name of SKILL_WRITERS) {
      expect(getToolSideEffect(name), name).toBe('automation-write')
      expect(mutating.has(name), name).toBe(true)
      expect(isReadShapedToolName(name), name).toBe(false)
    }
    for (const name of ['list_skills', 'get_skill', 'list_agents', 'get_agent']) {
      expect(getToolSideEffect(name), name).toBe('read')
      expect(ATTENDED_ONLY_TOOL_NAMES.has(name), name).toBe(false)
    }
  })

  it('the two bot-work reads stay reads: by class and by name (mutating-tools)', () => {
    const mutating = getMutatingToolNames()
    for (const name of BOT_WORK_READS) {
      expect(getToolSideEffect(name), name).toBe('read')
      expect(isReadShapedToolName(name), name).toBe(true)
      expect(mutating.has(name), name).toBe(false)
    }
  })
})

describe('never in an unattended run', () => {
  it('skill runs: no config grants one, and inherit-all (NON_CHAT_TOOL_NAMES) leaves them out', () => {
    for (const name of ATTENDED) expect(NON_CHAT_TOOL_NAMES, name).not.toContain(name)
    const configs = [
      { enabled_tools: [...ALL_CATEGORY_IDS] },
      { enabled_tools: ['actions', 'emails', 'captures'] },
      { enabled_tools: ['actions'], output_contract: 'verdict' as const },
      null,
    ]
    for (const config of configs) {
      for (const mode of ['act', 'report'] as const) {
        const ceiling = computeSkillCeiling(config, mode, true)
        for (const name of ATTENDED) expect(ceiling?.has(name) ?? false, `${name} ${mode} ${JSON.stringify(config)}`).toBe(false)
      }
    }
  })

  it('work runs: every origin, the drafting profile, and a teammate whose bounds admit every class', () => {
    const wide = { allowed_side_effects: ['read', 'internal-write', 'automation-write', 'external-write', 'delete'], tool_allowlist: null }
    const ceilings = [
      computeWorkRunCeiling(),
      computeDraftingCeiling(),
      ...[null, 'user', 'attempt', 'chat', 'delegation', 'loop'].map((origin) => ceilingForWorkRun(origin, wide, null)),
    ]
    for (const c of ceilings) for (const name of ATTENDED) expect(c.has(name), name).toBe(false)
  })

  it('a work run’s own token and its resume token get the run’s ceiling, never a grant', async () => {
    const run: WorkRunRow = { id: 'run-1', kind: 'workspace', origin: 'user', ai_team_member_id: 'tm-1', teammate: null }
    const granting = grantingClient('mail')
    for (const claims of [{ workspaceId: 'ws' }, { workspaceId: 'ws', resume: true as const }]) {
      const c = await ceilingForWorkRunTurn(granting, run, claims)
      for (const name of ATTENDED) expect(c.has(name), name).toBe(false)
    }
  })

  it('the live agent: no turn type or persona reaches one, and the READ allowlist holds none', () => {
    for (const name of ATTENDED) expect(LIVE_AGENT_READ_TOOLS.has(name), name).toBe(false)
    for (const turnType of LIVE_AGENT_TURN_TYPES) {
      for (const agentConfig of [null, { enabled_tools: [...ALL_CATEGORY_IDS] }]) {
        const { ceiling } = computeLiveAgentCeiling({ turnType, assistOnly: false, agentConfig })
        for (const name of ATTENDED) expect(ceiling.has(name), `${turnType} ${name}`).toBe(false)
        // Nor the page tool: the live agent draws no cards in the meeting.
        expect(ceiling.has('show'), `${turnType} show`).toBe(false)
      }
    }
  })

  it('the device ask (an unattended task session) excludes every one structurally', () => {
    for (const name of ATTENDED) expect(SURFACE_EXCLUDED_TOOLS.device_ask.has(name), name).toBe(true)
  })

  it('home turns: every reason refuses them all, but the check-in may hold update_now (and only it), through the one grant', () => {
    // The trust authority: a home turn is unattended; the grant is what lets the check-in's call run.
    expect(callerMayCall('agent_unattended', 'update_now')).toBe(false)
    expect(callerMayCall('agent_unattended', 'update_now', { granted: true })).toBe(true)
    for (const reason of ['helper_report', 'event', 'digest', 'guest_ask', 'agent_answer', undefined] as const) {
      for (const name of ATTENDED) expect([reason, name, serverTurnMayCall(name, 'home_turn', reason)]).toEqual([reason, name, false])
    }
    for (const name of ATTENDED) expect([name, serverTurnMayCall(name, 'home_turn', 'check_in')]).toEqual([name, NOW.includes(name)])
    // The grant is the check-in's own update_now call, nothing else.
    const checkIn = { conversationId: 'c', workspaceId: 'w', userId: 'u', exp: 1, server: 'home_turn' as const, homeTurnReason: 'check_in' as const }
    expect(checkInNowGrant(checkIn, 'update_now', {})).toBe(true)
    expect(checkInNowGrant(checkIn, 'update_now', { helper: true })).toBe(false)
    for (const name of ATTENDED.filter((n) => !NOW.includes(n))) expect([name, checkInNowGrant(checkIn, name, {})]).toEqual([name, false])
    expect(checkInNowGrant({ ...checkIn, homeTurnReason: 'event' }, 'update_now', {})).toBe(false)
    expect(checkInNowGrant({ conversationId: 'c', workspaceId: 'w', userId: 'u', exp: 1 }, 'update_now', {})).toBe(false)
  })

  it('a skill run whose skill selects the flows tools, in act mode, still holds no loop builder (an injected email or capture can’t make one)', () => {
    for (const config of [{ enabled_tools: ['flows'] }, { enabled_tools: ['flows', 'actions'] }, null]) {
      const ceiling = computeSkillCeiling(config, 'act', false)
      for (const name of LOOP_BUILDERS) expect(ceiling?.has(name) ?? NON_CHAT_TOOL_NAMES.includes(name), `${name} ${JSON.stringify(config)}`).toBe(false)
    }
    // The read stays: a skill can still list loops and their runs.
    expect(computeSkillCeiling({ enabled_tools: ['flows'] }, 'act', false)?.has('list_flows')).toBe(true)
  })

  it('a skill run whose skill selects the library tools, in act mode, still holds no skill writer (an injected email or capture can’t persist itself as a skill)', () => {
    // The `create-skill` system skill's and the library playbook's own config (migrations 225, 319).
    const configs = [{ enabled_tools: ['library'] }, { enabled_tools: ['library', 'actions'] }, { enabled_tools: [...ALL_CATEGORY_IDS] }, null]
    for (const config of configs) {
      const ceiling = computeSkillCeiling(config, 'act', false)
      for (const name of SKILL_WRITERS) expect(ceiling?.has(name) ?? NON_CHAT_TOOL_NAMES.includes(name), `${name} ${JSON.stringify(config)}`).toBe(false)
    }
    // The reads stay: a skill can still list and read skills and agents.
    const library = computeSkillCeiling({ enabled_tools: ['library'] }, 'act', false)
    for (const name of ['list_skills', 'get_skill', 'list_agents', 'get_agent']) expect(library?.has(name), name).toBe(true)
  })

  it('work runs hold no skill writer, even a teammate whose bounds admit automation writes, and its resume token neither', async () => {
    const wide = { allowed_side_effects: ['read', 'internal-write', 'automation-write', 'external-write', 'delete'], tool_allowlist: null }
    for (const origin of [null, 'user', 'attempt', 'chat', 'delegation', 'loop']) {
      const c = ceilingForWorkRun(origin, wide, null)
      for (const name of SKILL_WRITERS) expect(c.has(name), `${origin} ${name}`).toBe(false)
    }
    const run: WorkRunRow = { id: 'run-1', kind: 'workspace', origin: 'user', ai_team_member_id: 'tm-1', teammate: null }
    for (const claims of [{ workspaceId: 'ws' }, { workspaceId: 'ws', resume: true as const }, { workspaceId: 'ws', chat: true as const }]) {
      const c = await ceilingForWorkRunTurn(grantingClient('captures'), run, claims)
      for (const name of SKILL_WRITERS) expect(c.has(name), `${JSON.stringify(claims)} ${name}`).toBe(false)
    }
  })

  it('no bot is granted a skill writer: no system key, role or triage loop earns one, so no bot’s chat holds it', () => {
    for (const systemKey of [...SYSTEM_TEAMMATE_KEYS, null]) {
      for (const role of [null, 'correspondent', 'researcher', 'developer']) {
        for (const frontsTriageLoop of [false, true]) {
          const grant = followThroughFor({ systemKey, role, frontsTriageLoop })
          for (const name of SKILL_WRITERS) expect(grant.has(name), `${systemKey} ${role} ${frontsTriageLoop} ${name}`).toBe(false)
        }
      }
    }
  })

  it('a person’s own connector gets settle_card, revise_email_draft, the bot-work tools, remember, the loop builders and the skill writers, not the undo or the card reader', () => {
    // A connector has no cards on screen: read_card would only ever say so.
    // connect (F2): its Connect card is a chat card no MCP client draws.
    // review_post (content C0): an MCP client's model is unknown, so no reviewer of another vendor can be picked.
    // publish_post / schedule_post (C2a): a post goes out only on the person's card in the app.
    // update_now (docs/plans/now-file.md): the person's Now file is written only from their chat in the app.
    // finish_getting_started (docs/plans/getting-started-skill.md): getting started is the app's chat's.
    // unsubscribe_thread (GEN-1166): likewise only on their card; update_email_thread is theirs to call.
    expect(mcpWithheldAttendedTools()).toEqual(['undo_extraction_pass', 'update_now', 'finish_getting_started', 'read_card', 'connect', 'disconnect', 'set_tool_access', 'review_post', 'publish_post', 'schedule_post', 'unsubscribe_thread'])
  })
})

describe('attended: a work run’s follow-up chat turn holds its bot’s grant', () => {
  it('a chat token adds the bot’s follow-through grant to the run’s own ceiling (a superset of it)', async () => {
    const run: WorkRunRow = { id: 'run-1', kind: 'workspace', origin: 'user', ai_team_member_id: 'tm-1', teammate: null }
    const chat = await ceilingForWorkRunTurn(grantingClient('mail'), run, { workspaceId: 'ws', chat: true })
    expect(chat.has('revise_email_draft')).toBe(true)
    expect(chat.has('settle_card')).toBe(false)
    for (const name of computeWorkRunCeiling()) expect(chat.has(name), name).toBe(true)
    // A run with no bot: nothing granted.
    const none = await ceilingForWorkRunTurn(grantingClient('mail'), { ...run, ai_team_member_id: null }, { workspaceId: 'ws', chat: true })
    for (const name of ATTENDED) expect(none.has(name), name).toBe(false)
  })

  it('the grant is capped by the workspace’s edition', async () => {
    // A workspace with email switched off: every edition has every feature, so
    // an override is the only way a real workspace loses the email tools.
    const settings = { edition: 'full', feature_overrides: offOverrides(['email']) }
    expect(
      computeEditionToolCeiling(withEffectiveSurface(EDITIONS.full, settings.feature_overrides))?.has('revise_email_draft'),
      'email off must withhold the email tools',
    ).toBe(false)
    const run: WorkRunRow = { id: 'run-1', kind: 'workspace', origin: 'user', ai_team_member_id: 'tm-1', teammate: null }
    const chat = await ceilingForWorkRunTurn(grantingClient('mail', settings), run, { workspaceId: 'ws', chat: true })
    expect(chat.has('revise_email_draft')).toBe(false)
  })

  it('on work a chat handed over, the grant stays within that chat’s bound', async () => {
    const run: WorkRunRow = { id: 'run-1', kind: 'workspace', origin: 'chat', ai_team_member_id: 'tm-1', teammate: null }
    const without = await ceilingForWorkRunTurn(grantingClient('mail'), { ...run, chat_ceiling: ['list_actions'] }, { workspaceId: 'ws', chat: true })
    expect(without.has('revise_email_draft')).toBe(false)
    const withDrafts = await ceilingForWorkRunTurn(grantingClient('mail'), { ...run, chat_ceiling: ['create_email_draft'] }, { workspaceId: 'ws', chat: true })
    expect(withDrafts.has('revise_email_draft')).toBe(true)
    // No drafting counterpart: withheld on chat-bounded work (fail closed).
    expect(followThroughWithinChatBound('settle_card', new Set(computeDraftingCeiling()))).toBe(false)
    expect(followThroughWithinChatBound('undo_extraction_pass', new Set(computeDraftingCeiling()))).toBe(false)
  })
})

describe('the four registries', () => {
  it('the chat’s friendly labels name each tool (prompt-kit/tool.tsx)', () => {
    const labels = readFileSync(join(root, 'src/components/prompt-kit/tool.tsx'), 'utf8')
    for (const name of ATTENDED) expect(labels, name).toMatch(new RegExp(`\\b${name}: '`))
  })

  it('the library picker never lists them (no skill run can call one)', () => {
    const picker = readFileSync(join(root, 'src/app/account/(dashboard)/views/agents/item-dialogs.tsx'), 'utf8')
    expect(picker).toMatch(/!isAttendedOnlyTool\(t\.name\)/)
  })
})

/** A service-client double whose bot is the system teammate `key` (and fronts no loop). */
function grantingClient(key: string, workspaceSettings: Record<string, unknown> | null = null) {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.limit = () => c
    c.maybeSingle = async () => ({
      data:
        table === 'ai_team_member'
          ? { system_key: key, role: null }
          : table === 'workspace' && workspaceSettings
            ? { settings: workspaceSettings }
            : null,
      error: null,
    })
    c.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
    return c
  }
  return { from: (t: string) => chain(t) } as never
}
