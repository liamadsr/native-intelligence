/**
 * The browser the ads, the reels' type layers and the contact sheets are drawn in: the same Chrome headless shell the
 * worker renders videos in (STUDIO_CHROME, or Remotion's own under node_modules/.remotion), driven by playwright-core.
 *
 * It is started with a minimal environment (minimalEnv: no worker setting, no provider key) and with no route to any
 * network: every request goes to a proxy that is not there and no host name resolves, so even a request that slipped
 * past the page fence (fence.ts) would reach nothing. Pages are only ever opened through fencedPage().
 */
import { resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import { minimalEnv, pick } from '../child.ts'
import { PACKAGE_DIR } from '../config.ts'
import { findChromeIn } from '../render.ts'
import { JobError, type JobContext } from '../jobs/context.ts'

/** The headless shell's executable: STUDIO_CHROME's, else Remotion's (fetched once by the renderer). */
export async function adsChrome(ctx: Pick<JobContext, 'renderer' | 'log'>): Promise<string> {
  const set = await ctx.renderer.chrome(ctx.log)
  if (set) return set
  for (const dir of [resolve(PACKAGE_DIR, 'node_modules/.remotion'), resolve(process.cwd(), 'node_modules/.remotion')]) {
    const found = await findChromeIn(dir, 6)
    if (found) return found
  }
  throw new JobError('No Chrome headless shell was found to draw the ads in (set STUDIO_CHROME to one)')
}

/** The browser's arguments: no network at all (a proxy that is not there, no name resolves), software GL on Linux. Pure. */
export function browserArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [
    '--font-render-hinting=none',
    '--proxy-server=socks5://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-pings',
    // Software GL on a machine without a GPU (the container), as the video renders do.
    ...(platform === 'linux' ? ['--use-angle=swiftshader'] : []),
  ]
}

/** The browser's environment: the minimal one, plus fontconfig's and the cache folders' settings when set. Pure over `env`. */
export function browserEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return minimalEnv(pick(env, ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'LD_LIBRARY_PATH'], ['FONTCONFIG_']), env)
}

/** A browser for one job, closed when the job's signal aborts. */
export async function launchBrowser(ctx: Pick<JobContext, 'renderer' | 'log' | 'signal'>): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: await adsChrome(ctx), args: browserArgs(), env: browserEnv() })
  const onAbort = () => void browser.close().catch(() => undefined)
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  browser.on('disconnected', () => ctx.signal.removeEventListener('abort', onAbort))
  return browser
}
