/**
 * After the pull request (roadmap track E, steps 4 and 5): the run that made
 * a change settles, the host's preview shows up, the merge goes live, and
 * the wiring is checked for real.
 *
 *   run settled   {@link onWebsiteRunSettled} (the coding run's outcome
 *                 route): a pull request → its number, then the preview wait
 *                 and the merge card (src/lib/inngest/website-functions.ts);
 *                 a failed run, or one that finished with no pull request
 *                 (it needs something only the owner has) → failed, and the
 *                 owner told in plain words.
 *   preview       {@link changePreview}: the host's preview of the PR's head.
 *   deploy        {@link pollDeploy}, once a minute after the merge: the
 *                 host's production deploy of the merge commit (its GitHub
 *                 deployment). A failed deploy is told. An edit is live once
 *                 it succeeds; a host that reports nothing gets the benefit
 *                 of the doubt after a few minutes, in hedged words.
 *   live check    {@link checkWiringLive}, for a wiring change: the live site
 *                 must carry the new intake URL (its page, or the same-origin
 *                 scripts it loads), whose key must hash to the change's;
 *                 then a real test post goes to that URL from the site's
 *                 origin, marked with a one-time nonce the intake takes as
 *                 the check, never as a quote (intake-handler.ts). Passed:
 *                 "it works". The page not showing it within the watch: the
 *                 owner is told it's merged but not seen live.
 *
 * Pure over {@link DeployDeps}; never throws for an outcome.
 */
import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hashIntakeKey } from '@/lib/customers/intake-key'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { inngest } from '@/lib/inngest/client'
import { checkFailedText, clip, failedText, itWorksText, liveText } from './brief'
import { findPreviewUrl, getPull, parsePullUrl, productionDeploy, type DeployState, type GithubDeps } from './github'
import { activateIntakeKey, changeForm, failChange, keyStillWanted, notifyOwner, type OwnerNote } from './approval'
import { fetchPublic, publicHttpsUrl } from './fetch'
import { appOrigin } from '@/lib/twilio/config'
import { prOpenedEventId, WEBSITE_PR_OPENED, type WebsiteEventData } from './events'
import { nonceHash, testSubmission } from './intake-test'
import { getChange, getChangeByRun, getSite, updateChange, updateSite } from './store'
import { type CheckResult, type Framework, type WebsiteChange, type WebsiteSite } from './types'

type Svc = SupabaseClient

export interface DeployDeps {
  github?: (token: string) => GithubDeps
  token?: (svc: Svc, userId: string) => Promise<string | null>
  notify?: (svc: Svc, note: OwnerNote) => Promise<void>
  send?: (event: { name: string; id?: string; data: WebsiteEventData }) => Promise<unknown>
  /** Makes a wiring's key live (default approval.ts activateIntakeKey): tried again on every poll until it is. */
  activateKey?: (svc: Svc, change: WebsiteChange) => Promise<void>
  /** The live site's pages and the test post (default: fetch). */
  fetchImpl?: typeof fetch
  now?: () => number
}

const githubOf = (deps: DeployDeps, token: string): GithubDeps => deps.github?.(token) ?? { token }
const tokenOf = (deps: DeployDeps, svc: Svc, userId: string) => (deps.token ?? storedGithubToken)(svc, userId)
const notifyOf = (deps: DeployDeps) => deps.notify ?? notifyOwner

// ── The run settled ──────────────────────────────────────────────────────────

/**
 * A coding run settled (the outcome route, after its own settle): when it was
 * a website change's, move the change on. Never throws, never slows the
 * route: the preview wait runs in Inngest.
 */
export async function onWebsiteRunSettled(
  svc: Svc,
  run: { workspaceId: string; agentRunId: string; result: 'pr_open' | 'completed' | 'failed'; prUrl: string | null; summary: string | null; error: string | null },
  deps: DeployDeps = {},
): Promise<void> {
  try {
    const change = await getChangeByRun(svc, run.workspaceId, run.agentRunId)
    if (!change || change.state !== 'preparing') return
    const site = await getSite(svc, change.workspaceId, change.siteId)
    if (!site) return
    const pull = parsePullUrl(run.prUrl)
    if (run.result === 'pr_open' && pull && pull.repo.toLowerCase() === site.repoFullName.toLowerCase()) {
      await updateChange(svc, change.workspaceId, change.id, { pr_number: pull.number, pr_url: run.prUrl, ...(run.summary ? { summary: clip(run.summary, 600) } : {}) }, ['preparing'])
      await (deps.send ?? ((e: { name: string; id?: string; data: WebsiteEventData }) => inngest.send(e)))({ name: WEBSITE_PR_OPENED, id: prOpenedEventId(change.id, null), data: { workspaceId: change.workspaceId, changeId: change.id } })
      return
    }
    if (run.result === 'completed') {
      // No pull request: the run needs something only the owner has (its summary says what).
      const moved = await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: clip(run.summary ?? 'finished with no change', 900) }, ['preparing'])
      if (moved) {
        const text = run.summary ? `I need a bit more before I can change your site: ${clip(run.summary, 260)}` : failedText({ kind: change.kind })
        await notifyOf(deps)(svc, { userId: site.connectedBy, workspaceId: change.workspaceId, text, key: `website-${change.id}-needs` })
      }
      return
    }
    await failChange(svc, change, site, run.error ?? 'the run failed', deps)
  } catch (err) {
    console.warn('[website] run settle hook skipped:', err instanceof Error ? err.message : String(err))
  }
}

// ── The preview ──────────────────────────────────────────────────────────────

/** The host's preview of the change's pull request head, as far as GitHub knows now. */
export async function changePreview(svc: Svc, args: WebsiteEventData, deps: DeployDeps = {}): Promise<DeployState & { head?: string }> {
  const change = await getChange(svc, args.workspaceId, args.changeId)
  if (!change || change.state !== 'preparing' || !change.prNumber) return { state: 'none', url: null }
  const site = await getSite(svc, change.workspaceId, change.siteId)
  const token = site ? await tokenOf(deps, svc, site.connectedBy) : null
  if (!site || !token) return { state: 'none', url: null }
  const gh = githubOf(deps, token)
  const pull = await getPull(gh, site.repoFullName, change.prNumber)
  if (!pull.ok) return { state: 'none', url: null }
  return { ...(await findPreviewUrl(gh, site.repoFullName, pull.value.headSha)), head: pull.value.headSha }
}

// ── The deploy, and the live check ───────────────────────────────────────────

/** Polls the deploy watch makes (one a minute after the first). */
export const DEPLOY_POLLS = 20
/** An edit whose host reports no deploy is taken as live after this many polls. */
const NO_REPORT_GRACE_POLLS = 4

export type PollResult = { done: true; outcome: string } | { done: false }

/** One poll of the deploy watch (see the header). `poll` counts from 0. */
export async function pollDeploy(svc: Svc, args: WebsiteEventData & { poll: number }, deps: DeployDeps = {}): Promise<PollResult> {
  const change = await getChange(svc, args.workspaceId, args.changeId)
  if (!change || change.state !== 'deploying' || !change.mergeSha) return { done: true, outcome: 'not_deploying' }
  const site = await getSite(svc, change.workspaceId, change.siteId)
  const token = site && site.state !== 'disconnected' ? await tokenOf(deps, svc, site.connectedBy) : null
  if (!site || !token) return { done: true, outcome: 'no_site' }
  const deploy = await productionDeploy(githubOf(deps, token), site.repoFullName, change.mergeSha)
  if (deploy.state === 'failure') {
    const moved = await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: 'the host’s deploy failed' }, ['deploying'])
    if (moved) {
      await notifyOf(deps)(svc, {
        userId: site.connectedBy,
        workspaceId: change.workspaceId,
        text: "Your host couldn't put the change live: its deploy failed. Your site still shows the version from before. Text me and I'll look into it, or say \"undo\".",
        key: `website-${change.id}-deploy-failed`,
      })
    }
    return { done: true, outcome: 'deploy_failed' }
  }
  if (change.kind === 'wire_form') {
    // The key went live at the merge; if that write failed, every poll tries again (the merged form posts to it).
    await ensureKeyLive(svc, change, deps)
    if (deploy.state === 'pending') return { done: false }
    const check = await checkWiringLive(svc, change, site, deps)
    if (check.outcome === 'not_seen') return { done: false }
    await finishLive(svc, change, site, check, deps)
    return { done: true, outcome: check.outcome }
  }
  if (deploy.state === 'success' || (deploy.state === 'none' && args.poll + 1 >= NO_REPORT_GRACE_POLLS)) {
    await finishLive(svc, change, site, deploy.state === 'success' ? { outcome: 'passed' } : { outcome: 'not_seen', detail: 'the host reports no deploys' }, deps)
    return { done: true, outcome: deploy.state === 'success' ? 'live' : 'assumed_live' }
  }
  return { done: false }
}

/** A merged wiring's key made live if it still should be (a site still connected, no later wiring). Never throws. */
async function ensureKeyLive(svc: Svc, change: WebsiteChange, deps: DeployDeps): Promise<void> {
  try {
    if (await keyStillWanted(svc, change)) await (deps.activateKey ?? activateIntakeKey)(svc, change)
  } catch (err) {
    console.error('[website] intake key still not live:', err instanceof Error ? err.message : String(err))
  }
}

/** The watch ran out: told honestly, never as working. */
export async function giveUpDeploy(svc: Svc, args: WebsiteEventData, deps: DeployDeps = {}): Promise<void> {
  const change = await getChange(svc, args.workspaceId, args.changeId)
  if (!change || change.state !== 'deploying') return
  const site = await getSite(svc, change.workspaceId, change.siteId)
  if (!site) return
  if (change.kind === 'wire_form') await ensureKeyLive(svc, change, deps)
  await finishLive(svc, change, site, { outcome: 'not_seen', detail: 'not seen live within the watch' }, deps)
}

/** The change's watch is over: live (with what the check found), and the owner told. */
async function finishLive(svc: Svc, change: WebsiteChange, site: WebsiteSite, check: CheckResult, deps: DeployDeps): Promise<void> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString()
  const moved = await updateChange(svc, change.workspaceId, change.id, { state: 'live', live_at: nowIso, check_result: check }, ['deploying'])
  if (!moved) return
  let text: string
  if (change.kind === 'wire_form') {
    if (check.outcome === 'passed') {
      await updateSite(svc, change.workspaceId, site.id, { state: 'wired', wired_at: nowIso }).catch(() => undefined)
      text = itWorksText({ form: changeForm(change, site), siteUrl: site.siteUrl })
    } else {
      text = checkFailedText(check)
    }
  } else if (check.outcome === 'passed') {
    text = liveText({ siteUrl: site.siteUrl, kind: change.kind })
  } else {
    text = `Your change is merged${site.siteUrl ? ` and should show on ${site.siteUrl.replace(/^https:\/\//, '')} in a few minutes` : ''}. Text me if you don't see it, or "undo" to take it back.`
  }
  await notifyOf(deps)(svc, { userId: site.connectedBy, workspaceId: change.workspaceId, text, key: `website-${change.id}-live` })
}

/** An intake URL in a page or script, with its key. */
const INTAKE_URL_RE = /https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/api\/intake\/quotes\/(qk_[A-Za-z0-9_-]{43})/g
const PAGE_MAX_BYTES = 2_000_000
const SCRIPT_MAX_BYTES = 3_000_000
const SCRIPTS_MAX = 25
/** Pages a form commonly sits on, read after its own page when that is unknown. */
const COMMON_FORM_PAGES = ['/quote', '/contact', '/get-a-quote', '/book', '/estimate', '/free-quote']
/** Pages the check reads at most. */
const PAGES_MAX = 4

/** The page a form's file most likely renders at, by framework. Pure. */
export function formPagePath(framework: Framework | null, filePath: string): string | null {
  const p = filePath.replace(/\\/g, '/')
  const clean = (route: string) => `/${route.replace(/\([^)]*\)\/?/g, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '')}`.replace(/\/$/, '') || '/'
  let m = p.match(/^(?:src\/)?app\/(.*?)\/?page\.(?:tsx|jsx|ts|js|mdx)$/)
  if (m) return clean(m[1])
  m = p.match(/^(?:src\/)?pages\/(.*?)\.(?:tsx|jsx|ts|js|astro|vue|svelte|mdx|md|html)$/)
  if (m && !m[1].startsWith('api/') && !m[1].startsWith('_')) return clean(m[1].replace(/(^|\/)index$/, ''))
  m = p.match(/^(?:src\/)?routes\/(.*?)\/?\+page\.svelte$/)
  if (m) return clean(m[1])
  if (framework === 'html' || /\.html?$/i.test(p)) {
    const html = p.replace(/^(public|site|docs|www|static)\//, '')
    if (/(^|\/)index\.html?$/i.test(html)) return clean(html.replace(/index\.html?$/i, ''))
    return `/${html}`
  }
  return null
}

/** A path on the live site, under its base (a GitHub Pages project site serves from /repo/). Pure. */
export function sitePage(siteUrl: string, path: string): string | null {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`
  return publicHttpsUrl(path.replace(/^\//, ''), base)?.toString() ?? null
}

/** The pages the live check reads: the form's own (or the page importing it), the home page, then common ones. Pure. */
export function checkPages(siteUrl: string, framework: Framework | null, form: { path: string; page?: string | null } | null): string[] {
  const own = form ? formPagePath(framework, form.page ?? form.path) : null
  const known = own !== null
  const paths = [own, '/', ...(known ? [] : COMMON_FORM_PAGES)].filter((p): p is string => p !== null)
  const urls = paths.map((p) => sitePage(siteUrl, p)).filter((u): u is string => !!u)
  return [...new Set(urls)].slice(0, PAGES_MAX)
}

/** The same-origin scripts a page loads (src attributes), at most {@link SCRIPTS_MAX}. Pure. */
export function sameOriginScripts(html: string, pageUrl: string): string[] {
  const out: string[] = []
  const origin = new URL(pageUrl).origin
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(m[1], pageUrl)
      if (url.origin === origin && !out.includes(url.toString())) out.push(url.toString())
    } catch {
      // Not a URL.
    }
    if (out.length >= SCRIPTS_MAX) break
  }
  return out
}

/**
 * The live page (where its redirects ended) and script that carry Dial8's
 * own intake URL with a key hashing to `keyHash`, or null. An intake URL on
 * any other host is never the business's, and is never posted to.
 */
export async function findLiveIntake(deps: DeployDeps, pages: readonly string[], keyHash: string): Promise<{ pageUrl: string; intakeUrl: string } | null> {
  const intakeOrigin = new URL(appOrigin()).origin
  const scan = (text: string) => {
    for (const m of text.matchAll(INTAKE_URL_RE)) {
      if (new URL(m[0]).origin === intakeOrigin && hashIntakeKey(m[1]) === keyHash) return m[0]
    }
    return null
  }
  for (const page of pages) {
    const got = await fetchPublic(page, { fetchImpl: deps.fetchImpl, maxBytes: PAGE_MAX_BYTES })
    if (!got?.text) continue
    let hit = scan(got.text)
    if (!hit) {
      for (const script of sameOriginScripts(got.text, got.url)) {
        const js = await fetchPublic(script, { fetchImpl: deps.fetchImpl, maxBytes: SCRIPT_MAX_BYTES })
        if (js?.text && (hit = scan(js.text))) break
      }
    }
    if (hit) return { pageUrl: got.url, intakeUrl: hit }
  }
  return null
}

/**
 * The wiring's live check (see the header): the live site carries the new
 * intake URL, and a test post to it from the site's origin reaches the
 * intake. `not_seen` while the live site doesn't carry it yet.
 */
export async function checkWiringLive(svc: Svc, change: WebsiteChange, site: WebsiteSite, deps: DeployDeps = {}): Promise<CheckResult> {
  if (!site.siteUrl || !change.intakeKeyHash) return { outcome: 'not_seen', detail: site.siteUrl ? 'no key' : 'no live address' }
  const pages = checkPages(site.siteUrl, site.inspection?.framework ?? null, changeForm(change, site))
  const live = await findLiveIntake(deps, pages, change.intakeKeyHash)
  if (!live) return { outcome: 'not_seen', detail: 'the live site does not carry the new intake URL yet' }
  const nonce = randomBytes(18).toString('base64url')
  await updateChange(svc, change.workspaceId, change.id, { check_nonce_hash: nonceHash(nonce) }, ['deploying'])
  let status = 0
  try {
    // From where the customer's browser is: the page's origin after its redirects.
    const res = await (deps.fetchImpl ?? fetch)(live.intakeUrl, {
      redirect: 'manual',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(live.pageUrl).origin },
      body: new URLSearchParams(testSubmission(nonce)).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    status = res.status
  } catch {
    status = 0
  }
  const after = await getChange(svc, change.workspaceId, change.id)
  const receivedAt = after?.checkResult?.receivedAt ?? null
  if (receivedAt && status >= 200 && status < 300) return { outcome: 'passed', pageUrl: live.pageUrl, status, receivedAt }
  return { outcome: status === 403 ? 'refused' : 'failed', pageUrl: live.pageUrl, status, detail: status === 403 ? 'the intake refused the site’s origin' : 'the test post did not reach the intake' }
}
