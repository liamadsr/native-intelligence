// @vitest-environment jsdom
/**
 * The agent, edited (agent-look-editor.tsx), opened from its bot or its
 * settings icon (agent-editor.tsx, one editor hosted once): from the saved
 * name and look; tiles of each part, the preview wearing the look being made,
 * the name under it; every tab the same height; the colours in one row; Save
 * keeps what changed on the account (the profile PATCH, stubbed) and every bot
 * of the agent's wears it, or says so when the account didn't take it;
 * Cancel keeps nothing; Start over goes back to the default look. The renderer
 * is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/hooks/use-watched', () => ({ useWatched: (active: boolean) => active }))
vi.mock('bot-avatars', async () => {
  const { createElement } = await import('react')
  const { AGENT_LOOK_TYPES } = await import('@/lib/bots/agent-look')
  return {
    botAvatarPresets: Object.fromEntries(AGENT_LOOK_TYPES.map((t) => [t, { label: t[0].toUpperCase() + t.slice(1) }])),
    BotAvatar: (p: Record<string, unknown>) => createElement('canvas', { 'data-stub-bot': p.type, 'data-props': JSON.stringify(p) }),
  }
})

const { AgentEditButton, AgentEditorHost, AgentLookButton, __resetAgentEditorForTests } = await import('../agent-editor')
const { __resetAssistantNameForTests, getAssistantName } = await import('@/lib/voice/assistant-name-store')
const { DEFAULT_AGENT_LOOK } = await import('@/lib/bots/agent-look')
const { AGENT_LOOK_STORAGE_KEY, __resetAgentLookForTests } = await import('@/lib/bots/agent-look-store')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
/** The account: the profile PATCH answers `profileOk`; everything else isn't there. */
let profileOk = true
const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
  url === '/api/account/profile' && init?.method === 'PATCH'
    ? new Response(JSON.stringify(profileOk ? { success: true } : { error: 'boom' }), { status: profileOk ? 200 : 500 })
    : new Response('{}', { status: 404 }),
)
/** The bodies of the profile PATCHes sent. */
const patched = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH').map(([, init]) => JSON.parse(String(init!.body)))
beforeEach(() => {
  profileOk = true
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.localStorage.clear()
  __resetAgentLookForTests()
  __resetAgentEditorForTests()
  __resetAssistantNameForTests()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const dialog = () => q('[data-agent-look-editor]')
const tile = (label: string) => q<HTMLButtonElement>(`[data-agent-look-editor] [data-look-tile="${label}"]`)!
const preview = () => JSON.parse(q('[data-look-preview] canvas')!.getAttribute('data-props')!) as Record<string, unknown>
const cardBot = () => JSON.parse(q('[data-agent-look-open] canvas')!.getAttribute('data-props')!) as Record<string, unknown>
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[data-agent-look-editor] button')].find((b) => b.textContent === text)!
const click = (el: HTMLElement) => act(async () => el.click())
/** Until `ready`: ticks, each its own act so React commits between them (the lazy modules land in one). */
async function until(ready: () => boolean) {
  for (let i = 0; i < 500 && !ready(); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 10))))
  expect(ready()).toBe(true)
}

async function open() {
  await act(async () =>
    root.render(
      <>
        <AgentLookButton name="Joseph" state="default" active size={56} />
        <AgentEditButton name="Joseph" />
        <AgentEditorHost />
      </>,
    ),
  )
  // The renderer and the editor are fetched on first use (lazyComponent): the first import takes a moment.
  await until(() => !!q('[data-agent-look-open] canvas'))
  const bot = q<HTMLButtonElement>('[data-agent-look-open]')!
  expect(bot.getAttribute('aria-label')).toBe('Change how Joseph looks')
  await click(bot)
  await until(() => !!dialog())
}

describe('the agent’s look editor', { timeout: 15_000 }, () => {
  it('opens from a click on the bot, from the saved look, the shapes on its first tab', async () => {
    await open()
    expect(dialog()!.textContent).toContain('Your agent')
    expect(document.body.querySelectorAll('[data-agent-look-editor] [data-look-tile]')).toHaveLength(18)
    expect(tile('Flower').getAttribute('aria-checked')).toBe('true')
    expect(preview()).toMatchObject({ ...DEFAULT_AGENT_LOOK, shading: 'fabric' })
    // Nothing to save, nothing to start over from.
    expect(q<HTMLButtonElement>('[data-look-save]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-look-reset]')!.disabled).toBe(true)
  })

  it('each tile is the look with that one part changed; a pick shows in the preview, Save keeps it and the bot wears it', async () => {
    await open()
    expect(JSON.parse(tile('Cat').querySelector('canvas')!.getAttribute('data-props')!)).toMatchObject({ ...DEFAULT_AGENT_LOOK, type: 'cat', shading: 'smooth', paused: true })
    await click(tile('Cat'))
    expect(preview().type).toBe('cat')
    expect(tile('Cat').getAttribute('aria-checked')).toBe('true')
    await click(button('Wear'))
    await click(tile('Crown'))
    await click(tile('Headphones'))
    await click(tile('Bow tie'))
    // The default wears no headphones: a click puts them on.
    expect(preview()).toMatchObject({ type: 'cat', hat: 'crown', headphones: true, bowTie: true })
    await click(q<HTMLButtonElement>('[data-look-save]')!)
    expect(JSON.parse(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)!)).toMatchObject({ type: 'cat', hat: 'crown', headphones: true, bowTie: true })
    expect(patched()).toEqual([{ agent_look: expect.objectContaining({ type: 'cat', hat: 'crown', headphones: true, bowTie: true }) }])
    expect(cardBot()).toMatchObject({ type: 'cat', hat: 'crown' })
  })

  it('says so when the account doesn’t take the look, and the bot keeps the one it had', async () => {
    profileOk = false
    await open()
    await click(tile('Cat'))
    await click(q<HTMLButtonElement>('[data-look-save]')!)
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('Couldn’t save. Try again.')
    expect(cardBot().type).toBe(DEFAULT_AGENT_LOOK.type)
    expect(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)).toBeNull()
    // A second try that lands closes the editor.
    profileOk = true
    await click(q<HTMLButtonElement>('[data-look-save]')!)
    await until(() => !dialog())
    expect(cardBot().type).toBe('cat')
  })

  it('materials: each tile in its own, a pick in the preview and saved', async () => {
    await open()
    await click(button('Material'))
    const tiles = [...document.body.querySelectorAll('[data-agent-look-editor] [data-look-tile]')].map((t) => t.getAttribute('data-look-tile'))
    expect(tiles).toEqual(['Fabric', 'Plastic', 'Smooth', 'Crisp', 'Flat'])
    expect(tile('Fabric').getAttribute('aria-checked')).toBe('true')
    expect(JSON.parse(tile('Plastic').querySelector('canvas')!.getAttribute('data-props')!).shading).toBe('plastic')
    await click(tile('Plastic'))
    expect(preview().shading).toBe('plastic')
    await click(q<HTMLButtonElement>('[data-look-save]')!)
    expect(JSON.parse(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)!).shading).toBe('plastic')
    expect(cardBot().shading).toBe('plastic')
  })

  it('colours: a swatch, or the shape’s own; the accessories black', async () => {
    await open()
    const violet = q<HTMLButtonElement>('[data-agent-look-editor] [data-look-color="#9A62FF"]')!
    expect(violet.getAttribute('aria-label')).toBe('Violet')
    await click(violet)
    expect(preview().color).toBe('#9A62FF')
    // The shape's own colour first, in its colour: none picked.
    const own = q<HTMLButtonElement>('[data-agent-look-editor] [data-look-color="own"]')!
    expect(own.getAttribute('aria-label')).toBe('Its own (Flower)')
    await click(own)
    expect(preview().color).toBeUndefined()
    expect(own.getAttribute('aria-checked')).toBe('true')
    // One row, every colour in it.
    const row = own.parentElement!
    expect(row.className).toContain('sm:flex-nowrap')
    expect(row.querySelectorAll('[role="radio"]')).toHaveLength(14)
    await click(button('Wear'))
    const black = q<HTMLButtonElement>('[data-agent-look-editor] [data-look-color="own"]')!
    expect(black.getAttribute('aria-label')).toBe('Black')
    await click(black)
    expect(preview().accessoryColor).toBeUndefined()
  })

  it('Cancel keeps nothing; Start over goes back to the default look', async () => {
    window.localStorage.setItem(AGENT_LOOK_STORAGE_KEY, JSON.stringify({ ...DEFAULT_AGENT_LOOK, type: 'ghost' }))
    __resetAgentLookForTests()
    await open()
    expect(preview().type).toBe('ghost')
    await click(tile('Star'))
    await click(button('Cancel'))
    expect(JSON.parse(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)!).type).toBe('ghost')
    await click(q<HTMLButtonElement>('[data-agent-look-open]')!)
    await until(() => !!dialog())
    // A fresh start from the saved look.
    expect(preview().type).toBe('ghost')
    await click(q<HTMLButtonElement>('[data-look-reset]')!)
    expect(preview()).toMatchObject({ ...DEFAULT_AGENT_LOOK })
    await click(q<HTMLButtonElement>('[data-look-save]')!)
    expect(JSON.parse(window.localStorage.getItem(AGENT_LOOK_STORAGE_KEY)!).type).toBe('flower')
  })

  it('closing puts the focus back on the bot, which says it opens a dialog and whether it is open', async () => {
    await open()
    const bot = q<HTMLButtonElement>('[data-agent-look-open]')!
    expect(bot.getAttribute('aria-haspopup')).toBe('dialog')
    expect(bot.getAttribute('aria-expanded')).toBe('true')
    await click(button('Cancel'))
    expect(dialog()).toBeNull()
    // Radix hands the focus back a tick after the dialog unmounts.
    await until(() => document.activeElement === bot)
    expect(bot.getAttribute('aria-expanded')).toBe('false')
  })

  it('arrow keys move the pick within a group (one tab stop each) and between the tabs', async () => {
    await open()
    const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
    // The picked shape is the shapes' one tab stop.
    expect(tile('Flower').tabIndex).toBe(0)
    expect(tile('Triangle').tabIndex).toBe(-1)
    tile('Flower').focus()
    await key(tile('Flower'), 'ArrowRight')
    expect(preview().type).toBe('triangle')
    expect(document.activeElement).toBe(tile('Triangle'))
    await key(tile('Triangle'), 'ArrowLeft')
    expect(preview().type).toBe('flower')
    // The tabs: Body → Material, and back round to Wear.
    const body = button('Body')
    expect(body.getAttribute('aria-controls')).toBe(q('[data-agent-look-editor] [data-look-panel]')!.id)
    body.focus()
    await key(body, 'ArrowRight')
    expect(button('Material').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(button('Material'))
    await key(button('Material'), 'ArrowLeft')
    await key(button('Body'), 'ArrowLeft')
    expect(button('Wear').getAttribute('aria-selected')).toBe('true')
    // Headphones and bow tie are checkboxes in a plain group.
    await click(button('Wear'))
    expect(tile('Headphones').closest('[role="group"]')).not.toBeNull()
    expect(tile('Headphones').closest('[role="radiogroup"]')).toBeNull()
  })

  it('picking the eyes a shape already has (no face set: eyes) changes nothing', async () => {
    const { face: _face, ...noFace } = DEFAULT_AGENT_LOOK
    window.localStorage.setItem(AGENT_LOOK_STORAGE_KEY, JSON.stringify({ ...noFace, type: 'cat' }))
    __resetAgentLookForTests()
    await open()
    await click(button('Face'))
    expect(tile('Eyes').getAttribute('aria-checked')).toBe('true')
    await click(tile('Eyes'))
    expect(q<HTMLButtonElement>('[data-look-save]')!.disabled).toBe(true)
  })

  it('every tab is the same height, so the dialog keeps its size', async () => {
    await open()
    const panel = () => q('[data-agent-look-editor] [data-look-panel]')!
    const classes = panel().className
    expect(classes).toContain('h-[328px]')
    for (const tab of ['Material', 'Face', 'Glasses', 'Wear', 'Body']) {
      await click(button(tab))
      expect(panel().className).toBe(classes)
    }
  })

  it('the name, under the preview: typed over and saved as the agent’s name; one that can’t be is said so, and nothing is saved', async () => {
    await open()
    const name = q<HTMLInputElement>('[data-agent-look-editor] [data-look-name]')!
    expect(name.value).toBe(getAssistantName())
    const type = (value: string) =>
      act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        set.call(name, value)
        name.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await type('R2 D2')
    expect(q<HTMLButtonElement>('[data-look-save]')!.disabled).toBe(false)
    await click(q<HTMLButtonElement>('[data-look-save]')!)
    expect(dialog()).not.toBeNull()
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(dialog()!.textContent).toContain('Use letters')
    expect(getAssistantName()).not.toBe('R2 D2')
    await type('Ada')
    expect(name.hasAttribute('aria-invalid')).toBe(false)
    // Enter saves.
    await act(async () => void name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await until(() => !dialog())
    expect(getAssistantName()).toBe('Ada')
    expect(patched()).toEqual([{ assistant_name: 'Ada' }])
  })

  it('the card’s bot rests behind the open editor (the preview is the one moving)', async () => {
    await open()
    const cardCanvas = () => q('[data-agent-look-open] canvas')!
    expect(JSON.parse(cardCanvas().getAttribute('data-props')!).paused).toBe(true)
    await click(button('Cancel'))
  })

  it('the name field: a long or padded name is explained, not cut short; Enter mid-composition doesn’t save', async () => {
    await open()
    const name = q<HTMLInputElement>('[data-agent-look-editor] [data-look-name]')!
    expect(name.maxLength).toBe(40)
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      set.call(name, 'Ada')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => void name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })))
    expect(dialog()).not.toBeNull()
    expect(getAssistantName()).not.toBe('Ada')
  })

  it('the panel going away closes the editor: it doesn’t come back open by itself', async () => {
    await open()
    await act(async () => root.render(<AgentLookButton name="Joseph" state="default" active size={56} />))
    await act(async () =>
      root.render(
        <>
          <AgentLookButton name="Joseph" state="default" active size={56} />
          <AgentEditorHost />
        </>,
      ),
    )
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))))
    expect(dialog()).toBeNull()
    expect(q('[data-agent-look-open]')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('the settings icon opens the same editor, on its first tab (Phone), and gets the focus back', async () => {
    await open()
    await click(button('Cancel'))
    const gear = q<HTMLButtonElement>('[data-agent-edit]')!
    expect(gear.getAttribute('aria-label')).toBe('Edit Joseph')
    expect(gear.getAttribute('aria-haspopup')).toBe('dialog')
    await click(gear)
    await until(() => !!dialog())
    expect(gear.getAttribute('aria-expanded')).toBe('true')
    expect(q('[data-agent-panel-tab="phone"]')!.getAttribute('aria-selected')).toBe('true')
    await click(button('Close'))
    await until(() => document.activeElement === gear)
  })
})
