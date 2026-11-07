/**
 * The chat tells the model to choose each search's scope itself, and no longer
 * describes a person's "My captures" setting. The base prompt keeps the short
 * rule (search before answering, start narrow, widen when thin); how to widen
 * is `find`'s own guide, advertised with the tool (src/lib/ai/tool-guides.ts;
 * chat-run-rebuild-golden.test.ts holds the spec to it). The option names the
 * guidance uses are the tools' own.
 */
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../system-prompt'
import { createSearchTools } from '../tools/search'
import { toolGuide } from '../tool-guides'

function stubSupabase() {
  const result = { data: null, error: null }
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'eq', 'is', 'in', 'order', 'limit', 'not', 'gte', 'lte', 'neq']) chain[m] = () => chain
  chain.single = async () => result
  chain.maybeSingle = async () => result
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
  return chain as never
}

describe('the search scope guidance', () => {
  it('the base prompt says to search narrow first; find\'s guide says how to widen; the picker section is gone', async () => {
    const prompt = await buildSystemPrompt('user-1', stubSupabase(), undefined, { workspaceId: 'ws-1', webAccess: 'never' })
    expect(prompt).toContain('`find` is the front door')
    expect(prompt).toContain('Start narrow, widen when it comes back thin')
    const guide = toolGuide('find') ?? ''
    expect(guide).toContain('You choose the scope on every search')
    expect(guide).toContain('in the chat, no `since` or `all_time` covers the past 4 weeks of captures and emails')
    expect(guide).toContain('claims and documents are searched in full')
    expect(guide).toContain('`all_time: true`')
    expect(guide).toContain('`include_transcripts: true`')
    expect(guide).toContain('One focused pass, then widen if it comes back thin')
    for (const text of [prompt, guide]) {
      expect(text).not.toContain('## Search Time Window')
      expect(text).not.toContain('The user has set their search window')
      expect(text).not.toContain('expanded_search')
    }
  })

  it('names options the tools really take', () => {
    const t = createSearchTools('u', {} as never, 'w')
    const keys = (tool: { inputSchema: unknown }) => Object.keys((tool.inputSchema as { shape: Record<string, unknown> }).shape)
    expect(keys(t.find)).toEqual(expect.arrayContaining(['since', 'until', 'all_time', 'types']))
    expect(keys(t.deep_search)).toEqual(expect.arrayContaining(['since', 'until', 'all_time', 'include_transcripts', 'types']))
    expect(keys(t.deep_search)).not.toContain('expanded_search')
  })
})
