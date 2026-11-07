/**
 * The chat's ONE effective-ceiling computation (src/lib/chat/chat-ceiling.ts).
 *
 * Pins:
 *   1. the composition: (edition ∩ agent) ∪ external-MCP names; null only when
 *      BOTH sides impose no limit; `[]`-shaped results never masquerade as null;
 *   2. the agent half keeps the canonical present-but-empty [] → core-only
 *      semantics (never inherit-all);
 *   3. STRUCTURE: the advertise half (chat-run-rebuild.ts) and the enforce half
 *      (/api/internal/chat/tool) both call resolveChatCeiling and neither
 *      re-implements the intersection — the drift this module exists to end —
 *      /api/device/ask computes no ceiling of its own at all (it runs on these
 *      two halves as an eve task session) — AND both eve halves reach the AGENT
 *      half through agentCeilingFromConfig (the spec side via
 *      buildChatSystemPrompt, the enforce side via resolveAgentToolCeiling);
 *      neither calls computeToolCeiling itself.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import {
  agentCeilingFromConfig,
  composeChatCeiling,
  composeTeammateChatCeiling,
  resolveAgentToolCeiling,
  resolveChatCeiling,
  resolveTeammateChatBounds,
  resolveTeammateChatCeiling,
  SURFACE_EXCLUDED_TOOLS,
  CHANNEL_TURN_NATIVE_TOOLS,
  DEVICE_ONLY_EXCLUSIONS,
  TEAMMATE_CHAT_EXCLUDED_TOOLS,
  isToolExcludedForSurface,
  surfaceExternalToolNames,
  teammateChatBoundsFromRow,
  teammatePersonaCeiling,
  TEAMMATE_CHAT_BOUNDS_SELECT,
  WORK_BOT_PROPOSE_TOOLS,
  serverTurnMayCall,
  type TeammateChatBounds,
} from '../chat-ceiling'
import { ALL_TOOL_NAMES, getToolDefinition } from '@/lib/ai/tool-registry'
import { CORE_TOOL_NAMES, computeToolCeiling } from '@/lib/ai/tool-ceiling-core'
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'
import { computeEditionToolCeiling, EDITIONS, withEffectiveSurface } from '@/lib/editions'
import { offOverrides } from '@/test/editions'

const repoRoot = resolve(__dirname, '../../../..')

/** A supabase stub whose maybeSingle resolves per table. */
function stubSupabase(rows: { recipe?: unknown; workspace?: unknown }) {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq']) c[m] = () => c
    c.maybeSingle = async () => ({ data: (rows as Record<string, unknown>)[table] ?? null, error: null })
    return c
  }
  return { from: (t: string) => chain(t) } as never
}

describe('composeChatCeiling', () => {
  it('null when neither the edition nor the agent limits (inherit-all)', () => {
    expect(composeChatCeiling(null, null, ['mcp__x__y'])).toBeNull()
  })

  it('edition only → edition ∪ external', () => {
    const out = composeChatCeiling(new Set(['a', 'b']), null, ['mcp__x__y'])
    expect(out).toEqual(new Set(['a', 'b', 'mcp__x__y']))
  })

  it('agent only → agent ∪ external ∪ read_chat_file', () => {
    const out = composeChatCeiling(null, new Set(['a']), ['mcp__x__y'])
    expect(out).toEqual(new Set(['a', 'mcp__x__y', 'read_chat_file']))
  })

  it('the chat’s own uploads stay readable whatever a persona allows (a photo is seen only through read_chat_file), within the edition', () => {
    expect(composeChatCeiling(new Set(['a', 'read_chat_file']), new Set(['a']), [])).toEqual(new Set(['a', 'read_chat_file']))
    // An edition without it still caps it, as it does every tool.
    expect(composeChatCeiling(new Set(['a']), new Set(['a']), [])).toEqual(new Set(['a']))
  })

  it('both → the INTERSECTION, then ∪ external (an agent cannot widen the edition)', () => {
    const out = composeChatCeiling(new Set(['a', 'b']), new Set(['b', 'c']), ['mcp__x__y'])
    expect(out).toEqual(new Set(['b', 'mcp__x__y']))
  })

  it('an empty intersection is an EMPTY set (+ external), never null', () => {
    const out = composeChatCeiling(new Set(['a']), new Set(['b']), [])
    expect(out).toEqual(new Set())
  })
})

describe('resolveAgentToolCeiling', () => {
  it('no agent → null (no query needed)', async () => {
    expect(await resolveAgentToolCeiling(stubSupabase({}), undefined)).toBeNull()
  })

  it('unknown / non-agent id → null', async () => {
    expect(await resolveAgentToolCeiling(stubSupabase({ recipe: null }), 'ag-x')).toBeNull()
  })

  it('a present-but-empty enabled list is core-only, NEVER inherit-all', async () => {
    const out = await resolveAgentToolCeiling(
      stubSupabase({ recipe: { agent_config: { enabled_tools: [], disabled_tools: [] } } }),
      'ag-1',
    )
    expect(out).not.toBeNull()
    for (const core of CORE_TOOL_NAMES) expect(out!.has(core)).toBe(true)
  })
})

describe('agentCeilingFromConfig (the ONE agent_config → ceiling step)', () => {
  it('every category enabled, nothing disabled → inherit-all (null)', () => {
    expect(agentCeilingFromConfig({ enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: [] })).toBeNull()
  })

  it('absent / null config or keys → exactly what computeToolCeiling gives undefined arrays', () => {
    const expected = computeToolCeiling(undefined, undefined)
    expect(agentCeilingFromConfig(null)).toEqual(expected)
    expect(agentCeilingFromConfig(undefined)).toEqual(expected)
    expect(agentCeilingFromConfig({ enabled_tools: null, disabled_tools: null })).toEqual(expected)
  })

  it('a present-but-empty enabled list is core-only, NEVER inherit-all', () => {
    const out = agentCeilingFromConfig({ enabled_tools: [] })
    expect(out).not.toBeNull()
    for (const core of CORE_TOOL_NAMES) expect(out!.has(core)).toBe(true)
  })

  it('passes the arrays through to computeToolCeiling unchanged', () => {
    const cfg = { enabled_tools: ['actions'], disabled_tools: ['create_action'] }
    expect(agentCeilingFromConfig(cfg)).toEqual(computeToolCeiling(['actions'], ['create_action']))
  })
})

describe('resolveChatCeiling', () => {
  it('a workspace with nothing switched off is inherit-all (null)', async () => {
    const out = await resolveChatCeiling(stubSupabase({ workspace: { settings: null } }), {
      workspaceId: 'ws-1',
      agentToolCeiling: null,
      externalMcpToolNames: ['mcp__x__y'],
    })
    expect(out).toBeNull()
  })

  it('composes the workspace’s own settings (a feature off) with the agent half + external', async () => {
    const overrides = offOverrides(['email'])
    const edition = computeEditionToolCeiling(withEffectiveSurface(EDITIONS.full, overrides))
    const out = await resolveChatCeiling(stubSupabase({ workspace: { settings: { feature_overrides: overrides } } }), {
      workspaceId: 'ws-1',
      agentToolCeiling: null,
      externalMcpToolNames: ['mcp__x__y'],
    })
    expect(out).toEqual(composeChatCeiling(edition, null, ['mcp__x__y']))
    expect(out!.has('list_emails')).toBe(false)
    expect(out!.has('mcp__x__y')).toBe(true)
  })
})

describe('surface exclusions (structural, keyed on the verified token surface)', () => {
  it('device_ask can never reach mcp_confirm_call (nobody on the device can approve)', () => {
    expect([...SURFACE_EXCLUDED_TOOLS.device_ask]).toEqual([
      'mcp_confirm_call',
      // The chat-native tools: start_helper, stop_helper, and the main agent's relay to the
      // bots (bots-v4 Phase A3), which only the main chat runs.
      'start_helper',
      'stop_helper',
      'send_bot_message',
      'wait_for_bot_reply',
      // The local agents on the person's Mac (docs/plans/local-agents.md): chat-native too.
      'local_agents',
      'start_local_agent',
      'message_local_agent',
      'read_local_agent',
      'stop_local_agent',
      // …and their cloud counterpart (docs/plans/environments.md E2).
      'start_cloud_coding_run',
      // The main agent's answer to a guest's ask (guest access): chat-native too.
      'answer_guest',
      // The main agent asking a linked person's agent (agent links): chat-native too.
      'ask_agent',
      // A bot's attended-only writes (bots v3 Phase 5): nobody is on the device to have asked.
      'settle_card',
      'revise_email_draft',
      // Discarding drafts Dial8 wrote (GEN-1165): attended only too.
      'discard_email_draft',
      'undo_extraction_pass',
      // The main agent's reads of the bots' work (bots-v4 Phase A1): attended only too.
      'list_bot_work',
      'get_bot_item',
      // ... and its writes on that work (bots-v4 Phase A2).
      'settle_work_item',
      'send_work_answer',
      // ... and its management of the bots themselves (GEN-1168).
      'rename_bot',
      'delete_bot',
      'merge_bots',
      // ... and its memory (one-agent plan Part 3): only the person says what to remember.
      'remember',
      // ... and the person's Now file (docs/plans/now-file.md): written only in their own chat.
      'update_now',
      // ... and getting started (docs/plans/getting-started-skill.md): ended only in their own chat.
      'finish_getting_started',
      // The card reader (pages in the chat): the device draws no cards.
      'read_card',
      // The loop builders (A1b): nobody on the device to say yes to a loop.
      'create_flow',
      'update_flow',
      'delete_flow',
      'transfer_flow_owner',
      'request_flow_takeover',
      'test_flow',
      // The skill writers: a device ask reading injected text must not save it as a skill.
      'create_skill',
      'update_skill',
      // Rolling a document back to an earlier version is the person's call (documents phase 1).
      'restore_document_revision',
      // ... or undo just one edit to it (canon D2).
      'revert_section_edit',
      // Deleting a document for good (GEN-1169): only on the person's card in their chat.
      'delete_document',
      // The person's connections (F2): listed, connected and loosened only in their own chat.
      'list_connections',
      'connect',
      'disconnect',
      'set_tool_access',
      // The post review (content C0): the chat names the writer's model; the device doesn't.
      'review_post',
      // Posting through Typefully (C2a): only on the person's approval card in their chat.
      'publish_post',
      'schedule_post',
      // The inbox triage (GEN-1166): sorted while the person looks; unsubscribing only on their card.
      'update_email_thread',
      'unsubscribe_thread',
      // What the business's customers are told, and its website form's link (roadmap B): only in the owner's own chat.
      'update_business_profile',
      'create_quote_form_link',
      // ... nor puts one up: show and read_card both stay off the device.
      'show',
      // A contact's web enrichment waits up to 45 s: more than a 60 s device ask can hold.
      'enrich_contact',
    ])
    expect(isToolExcludedForSurface('show', 'device_ask')).toBe(true)
    expect(isToolExcludedForSurface('mcp_confirm_call', 'device_ask')).toBe(true)
    expect(isToolExcludedForSurface('mcp__jira__create_issue', 'device_ask')).toBe(false)
  })

  it('sms (a text the person sent the Dial8 number) excludes everything the device ask does, plus the desktop browser and the JWT tools', () => {
    // All but the chat-native tools a text keeps (Liam, 2026-10-26): background helpers and messages to another person's agent.
    // …and all but the ones held off the device for its 60 s budget alone (DEVICE_ONLY_EXCLUSIONS).
    for (const name of SURFACE_EXCLUDED_TOOLS.device_ask) {
      expect([name, SURFACE_EXCLUDED_TOOLS.sms.has(name)]).toEqual([name, !CHANNEL_TURN_NATIVE_TOOLS.has(name) && !DEVICE_ONLY_EXCLUSIONS.includes(name)])
    }
    // Nobody's desktop on the other end of a text, and a server token carries no JWT.
    for (const name of ['generate_email_drafts', 'draft_followup_email']) expect(isToolExcludedForSurface(name, 'sms')).toBe(true)
    const browserTools = [...SURFACE_EXCLUDED_TOOLS.sms].filter((n) => !SURFACE_EXCLUDED_TOOLS.device_ask.has(n) && !n.includes('email'))
    expect(browserTools.length).toBeGreaterThan(0)
    for (const name of browserTools) expect(getToolDefinition(name)).toBeTruthy()
    // No cards, no pickers' confirm, no relay to the bots on a phone.
    for (const name of ['show', 'read_card', 'mcp_confirm_call', 'send_bot_message', 'settle_card', 'remember']) {
      expect([name, isToolExcludedForSurface(name, 'sms')]).toEqual([name, true])
    }
    // A background helper and a message to another person's agent stay: their results follow the person back by text.
    for (const name of ['start_helper', 'stop_helper', 'ask_agent']) expect([name, isToolExcludedForSurface(name, 'sms')]).toEqual([name, false])
    // The person's ordinary tools stay: a text turn acts for them.
    for (const name of ['create_action', 'update_action', 'list_actions', 'search', 'create_email_draft']) {
      if (ALL_TOOL_NAMES.includes(name)) expect([name, isToolExcludedForSurface(name, 'sms')]).toEqual([name, false])
    }
    expect(isToolExcludedForSurface('mcp__jira__create_issue', 'sms')).toBe(false)
    expect(surfaceExternalToolNames(['mcp__jira__x', 'mcp_confirm_call'], 'sms')).toEqual(['mcp__jira__x'])
  })

  it('a text turn is not held to reads (serverTurnMayCall); an acting home turn acts on its own, a digest does not; idle compaction is still held to reads', () => {
    expect(serverTurnMayCall('create_action', 'channel_turn')).toBe(true)
    expect(serverTurnMayCall('create_action', 'home_turn', 'event')).toBe(true)
    expect(serverTurnMayCall('create_action', 'home_turn', 'digest')).toBe(false)
    expect(serverTurnMayCall('create_action', 'idle_compaction')).toBe(false)
    expect(serverTurnMayCall('list_actions', 'home_turn')).toBe(true)
  })

  it('no surface (the in-app chat) excludes nothing', () => {
    expect(isToolExcludedForSurface('mcp_confirm_call', undefined)).toBe(false)
    expect(surfaceExternalToolNames(['mcp__jira__x', 'mcp_confirm_call'], undefined)).toEqual(['mcp__jira__x', 'mcp_confirm_call'])
  })

  it('filters the external-MCP union both halves pass to resolveChatCeiling', () => {
    expect(surfaceExternalToolNames(['mcp__jira__x', 'mcp_confirm_call'], 'device_ask')).toEqual(['mcp__jira__x'])
  })

  it.each(['src/lib/chat/chat-run-rebuild.ts', 'src/app/api/internal/chat/tool/route.ts'])(
    '%s derives its external-MCP names through surfaceExternalToolNames(…, claims.surface)',
    (file) => {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src).toMatch(/surfaceExternalToolNames\(Object\.keys\(externalMcp\.tools\), claims\.surface\)/)
    },
  )
})

describe('one ceiling, two halves (structural)', () => {
  // The two eve halves. /api/device/ask (the ESP32 one-shot) runs on them as a
  // chat-agent task session with no agent → edition ∪ external.
  const SITES = ['src/lib/chat/chat-run-rebuild.ts', 'src/app/api/internal/chat/tool/route.ts']

  it.each(SITES)('%s computes its ceiling through resolveChatCeiling, never by hand', (file) => {
    const src = readFileSync(join(repoRoot, file), 'utf8')
    expect(src).toMatch(/resolveChatCeiling\(/)
    expect(src).not.toMatch(/intersectCeilings\(/)
    expect(src).not.toMatch(/computeEditionToolCeiling\(/)
  })

  // The AGENT half: the spec side computes it inside buildChatSystemPrompt, the
  // enforce side in the tool route. Both must go through agentCeilingFromConfig.
  const AGENT_SITES: Array<[string, RegExp]> = [
    ['src/lib/ai/chat-system-prompt.ts', /agentCeilingFromConfig\(/],
    ['src/app/api/internal/chat/tool/route.ts', /resolveAgentToolCeiling\(/],
    ['src/lib/chat/chat-run-rebuild.ts', /buildChatSystemPrompt\(/],
  ]
  it.each(AGENT_SITES)('%s reaches the agent ceiling through the shared helper, never computeToolCeiling', (file, via) => {
    const src = readFileSync(join(repoRoot, file), 'utf8')
    expect(src).toMatch(via)
    expect(src).not.toMatch(/computeToolCeiling\(/)
  })

  it('/api/device/ask builds no tool map or ceiling of its own (its tools are the eve halves above)', () => {
    const src = readFileSync(join(repoRoot, 'src/app/api/device/ask/route.ts'), 'utf8')
    expect(src).not.toMatch(/resolveChatCeiling\(|intersectCeilings\(|computeEditionToolCeiling\(|pickPermittedTools\(|createTools\(/)
  })

  it('resolveAgentToolCeiling itself delegates to agentCeilingFromConfig', () => {
    const src = readFileSync(join(repoRoot, 'src/lib/chat/chat-ceiling.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function resolveAgentToolCeiling'))
    expect(body).toMatch(/agentCeilingFromConfig\(/)
    expect(body).not.toMatch(/computeToolCeiling\(/)
  })
})

// ── Teammate chats (bots v2, decision 3) ──────────────────────────────────────
// teammateChatCeiling = narrowToTeammate(edition ∩ persona, bounds)
//                       − {start_helper, stop_helper, ask_user, mcp_confirm_call} ∪ {search_tools}
describe('composeTeammateChatCeiling', () => {
  const FULL = computeEditionToolCeiling(EDITIONS.full)
  const bounds = (b: Partial<TeammateChatBounds>): TeammateChatBounds => ({ agentConfig: null, ...b })
  const classOf = (name: string) => getToolDefinition(name)?.sideEffect
  const CORE_BOARD_WRITES = ['create_action', 'update_action', 'complete_action']

  it('a {read} SYSTEM teammate (no recipe config) gets reads only — no writes at all, core board writes included', () => {
    const out = composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: ['read'] }))
    for (const name of out) if (name !== 'search_tools') expect(classOf(name)).toBe('read')
    for (const write of CORE_BOARD_WRITES) expect(out.has(write)).toBe(false)
    expect(out.has('list_actions')).toBe(true)
    expect(out.has('find')).toBe(true)
    expect(out.has('search_tools')).toBe(true)
  })

  it('a role teammate with {read, internal-write} can draft (documents, email drafts) but not delete or write outside', () => {
    const out = composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: ['read', 'internal-write'] }))
    expect(out.has('create_document')).toBe(true)
    expect(out.has('create_email_draft')).toBe(true)
    expect(out.has('create_action')).toBe(true)
    expect(out.has('delete_action')).toBe(false)
    expect(out.has('push_action_to_linear')).toBe(false)
  })

  it('a persona with NO agent_config gets the registry (not core-only), narrowed by the bounds', () => {
    const out = composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: ['read'] }))
    // list_emails is a read outside CORE_TOOL_NAMES: the chat's agent half would
    // drop it for a null config (core-only), the teammate rule keeps it.
    expect(agentCeilingFromConfig(null)!.has('list_emails')).toBe(false)
    expect(out.has('list_emails')).toBe(true)
    expect(teammatePersonaCeiling(null)).toEqual(new Set(ALL_TOOL_NAMES))
    expect(teammatePersonaCeiling({ disabled_tools: ['list_emails'] }).has('list_emails')).toBe(false)
  })

  it('the bounds apply AFTER the persona half: a core-only persona ([] selected) on a {read} teammate keeps no core write', () => {
    // agentCeilingFromConfig({enabled_tools: []}) is CORE_TOOL_NAMES, board writes included.
    expect(agentCeilingFromConfig({ enabled_tools: [] })!.has('create_action')).toBe(true)
    const out = composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: ['read'], agentConfig: { enabled_tools: [] } }))
    for (const write of CORE_BOARD_WRITES) expect(out.has(write)).toBe(false)
    expect(out.has('list_actions')).toBe(true)
    // …and a core-only persona does not widen to the registry.
    expect(out.has('list_emails')).toBe(false)
  })

  it('a tool_allowlist narrows inside the classes', () => {
    const out = composeTeammateChatCeiling(
      FULL,
      bounds({ allowed_side_effects: ['read', 'internal-write'], tool_allowlist: ['find', 'create_document', 'delete_action'] }),
    )
    // read_chat_file stays: the chat's own uploads are always readable (it is
    // how the model sees a photo the person attached).
    expect(out).toEqual(new Set(['find', 'create_document', 'search_tools', 'read_chat_file']))
  })

  it('the edition still caps it (a tool outside the edition never comes back)', () => {
    const out = composeTeammateChatCeiling(new Set(['find', 'list_actions', 'create_document']), bounds({ allowed_side_effects: ['read'] }))
    expect(out).toEqual(new Set(['find', 'list_actions', 'search_tools']))
  })

  it('never a chat-native tool (start_helper, stop_helper, the relay to the bots, the local agents), ask_user or mcp_confirm_call — even for an automation-write teammate', () => {
    expect([...TEAMMATE_CHAT_EXCLUDED_TOOLS]).toEqual([
      'start_helper',
      'stop_helper',
      'send_bot_message',
      'wait_for_bot_reply',
      'local_agents',
      'start_local_agent',
      'message_local_agent',
      'read_local_agent',
      'stop_local_agent',
      'start_cloud_coding_run',
      'answer_guest',
      'ask_agent',
      'ask_user',
      'mcp_confirm_call',
    ])
    // A bot never calls back into the main agent or another bot (bots-v4 Phase A3).
    // The edition imposes no ceiling (every feature on), so these reach the
    // teammate filter and it alone takes them out.
    expect(FULL).toBeNull()
    const out = composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: ['read', 'internal-write', 'automation-write', 'external-write', 'delete'] }))
    for (const name of TEAMMATE_CHAT_EXCLUDED_TOOLS) expect(out.has(name)).toBe(false)
  })

  it('missing or malformed classes read as {read} (a bad row narrows, never widens)', () => {
    const out = composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: null }))
    for (const name of out) if (name !== 'search_tools') expect(classOf(name)).toBe('read')
  })
})

describe('resolveTeammateChatBounds / resolveTeammateChatCeiling', () => {
  function teammateSupabase(
    row: unknown,
    settings: unknown = null,
    reach: { team?: unknown; member?: unknown; team_member?: unknown } = { team: { is_private: false } },
  ) {
    const eqs: Array<[string, unknown]> = []
    const tables: string[] = []
    const chain = (table: string) => {
      tables.push(table)
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = (col: string, v: unknown) => (table === 'ai_team_member' && eqs.push([col, v]), c)
      c.maybeSingle = async () => ({
        data:
          table === 'workspace'
            ? { settings }
            : table === 'ai_team_member'
              ? row
              : ((reach as Record<string, unknown>)[table] ?? null),
        error: null,
      })
      return c
    }
    return { client: { from: (t: string) => chain(t) } as never, eqs, tables }
  }
  const ROW = { is_system: false, team_id: 'team-1', allowed_side_effects: ['read'], tool_allowlist: null }

  it('reads the bounds fenced to the workspace, and the persona config only from this workspace or a system recipe', async () => {
    const own = teammateSupabase({ ...ROW, agent: { agent_config: { enabled_tools: [] }, workspace_id: 'ws-1', is_system: false } })
    expect(await resolveTeammateChatBounds(own.client, 'ws-1', 'tm-1', 'user-1')).toEqual({
      allowed_side_effects: ['read'],
      tool_allowlist: null,
      agentConfig: { enabled_tools: [] },
    })
    expect(own.eqs).toEqual([['id', 'tm-1'], ['workspace_id', 'ws-1']])
    const foreign = teammateSupabase({ ...ROW, agent: { agent_config: { enabled_tools: [] }, workspace_id: 'ws-OTHER', is_system: false } })
    expect((await resolveTeammateChatBounds(foreign.client, 'ws-1', 'tm-1', 'user-1'))!.agentConfig).toBeNull()
  })

  it('the private-team rule for the token user: a seat on the team passes, an admin off it gets null bounds', async () => {
    const seated = teammateSupabase({ ...ROW, agent: null }, null, { team: { is_private: true }, member: { id: 'mem-1' }, team_member: { team_id: 'team-1' } })
    expect(await resolveTeammateChatBounds(seated.client, 'ws-1', 'tm-1', 'user-1')).not.toBeNull()
    expect(seated.tables).toEqual(['ai_team_member', 'team', 'member', 'team_member'])
    const offTeam = teammateSupabase({ ...ROW, agent: null }, null, { team: { is_private: true }, member: { id: 'mem-admin' }, team_member: null })
    expect(await resolveTeammateChatBounds(offTeam.client, 'ws-1', 'tm-1', 'user-admin')).toBeNull()
    // A system teammate is every member's (no team read).
    const system = teammateSupabase({ ...ROW, is_system: true, team_id: null, agent: null }, null, {})
    expect(await resolveTeammateChatBounds(system.client, 'ws-1', 'tm-1', 'user-1')).not.toBeNull()
    expect(system.tables).toEqual(['ai_team_member'])
  })

  it('a failed reach check fails closed (null bounds), never open', async () => {
    const client = {
      from: (table: string) => {
        const c: Record<string, unknown> = {}
        c.select = () => c
        c.eq = () => c
        c.maybeSingle = async () =>
          table === 'ai_team_member' ? { data: { ...ROW, agent: null }, error: null } : { data: null, error: { message: 'db down' } }
        return c
      },
    } as never
    expect(await resolveTeammateChatBounds(client, 'ws-1', 'tm-1', 'user-1')).toBeNull()
  })

  it('a teammate that is gone → null bounds → an EMPTY ceiling (not even search_tools)', async () => {
    const gone = teammateSupabase(null)
    expect(await resolveTeammateChatBounds(gone.client, 'ws-1', 'tm-1', 'user-1')).toBeNull()
    expect(await resolveTeammateChatCeiling(gone.client, { workspaceId: 'ws-1', teammateId: 'tm-1', bounds: null })).toEqual(new Set())
  })

  it('composes with the workspace edition, a feature switched off included', async () => {
    const overrides = offOverrides(['email'])
    const { client } = teammateSupabase(null, { feature_overrides: overrides })
    const b: TeammateChatBounds = { allowed_side_effects: ['read'], agentConfig: null }
    const out = await resolveTeammateChatCeiling(client, { workspaceId: 'ws-1', teammateId: 'tm-1', bounds: b })
    expect(out).toEqual(composeTeammateChatCeiling(computeEditionToolCeiling(withEffectiveSurface(EDITIONS.full, overrides)), b))
    // A read tool the teammate's bounds would admit, gone with its feature.
    expect(out.has('list_emails')).toBe(false)
    expect(out.has('list_captures')).toBe(true)
  })
})

describe('one teammate ceiling, two halves (structural)', () => {
  it.each(['src/lib/chat/chat-run-rebuild.ts', 'src/app/api/internal/chat/tool/route.ts'])(
    '%s computes a teammate chat ceiling through resolveTeammateChatCeiling',
    (file) => {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      expect(src).toMatch(/resolveTeammateChatCeiling\(/)
      expect(src).not.toMatch(/composeTeammateChatCeiling\(|narrowToTeammate\(/)
    },
  )

  it('both read the bounds through the shared row mapping (the spec side in buildChatSystemPrompt)', () => {
    expect(readFileSync(join(repoRoot, 'src/app/api/internal/chat/tool/route.ts'), 'utf8')).toMatch(/resolveTeammateChatBounds\(/)
    expect(readFileSync(join(repoRoot, 'src/lib/ai/chat-system-prompt.ts'), 'utf8')).toMatch(/teammateChatBoundsFromRow\(/)
  })
})

describe('the Assistant chats propose-only (bots-v4 Phase 5)', () => {
  const FULL = computeEditionToolCeiling(EDITIONS.full)
  const row = (over: Record<string, unknown>) => ({
    is_system: true,
    system_key: 'assistant',
    team_id: 'team-1',
    fronts_only: false,
    allowed_side_effects: ['read', 'internal-write'],
    tool_allowlist: null,
    agent: null,
    ...over,
  })

  it('reads its system key with the bounds, so both halves see it', () => {
    expect(TEAMMATE_CHAT_BOUNDS_SELECT).toMatch(/\bsystem_key\b/)
  })

  it('narrows to reads plus the propose-only tools, whatever its row says, as a work bot does', () => {
    const bounds = teammateChatBoundsFromRow(row({}) as never, 'ws-1')
    expect(bounds.frontsOnly).toBe(true)
    const out = composeTeammateChatCeiling(FULL, bounds)
    for (const name of out) {
      if (name === 'search_tools' || WORK_BOT_PROPOSE_TOOLS.has(name)) continue
      expect(getToolDefinition(name)?.sideEffect, name).toBe('read')
    }
    for (const name of WORK_BOT_PROPOSE_TOOLS) expect(out.has(name)).toBe(true)
    expect(out.has('create_document')).toBe(false)
    expect(out.has('create_email_draft')).toBe(false)
  })

  it('leaves every other system teammate on its own bounds', () => {
    expect(teammateChatBoundsFromRow(row({ system_key: 'triage' }) as never, 'ws-1').frontsOnly).toBeUndefined()
    // A non-system row can't claim the key.
    expect(teammateChatBoundsFromRow(row({ is_system: false }) as never, 'ws-1').frontsOnly).toBeUndefined()
  })
})
