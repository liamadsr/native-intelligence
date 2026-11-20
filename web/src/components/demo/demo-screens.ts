/**
 * The demo's screens and the two messages its frame and its page exchange.
 * Kept apart from the app's code, so the public page that frames a demo
 * (components/demo/demo-frame.tsx) loads none of it.
 */
export const DEMO_SCREENS = ['ask', 'tasks', 'meeting', 'knowledge', 'contact'] as const
export type DemoScreen = (typeof DEMO_SCREENS)[number]

/** What the page around the frame sends to change the screen without loading the app again. */
export const DEMO_SCREEN_MESSAGE = 'ni-demo-screen'
/** What the demo tells the page around the frame once the screen it was asked for is drawn. */
export const DEMO_READY_MESSAGE = 'ni-demo-ready'
