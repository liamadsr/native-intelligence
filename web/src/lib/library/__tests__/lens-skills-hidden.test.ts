/**
 * The lens skills (F3, migration 382) only run as a call loop's skill: the
 * library, the slash picker and the teammate skill picker leave them out,
 * and only the Flows editor's picker asks for them (review S6).
 */
import { describe, it, expect, vi } from 'vitest'

const calls: Array<[string, unknown[]]> = []
function recorder(): unknown {
  const target = {} as Record<string, unknown>
  const proxy: unknown = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      return (...args: unknown[]) => {
        calls.push([prop, args])
        return proxy
      }
    },
  })
  return proxy
}

vi.mock('@/lib/editions', () => ({ resolveWorkspaceEdition: async () => ({}), featureGatedRecipeExclusions: () => [] }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: { from: () => recorder() }, workspaceId: 'ws', user: { id: 'u' } }) }))

const { listLibraryItems } = await import('../queries')
const { GET: commandsGET } = await import('@/app/api/account/skills/commands/route')

const auth = () => ({ supabase: { from: () => recorder() }, workspaceId: 'ws', user: { id: 'u' } }) as never
const hidesLenses = () => calls.some(([m, a]) => m === 'is' && a[0] === 'agent_config->>lens' && a[1] === null)

describe('lens skills are hidden outside the Flows editor', () => {
  it('the library listing leaves them out by default', async () => {
    calls.length = 0
    await listLibraryItems(auth(), 'skill')
    expect(hidesLenses()).toBe(true)
  })

  it('the Flows editor asks for them', async () => {
    calls.length = 0
    await listLibraryItems(auth(), 'skill', { includeLenses: true })
    expect(hidesLenses()).toBe(false)
  })

  it('the slash picker never lists them', async () => {
    calls.length = 0
    await commandsGET()
    expect(hidesLenses()).toBe(true)
  })
})
