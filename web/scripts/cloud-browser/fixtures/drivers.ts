import { CloudBrowser } from '@/lib/cloud-browser/cdp/browser'
import type { CloudPage, PageNotice } from '@/lib/cloud-browser/cdp/page'
import { parseNative } from '@/lib/browser-agent/page-reads'

/** One browser engine, as the fixture runner drives it (run.ts). */
export interface FixtureTab {
  snapshot(): Promise<unknown>
  act(request: Record<string, unknown>): Promise<{ ok: boolean; code?: string }>
  guard(sites: string[], ms: number): Promise<void>
  url(): Promise<string>
  /** Notices and popups since the last call. */
  events(): Promise<{ notices: PageNotice[]; opened: string[] }>
  close(): Promise<void>
}
export interface FixtureDriver {
  name: string
  open(url: string): Promise<FixtureTab>
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The cloud driver (src/lib/cloud-browser/cdp) on a Chrome at `endpoint`. */
export async function cloudDriver(endpoint: number | string): Promise<FixtureDriver> {
  const browser = await CloudBrowser.connect(endpoint)
  return {
    name: 'cloud',
    async open(url) {
      const page = await browser.openPage()
      const notices: PageNotice[] = []
      const popups: CloudPage[] = []
      page.onNotice(notice => notices.push(notice))
      browser.onPage(opened => { if (opened.opener === page) popups.push(opened) })
      await page.navigate(url, new AbortController().signal, Date.now() + 15_000)
      return {
        snapshot: async () => parseNative(await page.decisionSnapshot()),
        act: async request => parseNative(await page.taskAction(request)) as { ok: boolean; code?: string },
        guard: (sites, ms) => page.setGuard(sites, ms),
        url: async () => page.url,
        async events() {
          // A popup reports its address once it commits.
          for (let i = 0; i < 40 && popups.some(p => !p.closed && (!p.url || p.url === 'about:blank')); i++) await sleep(50)
          // A popup the guard closed before it loaded never opened, for the person or the agent.
          const opened = popups.splice(0).filter(p => !(p.closed && (!p.url || p.url === 'about:blank'))).map(p => p.url)
          return { notices: notices.splice(0), opened }
        },
        async close() {
          for (const popup of browser.list()) if (popup.opener === page) await popup.close()
          await page.close()
        },
      }
    },
    async close() { browser.close() },
  }
}
