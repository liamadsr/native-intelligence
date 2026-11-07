import { describe, it, expect } from 'vitest'
import {
  LIVE_AGENT_READ_TOOLS,
  LIVE_AGENT_CORE_READ_TOOLS,
} from '../read-tool-names'
import { createPrepareStep } from '@/lib/ai/tool-discovery'

/**
 * The live agent's contract is "propose, never mutate". These tests guard the
 * single most important invariant of the read-tool expansion: the allowlist (and
 * therefore the discovery ceiling built from it) can NEVER contain a tool that
 * writes to the workspace. If someone adds a write tool to the set by mistake,
 * this suite fails before it can ship a silent un-gated mutation path.
 */

// Verb prefixes that denote a mutation or external side effect. Any tool name
// starting with one of these is, by definition, NOT read-only.
const WRITE_PREFIXES = [
  'create_',
  'update_',
  'delete_',
  'edit_',
  'complete_',
  'confirm_',
  'dismiss_',
  'archive_',
  'reorder_',
  'attach_',
  'link_',
  'unlink_',
  'add_',
  'remove_',
  'publish_',
  'propose_',
  'supersede_',
  'ingest_',
  'generate_',
  'draft_',
  'sync_',
  'start_',
  'accept_',
  'toggle_',
  'set_',
]

describe('LIVE_AGENT_READ_TOOLS', () => {
  it('contains no tool whose name implies a write or side effect', () => {
    const offenders = [...LIVE_AGENT_READ_TOOLS].filter((name) =>
      WRITE_PREFIXES.some((p) => name.startsWith(p)),
    )
    expect(offenders).toEqual([])
  })

  it('does not include known direct-mutating tools', () => {
    // A hand-picked blacklist of the highest-risk writers — belt to the
    // prefix-suspenders above, in case a future write tool uses a read-y name.
    const mustNotInclude = [
      'create_action',
      'update_action',
      'complete_action',
      'delete_action',
      'create_project',
      'update_project',
      'create_decision',
      'create_email_draft',
      'generate_email_drafts',
      'create_calendar_event',
      'update_calendar_event',
      'delete_calendar_event',
      'create_claim',
      'confirm_claim',
      'link_entities',
      'ingest_source',
      'create_document',
      'update_document',
      'publish_draft',
      'sync_calendar',
    ]
    for (const name of mustNotInclude) {
      expect(LIVE_AGENT_READ_TOOLS.has(name)).toBe(false)
    }
  })

  it('includes the core research reads the agent relies on', () => {
    for (const name of ['search', 'deep_search', 'list_actions', 'list_projects']) {
      expect(LIVE_AGENT_READ_TOOLS.has(name)).toBe(true)
    }
  })

  it('every core-read tool is also in the full read allowlist', () => {
    for (const name of LIVE_AGENT_CORE_READ_TOOLS) {
      expect(LIVE_AGENT_READ_TOOLS.has(name)).toBe(true)
    }
  })
})

describe('prepareStep read ceiling', () => {
  // The route builds the discovery ceiling as `staging tools ∪ read allowlist`.
  // This proves the ceiling does its job: a write tool surfaced by search_tools
  // is NEVER promoted into activeTools, so the model can't call it even if it
  // finds it.
  const initial = ['propose_change', 'search_tools']
  const available = new Set([
    ...initial,
    'list_actions',
    'create_action', // exists in the tool object, but is OUTSIDE the ceiling
  ])
  const ceiling = new Set([...initial, ...LIVE_AGENT_READ_TOOLS])

  const prepareStep = createPrepareStep(initial, available, ceiling)

  it('promotes a discovered READ tool into activeTools', () => {
    const result = prepareStep({
      steps: [
        {
          toolResults: [
            {
              toolName: 'search_tools',
              output: { tools: [{ name: 'list_actions' }] },
            },
          ],
        },
      ],
    })
    expect(result.activeTools).toContain('list_actions')
  })

  it('REFUSES to promote a discovered WRITE tool (outside the ceiling)', () => {
    const result = prepareStep({
      steps: [
        {
          toolResults: [
            {
              toolName: 'search_tools',
              output: { tools: [{ name: 'create_action' }, { name: 'list_actions' }] },
            },
          ],
        },
      ],
    })
    // list_actions got through; create_action was rejected by the ceiling.
    expect(result.activeTools).toContain('list_actions')
    expect(result.activeTools).not.toContain('create_action')
  })
})
