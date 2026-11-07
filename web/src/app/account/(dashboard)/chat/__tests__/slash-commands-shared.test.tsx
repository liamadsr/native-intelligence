// @vitest-environment jsdom
/**
 * The workspace's skill commands are ONE request shared by every chat.
 *
 * Each chat panel has its own composer, and a launch or a workspace switch
 * mounts several at once. Each used to reset the shared cache (and its
 * in-flight guard) on mount and fetch again — a request and a whole-panel
 * re-render per chat, right after a switch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => ({
  workspaceId: 'ws-a' as string | null,
  syncs: new Set<() => void>(),
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => env.workspaceId }))
vi.mock('@/hooks/use-entity-sync', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    // Every mounted consumer hears a recipe change, as the real one does.
    useEntityListSync: (_types: string[], cb: () => void) => {
      const ref = useRef(cb)
      ref.current = cb
      useEffect(() => {
        const fire = () => ref.current()
        env.syncs.add(fire)
        return () => void env.syncs.delete(fire)
      }, [])
    },
  }
})
vi.mock('../picker-popover', () => ({ PickerPopover: () => null, pickerItemClassName: '' }))

type Module = typeof import('../slash-command-picker')
let mod: Module
let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
const seen: string[][] = []

function Chat({ n }: { n: number }) {
  const commands = mod.useRecipeCommands()
  seen[n] = commands.map((c) => c.slug)
  return null
}

const commandsFor = (ws: string | null) => [{ slug: `skill-of-${ws}`, name: 'Skill' }]
const skillCommandCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/account/skills/commands').length

async function mountChats(count: number) {
  await act(async () => {
    root.render(
      <>
        {Array.from({ length: count }, (_, n) => (
          <Chat key={n} n={n} />
        ))}
      </>,
    )
  })
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.resetModules()
  env.workspaceId = 'ws-a'
  env.syncs.clear()
  seen.length = 0
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ commands: commandsFor(env.workspaceId) }) }) as Response)
  vi.stubGlobal('fetch', fetchMock)
  mod = await import('../slash-command-picker')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the shared skill commands', () => {
  it('serves every chat of a workspace from one request', async () => {
    await mountChats(4)
    expect(skillCommandCalls()).toBe(1)
    expect(seen).toEqual(Array(4).fill(['skill-of-ws-a']))
  })

  it('reuses the answer for a chat mounted within a minute, and asks again after', async () => {
    await mountChats(1)
    vi.setSystemTime(Date.now() + 30_000)
    await mountChats(2)
    expect(skillCommandCalls()).toBe(1)
    vi.setSystemTime(Date.now() + 61_000)
    await mountChats(3)
    expect(skillCommandCalls()).toBe(2)
  })

  it('asks again for another workspace, and never serves it the last one', async () => {
    await mountChats(1)
    act(() => root.render(<></>))
    env.workspaceId = 'ws-b'
    await mountChats(2)
    expect(skillCommandCalls()).toBe(2)
    expect(seen[0]).toEqual(['skill-of-ws-b'])
  })

  it('refetches on a skill change — once, however many chats hear it', async () => {
    await mountChats(3)
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ commands: [{ slug: 'renamed', name: 'R' }] }) }) as Response)
    await act(async () => {
      for (const fire of env.syncs) fire()
    })
    expect(skillCommandCalls()).toBe(2)
    expect(seen).toEqual(Array(3).fill(['renamed']))
  })
})

describe('a composer that names its own workspace (bots v4: a teammate’s or a run’s chat)', () => {
  it('reads that workspace’s skills, with its header, cached apart from the window’s', async () => {
    const { ComposerWorkspaceContext } = await import('../composer-workspace')
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const ws = (init?.headers as Record<string, string> | undefined)?.['x-workspace-id'] ?? env.workspaceId
      return { ok: true, json: async () => ({ commands: commandsFor(ws) }) } as Response
    })
    await act(async () => {
      root.render(
        <>
          <Chat n={0} />
          <ComposerWorkspaceContext.Provider value="ws-teammate">
            <Chat n={1} />
            <Chat n={2} />
          </ComposerWorkspaceContext.Provider>
        </>,
      )
    })
    expect(seen[0]).toEqual(['skill-of-ws-a'])
    expect(seen[1]).toEqual(['skill-of-ws-teammate'])
    expect(seen[2]).toEqual(['skill-of-ws-teammate'])
    // One request per workspace; the composer's names its workspace on it.
    expect(skillCommandCalls()).toBe(2)
    const withHeader = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.headers)
    expect(withHeader).toHaveLength(1)
    expect((withHeader[0][1] as RequestInit).headers).toEqual({ 'x-workspace-id': 'ws-teammate' })
  })
})
