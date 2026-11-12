// @vitest-environment jsdom
/**
 * The side panels' one store (side-panel-store.ts; the space plan's
 * decisions are in space-plan.test.ts):
 *
 *   • open/closed, the cards opened and their order are remembered per
 *     device (the cards closed until opened; a legacy list of folded cards
 *     reads as all closed), and storage that throws (read or
 *     write) or holds junk breaks nothing: the session holds them in memory;
 *   • a card moves among the cards showing; a hidden one keeps its slot;
 *   • the panel's two views (Liam, 11-11: the sections or the For you
 *     cards, never both): the view remembered per device, each view's
 *     button opening the panel on it, swapping to it or closing it; ⌘\
 *     keeping the view; For you with no cards off screen, the panel's open
 *     state and view kept for when cards come;
 *   • the capture's notepad docking is heard once;
 *   • the page panel's button (Liam, 11-11, right of Search): open by
 *     default, closing remembered per device, opening by hand lets it float
 *     (this session only), a press closing it only while it is on screen,
 *     the saved state kept while it hides for another reason, another tab's
 *     change heard;
 *   • a toggle puts the chat back at the same distance from its bottom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORDER_KEY,
  PAGE_PANEL_OPEN_KEY,
  RIGHT_OPEN_KEY,
  SECTIONS_KEY,
  SECTION_IDS,
  VIEW_KEY,
  captureChatAnchor,
  chatScroller,
  getServerSidePanelState,
  getSidePanelState,
  moveAmongVisible,
  moveSection,
  parseOrder,
  parseSectionOpen,
  parseView,
  resetSidePanelStore,
  registerChatScrollHold,
  restoreChatAnchor,
  setCaptureDockOpen,
  setPagePanelContent,
  setPagePanelOpen,
  setPagePanelShown,
  togglePagePanel,
  pagePanelWanted,
  rightShown,
  setForYouContent,
  setRightPanelOpen,
  setSectionOpen,
  setSidePanelView,
  shownView,
  subscribeSidePanels,
  toggleRightPanel,
  toggleSidePanelView,
} from '../side-panel-store'

beforeEach(() => {
  window.localStorage.clear()
  resetSidePanelStore()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('remembered per device', () => {
  it('the right panel: closed by default, its open state written and read back', () => {
    expect(getSidePanelState().rightOpen).toBe(false)
    toggleRightPanel()
    expect(getSidePanelState().rightOpen).toBe(true)
    expect(window.localStorage.getItem(RIGHT_OPEN_KEY)).toBe('1')
    resetSidePanelStore()
    expect(getSidePanelState().rightOpen).toBe(true)
    setRightPanelOpen(false)
    expect(window.localStorage.getItem(RIGHT_OPEN_KEY)).toBeNull()
  })

  it('the cards: all closed for a device that never opened one but the computer, each opened card written and read back', () => {
    expect(getSidePanelState().sectionOpen).toEqual({ computer: true, agents: false, plan: false, context: false, environment: false, connections: false })
    setSectionOpen('connections', true)
    expect(JSON.parse(window.localStorage.getItem(SECTIONS_KEY)!)).toEqual({ open: ['computer', 'connections'], known: SECTION_IDS })
    resetSidePanelStore()
    expect(getSidePanelState().sectionOpen).toEqual({ computer: true, agents: false, plan: false, context: false, environment: false, connections: true })
    setSectionOpen('connections', false)
    expect(JSON.parse(window.localStorage.getItem(SECTIONS_KEY)!)).toEqual({ open: ['computer'], known: SECTION_IDS })
  })

  it('a device’s legacy list of FOLDED cards (any list) reads as every card closed, and the next open writes the new shape', () => {
    window.localStorage.setItem(SECTIONS_KEY, '["connections"]')
    expect(getSidePanelState().sectionOpen).toEqual({ computer: true, agents: false, plan: false, context: false, environment: false, connections: false })
    resetSidePanelStore()
    window.localStorage.setItem(SECTIONS_KEY, '[]')
    expect(getSidePanelState().sectionOpen).toEqual({ computer: true, agents: false, plan: false, context: false, environment: false, connections: false })
    expect(parseSectionOpen('["agents","plan","connections"]')).toEqual({ computer: true, agents: false, plan: false, context: false, environment: false, connections: false })
    setSectionOpen('plan', true)
    expect(JSON.parse(window.localStorage.getItem(SECTIONS_KEY)!)).toEqual({ open: ['computer', 'plan'], known: SECTION_IDS })
  })

  it('the cards’ order: the default until moved, then written and read back', () => {
    expect(getSidePanelState().order).toEqual(['computer', 'agents', 'plan', 'context', 'environment', 'connections'])
    moveSection('connections', 0, SECTION_IDS)
    expect(JSON.parse(window.localStorage.getItem(ORDER_KEY)!)).toEqual(['connections', 'computer', 'agents', 'plan', 'context', 'environment'])
    resetSidePanelStore()
    expect(getSidePanelState().order).toEqual(['connections', 'computer', 'agents', 'plan', 'context', 'environment'])
  })

  it('a saved order tolerates unknown, repeated and missing ids, and junk', () => {
    expect(parseOrder('["calendar","connections","plan","connections"]')).toEqual(['computer', 'connections', 'plan', 'agents', 'context', 'environment'])
    // A device's order from before the Context and Environment cards: they come after the saved ones;
    // the computer card, new on top, before them.
    expect(parseOrder('["connections","agents","plan"]')).toEqual(['computer', 'connections', 'agents', 'plan', 'context', 'environment'])
    expect(parseOrder('["environment","connections","agents","plan"]')).toEqual(['computer', 'environment', 'connections', 'agents', 'plan', 'context'])
    // Once the person moved it, it stays where they put it.
    expect(parseOrder('["agents","computer","plan","context","environment","connections"]')).toEqual(['agents', 'computer', 'plan', 'context', 'environment', 'connections'])
    expect(parseSectionOpen('{"open":["environment"]}')).toMatchObject({ environment: true, connections: false })
    expect(parseSectionOpen('{"open":["context"]}')).toMatchObject({ context: true, plan: false })
    // A save from before the computer card shows it open; once known, the person's choice stands.
    expect(parseSectionOpen('{"open":[]}')).toMatchObject({ computer: true })
    expect(parseSectionOpen(`{"open":[],"known":${JSON.stringify(SECTION_IDS)}}`)).toMatchObject({ computer: false })
    expect(parseOrder('{"no":1}')).toEqual(SECTION_IDS)
    expect(parseOrder('not json')).toEqual(SECTION_IDS)
    expect(parseOrder(null)).toBe(SECTION_IDS)
  })

  it('a card moves among the cards showing; a hidden card keeps its slot', () => {
    // Plan hidden: Connections up past Agents, Plan still second.
    expect(moveAmongVisible(['agents', 'plan', 'connections'], ['agents', 'connections'], 'connections', 0)).toEqual([
      'connections',
      'plan',
      'agents',
    ])
    // Clamped; a card not showing, or no change, is no move (the same list back).
    const order = ['agents', 'plan', 'connections'] as const
    expect(moveAmongVisible(order, order, 'agents', 9)).toEqual(['plan', 'connections', 'agents'])
    expect(moveAmongVisible(order, ['connections'], 'agents', 0)).toBe(order)
    expect(moveAmongVisible(order, order, 'plan', 1)).toBe(order)
    // Nothing written when nothing moved.
    moveSection('plan', 1, order)
    expect(window.localStorage.getItem(ORDER_KEY)).toBeNull()
  })

  it('the panel’s view: the sections by default, For you written and read back, junk the sections', () => {
    expect(getSidePanelState().view).toBe('panel')
    setSidePanelView('forYou')
    expect(window.localStorage.getItem(VIEW_KEY)).toBe('for-you')
    resetSidePanelStore()
    expect(getSidePanelState().view).toBe('forYou')
    setSidePanelView('panel')
    expect(window.localStorage.getItem(VIEW_KEY)).toBeNull()
    expect(parseView('junk')).toBe('panel')
    expect(parseView(null)).toBe('panel')
    // The left column's fold key from before is not read by anything any more.
    window.localStorage.setItem('ni:for-you-column:folded', '1')
    resetSidePanelStore()
    expect(Object.keys(getSidePanelState())).not.toContain('leftOpen')
  })

  it('the server renders closed, every card closed, the default order (no hydration mismatch)', () => {
    window.localStorage.setItem(RIGHT_OPEN_KEY, '1')
    window.localStorage.setItem(SECTIONS_KEY, '{"open":["plan"]}')
    window.localStorage.setItem(VIEW_KEY, 'for-you')
    expect(getServerSidePanelState()).toMatchObject({
      rightOpen: false,
      view: 'panel',
      forYouContent: false,
      sectionOpen: { computer: true, agents: false, plan: false, context: false, environment: false, connections: false },
      order: SECTION_IDS,
    })
  })

  it('storage that throws, or junk in it, breaks nothing: the session holds the state in memory', () => {
    window.localStorage.setItem(SECTIONS_KEY, '{not json')
    window.localStorage.setItem(ORDER_KEY, '{not json')
    expect(getSidePanelState().sectionOpen).toEqual({ computer: true, agents: false, plan: false, context: false, environment: false, connections: false })
    expect(getSidePanelState().order).toEqual(SECTION_IDS)
    resetSidePanelStore()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(getSidePanelState().rightOpen).toBe(false)
    expect(() => setRightPanelOpen(true)).not.toThrow()
    expect(() => setSectionOpen('agents', true)).not.toThrow()
    expect(() => moveSection('plan', 0, SECTION_IDS)).not.toThrow()
    expect(() => setSidePanelView('forYou')).not.toThrow()
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'forYou', sectionOpen: { agents: true }, order: ['plan', 'computer', 'agents', 'context', 'environment', 'connections'] })
  })

  it('subscribers hear a change once, and nothing when nothing changed', () => {
    const heard = vi.fn()
    const off = subscribeSidePanels(heard)
    setRightPanelOpen(true)
    setRightPanelOpen(true)
    setForYouContent(false)
    setSidePanelView('panel')
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  it('the capture’s notepad docking is heard once, for the space plan', () => {
    const heard = vi.fn()
    const off = subscribeSidePanels(heard)
    expect(getSidePanelState().captureDock).toBe(false)
    setCaptureDockOpen(true)
    setCaptureDockOpen(true)
    expect(getSidePanelState().captureDock).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  it('the page panel having something to show is heard once, for the space plan, and never saved', () => {
    const heard = vi.fn()
    const off = subscribeSidePanels(heard)
    expect(getSidePanelState().pagePanel).toBe(false)
    setPagePanelContent(true)
    setPagePanelContent(true)
    expect(getSidePanelState().pagePanel).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(Object.keys(window.localStorage).filter((k) => k.includes('page'))).toEqual([])
    off()
  })
})

describe('one panel, two views (Liam, 11-11: “you can’t see both at the same time”)', () => {
  it('each view’s button opens the panel on its view, swaps to it from the other in place, and closes the panel while its view shows', () => {
    setForYouContent(true)
    // Side panel: opens on the sections.
    toggleSidePanelView('panel')
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'panel' })
    expect(shownView(getSidePanelState())).toBe('panel')
    // For you while the sections show: swapped, still open (no close, so no slide).
    const heard = vi.fn()
    const off = subscribeSidePanels(heard)
    toggleSidePanelView('forYou')
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'forYou' })
    expect(heard).toHaveBeenCalledTimes(1)
    off()
    expect(window.localStorage.getItem(VIEW_KEY)).toBe('for-you')
    // For you again: closed, its view kept.
    toggleSidePanelView('forYou')
    expect(getSidePanelState()).toMatchObject({ rightOpen: false, view: 'forYou' })
    expect(shownView(getSidePanelState())).toBeNull()
    // Side panel while closed: opens on the sections; again, closes.
    toggleSidePanelView('panel')
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'panel' })
    toggleSidePanelView('panel')
    expect(getSidePanelState().rightOpen).toBe(false)
  })

  it('⌘\\ opens and closes the panel on the view it had', () => {
    setForYouContent(true)
    setSidePanelView('forYou')
    toggleRightPanel()
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'forYou' })
    toggleRightPanel()
    expect(getSidePanelState()).toMatchObject({ rightOpen: false, view: 'forYou' })
    setSidePanelView('panel')
    toggleRightPanel()
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'panel' })
  })

  it('For you with no cards is off screen, its open state and view kept: it comes back on For you when cards arrive, never on the sections by itself', () => {
    setSidePanelView('forYou')
    setRightPanelOpen(true)
    expect(getSidePanelState().forYouContent).toBe(false)
    expect(rightShown(getSidePanelState())).toBe(false)
    expect(shownView(getSidePanelState())).toBeNull()
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'forYou' })
    expect(window.localStorage.getItem(RIGHT_OPEN_KEY)).toBe('1')
    setForYouContent(true)
    expect(shownView(getSidePanelState())).toBe('forYou')
    setForYouContent(false)
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'forYou' })
    expect(rightShown(getSidePanelState())).toBe(false)
    // The sections show whatever For you has.
    setSidePanelView('panel')
    expect(shownView(getSidePanelState())).toBe('panel')
  })

  it('⌘\\ with the panel saved on an empty For you (nothing on screen) opens the sections: a key press always shows something', () => {
    setSidePanelView('forYou')
    setRightPanelOpen(true)
    toggleRightPanel()
    expect(getSidePanelState()).toMatchObject({ rightOpen: true, view: 'panel' })
    expect(shownView(getSidePanelState())).toBe('panel')
  })

  it('another tab’s view change arrives as a storage event', () => {
    const heard = vi.fn()
    const off = subscribeSidePanels(heard)
    getSidePanelState()
    window.localStorage.setItem(VIEW_KEY, 'for-you')
    window.dispatchEvent(new StorageEvent('storage', { key: VIEW_KEY }))
    expect(getSidePanelState().view).toBe('forYou')
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('the chat’s bottom anchor', () => {
  /**
   * The live DOM: use-stick-to-bottom's role="log" root never scrolls; its
   * scroll element is the thread's parent (ChatContainerContent, marked
   * data-main-chat-thread).
   */
  function scroller({ scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    document.body.innerHTML =
      '<div id="ni-chat-strip-slot"><div role="log"><div data-scroll=""><div data-main-chat-thread=""></div></div></div></div>'
    const el = document.querySelector<HTMLElement>('[data-scroll]')!
    const log = document.querySelector<HTMLElement>('[role="log"]')!
    let height = scrollHeight
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => clientHeight, configurable: true })
    el.scrollTop = scrollTop
    return { el, log, grow: (h: number) => (height = h) }
  }

  it('finds what really scrolls the conversation: the thread’s parent, not the role="log" root', () => {
    const { el } = scroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 })
    expect(chatScroller()).toBe(el)
  })

  it('a toggle keeps the chat the same distance from its bottom after its text re-wraps', () => {
    // 300px above the bottom: 2000 - 1100 - 600.
    const { el, log, grow } = scroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1100 })
    setRightPanelOpen(true)
    // The chat narrowed; its text is taller now.
    grow(2600)
    restoreChatAnchor()
    expect(el.scrollTop).toBe(2600 - 600 - 300)
    expect(log.scrollTop).toBe(0)
  })

  it('scrolled up, the toggle stops the chat following its bottom, so the resize can’t pull it down (the first open after a reload too)', () => {
    const hold = vi.fn()
    registerChatScrollHold(hold)
    scroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1000 })
    setRightPanelOpen(true)
    expect(hold).toHaveBeenCalledTimes(1)
  })

  it('at the bottom it stays at the bottom (still following it); one use per capture', () => {
    const hold = vi.fn()
    registerChatScrollHold(hold)
    const { el, grow } = scroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 })
    captureChatAnchor()
    expect(hold).not.toHaveBeenCalled()
    grow(1800)
    restoreChatAnchor()
    expect(el.scrollTop).toBe(1200)
    el.scrollTop = 10
    restoreChatAnchor()
    expect(el.scrollTop).toBe(10)
  })

  it('a chat that unregistered its hold is never called', () => {
    const hold = vi.fn()
    const off = registerChatScrollHold(hold)
    off()
    scroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 })
    captureChatAnchor()
    expect(hold).not.toHaveBeenCalled()
  })
})

describe('the page panel’s button (Liam, 11-11: “a button for opening and closing the new panel”)', () => {
  it('open by default; closing is remembered per device, opening by hand clears it and lets it float this session only', () => {
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: false })
    expect(getServerSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: false, pagePanelShown: false })
    setPagePanelOpen(false)
    expect(window.localStorage.getItem(PAGE_PANEL_OPEN_KEY)).toBe('0')
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: false, pagePanelFloatOk: false })
    resetSidePanelStore()
    expect(getSidePanelState().pagePanelOpen).toBe(false)
    setPagePanelOpen(true)
    expect(window.localStorage.getItem(PAGE_PANEL_OPEN_KEY)).toBeNull()
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: true })
    // A new session: open as remembered, not opened by hand.
    resetSidePanelStore()
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: false })
  })

  it('a press closes it while on screen, else opens it by hand (open as remembered but off screen too)', () => {
    setPagePanelShown(true)
    togglePagePanel()
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: false, pagePanelFloatOk: false })
    setPagePanelShown(false)
    togglePagePanel()
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: true })
    resetSidePanelStore()
    togglePagePanel()
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: true })
  })

  it('a page’s sub-nav says so with its rows (pinned: shown while open, room or not); never without rows, never saved', () => {
    expect(getServerSidePanelState().pagePanelPage).toBe(false)
    setPagePanelContent(true, true)
    expect(getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true })
    // Home's Recent: not pinned.
    setPagePanelContent(true)
    expect(getSidePanelState().pagePanelPage).toBe(false)
    // No rows: nothing pinned either.
    setPagePanelContent(false, true)
    expect(getSidePanelState()).toMatchObject({ pagePanel: false, pagePanelPage: false })
    setPagePanelContent(true, true)
    resetSidePanelStore()
    expect(getSidePanelState().pagePanelPage).toBe(false)
  })

  it('wants the left only with rows and open; the saved state is kept while it hides for another reason', () => {
    setPagePanelContent(true)
    expect(pagePanelWanted(getSidePanelState())).toBe(true)
    setPagePanelOpen(false)
    expect(pagePanelWanted(getSidePanelState())).toBe(false)
    setPagePanelContent(false)
    setCaptureDockOpen(true)
    setPagePanelShown(false)
    setCaptureDockOpen(false)
    setPagePanelContent(true)
    expect(getSidePanelState().pagePanelOpen).toBe(false)
    expect(window.localStorage.getItem(PAGE_PANEL_OPEN_KEY)).toBe('0')
    // And open stays open through the same.
    setPagePanelOpen(true)
    setPagePanelContent(false)
    setCaptureDockOpen(true)
    expect(getSidePanelState().pagePanelOpen).toBe(true)
    expect(window.localStorage.getItem(PAGE_PANEL_OPEN_KEY)).toBeNull()
  })

  it('opening or closing it notes the chat’s place first (its width changes)', () => {
    const scroller = document.createElement('div')
    const thread = document.createElement('div')
    thread.setAttribute('data-main-chat-thread', '')
    const slot = document.createElement('div')
    slot.id = 'ni-chat-strip-slot'
    scroller.appendChild(thread)
    slot.appendChild(scroller)
    document.body.appendChild(slot)
    const hold = vi.fn()
    registerChatScrollHold(hold)
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    scroller.scrollTop = 100
    setPagePanelContent(true)
    hold.mockClear()
    setPagePanelOpen(false)
    expect(hold).toHaveBeenCalledTimes(1)
  })

  it('another tab’s change arrives as a storage event (the session’s by-hand flag untouched)', () => {
    const heard = vi.fn()
    const off = subscribeSidePanels(heard)
    getSidePanelState()
    window.localStorage.setItem(PAGE_PANEL_OPEN_KEY, '0')
    window.dispatchEvent(new StorageEvent('storage', { key: PAGE_PANEL_OPEN_KEY }))
    expect(getSidePanelState().pagePanelOpen).toBe(false)
    window.localStorage.removeItem(PAGE_PANEL_OPEN_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: PAGE_PANEL_OPEN_KEY }))
    expect(getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: false })
    expect(heard).toHaveBeenCalledTimes(2)
    off()
  })
})
