/**
 * Every registry tool carries a side-effect classification (SYNTHESIS WS-3c
 * Fix item 3). The work-run ceiling admits a tool only by its class, so the
 * class IS the fence: this file checks that the data behind it is well formed.
 *
 * The field is a required property of ToolDefinition, so a new registry entry
 * without one is a tsc error. These runtime checks cover what the type system
 * cannot: a value smuggled in with an `as` cast, a duplicate name whose two
 * entries disagree, and a write-shaped name classified as admitted.
 */
import { describe, it, expect } from 'vitest'
import {
  ALL_TOOL_NAMES,
  LIVE_AGENT_ONLY_RESOLVER_TOOLS,
  TOOL_CATEGORIES,
  TOOL_SIDE_EFFECTS,
  WORK_RUN_ADMITTED_SIDE_EFFECTS,
  WRITE_TARGETS,
  getToolSideEffect,
  getToolWriteTarget,
  type ToolDefinition,
} from '@/lib/ai/tool-registry'
import { DRAFTING_EXCLUDED_TOOLS, WORK_RUN_EXCLUDED_TOOLS } from '@/lib/agent-run/types'
import { computeDraftingCeiling, computeWorkRunCeiling } from '@/lib/agent-run/run-work-spec-rebuild'

const REGISTRY_TOOLS: ToolDefinition[] = TOOL_CATEGORIES.flatMap((c) => c.tools)
const FIVE = new Set<string>(['read', 'internal-write', 'external-write', 'automation-write', 'delete'])

describe('registry side-effect classification', () => {
  it('every registry entry carries one of the five classes', () => {
    const bad = [...REGISTRY_TOOLS, ...LIVE_AGENT_ONLY_RESOLVER_TOOLS]
      .filter((t) => typeof t.sideEffect !== 'string' || !FIVE.has(t.sideEffect))
      .map((t) => `${t.name}: ${String(t.sideEffect)}`)
    expect(bad).toEqual([])
  })

  it('TOOL_SIDE_EFFECTS lists exactly the five classes', () => {
    expect([...TOOL_SIDE_EFFECTS].sort()).toEqual([...FIVE].sort())
  })

  it('the work run admits exactly read and internal-write', () => {
    expect([...WORK_RUN_ADMITTED_SIDE_EFFECTS].sort()).toEqual(['internal-write', 'read'])
  })

  it('tool names are unique, so each name has exactly one class', () => {
    const seen = new Set<string>()
    const dupes = ALL_TOOL_NAMES.filter((n) => (seen.has(n) ? true : (seen.add(n), false)))
    expect(dupes).toEqual([])
  })

  it('getToolSideEffect reads the registry and misses on non-registry names', () => {
    expect(getToolSideEffect('list_actions')).toBe('read')
    expect(getToolSideEffect('create_email_draft')).toBe('internal-write')
    expect(getToolSideEffect('push_action_to_jira')).toBe('external-write')
    expect(getToolSideEffect('update_skill')).toBe('automation-write')
    expect(getToolSideEffect('delete_action')).toBe('delete')
    // Sequence step 2 (plan A.2): publish_draft IS the send — the published
    // document is what leaves the draft state, so it is an external write (it
    // was 'delete' for hard-deleting the draft row; both are outside the ceiling).
    expect(getToolSideEffect('publish_draft')).toBe('external-write')
    // …and staging enrolments is the external act once a sequence is live.
    expect(getToolSideEffect('enroll_contacts_in_sequence')).toBe('external-write')
    for (const name of ['search_tools', '__proto__', 'constructor', 'toString', 'no_such_tool']) {
      expect(getToolSideEffect(name), name).toBeUndefined()
    }
  })

  it('no admitted-class tool has a send/publish/push/delete-shaped name', () => {
    // Cheap sanity on the classification itself: a name that says it sends,
    // publishes, pushes or deletes cannot be a read or an internal write.
    const suspicious = REGISTRY_TOOLS.filter(
      (t) => WORK_RUN_ADMITTED_SIDE_EFFECTS.has(t.sideEffect) && /^(publish|push|send|delete)_/.test(t.name),
    ).map((t) => `${t.name} (${t.sideEffect})`)
    expect(suspicious).toEqual([])
  })

  it('every delete_* tool is classified delete', () => {
    const wrong = REGISTRY_TOOLS.filter((t) => t.name.startsWith('delete_') && t.sideEffect !== 'delete').map(
      (t) => `${t.name} (${t.sideEffect})`,
    )
    expect(wrong).toEqual([])
  })

  it('the live-only resolvers are reads', () => {
    for (const t of LIVE_AGENT_ONLY_RESOLVER_TOOLS) expect(t.sideEffect, t.name).toBe('read')
  })

  it('every internal write names what it writes; no other class does (Sequence step 2, plan A.3)', () => {
    const targets = new Set<string>(WRITE_TARGETS)
    const bad = REGISTRY_TOOLS.filter((t) =>
      t.sideEffect === 'internal-write' ? !targets.has(String(t.writeTarget)) : t.writeTarget !== undefined,
    ).map((t) => `${t.name}: ${t.sideEffect}/${String(t.writeTarget)}`)
    expect(bad).toEqual([])
    expect(getToolWriteTarget('create_document')).toBe('artifact')
    expect(getToolWriteTarget('create_action')).toBe('board')
    expect(getToolWriteTarget('create_contact')).toBe('crm')
    // The explicit borderline calls.
    expect(getToolWriteTarget('archive_capture')).toBe('board')
    expect(getToolWriteTarget('add_comment')).toBe('board')
    expect(getToolWriteTarget('link_entities')).toBe('board')
    expect(getToolWriteTarget('list_actions')).toBeUndefined()
    expect(getToolWriteTarget('publish_draft')).toBeUndefined()
  })

  it('the drafting ceiling is read + artifact writes, a subset of the work-run ceiling', () => {
    const drafting = computeDraftingCeiling()
    const work = computeWorkRunCeiling()
    for (const name of drafting) expect(work.has(name), name).toBe(true)
    for (const name of ['create_document', 'create_email_draft', 'create_claim', 'list_actions', 'find']) {
      expect(drafting.has(name), name).toBe(true)
    }
    for (const name of ['archive_capture', 'create_action', 'update_action', 'create_contact', 'add_comment', 'publish_draft', 'enroll_contacts_in_sequence']) {
      expect(drafting.has(name), name).toBe(false)
    }
    expect(DRAFTING_EXCLUDED_TOOLS).toContain('archive_capture')
    for (const name of WORK_RUN_EXCLUDED_TOOLS) expect(DRAFTING_EXCLUDED_TOOLS, name).toContain(name)
  })

  it('an entry without sideEffect does not typecheck', () => {
    // Compile-time pin, checked by `npm run typecheck` (tests are in the tsc
    // include). If sideEffect ever became optional, this directive would be
    // unused and tsc would fail on it.
    // @ts-expect-error — sideEffect is required on every ToolDefinition
    const unclassified: ToolDefinition = { name: 'new_tool', label: 'New', description: 'x' }
    expect(unclassified.name).toBe('new_tool')
  })
})
