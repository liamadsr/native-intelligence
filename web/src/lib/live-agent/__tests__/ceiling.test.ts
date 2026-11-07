/**
 * computeLiveAgentCeiling — CONTENT-MEMBERSHIP tests (LIVE-AGENT-DESIGN §4.2/§4.5).
 *
 * Every assertion here names tools. A size-only check is exactly how
 * WORK_RUN_EXCLUDED_TOOLS drifted silently against the registry (gap-6): the
 * arithmetic still added up while four externally-visible writes stayed
 * reachable. So these tests check WHICH names are in or out, per turn type, and
 * cross-check the hand-maintained exclusion sets against the real factories and
 * the live tool registry.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolSet } from 'ai'
import { createLiveAgentTools } from '../tools'
import { buildLiveAgentReadTools } from '../read-tools'
import {
  ASSIST_ONLY_EXCLUDED_TOOLS,
  LIVE_AGENT_READ_TOOLS,
  LIVE_NOTES_EXCLUDED_TOOLS,
  PAIRED_COPILOT_ONLY_TOOLS,
  LIVE_COPILOT_ONLY_TOOLS,
  agentInheritsAllTools,
  type AgentToolSelection,
  BUILTIN_ASSISTANT_TOOL_SELECTION,
  LIVE_AGENT_CORE_READ_TOOLS,
  personaToolSelection,
} from '../read-tool-names'
import {
  LIVE_AGENT_PINNED_READ_TOOL_NAMES,
  LIVE_AGENT_STAGING_TOOL_NAMES,
  LIVE_AGENT_TURN_TYPES,
  computeLiveAgentCeiling,
  computeLiveAgentCoreToolNames,
  liveTurnFlags,
  liveTurnTypeFromRequest,
} from '../ceiling'
import { assembleLiveAgentToolSet } from '../turn-composition'
import {
  ALL_CATEGORY_IDS,
  getMutatingToolNames,
  isReadShapedToolName,
  LIVE_AGENT_RESOLVER_TOOL_NAMES,
} from '@/lib/ai/tool-registry'
import { computeToolCeiling } from '@/lib/ai/tool-ceiling-core'

const stub = {} as SupabaseClient
const stagingTools = createLiveAgentTools('u', stub, 'w', 'c', null, null)
const readTools = buildLiveAgentReadTools('u', stub, 'w')

/** The staging tools that TALK to the user (their output channel, not the record). */
const TALK_TOOLS = ['say_to_user', 'ask_user']

describe('LIVE_AGENT_STAGING_TOOL_NAMES is the real staging factory', () => {
  it('names exactly the keys createLiveAgentTools builds, in order', () => {
    expect([...LIVE_AGENT_STAGING_TOOL_NAMES]).toEqual(Object.keys(stagingTools))
  })

  it('every resolver read is read-shaped — the live-only three are staging keys, the shared two are NOT', () => {
    for (const name of LIVE_AGENT_RESOLVER_TOOL_NAMES) expect(isReadShapedToolName(name), name).toBe(true)
    for (const name of ['search_projects', 'search_contacts', 'get_project_details']) {
      expect(LIVE_AGENT_STAGING_TOOL_NAMES).toContain(name)
    }
    // The hand-rolled list_workspace_members / list_labels are gone from the
    // factory: ONE implementation each (the registry's), pinned in the ceiling.
    expect([...LIVE_AGENT_PINNED_READ_TOOL_NAMES].sort()).toEqual(['list_labels', 'list_workspace_members'])
    for (const name of LIVE_AGENT_PINNED_READ_TOOL_NAMES) {
      expect(Object.keys(stagingTools), `${name} is still hand-rolled in createLiveAgentTools`).not.toContain(name)
      expect(LIVE_AGENT_STAGING_TOOL_NAMES).not.toContain(name)
      expect(LIVE_AGENT_RESOLVER_TOOL_NAMES as readonly string[]).toContain(name)
      expect(Object.keys(readTools), `${name} has no registry implementation`).toContain(name)
    }
  })
})

describe('turn types', () => {
  it('maps the route’s request fields exactly as the route reads them', () => {
    expect(liveTurnTypeFromRequest(undefined, undefined)).toBe('copilot')
    expect(liveTurnTypeFromRequest('live', 'copilot')).toBe('copilot')
    expect(liveTurnTypeFromRequest('live', 'notes')).toBe('notes')
    expect(liveTurnTypeFromRequest(undefined, 'notes')).toBe('notes')
    // live_role is ignored in batch mode.
    expect(liveTurnTypeFromRequest('batch', 'notes')).toBe('batch')
    expect(liveTurnFlags('batch')).toEqual({ isBatch: true, notesRole: false, writesRecord: true })
    expect(liveTurnFlags('notes')).toEqual({ isBatch: false, notesRole: true, writesRecord: true })
    expect(liveTurnFlags('copilot')).toEqual({ isBatch: false, notesRole: false, writesRecord: false })
  })
})

describe('computeLiveAgentCeiling — per-turn-type membership', () => {
  // The built-in Assistant (no persona row) inherits every read; a persona
  // row's NULL config is core-only (see the narrowing block below).
  const full = (turnType: 'copilot' | 'notes' | 'batch', assistOnly = false) =>
    computeLiveAgentCeiling({ turnType, assistOnly, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION })

  it('never holds a chat-native tool (start_helper), whatever the turn or persona selection', () => {
    for (const turnType of LIVE_AGENT_TURN_TYPES) {
      for (const agentConfig of [BUILTIN_ASSISTANT_TOOL_SELECTION, { enabled_tools: [...ALL_CATEGORY_IDS] }, { enabled_tools: ['actions'] }, null]) {
        const { ceiling } = computeLiveAgentCeiling({ turnType, assistOnly: false, agentConfig })
        expect(ceiling.has('start_helper'), `${turnType} ${JSON.stringify(agentConfig)}`).toBe(false)
      }
    }
  })

  it('a plain copilot turn holds every staging tool but the relay, and the whole read allowlist', () => {
    const { ceiling } = full('copilot')
    for (const name of LIVE_AGENT_STAGING_TOOL_NAMES) {
      expect(ceiling.has(name), name).toBe(!PAIRED_COPILOT_ONLY_TOOLS.has(name))
    }
    for (const name of LIVE_AGENT_READ_TOOLS) expect(ceiling.has(name), name).toBe(true)
  })

  it('an ASSIST-ONLY copilot loses every record-writing tool, by name, and keeps the talk tools', () => {
    const { ceiling, staging } = full('copilot', true)
    for (const name of [
      'write_summary',
      'update_summary',
      'propose_change',
      'record_commitment',
      'edit_proposal',
      'dismiss_proposal',
      'propose_mcp_call',
      'set_capture_title',
    ]) {
      expect(ASSIST_ONLY_EXCLUDED_TOOLS.has(name), name).toBe(true)
      expect(ceiling.has(name), `${name} survived the assist-only strip`).toBe(false)
    }
    for (const name of TALK_TOOLS) expect(ceiling.has(name), name).toBe(true)
    // It relays what the user asks to have noted (live-agent messaging L2).
    expect([...PAIRED_COPILOT_ONLY_TOOLS]).toEqual(['direct_notes'])
    expect(staging).toContain('direct_notes')
    // The read resolvers are not record writers — they stay.
    for (const name of LIVE_AGENT_RESOLVER_TOOL_NAMES) expect(ceiling.has(name), name).toBe(true)
    for (const name of ['search_projects', 'search_contacts', 'get_project_details']) expect(staging).toContain(name)
  })

  it('a paired NOTES turn loses exactly the talk tools and keeps every record writer', () => {
    const { ceiling } = full('notes')
    expect([...LIVE_NOTES_EXCLUDED_TOOLS].sort()).toEqual([...TALK_TOOLS].sort())
    for (const name of TALK_TOOLS) expect(ceiling.has(name), `${name} reachable on a notes turn`).toBe(false)
    for (const name of ASSIST_ONLY_EXCLUDED_TOOLS) expect(ceiling.has(name), name).toBe(true)
    // It writes the record itself; the relay is the copilot's.
    expect(ceiling.has('direct_notes')).toBe(false)
  })

  it('a BATCH turn holds every staging tool but the relay and load_skill (it is the record’s writer)', () => {
    const { ceiling } = full('batch')
    for (const name of LIVE_AGENT_STAGING_TOOL_NAMES) {
      expect(ceiling.has(name), name).toBe(!PAIRED_COPILOT_ONLY_TOOLS.has(name) && !LIVE_COPILOT_ONLY_TOOLS.has(name))
    }
  })

  it('load_skill is a copilot tool, assist-only or not, and never a writer turn’s', () => {
    expect(full('copilot').ceiling.has('load_skill')).toBe(true)
    expect(full('copilot', true).ceiling.has('load_skill')).toBe(true)
    expect(full('notes').ceiling.has('load_skill')).toBe(false)
    expect(full('batch').ceiling.has('load_skill')).toBe(false)
  })

  it('assistOnly can never strip a WRITER turn’s write tools', () => {
    for (const turnType of ['notes', 'batch'] as const) {
      const { ceiling } = full(turnType, true)
      for (const name of ASSIST_ONLY_EXCLUDED_TOOLS) expect(ceiling.has(name), `${turnType}: ${name}`).toBe(true)
      // …nor hand a writer turn the copilot's relay.
      expect(ceiling.has('direct_notes'), turnType).toBe(false)
    }
  })

  it('never admits a registry WRITE tool on any turn type', () => {
    const mutating = getMutatingToolNames()
    for (const turnType of LIVE_AGENT_TURN_TYPES) {
      for (const assistOnly of [false, true]) {
        const { ceiling } = computeLiveAgentCeiling({ turnType, assistOnly, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION })
        // A registry mutator in the ceiling would be callable through the tool
        // route. The ONLY names that match the write-verb pattern are the live
        // agent's own staging tools (which stage proposals, never write).
        const leaked = [...ceiling].filter(
          (name) => mutating.has(name) && !LIVE_AGENT_STAGING_TOOL_NAMES.includes(name),
        )
        expect(leaked, `${turnType}/${assistOnly}`).toEqual([])
        for (const name of [
          'create_action',
          'update_action',
          'accept_proposal',
          'publish_prospect_list',
          'push_action_to_asana',
          'push_action_to_jira',
          'push_action_to_linear',
          'delete_action',
          'create_email_draft',
          'publish_draft',
        ]) {
          expect(ceiling.has(name), `${turnType}: ${name}`).toBe(false)
        }
      }
    }
  })
})

describe('cross-check of the hand-maintained sets against the registry (§4.5)', () => {
  it('every LIVE_AGENT_READ_TOOLS name is read-shaped and none is a registry mutator', () => {
    const mutating = getMutatingToolNames()
    for (const name of LIVE_AGENT_READ_TOOLS) {
      expect(isReadShapedToolName(name), `${name} is not read-shaped`).toBe(true)
      expect(mutating.has(name), `${name} is a mutator`).toBe(false)
    }
  })

  it('an assist-only ceiling holds no staging tool that writes the record — a NEW write tool must join ASSIST_ONLY_EXCLUDED_TOOLS', () => {
    // Every staging tool is either read-shaped (a resolver), a talk tool, or
    // excluded for assist-only. A staging tool added to createLiveAgentTools that
    // is none of these fails here instead of silently reaching assist-only turns.
    // The relay to the note-taker is the one write an assist-only turn holds:
    // it writes a directive for the note-taker, never the record.
    for (const name of LIVE_AGENT_STAGING_TOOL_NAMES) {
      const classified =
        isReadShapedToolName(name) ||
        TALK_TOOLS.includes(name) ||
        ASSIST_ONLY_EXCLUDED_TOOLS.has(name) ||
        PAIRED_COPILOT_ONLY_TOOLS.has(name) ||
        // load_skill returns instructions and remembers the call's playbook; it never writes the record.
        LIVE_COPILOT_ONLY_TOOLS.has(name)
      expect(classified, `${name} is unclassified`).toBe(true)
    }
    for (const name of [...ASSIST_ONLY_EXCLUDED_TOOLS, ...PAIRED_COPILOT_ONLY_TOOLS]) {
      expect(LIVE_AGENT_STAGING_TOOL_NAMES, `${name} is not a staging tool`).toContain(name)
    }
    for (const name of PAIRED_COPILOT_ONLY_TOOLS) expect(ASSIST_ONLY_EXCLUDED_TOOLS.has(name), name).toBe(false)
  })
})

describe('agent narrowing — agentInheritsAllTools ⇔ computeToolCeiling parity (§4.2)', () => {
  const ALL_ON: AgentToolSelection = { enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: [] }

  // Sequence step 1 (the D.1 lockdown): NO divergence is left. A null config,
  // an absent enabled_tools key and a present-but-empty [] all read the same on
  // every runtime — core-only — exactly as chat's computeToolCeiling reads them.
  it.each([
    ['null config', null],
    ['absent enabled_tools key', { disabled_tools: [] }],
    ['every category on, nothing disabled', ALL_ON],
    ['every category on, one tool disabled', { ...ALL_ON, disabled_tools: ['list_labels'] }],
    ['present-but-EMPTY enabled_tools', { enabled_tools: [] }],
    ['one category', { enabled_tools: ['actions'] }],
  ] as Array<[string, AgentToolSelection | null]>)('%s: both runtimes agree on inherit-all', (_label, cfg) => {
    const chatInherits = computeToolCeiling(cfg?.enabled_tools ?? undefined, cfg?.disabled_tools ?? undefined) === null
    expect(agentInheritsAllTools(cfg)).toBe(chatInherits)
    const { read } = computeLiveAgentCeiling({ turnType: 'copilot', assistOnly: false, agentConfig: cfg })
    expect(read.size === LIVE_AGENT_READ_TOOLS.size && [...LIVE_AGENT_READ_TOOLS].every((n) => read.has(n))).toBe(
      chatInherits,
    )
  })

  it('the built-in Assistant (no persona row) inherits every read — it is not a persona row with a NULL config', () => {
    expect(personaToolSelection(null)).toBe(BUILTIN_ASSISTANT_TOOL_SELECTION)
    expect(personaToolSelection(undefined)).toBe(BUILTIN_ASSISTANT_TOOL_SELECTION)
    expect(agentInheritsAllTools(BUILTIN_ASSISTANT_TOOL_SELECTION)).toBe(true)
    // A resolved row hands back ITS selection — null included, which is core-only.
    expect(personaToolSelection({ agent_config: null })).toBeNull()
    expect(personaToolSelection({})).toBeNull()
    expect(personaToolSelection({ agent_config: { enabled_tools: ['actions'] } })).toEqual({ enabled_tools: ['actions'] })
  })

  it.each([
    ['a persona row with a NULL config', null],
    ['a persona row with an absent enabled_tools key', { disabled_tools: [] }],
    ['a present-but-empty enabled_tools', { enabled_tools: [] }],
  ] as Array<[string, AgentToolSelection | null]>)(
    '%s narrows the READ half to the live core reads — staging untouched',
    (_label, cfg) => {
      const { ceiling, read, staging } = computeLiveAgentCeiling({ turnType: 'copilot', assistOnly: false, agentConfig: cfg })
      expect([...read].sort()).toEqual([...LIVE_AGENT_CORE_READ_TOOLS].sort())
      for (const name of ['get_package', 'get_attachment_content', 'search_claims', 'list_emails']) {
        expect(ceiling.has(name), name).toBe(false)
      }
      for (const name of ['find', 'search', 'list_actions']) expect(ceiling.has(name), name).toBe(true)
      expect(staging).toEqual(LIVE_AGENT_STAGING_TOOL_NAMES.filter((n) => !PAIRED_COPILOT_ONLY_TOOLS.has(n)))
    },
  )

  it('a disabled core read stays out of the core-only seed', () => {
    const { read } = computeLiveAgentCeiling({
      turnType: 'copilot',
      assistOnly: false,
      agentConfig: { enabled_tools: [], disabled_tools: ['deep_search'] },
    })
    expect(read.has('deep_search')).toBe(false)
    expect(read.has('find')).toBe(true)
  })

  it('a category selection keeps only that category’s reads, minus disabled ones', () => {
    const { read, ceiling } = computeLiveAgentCeiling({
      turnType: 'copilot',
      assistOnly: false,
      agentConfig: { enabled_tools: ['actions'], disabled_tools: ['list_labels'] },
    })
    expect(read.has('list_actions')).toBe(true)
    expect(read.has('get_action')).toBe(true)
    expect(read.has('list_labels')).toBe(false)
    expect(read.has('find')).toBe(false)
    expect(read.has('get_package')).toBe(false)
    // …but list_labels is a PINNED resolver read: granted whatever the selection
    // says (it used to be a never-narrowed hand-rolled staging copy).
    expect(ceiling.has('list_labels')).toBe(true)
  })
})

describe('computeLiveAgentCoreToolNames', () => {
  const ceiling = computeLiveAgentCeiling({ turnType: 'copilot', assistOnly: false, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION })

  it('seeds get_package only when there is a manifest', () => {
    expect(computeLiveAgentCoreToolNames(ceiling, true)).toContain('get_package')
    expect(computeLiveAgentCoreToolNames(ceiling, false)).not.toContain('get_package')
  })

  it('clamps every core read to the ceiling (a narrowed-away core read stays away)', () => {
    const narrowed = computeLiveAgentCeiling({
      turnType: 'copilot',
      assistOnly: false,
      agentConfig: { enabled_tools: ['actions'] },
    })
    const core = computeLiveAgentCoreToolNames(narrowed, true)
    expect(core).not.toContain('find')
    expect(core).not.toContain('get_package')
    expect(core).toContain('list_actions')
    for (const name of core) expect(narrowed.ceiling.has(name), name).toBe(true)
  })

  it('never names search_tools or web_search (eve mints those natively)', () => {
    const core = computeLiveAgentCoreToolNames(ceiling, true)
    expect(core).not.toContain('search_tools')
    expect(core).not.toContain('web_search')
  })
})

describe('assembleLiveAgentToolSet — the map IS the ceiling', () => {
  const build = (turnType: 'copilot' | 'notes' | 'batch', assistOnly: boolean, agentConfig: AgentToolSelection | null) =>
    assembleLiveAgentToolSet({
      allStagingTools: stagingTools,
      readTools,
      webTools: {} as ToolSet,
      turnType,
      assistOnly,
      agentConfig,
      packageBlock: null,
    })

  it.each([
    ['copilot', false],
    ['copilot', true],
    ['notes', false],
    ['batch', false],
  ] as const)('%s (assistOnly=%s): map keys = ceiling ∪ {search_tools}, no phantoms', (turnType, assistOnly) => {
    const { tools, ceiling } = build(turnType, assistOnly, null)
    expect(new Set(Object.keys(tools))).toEqual(new Set([...ceiling.ceiling, 'search_tools']))
  })

  it('list_workspace_members / list_labels have ONE implementation — the registry’s', () => {
    const { tools } = build('copilot', false, null)
    const map = tools as Record<string, unknown>
    const reads = readTools as Record<string, unknown>
    const staged = stagingTools as Record<string, unknown>
    for (const name of LIVE_AGENT_PINNED_READ_TOOL_NAMES) {
      expect(staged[name], `${name} is still shadowed by a hand-rolled copy`).toBeUndefined()
      expect(map[name]).toBe(reads[name])
    }
    // The live-only resolvers have no registry twin — the staging one runs.
    for (const name of ['search_projects', 'search_contacts', 'get_project_details']) {
      expect(map[name]).toBe(staged[name])
      expect(reads[name]).toBeUndefined()
    }
  })

  it('a persona that narrows the pinned reads away still gets them — served by the registry tool', () => {
    const { tools, ceiling } = build('copilot', false, {
      enabled_tools: ['contacts'],
      disabled_tools: ['list_labels', 'list_workspace_members'],
    })
    const map = tools as Record<string, unknown>
    const reads = readTools as Record<string, unknown>
    for (const name of LIVE_AGENT_PINNED_READ_TOOL_NAMES) {
      expect(ceiling.read.has(name), `${name} should be narrowed out of the read half`).toBe(false)
      expect(ceiling.ceiling.has(name), name).toBe(true)
      expect(map[name], name).toBe(reads[name])
    }
  })

  it('a withheld staging tool is absent from the MAP, not just from the active set', () => {
    const assist = build('copilot', true, null).tools as Record<string, unknown>
    for (const name of ASSIST_ONLY_EXCLUDED_TOOLS) expect(name in assist, name).toBe(false)
    const notes = build('notes', false, null).tools as Record<string, unknown>
    for (const name of LIVE_NOTES_EXCLUDED_TOOLS) expect(name in notes, name).toBe(false)
  })
})

describe('connected-app lookups (mcp-lookups.ts): discoverable, never core, copilot only', () => {
  const LOOKUPS = ['mcp__jira__getJiraIssue', 'mcp__linear__list_issues']

  it('a copilot turn’s ceiling holds the lookups; the core set does not', () => {
    for (const assistOnly of [false, true]) {
      const ceiling = computeLiveAgentCeiling({
        turnType: 'copilot',
        assistOnly,
        agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION,
        mcpLookups: LOOKUPS,
      })
      for (const name of LOOKUPS) expect(ceiling.ceiling.has(name), name).toBe(true)
      expect([...ceiling.mcpLookups]).toEqual(LOOKUPS)
      const core = computeLiveAgentCoreToolNames(ceiling, true)
      for (const name of LOOKUPS) expect(core).not.toContain(name)
    }
  })

  it('never on a notes or batch turn', () => {
    for (const turnType of ['notes', 'batch'] as const) {
      const ceiling = computeLiveAgentCeiling({
        turnType,
        assistOnly: false,
        agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION,
        mcpLookups: LOOKUPS,
      })
      expect(ceiling.mcpLookups.size).toBe(0)
      for (const name of LOOKUPS) expect(ceiling.ceiling.has(name)).toBe(false)
    }
  })

  it('only an mcp__ name: the list can never smuggle in a workspace tool', () => {
    const ceiling = computeLiveAgentCeiling({
      turnType: 'copilot',
      assistOnly: true,
      agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION,
      mcpLookups: ['propose_change', 'write_summary', 'mcp__jira__get_issue'],
    })
    expect(ceiling.ceiling.has('propose_change')).toBe(false)
    expect(ceiling.ceiling.has('write_summary')).toBe(false)
    expect([...ceiling.mcpLookups]).toEqual(['mcp__jira__get_issue'])
  })

  it('without lookups the ceiling is unchanged', () => {
    const a = computeLiveAgentCeiling({ turnType: 'copilot', assistOnly: false, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION })
    const b = computeLiveAgentCeiling({
      turnType: 'copilot',
      assistOnly: false,
      agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION,
      mcpLookups: [],
    })
    expect([...b.ceiling]).toEqual([...a.ceiling])
    expect(a.mcpLookups.size).toBe(0)
  })
})
