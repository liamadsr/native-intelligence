// @vitest-environment jsdom
/**
 * A bot's page (teammate-chat-page.tsx; docs/plans/bots-v4.md Phase 1b) and
 * the dashboard's opener for it (teammate-chat-tab-bridge.tsx).
 *
 * The page: its header is the bot's (its face drawn in its state, its name
 * where the "Agents" breadcrumb was, its workspace, and the switcher when
 * several teammates wear the face); under it its chat on the left, the main
 * column (#611's: the teammate's thread with the main chat's composer), and
 * its work on the right (BotWork's cards, read through useBotWork while the
 * page is drawn). A narrow window shows Chat and Work as two tabs, in that
 * order: Chat unless what opened it asked for Work, and switching never
 * remounts the chat. While its own page is in front (its lists or one of its
 * items) it says so, for its bubble. A teammate the loaded roster doesn't hold
 * says it's not available.
 *
 * Phase 2, an item open on the page (`itemId`, bot-page/item-view.tsx): the
 * work side, on the right, is the item (the work item panel, embedded, as a
 * card in a wider column, stamped only while it's shown), the chat side, on
 * the left, the conversation about it, found from the item: a work run's chat
 * or a loop run's (RunChat on its parked session, once, never the run view),
 * a run asking a question (what's sent answers it), a refused or missing run
 * chat (the teammate's thread with the item attached). The way back returns
 * the right column to the lists (the card's onOpenItem(null)). A narrow
 * window opens an item on the item.
 *
 * The page is a card in the chat (P5, pages/bot-card.tsx): the card says
 * whether it is drawn and in front, and where its clicks go. (The bridge that
 * opens it is pinned in teammate-chat-tab-bridge.test.tsx.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({
  roster: [] as Array<{ id: string; name: string; workspace_id: string; bot_character: string | null; autonomy?: string | null; breaker?: unknown; voice?: string | null; agent_recipe_id?: string | null }>,
  rowsLoaded: true,
  counts: new Map<string, { running: number; needsYou: number; beckoning: string[] }>(),
  desktop: false,
  drawn: true,
  chats: [] as Array<Record<string, unknown>>,
  chatMounts: 0,
  /** Where the page sent its clicks (the card's onOpenItem / onSwitchTeammate). */
  openedItems: [] as unknown[],
  switched: [] as unknown[],
  runChats: [] as Array<Record<string, unknown>>,
  panels: [] as Array<Record<string, unknown>>,
  refusals: new Map<string, { status: number; code: string | null }>(),
  /** Each time a run's chat is asked for (the hook mounted with it). */
  runAsks: [] as string[],
  botWorkAsked: [] as Array<string | null>,
  botWork: null as null | Record<string, unknown>,
  botWorkProps: [] as Array<Record<string, unknown>>,
  /** Who the AI limit stopped (`work.aiLimited`: bots-v4 Phase 4b); null until an answer has said. */
  aiLimited: null as Map<string, string> | null,
  /** A local agent's conversation mounting (LocalAgentPanel), by session. */
  localMounts: [] as string[],
}))
vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({
    work: { roster: shared.roster, rows: shared.rowsLoaded ? [] : null, cardRows: [], aiLimited: shared.aiLimited },
    attention: { items: [], loaded: true },
    counts: shared.counts,
  }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaces: () => ({ workspaces: [{ id: 'ws-1', name: 'Acme' }, { id: 'ws-2', name: 'Side project' }], currentId: 'ws-1' }),
}))
vi.mock('@/app/account/(dashboard)/views/view-header', () => ({
  ViewHeader: ({ title }: { title: ReactNode }) => h('header', { 'data-view-header': '' }, title),
}))
vi.mock('@/components/views/unified-view-layout', () => ({ useIsWindowDrawn: () => shared.drawn }))
vi.mock('@/hooks/use-bot-work', () => ({
  useBotWork: (teammateId: string | null) => {
    shared.botWorkAsked.push(teammateId)
    return (
      shared.botWork ?? {
        rows: null,
        chips: {},
        teammate: null,
        mayResume: false,
        lastFinished: null,
        about: { skills: [], agent: null, loops: [] },
        loading: false,
        failed: false,
        refresh: async () => {},
      }
    )
  },
}))
vi.mock('../bot-page/bot-work', () => ({
  BotWork: (props: Record<string, unknown>) => {
    shared.botWorkProps.push(props)
    return h('div', { 'data-bot-work': props.teammateId as string })
  },
}))
vi.mock('../teammate-chat', async () => {
  const { useEffect } = await import('react')
  return {
    TeammateChat: (props: Record<string, unknown>) => {
      shared.chats.push(props)
      useEffect(() => {
        shared.chatMounts += 1
      }, [])
      return h('div', { 'data-teammate-chat': props.teammateId as string })
    },
  }
})
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => shared.desktop }))
// The bot's own voice when its teammate chose one (bots-v4 B2), else its face's.
vi.mock('@/lib/bots/bot-voice', () => ({ useBotVoice: (face: string, own?: string | null) => own ?? (face ? `voice-${face}` : null) }))
vi.mock('@/app/account/(dashboard)/views/cloud-run-view', () => ({
  CloudRunByIdView: () => h('div', { 'data-run-view': '' }),
}))
// The item, as its panel loads it (a test hands the row back through onItem).
vi.mock('@/components/work/work-item-detail-panel', () => ({
  WorkItemDetailPanel: (props: Record<string, unknown>) => {
    shared.panels.push(props)
    return h('div', { 'data-item-panel': props.itemId as string, 'data-embedded': String(props.embedded), 'data-shown': String(props.shown) })
  },
}))
// A run's chat, as its replay answers: refused, or there to be had. The real
// hook reads it as it mounts (and a refused one again at its next mount).
vi.mock('@/hooks/use-run-chat', async () => {
  const { useEffect } = await import('react')
  return {
    useRunChat: (runId: string | null) => {
      useEffect(() => {
        if (runId) shared.runAsks.push(runId)
      }, [runId])
      return runId ? { runId, refusal: shared.refusals.get(runId) ?? null, loading: false } : null
    },
  }
})

// A local agent's conversation (local-agents contract G), counted as it mounts.
vi.mock('@/components/local-agent/local-agent-panel', async () => {
  const { useEffect } = await import('react')
  return {
    LocalAgentPanel: (props: { sessionId: string }) => {
      useEffect(() => {
        shared.localMounts.push(props.sessionId)
      }, [props.sessionId])
      return h('div', { 'data-local-agent-panel': props.sessionId })
    },
  }
})

vi.mock('@/components/agent-run/run-chat', () => ({
  RunChat: (props: Record<string, unknown>) => {
    shared.runChats.push(props)
    return h('div', { 'data-run-chat': props.runId as string })
  },
}))

/**
 * The page's laid-out width (clientWidth, and the ResizeObserver entry's
 * contentRect), and its width on screen (getBoundingClientRect), which a
 * window's glide or the stack scales: the page must read the first.
 */
let pageWidth = 1200
let screenWidth: number | null = null
type RoEntry = { target: Element; contentRect: { width: number } }
let resize: ((entries: RoEntry[]) => void) | null = null
let observedEl: Element | null = null
class StubResizeObserver {
  constructor(cb: (entries: RoEntry[]) => void) {
    resize = cb
  }
  observe(el: Element) {
    observedEl = el
  }
  disconnect() {
    resize = null
  }
}

let container: HTMLDivElement
let root: Root
const realRect = HTMLElement.prototype.getBoundingClientRect
const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  shared.roster = [
    { id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research' },
    { id: 'tm-bo', name: 'Bo', workspace_id: 'ws-1', bot_character: null },
  ]
  shared.rowsLoaded = true
  shared.counts = new Map()
  shared.aiLimited = null
  shared.desktop = false
  shared.drawn = true
  shared.chats = []
  shared.chatMounts = 0
  shared.runChats = []
  shared.panels = []
  shared.refusals = new Map()
  shared.runAsks = []
  shared.openedItems = []
  shared.switched = []
  shared.botWorkAsked = []
  shared.botWork = null
  shared.botWorkProps = []
  shared.localMounts = []
  pageWidth = 1200
  screenWidth = null
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-teammate-chat-page') ? pageWidth : 0
    },
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const width = this.hasAttribute('data-teammate-chat-page') ? (screenWidth ?? pageWidth) : 0
    return { width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  HTMLElement.prototype.getBoundingClientRect = realRect
  if (realClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth)
  vi.unstubAllGlobals()
})

async function page(props: { teammateId: string; name: string; workspaceId: string | null; itemId?: string; itemTitle?: string }) {
  const { TeammateChatPage } = await import('../teammate-chat-page')
  await act(async () =>
    root.render(
      h(TeammateChatPage, {
        ...props,
        drawn: shared.drawn,
        onOpenItem: (item) => void shared.openedItems.push(item),
        onSwitchTeammate: (teammateId, focus) => void shared.switched.push({ teammateId, focus }),
      }),
    ),
  )
}
const ITEM = '11111111-1111-4111-8111-111111111111'
/** An item's row, as its panel loads it. */
function itemRow(over: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    workspace_id: 'ws-2',
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_review',
    title: 'Reply to Acme',
    agent_run_id: 'run-1',
    source: {},
    ai_team_member_id: 'tm-ada',
    created_at: '2026-10-06T08:00:00.000Z',
    ...over,
  }
}
/** The panel has loaded the item (or couldn't). */
async function loaded(row: Record<string, unknown> | null, failed = false) {
  await act(async () => (shared.panels.at(-1)!.onItem as (r: unknown, f: boolean) => void)(row, failed))
}
const q = (sel: string) => container.querySelector<HTMLElement>(sel)
/** The page's box changes size (a resize, a snap); `screen`: what a transform draws it at meanwhile. */
async function widthTo(px: number, screen: number | null = null) {
  pageWidth = px
  screenWidth = screen
  await act(async () => resize?.([{ target: observedEl!, contentRect: { width: px } }]))
}
const layout = () => q('[data-bot-page-layout]')!.getAttribute('data-bot-page-layout')
/** A narrow page's tab, by its label. */
const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent === label)!

describe('TeammateChatPage: the bot’s page', () => {
  it('its header is the agent’s: the agent mark, name where “Agents” was, workspace; its thread on the left, its work on the right', async () => {
    const { setTeammateChatUser } = await import('@/lib/bots/teammate-chat-tab')
    setTeammateChatUser({ avatarUrl: 'https://x/me.png', initials: 'LA' })
    await page({ teammateId: 'tm-ada', name: 'Old name', workspaceId: null })
    expect(q('[data-teammate-chat-page]')!.getAttribute('data-teammate-chat-page')).toBe('tm-ada')
    expect(q('[data-teammate-chat-page-name]')!.textContent).toBe('Ada')
    expect(q('[data-teammate-chat-page-workspace]')!.textContent).toBe('Side project')
    // No face, no initial: the agent mark.
    expect(q('[data-bot-page-face] [data-agent-icon]')).not.toBeNull()
    expect(q('[data-bot-page-face]')!.textContent).toBe('')
    expect(q('[data-bot-page-face] img, [data-bot-page-face] canvas')).toBeNull()
    // No "Agents" crumb: the page is the bot's.
    expect(q('[data-view-header]')!.textContent).not.toContain('Agents')
    // Two columns: its chat, the main one, on the left; then its work, a narrower column on the right.
    expect(layout()).toBe('columns')
    const chatColumn = q('[data-bot-page-chat]')!
    const workColumn = q('[data-bot-page-work]')!
    expect(chatColumn.parentElement).toBe(workColumn.parentElement)
    expect(chatColumn.compareDocumentPosition(workColumn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chatColumn.className).toContain('flex-1')
    expect(workColumn.className).toContain('shrink-0')
    // The work column scrolls as a whole.
    expect(workColumn.className).toContain('overflow-y-auto')
    expect(q('[data-bot-page-work] [data-bot-work]')!.getAttribute('data-bot-work')).toBe('tm-ada')
    expect(q('[data-bot-page-chat] [data-teammate-chat]')!.getAttribute('data-teammate-chat')).toBe('tm-ada')
    expect(q('[role="tablist"]')).toBeNull()
    expect(shared.chats.at(-1)).toMatchObject({
      teammateId: 'tm-ada',
      workspaceId: 'ws-2',
      userAvatarUrl: 'https://x/me.png',
      userInitials: 'LA',
      voice: undefined,
    })
    // The main chat's sizes, not the bubble's, and its composer (#611).
    expect(shared.chats.at(-1)!.density).toBeUndefined()
    expect(shared.chats.at(-1)!.composer).toBe('full')
  })

  it('reads its work while drawn, and hands it to the work column', async () => {
    shared.botWork = {
      rows: [],
      chips: {},
      teammate: { id: 'tm-ada', autonomy: 'attempt', breaker: null },
      mayResume: true,
      lastFinished: null,
      about: { skills: [], agent: null, loops: [] },
      loading: false,
      failed: false,
      refresh: async () => {},
    }
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(shared.botWorkAsked.at(-1)).toBe('tm-ada')
    expect(shared.botWorkProps.at(-1)).toMatchObject({ teammateId: 'tm-ada', name: 'Ada', mate: { id: 'tm-ada' }, work: shared.botWork, aiLimit: false })
  })

  it('keeps its read while its window is out of sight for a moment (no reload, no skeleton), and lets it go after', async () => {
    vi.useFakeTimers()
    try {
      const { BOT_PAGE_LINGER_MS } = await import('@/lib/bots/bot-page')
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
      expect(shared.botWorkAsked.at(-1)).toBe('tm-ada')
      // A tab flipped, the windows tucked: still asked for, so nothing is dropped.
      shared.drawn = false
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
      expect(shared.botWorkAsked.at(-1)).toBe('tm-ada')
      // Back within the moment: the same read, never asked for no one in between.
      shared.drawn = true
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
      expect(shared.botWorkAsked.every((id) => id === 'tm-ada')).toBe(true)
      // Out of sight for longer: let go.
      shared.drawn = false
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
      await act(async () => {
        vi.advanceTimersByTime(BOT_PAGE_LINGER_MS + 1)
      })
      expect(shared.botWorkAsked.at(-1)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says it is working while one of its runs runs, asleep while switched off or stopped by the AI limit', async () => {
    shared.counts = new Map([['tm:tm-ada', { running: 1, needsYou: 0, beckoning: [] }]])
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-face]')!.getAttribute('data-bot-page-face')).toBe('working')
    expect(q('[data-teammate-chat-page-name]')!.textContent).toContain('working')

    shared.counts = new Map()
    shared.roster = [{ id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', autonomy: 'off', breaker: null }]
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-face]')!.getAttribute('data-bot-page-face')).toBe('sleeping')

    shared.roster = [{ id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', autonomy: 'attempt', breaker: null }]
    const now = new Date().toISOString()
    shared.botWork = {
      rows: [],
      chips: {},
      teammate: null,
      mayResume: false,
      lastFinished: { id: 'r1', status: 'failed', error_message: 'Plan AI usage limit reached', finished_at: now, created_at: now },
      about: { skills: [], agent: null, loops: [] },
      loading: false,
      failed: false,
      refresh: async () => {},
    }
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-face]')!.getAttribute('data-bot-page-face')).toBe('sleeping')
    expect(shared.botWorkProps.at(-1)).toMatchObject({ aiLimit: true })
  })

  // bots-v4 Phase 4b: the page says which rest, and agrees with its bot beside the chat.
  it('asleep, its header says which: switched off, attempts paused, or stopped by the AI limit (its last row, or the shared source)', async () => {
    shared.roster = [{ id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', autonomy: 'off', breaker: null }]
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-status]')!.textContent).toBe('Switched off')
    expect(q('[data-bot-page-face]')!.getAttribute('title')).toBe('Switched off')

    shared.roster = [{ id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', autonomy: 'attempt', breaker: { paused: true, window: 5 } }]
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-status]')!.textContent).toBe('Attempts paused')

    // Its own read holds nothing of it; the shared source says the limit stopped it.
    shared.roster = [{ id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', autonomy: 'attempt', breaker: null }]
    shared.aiLimited = new Map([['tm-ada', new Date().toISOString()]])
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-face]')!.getAttribute('data-bot-page-face')).toBe('sleeping')
    expect(q('[data-bot-page-status]')!.textContent).toBe('Stopped by the AI limit')
    expect(shared.botWorkProps.at(-1)).toMatchObject({ aiLimit: true })

    // Awake: nothing said.
    shared.aiLimited = new Map()
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-status]')).toBeNull()
  })

  // Review of #650: one rule with its bot beside the chat. While the shared
  // source holds an answer, the page trusts it over its own last row (a later
  // run, even one waiting on you, woke it there).
  it('trusts the shared source’s answer on the AI limit over its own last row; its last row only until the source has said', async () => {
    shared.roster = [{ id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', autonomy: 'attempt', breaker: null }]
    const now = new Date().toISOString()
    shared.botWork = {
      rows: [],
      chips: {},
      teammate: null,
      mayResume: false,
      lastFinished: { id: 'r1', status: 'failed', error_message: 'Plan AI usage limit reached', finished_at: now, created_at: now },
      about: { skills: [], agent: null, loops: [] },
      loading: false,
      failed: false,
      refresh: async () => {},
    }
    // The source has said: nobody's stopped.
    shared.aiLimited = new Map()
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-face]')!.getAttribute('data-bot-page-face')).toBe('default')
    expect(q('[data-bot-page-status]')).toBeNull()
    expect(shared.botWorkProps.at(-1)).toMatchObject({ aiLimit: false })
    // Not yet: its own last row says so.
    shared.aiLimited = null
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-status]')!.textContent).toBe('Stopped by the AI limit')
  })

  it('with this agent in other workspaces, the switcher moves the page to the one picked; an agent that only shares its face is not in it', async () => {
    shared.roster = [
      { id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', agent_recipe_id: 'p-research' },
      { id: 'tm-ada-acme', name: 'Ada', workspace_id: 'ws-1', bot_character: 'research', agent_recipe_id: 'p-research' },
      // Same (invisible) face, different agent: never a chip.
      { id: 'tm-cy', name: 'Cy', workspace_id: 'ws-1', bot_character: 'research', agent_recipe_id: 'p-other' },
      { id: 'tm-bo', name: 'Bo', workspace_id: 'ws-1', bot_character: null },
    ]
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-switcher]')!.getAttribute('aria-label')).toBe('This agent in other workspaces')
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-bot-page-switcher] button'))
    // Same name: each says its workspace, the one on screen (Acme) first.
    expect(chips.map((c) => c.textContent)).toEqual(['Acme', 'Side project'])
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    await act(async () => chips[0].click())
    expect(shared.switched).toEqual([{ teammateId: 'tm-ada-acme', focus: 'chat' }])

    // On one of its items too.
    shared.switched = []
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2', itemId: ITEM, itemTitle: 'Reply to Acme' })
    await act(async () => container.querySelector<HTMLButtonElement>('[data-bot-page-switcher] button')!.click())
    expect(shared.switched).toHaveLength(1)
    expect(shared.switched[0]).toMatchObject({ teammateId: 'tm-ada-acme' })
  })

  it('no switcher for an agent in one workspace only, even when another agent holds its face', async () => {
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-switcher]')).toBeNull()
    shared.roster = [
      { id: 'tm-ada', name: 'Ada', workspace_id: 'ws-2', bot_character: 'research', agent_recipe_id: 'p-research' },
      { id: 'tm-cy', name: 'Cy', workspace_id: 'ws-1', bot_character: 'research', agent_recipe_id: 'p-other' },
    ]
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-switcher]')).toBeNull()
  })

  it('in a narrow window shows Chat and Work as two tabs, in that order, on Chat, without remounting the chat', async () => {
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(shared.chatMounts).toBe(1)
    await widthTo(600)
    expect(layout()).toBe('tabs')
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.map((t) => t.textContent)).toEqual(['Chat', 'Work'])
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    expect(q('[data-bot-page-chat]')!.hidden).toBe(false)
    expect(q('[data-bot-page-work]')!.hidden).toBe(true)
    expect(q('[data-bot-page-chat]')!.getAttribute('role')).toBe('tabpanel')

    await act(async () => tabs[1].click())
    expect(q('[data-bot-page-work]')!.hidden).toBe(false)
    expect(q('[data-bot-page-chat]')!.hidden).toBe(true)
    // The arrow keys move between them (past the last, back to the first), focus going along.
    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(q('[data-bot-page-chat]')!.hidden).toBe(false)
    expect(document.activeElement).toBe(tabs[0])
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(q('[data-bot-page-work]')!.hidden).toBe(false)
    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(q('[data-bot-page-chat]')!.hidden).toBe(false)

    // Wide again: both columns, and the chat was never remounted.
    await widthTo(900)
    expect(layout()).toBe('columns')
    expect(q('[data-bot-page-work]')!.hidden).toBe(false)
    expect(q('[data-bot-page-chat]')!.hidden).toBe(false)
    expect(shared.chatMounts).toBe(1)
  })

  it('reads its laid-out width, not the width a glide or the stack draws it at', async () => {
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    // Snapped to a narrow card: its box is 600 px while the glide still draws it at 1200.
    await widthTo(600, 1200)
    expect(layout()).toBe('tabs')
    // Back to a wide box, drawn scaled down as it recedes in the stack.
    await widthTo(1000, 700)
    expect(layout()).toBe('columns')
  })

  it('a page opening in a narrow window is tabs from the start (measured before it paints)', async () => {
    pageWidth = 600
    // Drawn mid-landing at a wider size: not what it lays out at.
    screenWidth = 1100
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(layout()).toBe('tabs')
  })

  it('keeps its layout at the edge: back to columns takes a little more room than staying', async () => {
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    const { BOT_PAGE_COLUMNS_MIN_PX } = await import('../bot-page/use-page-columns')
    await widthTo(BOT_PAGE_COLUMNS_MIN_PX)
    expect(layout()).toBe('columns')
    await widthTo(BOT_PAGE_COLUMNS_MIN_PX - 1)
    expect(layout()).toBe('tabs')
    await widthTo(BOT_PAGE_COLUMNS_MIN_PX + 10)
    expect(layout()).toBe('tabs')
  })

  it('a narrow page opened as its page (openBotPage) shows its Work', async () => {
    pageWidth = 600
    const { OPEN_TEAMMATE_CHAT_EVENT } = await import('@/lib/bots/teammate-chat-tab')
    const take = (e: Event) => e.preventDefault()
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    try {
      const { openBotPage } = await import('@/lib/bots/bot-page')
      // Asked just before the page mounts (the tab's window opening).
      expect(openBotPage('tm-ada')).toBe(true)
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
      expect(q('[data-bot-page-work]')!.hidden).toBe(false)
      expect(q('[data-bot-page-chat]')!.hidden).toBe(true)
      expect(tab('Work').getAttribute('aria-selected')).toBe('true')
      // And asked again while it's open.
      await act(async () => {
        openBotPage('tm-ada', { focus: 'chat' })
      })
      expect(q('[data-bot-page-chat]')!.hidden).toBe(false)
    } finally {
      window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    }
  })

  it('an item opens on the item (Work) in a narrow window, even with a fresh ask for Chat, and leaves that ask for no one else', async () => {
    pageWidth = 600
    const { OPEN_TEAMMATE_CHAT_EVENT } = await import('@/lib/bots/teammate-chat-tab')
    const take = (e: Event) => e.preventDefault()
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    try {
      const { openBotPage } = await import('@/lib/bots/bot-page')
      expect(openBotPage('tm-ada', { focus: 'chat' })).toBe(true)
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2', itemId: ITEM, itemTitle: 'Reply to Acme' })
      expect(q('[data-bot-page-work]')!.hidden).toBe(false)
      expect(q('[data-bot-page-chat]')!.hidden).toBe(true)
      // The item is on show, so it may be stamped (the panel's rule, `shown`).
      expect(shared.panels.at(-1)).toMatchObject({ itemId: ITEM, embedded: true, shown: true })
      // Its chat a tab away: then the item isn't on show, and isn't stamped.
      await act(async () => tab('Chat').click())
      expect(q('[data-bot-page-chat]')!.hidden).toBe(false)
      expect(shared.panels.at(-1)).toMatchObject({ shown: false })
    } finally {
      window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    }
  })

  it('a page that showed its Chat moves to an item on the item', async () => {
    pageWidth = 600
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(q('[data-bot-page-chat]')!.hidden).toBe(false)
    // The same window, navigated to one of its items.
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2', itemId: ITEM, itemTitle: 'Reply to Acme' })
    expect(q('[data-bot-page-work]')!.hidden).toBe(false)
    expect(q('[data-bot-page-chat]')!.hidden).toBe(true)
  })

  it('takes the ask it applied: the same page opening again later shows its chat', async () => {
    pageWidth = 600
    const { OPEN_TEAMMATE_CHAT_EVENT } = await import('@/lib/bots/teammate-chat-tab')
    const take = (e: Event) => e.preventDefault()
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    try {
      const { openBotPage } = await import('@/lib/bots/bot-page')
      openBotPage('tm-ada')
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
      expect(q('[data-bot-page-work]')!.hidden).toBe(false)
      // Mounted again (a saved tab restored, a remount): nothing is asked any more.
      act(() => root.unmount())
      root = createRoot(container)
      await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
      expect(q('[data-bot-page-chat]')!.hidden).toBe(false)
      expect(q('[data-bot-page-work]')!.hidden).toBe(true)
    } finally {
      window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    }
  })

  it('in the desktop app, has the mic and the bot’s own voice', async () => {
    shared.desktop = true
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(shared.chats.at(-1)!.voice).toMatchObject({ ttsVoice: 'voice-research' })
  })

  it('in the desktop app, speaks in the voice its teammate chose (bots-v4 B2), off the roster', async () => {
    shared.desktop = true
    shared.roster = shared.roster.map((t) => (t.id === 'tm-ada' ? { ...t, voice: 'lori' } : t))
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(shared.chats.at(-1)!.voice).toMatchObject({ ttsVoice: 'lori' })
  })

  it('uses the entry’s name and workspace until the roster loads, and opens no chat until it knows the teammate', async () => {
    shared.rowsLoaded = false
    shared.roster = []
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-1' })
    expect(q('[data-teammate-chat-page-name]')!.textContent).toBe('Ada')
    expect(q('[data-teammate-chat-page-workspace]')!.textContent).toBe('Acme')
    // Pending, not an error: no chat (an area face's id, or the agent before its hand-off is known, would open the wrong one).
    expect(q('[data-teammate-chat-page-pending]')).not.toBeNull()
    expect(q('[data-teammate-chat-page-missing]')).toBeNull()
    expect(shared.chats).toEqual([])
  })

  it('a teammate the loaded roster doesn’t hold isn’t opened: it says so, and reads nothing', async () => {
    await page({ teammateId: 'tm-gone', name: 'Gone', workspaceId: null })
    expect(q('[data-teammate-chat-page-missing]')!.textContent).toContain('isn’t available')
    expect(q('[data-teammate-chat]')).toBeNull()
    expect(q('[data-bot-work]')).toBeNull()
    expect(shared.chats).toEqual([])
    expect(shared.botWorkAsked.every((id) => id === null)).toBe(true)
  })

  it('with a teammate the roster doesn’t hold, an item isn’t opened either', async () => {
    await page({ teammateId: 'tm-gone', name: 'Gone', workspaceId: null, itemId: ITEM, itemTitle: 'x' })
    expect(q('[data-item-panel]')).toBeNull()
    expect(q('[data-teammate-chat-page-missing]')).not.toBeNull()
  })
})

// docs/plans/bots-v4.md "An item opens on its bot's page" (Phase 2).
describe('TeammateChatPage: an item open on it', () => {
  const open = (over: Record<string, unknown> = {}) =>
    page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2', itemId: ITEM, itemTitle: 'Reply to Acme', ...over })

  it('the item on the work side (its panel, embedded, in a wider column) and the header names it; not the bot’s lists', async () => {
    await open()
    expect(q('[data-teammate-chat-page-item]')!.getAttribute('data-teammate-chat-page-item')).toBe(ITEM)
    expect(q('[data-bot-page-work]')!.getAttribute('data-bot-page-work')).toBe('item')
    expect(q('[data-bot-page-work] [data-item-panel]')!.getAttribute('data-item-panel')).toBe(ITEM)
    expect(q('[data-bot-page-work] [data-item-panel]')!.getAttribute('data-embedded')).toBe('true')
    expect(q('[data-bot-work]')).toBeNull()
    expect(q('[data-bot-page-work]')!.className).toContain('w-[clamp(22rem,46%,34rem)]')
    expect(q('[data-teammate-chat-page-item-title]')!.textContent).toBe('Reply to Acme')
    // Its chat waits for the item (whose run it continues), with no teammate thread meanwhile.
    expect(q('[data-bot-page-item-chat]')!.getAttribute('data-bot-page-item-chat')).toBe('loading')
    expect(shared.chats).toEqual([])
  })

  it('a work run’s item: its run’s chat, its parked session (RunChat on its agent run), once; never the run view', async () => {
    const { setTeammateChatUser } = await import('@/lib/bots/teammate-chat-tab')
    setTeammateChatUser({ avatarUrl: 'https://x/me.png', initials: 'LA' })
    await open()
    await loaded(itemRow())
    expect(q('[data-bot-page-item-chat]')!.getAttribute('data-bot-page-item-chat')).toBe('run')
    expect(q('[data-bot-page-chat] [data-run-chat]')!.getAttribute('data-run-chat')).toBe('run-1')
    expect(container.querySelectorAll('[data-run-chat]')).toHaveLength(1)
    expect(q('[data-run-view]')).toBeNull()
    expect(shared.runChats.at(-1)).toMatchObject({ runId: 'run-1', workspaceId: 'ws-2', agentName: 'Ada', userAvatarUrl: 'https://x/me.png', userInitials: 'LA', autoFocus: true })
    expect(shared.chats).toEqual([])
    // Its "About:" line, and the way to the teammate's own thread for this item, and back.
    expect(q('[data-bot-page-item-chat]')!.textContent).toContain('About: Reply to Acme')
    await act(async () => q('[data-bot-page-item-own-chat]')!.click())
    expect(q('[data-run-chat]')).toBeNull()
    expect(shared.chats.at(-1)).toMatchObject({ teammateId: 'tm-ada', composer: 'full', about: { runId: 'run-1', context: { workItemId: ITEM }, title: 'Reply to Acme', off: true } })
    await act(async () => (shared.chats.at(-1)!.onAboutChange as (on: boolean) => void)(true))
    expect(q('[data-run-chat]')!.getAttribute('data-run-chat')).toBe('run-1')
  })

  it('a loop run’s item: its chat on the loop id (bots v3 Phase 4), its route the loop run’s', async () => {
    await open()
    await loaded(itemRow({ kind: 'flow_run', agent_run_id: null, source: { run_chat: true }, title: 'Weekly brief' }))
    expect(q('[data-run-chat]')!.getAttribute('data-run-chat')).toBe(`loop:${ITEM}`)
    expect(shared.runChats.at(-1)).toMatchObject({ workspaceId: 'ws-2', agentName: 'Ada' })
    const { runChatRoute } = await import('@/lib/agent-run/run-chat-ref')
    expect(runChatRoute(`loop:${ITEM}`)).toBe(`/api/account/activity/${ITEM}/chat`)
  })

  it('a run waiting on an answer: the teammate’s chat, what’s sent answering it', async () => {
    await open()
    await loaded(itemRow({ status: 'needs_input' }))
    expect(q('[data-run-chat]')).toBeNull()
    expect(shared.chats.at(-1)).toMatchObject({
      teammateId: 'tm-ada',
      about: { runId: 'run-1', asking: true, workspaceId: 'ws-2', title: 'Reply to Acme', off: false },
    })
  })

  it('a run whose chat the route refuses (someone else started it, still running): the teammate’s thread, the run attached, saying why', async () => {
    shared.refusals.set('run-1', { status: 403, code: null })
    await open()
    await loaded(itemRow())
    expect(q('[data-run-chat]')).toBeNull()
    // TeammateChat reads the same refusal and says why (runChatRefusalLine).
    expect(shared.chats.at(-1)).toMatchObject({ about: { runId: 'run-1', context: { workItemId: ITEM }, off: false } })
  })

  it('a run that settles while its item is open asks for its chat again, and has it', async () => {
    // Still running: the route refuses its chat (not settled), so the teammate's thread.
    shared.refusals.set('run-1', { status: 409, code: 'NOT_TERMINAL' })
    await open()
    await loaded(itemRow({ status: 'running' }))
    expect(q('[data-run-chat]')).toBeNull()
    const asks = shared.runAsks.filter((id) => id === 'run-1').length
    // It settles (a pushed row): asked again, and now there to be had.
    shared.refusals.delete('run-1')
    await loaded(itemRow({ status: 'needs_review' }))
    expect(shared.runAsks.filter((id) => id === 'run-1').length).toBeGreaterThan(asks)
    expect(q('[data-run-chat]')!.getAttribute('data-run-chat')).toBe('run-1')
  })

  it('a local agent’s turn: its session’s own conversation, not the teammate’s thread; the work side doesn’t draw it again', async () => {
    const SESSION = '22222222-3333-4444-8555-666666666666'
    await open()
    const local = { kind: 'local_agent', agent_run_id: null, title: 'Your Mac · dial8-website: Look around', source: { local_agent_session_id: SESSION } }
    await loaded(itemRow({ ...local, status: 'running' }))
    expect(q('[data-bot-page-item-chat]')!.getAttribute('data-bot-page-item-chat')).toBe('local-agent')
    expect(q('[data-bot-page-chat] [data-local-agent-panel]')!.getAttribute('data-local-agent-panel')).toBe(SESSION)
    expect(shared.chats).toEqual([])
    expect(q('[data-run-chat]')).toBeNull()
    expect(shared.panels.at(-1)).toMatchObject({ itemId: ITEM, embedded: true, conversationBeside: true })
    // The turn settling keeps the conversation mounted: the session goes on.
    const mounts = shared.localMounts.length
    await loaded(itemRow({ ...local, status: 'needs_review' }))
    expect(shared.localMounts.length).toBe(mounts)
    expect(q('[data-local-agent-panel]')).not.toBeNull()
  })

  it('an item with no run chat (a coding run, a loop run that didn’t park): the teammate’s thread with the item attached', async () => {
    await open()
    await loaded(itemRow({ kind: 'coding_run' }))
    expect(q('[data-run-chat]')).toBeNull()
    expect(shared.chats.at(-1)).toMatchObject({ teammateId: 'tm-ada', workspaceId: 'ws-2', composer: 'full', about: { context: { workItemId: ITEM }, title: 'Reply to Acme', off: false } })
    expect(shared.chats.at(-1)!.about).not.toHaveProperty('runId')
  })

  it('a row the page already holds starts its chat before the panel loads; an item that won’t load leaves the teammate’s own thread', async () => {
    shared.botWork = {
      rows: [itemRow({ kind: 'flow_run', agent_run_id: null, source: { run_chat: true } })],
      chips: {},
      teammate: null,
      mayResume: false,
      lastFinished: null,
      about: { skills: [], agent: null, loops: [] },
      loading: false,
      failed: false,
      refresh: async () => {},
    }
    await open()
    expect(q('[data-run-chat]')!.getAttribute('data-run-chat')).toBe(`loop:${ITEM}`)
    shared.botWork = null
    act(() => root.unmount())
    root = createRoot(container)
    await open()
    await loaded(null, true)
    expect(shared.chats.at(-1)).toMatchObject({ teammateId: 'tm-ada', about: null })
  })

  it('its way back: the card goes back to the bot’s lists', async () => {
    await open()
    await act(async () => q('[data-bot-page-item-back]')!.click())
    expect(shared.openedItems.at(-1)).toBeNull()
  })

  it('an item’s wider column takes a wider page: two columns at 780 px for the lists, tabs with an item', async () => {
    pageWidth = 780
    await page({ teammateId: 'tm-ada', name: 'Ada', workspaceId: 'ws-2' })
    expect(layout()).toBe('columns')
    await open()
    expect(layout()).toBe('tabs')
    const { BOT_PAGE_ITEM_COLUMNS_MIN_PX } = await import('../bot-page/use-page-columns')
    await widthTo(BOT_PAGE_ITEM_COLUMNS_MIN_PX + 40)
    expect(layout()).toBe('columns')
  })

  it('in the desktop app, the item’s chat has the bot’s own voice', async () => {
    shared.desktop = true
    await open()
    await loaded(itemRow())
    expect(shared.runChats.at(-1)!.voice).toMatchObject({ ttsVoice: 'voice-research' })
  })
})
