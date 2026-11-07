/**
 * Every eve agent that runs a free user on their ChatGPT plan keeps a copy of
 * lib/chatgpt-plan-model.ts (an agent bundles only its own folder). The
 * copies must stay byte-identical: the plan's request shape, the Gateway
 * guard and the secret handling are one decision, not one per agent.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const AGENTS = join(__dirname, '../../..')
const copies = readdirSync(AGENTS)
  .map((name) => join(AGENTS, name, 'lib', 'chatgpt-plan-model.ts'))
  .filter((path) => existsSync(path))

describe('chatgpt-plan-model copies', () => {
  it('exist in every agent that runs a free user on their plan', () => {
    const owners = copies.map((path) => path.split('/').at(-3))
    expect(owners).toEqual(expect.arrayContaining(['chat-agent', 'utility', 'work-agent', 'skill-runner', 'live-agent', 'local-agent', 'web-research', 'onboarding-researcher']))
  })

  it('are byte-identical', () => {
    const canonical = readFileSync(join(AGENTS, 'chat-agent', 'lib', 'chatgpt-plan-model.ts'), 'utf8')
    for (const path of copies) expect(readFileSync(path, 'utf8'), path).toBe(canonical)
  })
})
