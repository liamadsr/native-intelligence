/**
 * withTeammateIdentity (bots v2): a teammate chat's base prompt. Its opening
 * identity sentence ("You are Assistant, the user's always-on agent in Native Intelligence…") becomes the
 * teammate's own, and every rule after it stays byte for byte. Live on DEV a
 * teammate asked "Who are you?" answered as Native Intelligence's chat assistant while that
 * sentence still claimed to be Native Intelligence.
 */
import { describe, it, expect } from 'vitest'
import { buildSystemPromptParts, withTeammateIdentity } from '../system-prompt'

/** A service client with no rows: enough for the base prompt's parts. */
function emptyClient() {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) c[m] = () => c
    c.single = async () => ({ data: null, error: null })
    c.maybeSingle = async () => ({ data: null, error: null })
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
    return c
  }
  return { from: chain } as never
}

async function realBase(): Promise<string> {
  return (await buildSystemPromptParts('nobody', emptyClient(), undefined, { workspaceId: 'ws-none', webAccess: 'never' })).base
}

const NI_IDENTITY = "You are Assistant, the user's always-on agent in Native Intelligence, for them and their team."

describe('withTeammateIdentity', () => {
  it('swaps only the opening identity sentence for the teammate’s', async () => {
    const base = await realBase()
    expect(base.startsWith(`${NI_IDENTITY} You know their actions`)).toBe(true)
    const teammate = withTeammateIdentity(base, 'Triage')
    expect(teammate).toBe(`You are Triage, one of the user's AI teammates in Native Intelligence.${base.slice(NI_IDENTITY.length)}`)
    expect(teammate).not.toContain('You are Assistant,')
    expect(teammate).not.toContain("the user's always-on agent in Native Intelligence, for them and their team")
  })

  it('keeps a $ in the name literal (never a replacement pattern)', async () => {
    const teammate = withTeammateIdentity(await realBase(), "Cash $& $' Co")
    expect(teammate.startsWith("You are Cash $& $' Co, one of the user's AI teammates in Native Intelligence. You know their actions")).toBe(true)
  })

  it('a base without the sentence comes back as is', () => {
    expect(withTeammateIdentity('BASE_RULES', 'Triage')).toBe('BASE_RULES')
  })
})
