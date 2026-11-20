/**
 * Records what the app's real screens ask the server for, on the made-up demo
 * workspace, so public pages can draw those screens with no server behind
 * them (src/lib/demo/demo-fetch.ts, src/components/demo/demo-app.tsx).
 *
 * For each screen in SCREENS it signs in as the demo person, opens the
 * screen the way a person would, and saves:
 *   - every GET answer under /api/ the app asked for, and every POST answer
 *     under /api/account/ (the app reads some lists with a POST), and
 *   - the app's own request to open that screen (the last `ni:open-card`
 *     window event, lib/chat-cards/open-card.ts), which the demo sends again,
 * to src/lib/demo/snapshots/app/<screen>.json. Run it again after the app's
 * screens or their answers change, and commit what it writes.
 *
 * DEV OR LOCAL ONLY, like scripts/demo-workspace.ts (the same guard), and
 * only for the demo person. It writes nothing to the workspace. What it
 * saves is scrubbed (connected accounts, chat history, mail) and then
 * refused outright if an address outside `.test` / `.example` is left in it.
 *
 *   next dev on :3002, then from web/:
 *   node node_modules/.bin/tsx scripts/record-demo-screens.ts [--port=3002] [--shots=<dir>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { chromium, type Page } from 'playwright'
import { DEMO_USER_EMAIL, PROD_SUPABASE_REF, demoSupabaseTarget } from '../src/lib/demo/demo-workspace-guard'

type Step = { click: string } | { clickText: string } | { search: string }
interface Screen {
  /** How a person gets there. */
  steps: Step[]
  /**
   * What to hand `openTarget` (lib/chat-cards/open-card.ts) when the steps
   * send no `ni:open-card` event of their own (search opens a card directly).
   * `capture` names a meeting by its title; its id is read from the answers.
   */
  target?: { type: 'page'; slug: string } | { type: 'capture'; title: string }
}
const SCREENS: Record<string, Screen> = {
  tasks: { steps: [{ click: 'My Actions' }] },
  meeting: { steps: [{ search: 'Kickoff: Larkspur' }], target: { type: 'capture', title: 'Kickoff: Larkspur Coffee site relaunch' } },
  knowledge: { steps: [{ search: 'Knowledge' }], target: { type: 'page', slug: 'knowledge' } },
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const ORIGIN = `http://localhost:${arg('port') ?? '3002'}`
const SHOTS = arg('shots')
const OUT = 'src/lib/demo/snapshots/app'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
if (!demoSupabaseTarget(url)) throw new Error('refusing: not DEV or a local Supabase')
if (key.includes(PROD_SUPABASE_REF)) throw new Error("refusing: the service role key is PROD's")

/** Answers never saved, whatever they hold: a person's mail and connected accounts. */
const NEVER = [/^\/api\/account\/email/, /^\/api\/account\/mail/, /^\/api\/account\/messages/, /^\/api\/oauth\//]
const EMPTY: Record<string, unknown> = { '/api/oauth/status': { accounts: [] }, '/api/account/messages': { messages: [] }, '/api/account/email/agent-drafts': { drafts: [] } }

function scrub(path: string, body: unknown): unknown {
  const bare = path.split('?')[0]
  if (bare in EMPTY) return EMPTY[bare]
  if (NEVER.some((re) => re.test(bare))) return {}
  if (bare.startsWith('/api/account/chat-history/') && body && typeof body === 'object') return { ...(body as object), messages: [] }
  // The demo is a picture: no nudge to enrol a voice over it.
  if (bare === '/api/account/voice-profile') return { ...(body as object), enrolled: true }
  if (bare === '/api/account/onboarding' && body && typeof body === 'object') return { ...(body as object), connectedAccounts: [] }
  return body
}

function assertMadeUp(name: string, json: string) {
  const real = [...new Set(json.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])].filter((e) => !/\.(test|example)$/i.test(e))
  if (real.length) throw new Error(`${name}: refusing to save, it holds ${real.length} address(es) outside .test/.example`)
  if (/eyJ[A-Za-z0-9_-]{20,}|access_token|refresh_token/.test(json)) throw new Error(`${name}: refusing to save, it holds something token-like`)
}

async function run(page: Page, steps: Step[]) {
  for (const step of steps) {
    if ('click' in step) await page.locator(`[aria-label="${step.click}"]`).first().click()
    else if ('clickText' in step) await page.getByText(step.clickText, { exact: false }).first().click()
    else {
      await page.locator('[data-search-button]').first().click()
      await page.waitForTimeout(800)
      await page.keyboard.type(step.search, { delay: 40 })
      await page.waitForTimeout(2500)
      await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(9000)
  }
}

async function main() {
  const admin = createClient(url, key, { auth: { persistSession: false } })
  const browser = await chromium.launch({ channel: 'chrome' })
  mkdirSync(OUT, { recursive: true })
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))

  for (const [name, { steps, target: wanted }] of Object.entries(SCREENS)) {
    if (only.length && !only.includes(name)) continue
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: DEMO_USER_EMAIL })
    if (error || !data.properties?.hashed_token) throw new Error(`generateLink: ${error?.message ?? 'no token'}`)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'America/Los_Angeles' })
    const page = await context.newPage()
    await page.addInitScript(() => {
      window.addEventListener('ni:open-card', (event) => {
        ;(window as unknown as { __demoOpen?: unknown }).__demoOpen = (event as CustomEvent).detail
      })
    })
    const answers: Record<string, unknown> = {}
    page.on('response', async (res) => {
      const u = new URL(res.url())
      const method = res.request().method()
      if (u.origin !== ORIGIN || !u.pathname.startsWith('/api/account/') && method !== 'GET') return
      if (u.origin !== ORIGIN || !u.pathname.startsWith('/api/') || (method !== 'GET' && method !== 'POST') || res.status() !== 200) return
      if (!(res.headers()['content-type'] ?? '').includes('json')) return
      try {
        const body = scrub(u.pathname + u.search, await res.json())
        if (method === 'GET') answers[u.pathname + u.search] = body
        else {
          // A list the app reads with a POST: kept under its exact request, and under its path for a near miss.
          answers[`POST ${u.pathname}${u.search}#${res.request().postData() ?? ''}`] = body
          answers[`POST ${u.pathname}`] = body
        }
      } catch {}
    })
    await page.goto(`${ORIGIN}/auth/demo-link?token_hash=${data.properties.hashed_token}`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await page.waitForTimeout(18_000)
    await page.addStyleTag({ content: 'nextjs-portal,[data-sonner-toaster]{display:none}' })
    await run(page, steps)
    const open = await page.evaluate(() => (window as unknown as { __demoOpen?: unknown }).__demoOpen ?? null)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/demo-rec-${name}.png` })
    await context.close()
    let target: unknown = null
    if (!open && wanted?.type === 'page') target = wanted
    if (!open && wanted?.type === 'capture') {
      const id = JSON.stringify(answers).match(new RegExp(`"id":"([0-9a-f-]{36})"[^{}]*"(?:label|title)":"${wanted.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))?.[1]
      if (!id) throw new Error(`${name}: no meeting titled "${wanted.title}" in what was recorded`)
      target = { type: 'capture', id, title: wanted.title }
    }
    const out = JSON.stringify({ open, target, answers })
    assertMadeUp(name, out)
    writeFileSync(`${OUT}/${name}.json`, out)
    console.log(`${name}: ${Object.keys(answers).length} answers, ${out.length} bytes, ${open ? 'open request saved' : target ? 'target saved' : 'NOTHING TO OPEN IT WITH'}`)
  }
  await browser.close()
}

main().catch((err) => {
  console.error(`[record-demo-screens] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
