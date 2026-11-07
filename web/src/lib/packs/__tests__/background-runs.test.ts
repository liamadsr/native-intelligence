/**
 * The two background run prompts carry the area know-how: a skill run
 * (rebuildEveSpec, the skill-runner's spec) and a work run (rebuildWorkRunSpec,
 * the work-agent's), each behind the workspace's feature gate. The DB double
 * answers by table and selected columns, so a rebuild that stops asking for
 * `area` or `flow_id` loses the playbook and fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  settings: {} as unknown,
  skill: { name: 'Bridge', system_prompt: 'SKILL OWN PROMPT', agent_config: { enabled_tools: ['emails', 'contacts', 'calendar'] }, area: 'mail' as string | null },
  run: { id: 'run-1', kind: 'workspace', origin: 'user' as string | null, flow_id: 'loop-mail' as string | null, helper_areas: null as string[] | null },
  facts: [] as Array<{ id: string; text: string; importance: number; updated_at: string }>,
}))

type Result = { data: unknown; error: null }
function router(table: string) {
  let columns = ''
  const filters: Record<string, unknown> = {}
  const api: Record<string, unknown> = {}
  const list = (): Result => {
    if (table === 'recipe' && columns.includes('system_prompt')) {
      // The playbook read: system skills by slug.
      const slugs = (filters.slug as string[] | undefined) ?? []
      return { data: slugs.includes('mail-playbook') ? [{ slug: 'mail-playbook', area: 'mail', system_prompt: 'MAIL PLAYBOOK TEXT' }] : [], error: null }
    }
    if (table === 'recipe' && columns.includes('area')) return { data: [{ id: 'bridge', area: 'mail' }], error: null }
    if (table === 'profile_fact') return { data: h.facts, error: null }
    return { data: [], error: null }
  }
  const one = (): Result => {
    if (table === 'workspace') return { data: { settings: h.settings }, error: null }
    if (table === 'recipe') return { data: columns.includes('area') ? h.skill : { ...h.skill, area: undefined }, error: null }
    if (table === 'agent_run') {
      const run = columns.includes('flow_id') ? h.run : { ...h.run, flow_id: undefined }
      return { data: columns.includes('helper_areas') ? run : { ...run, helper_areas: undefined }, error: null }
    }
    if (table === 'flow') return { data: { actions: [{ type: 'run_skill', config: { skill_id: 'bridge' } }] }, error: null }
    return { data: null, error: null }
  }
  Object.assign(api, {
    select: (c: string) => ((columns = c), api),
    eq: (k: string, v: unknown) => ((filters[k] = v), api),
    or: () => api,
    is: () => api,
    in: (k: string, v: unknown[]) => ((filters[k] = v), api),
    limit: () => api,
    order: () => api,
    maybeSingle: async () => one(),
    single: async () => one(),
    then: (resolve: (r: Result) => unknown) => Promise.resolve(list()).then(resolve),
  })
  return api
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: (t: string) => router(t) }) }))
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: async () => 'BASE PROMPT' }))
vi.mock('@/lib/ai/gateway-telemetry', () => ({ gatewayTelemetryValues: () => null }))

import { rebuildEveSpec } from '@/lib/flows/skill-run-rebuild'
import { rebuildWorkRunSpec } from '@/lib/agent-run/run-work-spec-rebuild'

const skillClaims = {
  workspaceId: 'ws-1',
  runAsUserId: 'user-1',
  skillId: 'skill-1',
  mode: 'report' as const,
  hasCapture: false,
  outputContract: 'prose' as const,
  model: 'claude-haiku-4-5-20251001',
  exp: Date.now() + 60_000,
}
const workClaims = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 600_000 }

beforeEach(() => {
  h.settings = {}
  h.skill.area = 'mail'
  h.run.flow_id = 'loop-mail'
  h.run.helper_areas = null
  h.run.origin = 'user'
  h.facts = []
})

describe('a skill run gets its area’s playbook', () => {
  it('after the skill’s own prompt, before the base prompt', async () => {
    const spec = await rebuildEveSpec(skillClaims)
    const prompt = spec!.systemPrompt
    expect(prompt).toContain('## Expertise: Mail\n\nMAIL PLAYBOOK TEXT')
    expect(prompt.indexOf('SKILL OWN PROMPT')).toBeLessThan(prompt.indexOf('MAIL PLAYBOOK TEXT'))
    expect(prompt.indexOf('MAIL PLAYBOOK TEXT')).toBeLessThan(prompt.indexOf('BASE PROMPT'))
  })

  it('not when the workspace has Email off', async () => {
    h.settings = { edition: 'full', feature_overrides: { email: 'off' } }
    expect((await rebuildEveSpec(skillClaims))!.systemPrompt).not.toContain('MAIL PLAYBOOK TEXT')
  })

  it('not for a skill with no area whose tools span many areas', async () => {
    h.skill.area = null
    expect((await rebuildEveSpec(skillClaims))!.systemPrompt).not.toContain('Expertise:')
  })
})

describe('a work run gets its loop’s area playbook', () => {
  it('a run of a loop whose skill is a Mail skill', async () => {
    const spec = await rebuildWorkRunSpec(workClaims)
    expect(spec!.systemPrompt).toContain('MAIL PLAYBOOK TEXT')
    expect(spec!.systemPrompt.indexOf('MAIL PLAYBOOK TEXT')).toBeLessThan(spec!.systemPrompt.indexOf('## How this run started'))
  })

  it('a run with no loop gets none', async () => {
    h.run.flow_id = null
    expect((await rebuildWorkRunSpec(workClaims))!.systemPrompt).not.toContain('Expertise:')
  })
})

describe('a background helper gets its thread areas and what the person told the assistant (A4)', () => {
  it('a helper with no loop and no teammate loads its own areas\' playbooks (agent_run.helper_areas)', async () => {
    h.run.flow_id = null
    h.run.helper_areas = ['mail']
    const prompt = (await rebuildWorkRunSpec(workClaims))!.systemPrompt
    expect(prompt).toContain('MAIL PLAYBOOK TEXT')
  })

  it('"About the person" from the profile facts, fenced, after the expertise and before how the run started (a chat-started helper)', async () => {
    h.run.origin = 'chat'
    h.facts = [{ id: 'f1', text: 'Prefers short emails', importance: 3, updated_at: '2026-10-01' }]
    const prompt = (await rebuildWorkRunSpec(workClaims))!.systemPrompt
    expect(prompt).toContain('## About the person')
    expect(prompt).toContain('<about_the_person>\n- Prefers short emails\n</about_the_person>')
    expect(prompt.indexOf('MAIL PLAYBOOK TEXT')).toBeLessThan(prompt.indexOf('## About the person'))
    expect(prompt.indexOf('## About the person')).toBeLessThan(prompt.indexOf('## How this run started'))
  })

  it('ranked and capped by selectProfileFacts: most important first, then newest, within the character budget', async () => {
    h.run.origin = 'chat'
    h.facts = [
      { id: 'f1', text: 'Low and old', importance: 1, updated_at: '2026-01-01' },
      { id: 'f2', text: 'High', importance: 5, updated_at: '2026-01-01' },
      { id: 'f3', text: 'x'.repeat(4_100), importance: 5, updated_at: '2026-10-01' },
      { id: 'f4', text: 'Mid, newer', importance: 3, updated_at: '2026-09-01' },
    ]
    const prompt = (await rebuildWorkRunSpec(workClaims))!.systemPrompt
    const block = prompt.slice(prompt.indexOf('<about_the_person>'), prompt.indexOf('</about_the_person>'))
    expect(block.split('\n').slice(1).filter(Boolean)).toEqual(['- High', '- Mid, newer', '- Low and old'])
  })

  it('never for a loop, flow, automation or person-started run (their drafts other members can see)', async () => {
    h.facts = [{ id: 'f1', text: 'Prefers short emails', importance: 3, updated_at: '2026-10-01' }]
    for (const origin of ['user', 'loop', 'attempt', 'delegation', null]) {
      h.run.origin = origin as never
      expect((await rebuildWorkRunSpec(workClaims))!.systemPrompt, String(origin)).not.toContain('About the person')
    }
  })

  it('no facts, no section', async () => {
    h.run.origin = 'chat'
    expect((await rebuildWorkRunSpec(workClaims))!.systemPrompt).not.toContain('About the person')
  })
})
