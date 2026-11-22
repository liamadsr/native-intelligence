/**
 * The demo's screens and the two messages its frame and its page exchange.
 * Kept apart from the app's code, so the public page that frames a demo
 * (components/demo/demo-frame.tsx) loads none of it.
 */
export const DEMO_SCREENS = ['ask', 'tasks', 'meeting', 'knowledge', 'contact', 'chat', 'list', 'notes', 'transcript'] as const
export type DemoScreen = (typeof DEMO_SCREENS)[number]

/** What the page around the frame sends to change the screen without loading the app again. */
export const DEMO_SCREEN_MESSAGE = 'ni-demo-screen'
/** What the demo tells the page around the frame once the screen it was asked for is drawn. */
export const DEMO_READY_MESSAGE = 'ni-demo-ready'

/**
 * The window each screen was recorded in, which is the shape of its picture (public/screens/demo).
 * The first four are the hero's, a desktop window; the rest sit in a page's column, in a narrower
 * one that keeps the app's text readable there.
 */
const HERO_WINDOW = { width: 1440, height: 900 } as const
const COLUMN_WINDOW = { width: 1080, height: 740 } as const
export const DEMO_WINDOWS: Record<DemoScreen, { width: number; height: number }> = {
  ask: HERO_WINDOW,
  tasks: HERO_WINDOW,
  meeting: HERO_WINDOW,
  knowledge: HERO_WINDOW,
  contact: COLUMN_WINDOW,
  chat: COLUMN_WINDOW,
  // Its columns need the room.
  list: { width: 1280, height: 800 },
  notes: COLUMN_WINDOW,
  transcript: COLUMN_WINDOW,
}

/**
 * The part of a screen that is its open window (or, for the chat, the conversation), in the
 * screen's own window's pixels, with a little of the sky around it. A frame in a narrow slot shows
 * only this (`cut` on components/demo/demo-frame.tsx), so the app is not shrunk past reading to
 * fit its rail and panel in too. Measured on /demo/app at each screen's window size; measure
 * again if the app's layout moves (the picture and the app are cut alike, so a stale number
 * shows the wrong part of both, never a mismatch between them).
 */
// Measured again 11-22: the page's header is an island above it now, as wide
// as the page (374 to the window's edge less 10), from 3px down.
export const DEMO_CUTS: Partial<Record<DemoScreen, { x: number; y: number; width: number; height: number }>> = {
  contact: { x: 366, y: 0, width: 714, height: 628 },
  notes: { x: 366, y: 0, width: 714, height: 628 },
  transcript: { x: 366, y: 0, width: 714, height: 628 },
  list: { x: 366, y: 0, width: 914, height: 688 },
  chat: { x: 390, y: 96, width: 624, height: 644 },
}
