/**
 * B PR 4: a work run done by a teammate. Its spec carries the teammate's
 * persona after the base prompt, and an UNATTENDED run's ceiling narrows to the
 * teammate's own bounds (classes, then allowlist). A person-started run keeps
 * the person's ceiling; a run with no teammate is exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  persona: null as unknown,
  personaCalls: [] as string[],
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => ({ data: hoisted.row, error: null }),
      }
      return api
    },
  }),
}))
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: async () => 'BASE PROMPT' }))
vi.mock('@/lib/ai/gateway-telemetry', () => ({ gatewayTelemetryValues: () => null }))
vi.mock('@/lib/ai/agent-run-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/agent-run-context')>()
  return {
    ...actual,
    loadAgentPersona: async (_sb: unknown, id: string) => {
      hoisted.personaCalls.push(id)
      return hoisted.persona
    },
  }
})

import { getToolDefinition } from '@/lib/ai/tool-registry'
import {
  ceilingForWorkRun,
  computeDraftingCeiling,
  computeWorkRunCeiling,
  narrowToTeammate,
  rebuildWorkRunSpec,
  runStartSection,
} from '../run-work-spec-rebuild'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 600_000 }
const sorted = (s: Iterable<string>) => [...s].sort()

beforeEach(() => {
  hoisted.personaCalls = []
  hoisted.persona = { name: 'Quill', agentSystemPrompt: 'You write crisp notes.', agentConfig: null, skills: [] }
})

describe('ceilingForWorkRun with a teammate', () => {
  it('an unattended run narrows to the teammate’s classes', () => {
    const drafts = ceilingForWorkRun('attempt', { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null })
    expect(sorted(drafts)).toEqual(sorted(computeDraftingCeiling()))
    const readOnly = ceilingForWorkRun('attempt', { allowed_side_effects: ['read'], tool_allowlist: null })
    expect(readOnly.size).toBeGreaterThan(0)
    expect(readOnly.has('create_document')).toBe(false)
    for (const name of readOnly) expect(getToolDefinition(name)?.sideEffect, name).toBe('read')
  })

  it('and then to its allowlist', () => {
    const narrowed = ceilingForWorkRun('attempt', {
      allowed_side_effects: ['read', 'internal-write'],
      tool_allowlist: ['create_document', 'get_capture_transcript', 'create_action', 'not_a_tool'],
    })
    // create_action is a board write: outside the drafting ceiling, so the allowlist cannot add it back.
    expect(sorted(narrowed)).toEqual(['create_document', 'get_capture_transcript'])
  })

  it('missing or malformed classes read as read-only — a bad row narrows, never widens', () => {
    const readOnly = sorted(ceilingForWorkRun('attempt', { allowed_side_effects: ['read'] }))
    expect(sorted(ceilingForWorkRun('attempt', { allowed_side_effects: null }))).toEqual(readOnly)
    expect(sorted(narrowToTeammate(computeDraftingCeiling(), {}))).toEqual(readOnly)
  })

  it('a person-started run keeps the person’s ceiling, whoever the teammate is', () => {
    expect(sorted(ceilingForWorkRun('user', { allowed_side_effects: ['read'], tool_allowlist: [] }))).toEqual(sorted(computeWorkRunCeiling()))
    expect(sorted(ceilingForWorkRun(null, { allowed_side_effects: ['read'] }))).toEqual(sorted(computeWorkRunCeiling()))
  })
})

describe('rebuildWorkRunSpec with a teammate', () => {
  it('composes the teammate’s persona after the base prompt, and advertises its narrowed ceiling', async () => {
    hoisted.row = {
      id: 'run-1',
      kind: 'workspace',
      origin: 'attempt',
      ai_team_member_id: 'tm-quill',
      teammate: { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: ['create_document', 'get_document'] },
    }
    const spec = await rebuildWorkRunSpec(CLAIMS)
    expect(hoisted.personaCalls).toEqual(['tm-quill'])
    expect(spec?.systemPrompt.startsWith('BASE PROMPT\n\n')).toBe(true)
    expect(spec?.systemPrompt).toContain('## Your role: Quill')
    expect(spec?.systemPrompt).toContain('You write crisp notes.')
    expect(spec?.ceilingTools.map((t) => t.name).sort()).toEqual(['create_document', 'get_document'])
  })

  it('a teammate whose persona cannot be read runs on the base prompt', async () => {
    hoisted.persona = null
    hoisted.row = { id: 'run-1', kind: 'workspace', origin: 'user', ai_team_member_id: 'tm-gone', teammate: null }
    const spec = await rebuildWorkRunSpec(CLAIMS)
    expect(spec?.systemPrompt).toBe(`BASE PROMPT\n\n${runStartSection('user')}`)
    expect(spec?.ceilingTools.map((t) => t.name).sort()).toEqual(sorted(computeWorkRunCeiling()))
  })

  it('no teammate: no persona read, the base prompt and the origin’s ceiling, as before', async () => {
    hoisted.row = { id: 'run-1', kind: 'workspace', origin: 'attempt', ai_team_member_id: null, teammate: null }
    const spec = await rebuildWorkRunSpec(CLAIMS)
    expect(hoisted.personaCalls).toEqual([])
    expect(spec?.systemPrompt).toBe(`BASE PROMPT\n\n${runStartSection('attempt')}`)
    expect(spec?.ceilingTools.map((t) => t.name).sort()).toEqual(sorted(computeDraftingCeiling()))
  })
})

describe('rebuildWorkRunSpec for chat-delegated work (migration 299)', () => {
  const correspondent = { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null }
  it('advertises only what the delegating chat could call, for the root and its handoffs', async () => {
    for (const origin of ['chat', 'delegation']) {
      hoisted.row = { id: 'run-1', kind: 'workspace', origin, chat_ceiling: ['create_document', 'get_document'], ai_team_member_id: 'tm', teammate: correspondent }
      const names = (await rebuildWorkRunSpec(CLAIMS))?.ceilingTools.map((t) => t.name).sort()
      expect(names, origin).toEqual(['create_document', 'get_document'])
    }
  })
  it('a chat root with no recorded bound advertises no registry tools', async () => {
    hoisted.row = { id: 'run-1', kind: 'workspace', origin: 'chat', chat_ceiling: null, ai_team_member_id: 'tm', teammate: correspondent }
    expect((await rebuildWorkRunSpec(CLAIMS))?.ceilingTools).toEqual([])
  })
})

describe('how the run started (row 9)', () => {
  it('a person’s Start says so; an attempt is told it is an unrequested first pass', () => {
    expect(runStartSection('user')).toContain('A person reviewed this work and pressed Start')
    const attempt = runStartSection('attempt')
    expect(attempt).toContain('Nobody has asked for this run yet')
    expect(attempt).toContain('unrequested')
    expect(attempt).toContain('Do not pause to ask questions')
    expect(attempt).not.toContain('pressed Start')
  })

  it('the same split as the ceiling: no origin is a person’s Start, any other origin a first pass', () => {
    expect(runStartSection(null)).toBe(runStartSection('user'))
    expect(runStartSection(undefined)).toBe(runStartSection('user'))
    expect(runStartSection('something-new')).toBe(runStartSection('attempt'))
  })

  it('a delegated child is told a teammate handed it the work and is waiting, and not to ask', () => {
    const delegated = runStartSection('delegation')
    expect(delegated).toContain('A teammate handed you this piece of their work')
    expect(delegated).toContain('Do not pause to ask questions')
    expect(delegated).toContain('finish_work')
    expect(delegated).not.toContain('pressed Start')
    expect(delegated).not.toBe(runStartSection('attempt'))
  })

  it('is the prompt’s last section, after the persona', async () => {
    hoisted.row = {
      id: 'run-1',
      kind: 'workspace',
      origin: 'attempt',
      ai_team_member_id: 'tm-quill',
      teammate: { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null },
    }
    const prompt = (await rebuildWorkRunSpec(CLAIMS))?.systemPrompt ?? ''
    expect(prompt.endsWith(`\n\n${runStartSection('attempt')}`)).toBe(true)
    expect(prompt.indexOf('## Your role: Quill')).toBeLessThan(prompt.indexOf('## How this run started'))
  })
})
