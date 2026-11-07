/**
 * A skill run (a loop's step, a flow's skill) carries the workspace's words
 * (src/lib/editions/words.ts): the seeded Triage loop's report to a service
 * business says jobs and customers. Both prompt builders (assembleSkillRun and
 * the eve rebuild) share buildSkillSystemPrompt and skillRunWordsSection.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSkillSystemPrompt, skillRunWordsSection } from '../run-skill'

function workspaceWith(settings: unknown): SupabaseClient {
  const api: Record<string, unknown> = {
    select: () => api,
    eq: () => api,
    maybeSingle: async () => ({ data: { settings }, error: null }),
  }
  return { from: () => api } as unknown as SupabaseClient
}

describe('a skill run’s words', () => {
  it('a service business’s run gets the words section; another edition gets none', async () => {
    expect(await skillRunWordsSection(workspaceWith({ edition: 'service' }), 'ws-1')).toMatch(/^## Words to use\n/)
    expect(await skillRunWordsSection(workspaceWith({ edition: 'sales' }), 'ws-1')).toBe('')
    expect(await skillRunWordsSection(workspaceWith(null), 'ws-1')).toBe('')
  })

  it('sits after the skill’s own sections and its area know-how, above the base prompt', () => {
    const prompt = buildSkillSystemPrompt('Triage', 'SKILL_PROMPT', null as never, 'BASE_PROMPT', 'EXPERTISE', '## Words to use\nWORDS')
    expect(prompt.indexOf('SKILL_PROMPT')).toBeLessThan(prompt.indexOf('EXPERTISE'))
    expect(prompt.indexOf('EXPERTISE')).toBeLessThan(prompt.indexOf('## Words to use'))
    expect(prompt.indexOf('## Words to use')).toBeLessThan(prompt.indexOf('BASE_PROMPT'))
    // No words: the prompt is what it was.
    expect(buildSkillSystemPrompt('Triage', 'SKILL_PROMPT', null as never, 'BASE_PROMPT', 'EXPERTISE')).toBe(
      buildSkillSystemPrompt('Triage', 'SKILL_PROMPT', null as never, 'BASE_PROMPT', 'EXPERTISE', ''),
    )
  })
})
