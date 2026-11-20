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
 * to src/lib/demo/snapshots/app/<screen>.json, and a picture of the screen
 * to public/screens/demo/<screen>.webp (what the frame shows until the app
 * is up, and on a phone, where the app is not loaded). Run it again after
 * the app's screens or their answers change, and commit what it writes.
 *
 * DEV OR LOCAL ONLY, like scripts/demo-workspace.ts (the same guard), and
 * only for the demo person. Opening a page leaves an "opened" note in the
 * demo person's own chat, as it does for anyone; nothing else is written
 * (`scripts/demo-workspace.ts --clear-activity` clears the chat). What it
 * saves is scrubbed (connected accounts, chat history, mail) and then
 * refused outright if an address outside `.test` / `.example` is left in it.
 *
 *   next dev on :3002, then from web/:
 *   node node_modules/.bin/tsx scripts/record-demo-screens.ts [--port=3002] [--shots=<dir>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
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
   * A meeting is named by its title and a contact by their name; the id is
   * looked up in the demo workspace.
   */
  target?: { type: 'page'; slug: string } | { type: 'capture'; title: string } | { type: 'contact'; title: string } | { type: 'action'; title: string }
  /**
   * The screen is the home chat itself, showing a written exchange (the one
   * named here, CONVERSATIONS) handed to the app in place of the demo
   * person's own history (which is whatever the last person to try the demo
   * left there), so the app draws it, asks for what it needs, and that is
   * recorded too.
   */
  chat?: 'ask' | 'memory'
  /**
   * Controls to press once the screen is open, each named by its text or its
   * label (the Transcripts pill on a meeting). The demo presses the same ones
   * (components/demo/demo-shell.tsx), so they are saved with the recording.
   */
  then?: string[]
  /**
   * Take the picture from the demo itself (/demo/app, once the recording is written), not from
   * the signed-in app. For the home chat: beside it the demo draws the Recent panel, which the
   * signed-in app at that moment did not, and the conversation sits further right for it. The
   * picture stands in for the demo, so it has to be of the same layout.
   */
  picture?: 'demo'
  /** The window the screen is drawn in, where a slot narrower than the hero's wants one (default 1440 x 900). */
  window?: { width: number; height: number }
}
/** A window for a slot narrower than the hero's (a feature page's column), so the app's text stays readable in it. */
const WINDOW = { width: 1080, height: 740 }
const MEETING = 'Kickoff: Larkspur Coffee site relaunch'
const SCREENS: Record<string, Screen> = {
  ask: { steps: [], chat: 'ask' },
  tasks: { steps: [{ click: 'My Actions' }] },
  meeting: { steps: [{ search: 'Kickoff: Larkspur' }], target: { type: 'capture', title: 'Kickoff: Larkspur Coffee site relaunch' } },
  knowledge: { steps: [{ search: 'Knowledge' }], target: { type: 'page', slug: 'knowledge' } },
  contact: { steps: [{ search: 'Maya Okafor' }], target: { type: 'contact', title: 'Maya Okafor' }, window: WINDOW },
  // The same app in the narrower window, for the pages whose demos sit in a column.
  chat: { steps: [], chat: 'memory', window: WINDOW, picture: 'demo' },
  // The list's columns need the room: a wider window than the other column screens.
  list: { steps: [{ click: 'My Actions' }], window: { width: 1280, height: 800 } },
  notes: { steps: [{ search: 'Kickoff: Larkspur' }], target: { type: 'capture', title: MEETING }, window: WINDOW },
  transcript: { steps: [{ search: 'Kickoff: Larkspur' }], target: { type: 'capture', title: MEETING }, then: ['Transcripts'], window: WINDOW },
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const ORIGIN = `http://localhost:${arg('port') ?? '3002'}`
const SHOTS = arg('shots')
const OUT = 'src/lib/demo/snapshots/app'
const POSTERS = 'public/screens/demo'

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

let keepChat = false

/** Press a control by its label or its text, the way the demo does once the screen is open (components/demo/demo-shell.tsx). */
async function press(page: Page, name: string) {
  const pressed = await page.evaluate((wanted) => {
    const controls = [...document.querySelectorAll<HTMLElement>('button,[role="button"],[role="tab"]')]
    const control = controls.find((el) => el.getAttribute('aria-label') === wanted) ?? controls.find((el) => el.textContent?.trim().startsWith(wanted))
    control?.click()
    return Boolean(control)
  }, name)
  if (!pressed) throw new Error(`no control named "${name}" on the screen`)
  await settle(page, 4000)
}

/** The project the written conversation asks about (scripts/demo-workspace.ts seeds it). */
const ASK_PROJECT = 'Larkspur Coffee site relaunch'

/**
 * The written conversations. `ask`: a question, and the agent's answer with the live board in it.
 * `memory`: what was agreed on a call and who said it. Both say only what
 * the seeded workspace holds (src/lib/demo/seed.ts: the kickoff's decisions, transcript and tasks).
 */
function conversation(which: 'ask' | 'memory', projectId: string) {
  const at = (minutesAgo: number) => ({ createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
  const card = {
    kind: 'list',
    title: `Open tasks · ${ASK_PROJECT}`,
    entity_type: 'action',
    layout: 'board',
    grouping: { field: 'status_id', direction: 'asc' },
    filters: [
      { field: 'project_id', operator: 'is', value: projectId },
      { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
    ],
  }
  if (which === 'memory') {
    return [
      { id: 'demo-memory-1', role: 'user', parts: [{ type: 'text', text: 'What did we agree with Larkspur about the launch, and who said it?' }], metadata: at(6) },
      {
        id: 'demo-memory-2',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: [
              'Four decisions, all from the call *Kickoff: Larkspur Coffee site relaunch*:',
              '',
              '- **Launch in the first week of next month.** Theo called the timing ideal.',
              '- **Beans are ordered on Shopify**, menus stay on the main site. Maya agreed.',
              '- **The warm editorial direction.** Maya picked it, Theo agreed.',
              '- **No wholesale prices on the site.** Maya asked for them behind the form.',
            ].join('\n'),
          },
        ],
        metadata: at(5),
      },
    ]
  }
  return [
    { id: 'demo-ask-1', role: 'user', parts: [{ type: 'text', text: 'Show me the open tasks on the Larkspur relaunch as a board.' }], metadata: at(3) },
    {
      id: 'demo-ask-2',
      role: 'assistant',
      parts: [
        { type: 'tool-show', toolCallId: 'demo-ask-show', state: 'output-available', input: card, output: { success: true, card, card_number: 1 } },
        { type: 'text', text: 'Here is the board for the Larkspur Coffee site relaunch. The homepage wireframes and the new menu copy are in progress.' },
      ],
      metadata: at(2),
    },
  ]
}

function scrub(path: string, body: unknown): unknown {
  const bare = path.split('?')[0]
  if (bare in EMPTY) return EMPTY[bare]
  if (NEVER.some((re) => re.test(bare))) return {}
  if (!keepChat && bare.startsWith('/api/account/chat-history/') && body && typeof body === 'object') return { ...(body as object), messages: [] }
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

/**
 * Wait until the app has stopped asking for things: nothing under /api/ still waiting for its
 * answer (the DEV database can take ten seconds over one), none for `quiet` ms, and at least
 * `least` ms in all.
 */
let lastAnswer = 0
/** Requests under /api/ still waiting for their answer: a slow one is not quiet. */
const waiting = new Set<unknown>()
async function settle(page: Page, least: number, quiet = 6000, most = 120_000) {
  const start = Date.now()
  await page.waitForTimeout(least)
  while ((waiting.size > 0 || Date.now() - lastAnswer < quiet) && Date.now() - start < most) await page.waitForTimeout(500)
}

async function run(page: Page, steps: Step[]) {
  for (const step of steps) {
    if ('click' in step) await page.locator(`[aria-label="${step.click}"]`).first().click()
    else if ('clickText' in step) await page.getByText(step.clickText, { exact: false }).first().click()
    else {
      await page.locator('[data-search-button]').first().click()
      await page.waitForTimeout(800)
      // Enter only once the results for the whole phrase are in: the first one is what it opens.
      await page.keyboard.type(step.search, { delay: 40 })
      await page.getByText('open', { exact: true }).first().waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      await page.keyboard.press('Enter')
    }
    await settle(page, 9000)
  }
}

async function main() {
  const admin = createClient(url, key, { auth: { persistSession: false } })
  const browser = await chromium.launch({ channel: 'chrome' })
  mkdirSync(OUT, { recursive: true })
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))

  for (const [name, { steps, target: wanted, chat, then, window: size, picture }] of Object.entries(SCREENS)) {
    keepChat = Boolean(chat)
    if (only.length && !only.includes(name)) continue
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: DEMO_USER_EMAIL })
    if (error || !data.properties?.hashed_token) throw new Error(`generateLink: ${error?.message ?? 'no token'}`)
    const context = await browser.newContext({ viewport: size ?? { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark', timezoneId: 'America/Los_Angeles' })
    const page = await context.newPage()
    if (chat) {
      const project = await admin.from('projects').select('id, name, workspace_id').eq('name', ASK_PROJECT).limit(1).maybeSingle()
      if (project.error || !project.data) throw new Error(`${name}: no project named "${ASK_PROJECT}" in the demo workspace`)
      const written = conversation(chat, project.data.id as string)
      await page.route('**/api/account/chat-history/*', async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const res = await route.fetch()
        const body = (await res.json()) as Record<string, unknown>
        await route.fulfill({ response: res, json: { ...body, messages: written, hasMore: false } })
      })
    }
    await page.addInitScript(() => {
      window.addEventListener('ni:open-card', (event) => {
        ;(window as unknown as { __demoOpen?: unknown }).__demoOpen = (event as CustomEvent).detail
      })
    })
    const answers: Record<string, unknown> = {}
    waiting.clear()
    const done = (req: unknown) => {
      if (waiting.delete(req)) lastAnswer = Date.now()
    }
    page.on('request', (req) => {
      if (!req.url().startsWith(`${ORIGIN}/api/`)) return
      waiting.add(req)
      lastAnswer = Date.now()
    })
    page.on('requestfinished', done)
    page.on('requestfailed', done)
    page.on('response', async (res) => {
      const u = new URL(res.url())
      if (u.origin === ORIGIN && u.pathname.startsWith('/api/')) lastAnswer = Date.now()
      const method = res.request().method()
      if (u.origin !== ORIGIN || !u.pathname.startsWith('/api/account/') && method !== 'GET') return
      if (u.origin !== ORIGIN || !u.pathname.startsWith('/api/') || (method !== 'GET' && method !== 'POST') || res.status() !== 200) return
      if (!(res.headers()['content-type'] ?? '').includes('json')) return
      try {
        const body = scrub(u.pathname + u.search, await res.json())
        if (method === 'GET') {
          answers[u.pathname + u.search] = body
          // For a request whose query differs by the time a visitor makes it (a `since`, a timezone).
          if (u.search && !(u.pathname in answers)) answers[u.pathname] = body
        } else {
          // A list the app reads with a POST: kept under its exact request, and under its path for a near miss.
          answers[`POST ${u.pathname}${u.search}#${res.request().postData() ?? ''}`] = body
          answers[`POST ${u.pathname}`] = body
        }
      } catch {}
    })
    await page.goto(`${ORIGIN}/auth/demo-link?token_hash=${data.properties.hashed_token}`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await settle(page, 18_000)
    await page.addStyleTag({ content: 'nextjs-portal,[data-sonner-toaster]{display:none}' })
    await run(page, steps)
    for (const control of then ?? []) await press(page, control)
    const open = chat ? null : await page.evaluate(() => (window as unknown as { __demoOpen?: unknown }).__demoOpen ?? null)
    // The picture the frame shows until the app is up, and wherever the app is not loaded at all.
    await page.mouse.move(0, 0)
    const shot = await page.screenshot({ type: 'png' })
    mkdirSync(POSTERS, { recursive: true })
    await sharp(shot).webp({ quality: 82 }).toFile(`${POSTERS}/${name}.webp`)
    if (SHOTS) writeFileSync(`${SHOTS}/demo-rec-${name}.png`, shot)
    // A request still on its way through the chat's route must not fail the run as the page closes.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
    let target: unknown = null
    if (!open && wanted?.type === 'page') target = wanted
    if (!open && (wanted?.type === 'capture' || wanted?.type === 'contact' || wanted?.type === 'action')) {
      const workspaceId = (answers['/api/account/workspace'] as { workspace?: { id?: string } } | undefined)?.workspace?.id
      if (!workspaceId) throw new Error(`${name}: the recording has no workspace answer to look the ${wanted.type} up in`)
      const found =
        wanted.type === 'capture'
          ? await admin.from('captures').select('id').eq('workspace_id', workspaceId).eq('title', wanted.title).limit(1).maybeSingle()
          : wanted.type === 'action'
            ? await admin.from('actions').select('id').eq('workspace_id', workspaceId).eq('title', wanted.title).limit(1).maybeSingle()
            : await admin.from('contact').select('id').eq('workspace_id', workspaceId).eq('full_name', wanted.title).limit(1).maybeSingle()
      if (found.error || !found.data) throw new Error(`${name}: no ${wanted.type} "${wanted.title}" in the demo workspace`)
      target = { type: wanted.type, id: found.data.id, title: wanted.title }
    }
    const out = JSON.stringify({ open, target, ...(then?.length ? { then } : {}), answers })
    assertMadeUp(name, out)
    writeFileSync(`${OUT}/${name}.json`, out)
    if (picture === 'demo') {
      // Signed out, in a context of its own: the demo as a visitor's frame draws it.
      const demo = await browser.newContext({ viewport: size ?? { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark', timezoneId: 'America/Los_Angeles' })
      const view = await demo.newPage()
      await view.goto(`${ORIGIN}/demo/app?screen=${name}`, { waitUntil: 'load', timeout: 180_000 })
      await view.waitForTimeout(20_000)
      const drawn = await view.screenshot({ type: 'png' })
      await sharp(drawn).webp({ quality: 82 }).toFile(`${POSTERS}/${name}.webp`)
      if (SHOTS) writeFileSync(`${SHOTS}/demo-rec-${name}.png`, drawn)
      await demo.close()
    }
    console.log(`${name}: ${Object.keys(answers).length} answers, ${out.length} bytes, ${open ? 'open request saved' : target ? 'target saved' : chat ? 'the home chat' : 'NOTHING TO OPEN IT WITH'}`)
  }
  await browser.close()
}

main().catch((err) => {
  console.error(`[record-demo-screens] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
