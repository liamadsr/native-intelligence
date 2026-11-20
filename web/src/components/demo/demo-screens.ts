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
