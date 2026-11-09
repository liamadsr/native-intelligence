/**
 * Lines the main chat's prompt dropped as stale (10-27), kept out: there is no
 * nav to send the person to, no made-up skill names, "what did I miss?"
 * is their agents' work then the agent's own events (instructions.md), loops
 * do more than fire HTTP POSTs, and the main chat and its static instructions
 * open on the same always-on framing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSystemPrompt } from '../system-prompt'

function stubSupabase() {
  const result = { data: null, error: null }
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'eq', 'is', 'in', 'order', 'limit', 'not', 'gte', 'lte', 'neq']) chain[m] = () => chain
  chain.single = async () => result
  chain.maybeSingle = async () => result
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
  return chain as never
}

describe('the base prompt keeps its stale lines out', () => {
  it('no page URLs, no slash-command skills, no dashboard for "what did I miss?", no HTTP-POST-only loops', async () => {
    const prompt = await buildSystemPrompt('user-1', stubSupabase(), undefined, { workspaceId: 'ws-1', webAccess: 'never' })
    for (const stale of ['/account/wiki', '/api/account/', '/project-manager', 'What did I miss?', 'fire HTTP POSTs', "Native Intelligence's chat assistant"]) {
      expect(prompt, stale).not.toContain(stale)
    }
  })

  it('the base prompt and the static instructions open on the same always-on framing', async () => {
    const prompt = await buildSystemPrompt('user-1', stubSupabase(), undefined, { workspaceId: 'ws-1', webAccess: 'never' })
    expect(prompt).toContain("You are Assistant, the user's always-on agent in Native Intelligence, for them and their team.")
    // The person runs a skill by typing / and its name (chat-input.tsx); the agent loads one.
    expect(prompt).toContain('the person runs one by typing / and its name, and you load one with `load_skill`')
    const md = readFileSync(join(process.cwd(), 'agents/chat-agent/instructions.md'), 'utf8').replace(/\s+/g, ' ')
    expect(md).toContain("In the user's main in-app chat you are their always-on agent, under the name they gave you in Settings → Preferences (\"Assistant\" by default; Native Intelligence is the product)")
    expect(md).not.toContain("Native Intelligence's chat assistant")
  })
})
