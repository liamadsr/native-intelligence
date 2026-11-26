#!/usr/bin/env node
/**
 * Screenshots of the Code view from fixtures (the dev page /dev/code-view,
 * which renders only in development). With `npm run dev` running:
 *
 *   node scripts/code-view-screenshots.mjs [outDir] [baseUrl]
 *   (PW_CHROMIUM=/path/to/chromium to use a Chromium of your own)
 *
 * The app shows its sign-in over a signed-out browser: give a dev account in
 * CODE_VIEW_EMAIL and CODE_VIEW_PASSWORD (env only, never committed) and the
 * script signs in once first. The fixture reads nothing of the account's.
 *
 * Writes chat-light.png, chat-dark.png, new-light.png and new-dark.png at
 * 1440×900 (deviceScaleFactor 2) into outDir (default ./code-view-shots).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const out = process.argv[2] || 'code-view-shots'
const base = process.argv[3] || 'http://localhost:3000'
mkdirSync(out, { recursive: true })

// PW_CHROMIUM: a Chromium of your own, when the installed Playwright's browser isn't downloaded.
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
try {
  if (process.env.CODE_VIEW_EMAIL && process.env.CODE_VIEW_PASSWORD) {
    const page = await context.newPage()
    await page.goto(`${base}/login`, { waitUntil: 'load', timeout: 180_000 })
    await page.waitForTimeout(3000)
    await page.fill('input[type="email"]', process.env.CODE_VIEW_EMAIL)
    await page.fill('input[type="password"]', process.env.CODE_VIEW_PASSWORD)
    await page.click('button[type="submit"]')
    // Signed in once the session cookie is set (the redirect after it compiles the whole dashboard: not needed here).
    for (let i = 0; i < 600 && !(await context.cookies()).some((c) => c.name.includes('auth-token')); i++) await page.waitForTimeout(500)
    await page.close()
  }
  for (const view of ['chat', 'new']) {
    for (const theme of ['light', 'dark']) {
      const page = await context.newPage()
      await page.emulateMedia({ colorScheme: theme })
      const qs = new URLSearchParams({ theme, ...(view === 'new' ? { view: 'new' } : {}) })
      await page.goto(`${base}/dev/code-view?${qs}`, { waitUntil: 'networkidle', timeout: 180_000 })
      await page.waitForSelector(`[data-code-view-fixture="${view}"]`, { state: 'attached', timeout: 120_000 }).catch(async (e) => {
        await page.screenshot({ path: join(out, `failed-${view}-${theme}.png`) })
        throw e
      })
      if (view === 'chat') await page.waitForSelector('[data-work-item-panel]', { timeout: 60_000 }).catch(() => {})
      await page.waitForTimeout(1500)
      const file = join(out, `${view}-${theme}.png`)
      await page.screenshot({ path: file })
      console.log(file)
      await page.close()
    }
  }
} finally {
  await browser.close()
}
