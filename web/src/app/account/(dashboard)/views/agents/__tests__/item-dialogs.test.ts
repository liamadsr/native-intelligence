import { describe, it, expect } from 'vitest'
import {
  buildSubmitBody,
  defaultForm,
  formFromRow,
  formFromParsedSkill,
  pickerTools,
  skillScopeLabels,
  type EditorForm,
} from '../item-dialogs'
import { parseSkillMd } from '@/lib/library/skill-md'
import { ALL_CATEGORY_IDS, ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import type { LibraryRow } from '../library-types'

/**
 * Unit tests for the pure form helpers behind the Agents & Skills editor's
 * create/edit dialog. The body shape differs by category — skills carry a
 * generated slug on create + persona styling; agents carry the tool allowlist —
 * so these are the contract the dialog depends on.
 *
 * Chat's "Save as skill" used to be a second consumer; it's now the
 * /create-skill system skill, which writes through the create_skill TOOL
 * (src/lib/ai/tools/library.ts) rather than this form.
 */

function skillForm(overrides: Partial<EditorForm> = {}): EditorForm {
  return { ...defaultForm('skill'), name: 'Draft Release Notes', ...overrides }
}

function agentForm(overrides: Partial<EditorForm> = {}): EditorForm {
  return { ...defaultForm('agent'), name: 'Support Agent', ...overrides }
}

describe('buildSubmitBody — skill', () => {
  it('create: includes a slug generated from the name', () => {
    const body = buildSubmitBody(skillForm({ name: 'Draft Release Notes!' }), false)
    expect(body.slug).toBe('draft-release-notes')
    expect(body.name).toBe('Draft Release Notes!')
  })

  it('edit: omits the slug so memorized slash-commands do not break', () => {
    const body = buildSubmitBody(skillForm({ name: 'Draft Release Notes' }), true)
    expect('slug' in body).toBe(false)
  })

  it('carries persona styling (response_style + context_rules) plus a tool scope', () => {
    const body = buildSubmitBody(
      skillForm({
        response_format: 'concise',
        response_tone: 'casual',
        always_cite_sources: false,
        context_rules: ['Check overdue actions first', '', '  '],
        enabled_tools: ['actions'],
        disabled_tools: [],
      }),
      false,
    )
    expect(body.agent_config).toEqual({
      // Skills carry a tool scope now — enforced when they run unattended in Flows.
      enabled_tools: ['actions'],
      disabled_tools: [],
      response_style: { format: 'concise', tone: 'casual', always_cite_sources: false },
      // Blank/whitespace-only rules are filtered out.
      context_rules: ['Check overdue actions first'],
    })
  })

  it('carries the same tool scope for skills as agents (enabled/disabled)', () => {
    const body = buildSubmitBody(
      skillForm({ enabled_tools: ['captures', 'actions'], disabled_tools: ['edit_capture_content', ''] }),
      false,
    )
    const cfg = body.agent_config as Record<string, unknown>
    expect(cfg.enabled_tools).toEqual(['captures', 'actions'])
    // Blank entries filtered from disabled_tools, same as agents.
    expect(cfg.disabled_tools).toEqual(['edit_capture_content'])
  })
})

describe('buildSubmitBody — agent', () => {
  it('carries the tool allowlist (enabled/disabled) and omits skill-only fields', () => {
    const body = buildSubmitBody(
      agentForm({
        enabled_tools: ['crm', 'actions'],
        // Blank entries are filtered from disabled_tools.
        disabled_tools: ['dial8_delete_action', ''],
      }),
      false,
    )
    expect(body.agent_config).toEqual({
      enabled_tools: ['crm', 'actions'],
      disabled_tools: ['dial8_delete_action'],
    })
    // No slug on agents (skill-only), and no persona styling keys.
    expect('slug' in body).toBe(false)
    expect((body.agent_config as Record<string, unknown>).response_style).toBeUndefined()
    expect((body.agent_config as Record<string, unknown>).context_rules).toBeUndefined()
  })
})

describe('buildSubmitBody — shared', () => {
  it('passes visibility through unchanged for both categories', () => {
    expect(buildSubmitBody(skillForm({ visibility: 'public' }), false).visibility).toBe('public')
    expect(buildSubmitBody(agentForm({ visibility: 'personal' }), false).visibility).toBe(
      'personal',
    )
  })

  it('trims the name and drops an empty description to undefined', () => {
    const body = buildSubmitBody(skillForm({ name: '  Padded  ', description: '' }), false)
    expect(body.name).toBe('Padded')
    expect(body.description).toBeUndefined()
  })
})

describe('defaultForm', () => {
  it('seeds an agent with every tool category enabled by default', () => {
    const form = defaultForm('agent')
    expect(form.category).toBe('agent')
    expect(form.enabled_tools).toEqual([...ALL_CATEGORY_IDS])
    expect(form.disabled_tools).toEqual([])
    expect(form.visibility).toBe('workspace')
  })
})

describe('formFromRow round-trip', () => {
  it('reconstructs an agent form from a persisted row', () => {
    const row = {
      id: 'a1',
      name: 'Support Agent',
      description: 'Handles tickets',
      category: 'agent',
      visibility: 'workspace',
      icon: null,
      color: '#123456',
      system_prompt: 'Be helpful.',
      agent_config: {
        enabled_tools: ['crm'],
        disabled_tools: ['dial8_delete_action'],
      },
    } as unknown as LibraryRow

    const form = formFromRow(row)
    expect(form.name).toBe('Support Agent')
    expect(form.description).toBe('Handles tickets')
    expect(form.system_prompt).toBe('Be helpful.')
    expect(form.enabled_tools).toEqual(['crm'])
    expect(form.disabled_tools).toEqual(['dial8_delete_action'])

    // Round-trip: the rebuilt body must carry the same allowlist back.
    const body = buildSubmitBody(form, true)
    expect(body.agent_config).toEqual({
      enabled_tools: ['crm'],
      disabled_tools: ['dial8_delete_action'],
    })
  })

  it('reconstructs a skill form, defaulting persona styling when absent', () => {
    const row = {
      id: 's1',
      name: 'Draft Notes',
      description: null,
      category: 'skill',
      visibility: 'personal',
      icon: '🤖',
      color: null,
      system_prompt: 'Write notes.',
      agent_config: {},
    } as unknown as LibraryRow

    const form = formFromRow(row)
    expect(form.category).toBe('skill')
    expect(form.description).toBe('')
    expect(form.icon).toBe('🤖')
    // Missing response_style → the documented defaults.
    expect(form.response_format).toBe('detailed')
    expect(form.response_tone).toBe('professional')
    expect(form.always_cite_sources).toBe(true)
    // Empty context_rules normalizes to a single blank input row.
    expect(form.context_rules).toEqual([''])
  })

  it('reconstructs a skill tool scope from the row (curated list, not all-tools)', () => {
    const row = {
      id: 's2',
      name: 'Weekly Report',
      category: 'skill',
      visibility: 'workspace',
      system_prompt: 'Report.',
      agent_config: {
        enabled_tools: ['actions', 'projects'],
        disabled_tools: ['delete_action'],
      },
    } as unknown as LibraryRow

    const form = formFromRow(row)
    // Skills reconstruct their tool scope the same way agents do.
    expect(form.enabled_tools).toEqual(['actions', 'projects'])
    expect(form.disabled_tools).toEqual(['delete_action'])
    // Round-trips back into the body unchanged.
    const cfg = buildSubmitBody(form, true).agent_config as Record<string, unknown>
    expect(cfg.enabled_tools).toEqual(['actions', 'projects'])
    expect(cfg.disabled_tools).toEqual(['delete_action'])
  })

  it('keeps a skill with no stored scope at no categories, so an edit does not widen it', () => {
    // An absent list is the narrow default for a skill (core tools, or reads
    // and drafts for an agent-authored one — skillActCeiling), not all tools.
    const row = {
      id: 's3',
      name: 'Blank Scope',
      category: 'skill',
      visibility: 'workspace',
      system_prompt: '',
      agent_config: { authored_by: 'agent' },
    } as unknown as LibraryRow

    const form = formFromRow(row)
    expect(form.enabled_tools).toEqual([])
    expect(form.disabled_tools).toEqual([])
    const cfg = buildSubmitBody(form, true).agent_config as Record<string, unknown>
    expect(cfg.enabled_tools).toEqual([])
    expect(cfg.authored_by).toBe('agent')
  })

  it('still defaults an agent with no stored scope to all tools', () => {
    const row = {
      id: 'a3',
      name: 'Blank Agent',
      category: 'agent',
      visibility: 'workspace',
      system_prompt: '',
      agent_config: {},
    } as unknown as LibraryRow

    expect(formFromRow(row).enabled_tools).toEqual([...ALL_CATEGORY_IDS])
  })
})

/**
 * The data-loss guard: buildSubmitBody rebuilds agent_config and the PATCH route
 * stores it verbatim. A row can carry keys the form doesn't surface — seeded
 * system-skill forks hold `preconditions`/`output_contract` (Flows config). The
 * form must round-trip those UNTOUCHED (form-managed keys override; everything
 * else is preserved) instead of clobbering them to nothing.
 */
describe('buildSubmitBody — preserves unknown agent_config keys (data-loss guard)', () => {
  it('skill edit keeps preconditions/output_contract the form never surfaces', () => {
    const row = {
      id: 's-flow',
      name: 'Triage Flow Skill',
      description: 'Runs in a flow',
      category: 'skill',
      visibility: 'workspace',
      icon: '⚙️',
      color: '#abcdef',
      system_prompt: 'Do the flow.',
      agent_config: {
        enabled_tools: ['actions'],
        disabled_tools: ['delete_action'],
        response_style: { format: 'structured', tone: 'technical', always_cite_sources: true },
        context_rules: ['Rule one'],
        // Keys the editor form has no field for — MUST survive an edit.
        preconditions: { requires_capture: true },
        output_contract: { produces: 'document' },
      },
    } as unknown as LibraryRow

    const form = formFromRow(row)
    // User tweaks a form-managed field.
    form.response_format = 'concise'
    const cfg = buildSubmitBody(form, true).agent_config as Record<string, unknown>

    // Unknown keys preserved verbatim.
    expect(cfg.preconditions).toEqual({ requires_capture: true })
    expect(cfg.output_contract).toEqual({ produces: 'document' })
    // Form-managed key reflects the edit (override wins).
    expect((cfg.response_style as Record<string, unknown>).format).toBe('concise')
    // And the tool scope / rules still round-trip.
    expect(cfg.enabled_tools).toEqual(['actions'])
    expect(cfg.context_rules).toEqual(['Rule one'])
  })

  it('agent edit keeps unknown keys the form never surfaces', () => {
    const row = {
      id: 'a-mystery',
      name: 'Legacy Agent',
      category: 'agent',
      visibility: 'workspace',
      system_prompt: 'Legacy.',
      agent_config: {
        enabled_tools: ['crm'],
        disabled_tools: [],
        // A hypothetical future/legacy key with no form field.
        model_override: 'claude-x',
      },
    } as unknown as LibraryRow

    const form = formFromRow(row)
    const cfg = buildSubmitBody(form, true).agent_config as Record<string, unknown>
    expect(cfg.model_override).toBe('claude-x')
    expect(cfg.enabled_tools).toEqual(['crm'])
  })

  it('create starts from an empty base — no phantom keys leak in', () => {
    const cfg = buildSubmitBody(defaultForm('skill'), false).agent_config as Record<string, unknown>
    expect('preconditions' in cfg).toBe(false)
    expect('output_contract' in cfg).toBe(false)
  })
})

describe('skillScopeLabels', () => {
  it('maps enabled category ids to their human labels', () => {
    expect(skillScopeLabels({ enabled_tools: ['actions', 'captures'] })).toEqual([
      'Actions',
      'Captures',
    ])
  })

  it('returns empty (→ "Core tools") when the scope is absent or empty', () => {
    // Empty/absent scope = the CORE fall-through an Act flow run gets
    // (computeSkillCeiling), NOT inherit-all — the caller renders a "Core tools"
    // placeholder for the empty array.
    expect(skillScopeLabels(null)).toEqual([])
    expect(skillScopeLabels({})).toEqual([])
    expect(skillScopeLabels({ enabled_tools: [] })).toEqual([])
  })

  it('falls through to the raw id for an unknown category', () => {
    expect(skillScopeLabels({ enabled_tools: ['actions', 'made_up'] })).toEqual([
      'Actions',
      'made_up',
    ])
  })
})

/**
 * SKILL.md import maps parsed frontmatter + body onto the create form. Paired
 * with parseSkillMd (its own suite) this covers the end-to-end import prefill.
 */
describe('formFromParsedSkill (SKILL.md import prefill)', () => {
  it('maps name/description/body onto the three prefilled fields', () => {
    const parsed = parseSkillMd(
      ['---', 'name: plan-week', 'description: Plans the coming week', '---', '', 'Do the planning.'].join(
        '\n',
      ),
    )
    const form = formFromParsedSkill(parsed)
    expect(form.category).toBe('skill')
    expect(form.name).toBe('plan-week')
    expect(form.description).toBe('Plans the coming week')
    expect(form.system_prompt).toBe('Do the planning.')
    // Untouched fields keep their skill defaults.
    expect(form.enabled_tools).toEqual([...ALL_CATEGORY_IDS])
    expect(form.visibility).toBe('workspace')
  })

  it('leaves the name blank when the file has no name (required-name validation handles it)', () => {
    // No frontmatter → parseSkillMd yields an empty name + a warning.
    const parsed = parseSkillMd('Just a body, no frontmatter.')
    const form = formFromParsedSkill(parsed)
    expect(form.name).toBe('')
    expect(form.system_prompt).toBe('Just a body, no frontmatter.')
    expect(parsed.warnings.length).toBeGreaterThan(0)
  })

  it('imported form round-trips through buildSubmitBody as a create', () => {
    const parsed = parseSkillMd(
      ['---', 'name: notes', 'description: Take notes', '---', 'Body.'].join('\n'),
    )
    const body = buildSubmitBody(formFromParsedSkill(parsed), false)
    expect(body.name).toBe('notes')
    expect(body.slug).toBe('notes')
    expect(body.system_prompt).toBe('Body.')
  })
})

describe('the tool picker', () => {
  it('never lists a chat-native tool (start_helper, stop_helper, the relay to the bots, the local agents), like ask_user, or a bot’s attended-only tool; every other registry tool is listed', () => {
    const listed = TOOL_CATEGORIES.flatMap((c) => pickerTools(c).map((t) => t.name))
    expect(listed).not.toContain('ask_user')
    // Only the main chat runs them (bots-v4 Phase A3: send_bot_message, wait_for_bot_reply): no persona grants one.
    for (const name of CHAT_NATIVE_TOOL_NAMES) expect(listed).not.toContain(name)
    expect([...CHAT_NATIVE_TOOL_NAMES]).toEqual([
      'start_helper',
      'stop_helper',
      'send_bot_message',
      'wait_for_bot_reply',
      // The local agents on the person's Mac (docs/plans/local-agents.md).
      'local_agents',
      'start_local_agent',
      'message_local_agent',
      'read_local_agent',
      'stop_local_agent',
      // …and their cloud counterpart (docs/plans/environments.md E2).
      'start_cloud_coding_run',
      // The main agent's answer to a guest's ask (guest access).
      'answer_guest',
      // The main agent asking a linked person's agent (agent links).
      'ask_agent',
    ])
    // Bots v3 Phase 5: no skill run holds one, and a bot's chat gets one by what it fronts.
    for (const name of ATTENDED_ONLY_TOOL_NAMES) expect(listed).not.toContain(name)
    expect(listed.length).toBe(TOOL_CATEGORIES.flatMap((c) => c.tools).length - CHAT_NATIVE_TOOL_NAMES.size - ATTENDED_ONLY_TOOL_NAMES.size)
  })
})

describe('buildSubmitBody — Give it a bot (bots-v3 Phase 6)', () => {
  it('sends a new agent’s bot, a character or a built one', () => {
    expect(buildSubmitBody(agentForm({ bot_character: 'ember' }), false).bot_character).toBe('ember')
    expect(buildSubmitBody(agentForm({ bot_character: 'xaabcaaa' }), false).bot_character).toBe('xaabcaaa')
  })

  it('sends none on edit, for a skill, or when none is picked', () => {
    expect('bot_character' in buildSubmitBody(agentForm({ bot_character: 'ember' }), true)).toBe(false)
    expect('bot_character' in buildSubmitBody(skillForm({ bot_character: 'ember' }), false)).toBe(false)
    expect('bot_character' in buildSubmitBody(agentForm(), false)).toBe(false)
  })

  it('sends none for a personal agent: its bot would be on a team everyone sees', () => {
    expect('bot_character' in buildSubmitBody(agentForm({ bot_character: 'ember', visibility: 'personal' }), false)).toBe(false)
  })
})

describe('the skill’s area ("Use it whenever I work on")', () => {
  it('a new skill has none, and sends null', () => {
    expect(defaultForm('skill').area).toBe('')
    expect(buildSubmitBody(skillForm(), false).area).toBeNull()
  })

  it('round-trips an area from the row to the body', () => {
    const row = { id: 's1', name: 'Outbound rules', category: 'skill', visibility: 'workspace', area: 'prospecting', agent_config: {} } as unknown as LibraryRow
    const form = formFromRow(row)
    expect(form.area).toBe('prospecting')
    expect(buildSubmitBody(form, true).area).toBe('prospecting')
  })

  it('reads a tag that is not an area as none', () => {
    const row = { id: 's1', name: 'x', category: 'skill', visibility: 'workspace', area: 'inbox', agent_config: {} } as unknown as LibraryRow
    expect(formFromRow(row).area).toBe('')
  })

  it('an agent never sends one', () => {
    expect(buildSubmitBody(agentForm({ area: 'mail' }), false)).not.toHaveProperty('area')
  })
})
