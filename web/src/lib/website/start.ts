/**
 * Starting a website change (roadmap track E, steps 3 and 6): one loop for
 * every kind, so wiring the form, an edit and an undo each end as a pull
 * request the owner approves by text.
 *
 *   connect   {@link connectWebsite}: the owner picked a repo they can push
 *             to; it is inspected (./inspect.ts) and saved, with the
 *             project and the shared cloud environment its coding runs use
 *             ({@link ensureSiteWorkspace}: the repo's project, else a new
 *             "Website" one; and always a CLEAN cloud environment of its
 *             own: shared, restricted network, no env vars, no setup script,
 *             never a project's or the workspace's default, so a run on the
 *             site's repo can't reach another project's secrets).
 *   wire      {@link startWiring}: a fresh intake key for the site's
 *             origins (its SHA-256 kept on the change: the key goes live
 *             only at merge, so the business's current one keeps working
 *             until then), the wiring brief (./brief.ts), a coding run.
 *   edit      {@link startEdit}: the owner's words, fenced, as a coding run.
 *   undo      {@link startUndo}: GitHub's own revert of the last change that
 *             went live, as a new pull request (no coding run).
 *
 * The coding run is start_cloud_coding_run's own launch
 * (src/lib/chat/cloud-coding-tools.ts startSiteCodingRun), keyed on the
 * change, so a retried start returns the run it started. When its pull
 * request opens, ./approval.ts raises the merge card (src/lib/inngest/website-functions.ts
 * waits a little for the host's preview first).
 *
 * Only the person who connected the site starts its changes: the run and its
 * pull request are theirs on GitHub. At most one change is open per site.
 * Never throws for an outcome the owner should hear: each is a result.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { startSiteCodingRun } from '@/lib/chat/cloud-coding-tools'
import { createCloudEnvironment, listCloudEnvironments } from '@/lib/environments/store'
import type { CloudEnvironment } from '@/lib/environments/types'
import { cleanOrigins, generateIntakeKey, hashIntakeKey } from '@/lib/customers/intake-key'
import { intakeUrl } from '@/lib/customers/profile-input'
import { businessName } from '@/lib/customers/store'
import { appOrigin } from '@/lib/twilio/config'
import { editRequest, failedText, inspectionWords, wiringBrief } from './brief'
import { getPull, getRepo, listOwnerRepos, revertPull, type GithubDeps } from './github'
import { rankingHints, rankWebsiteRepos, WEBSITE_REPO_CHOICES } from './repos'
import { inspectRepo, platformHostOf, siteUrlOf } from './inspect'
import { liveAddress } from './address'
import { fetchPublic } from './fetch'
import { prOpenedEventId, WEBSITE_PR_OPENED, type WebsiteEventData } from './events'
import { reconcileOpenChange } from './reconcile'
import { connectSite, getLiveSite, getOpenChange, insertChange, recentChanges, updateChange, updateSite } from './store'
import type { FormCandidate, SiteInspection, WebsiteChange, WebsiteSite } from './types'

type Svc = SupabaseClient

/** The project and environment names the flow makes when the workspace has none. */
export const WEBSITE_PROJECT_NAME = 'Website'
export const WEBSITE_ENVIRONMENT_NAME = 'Website'

/** The most of an edit request texted in: the card and the text asking for their yes quote it back whole. */
export const TEXT_EDIT_REQUEST_MAX = 300

export interface Who {
  userId: string
  workspaceId: string
}

/** Seams for the tests. */
export interface StartDeps {
  github?: (token: string) => GithubDeps
  token?: (svc: Svc, userId: string) => Promise<string | null>
  launch?: typeof startSiteCodingRun
  send?: (event: { name: string; id?: string; data: WebsiteEventData }) => Promise<unknown>
  /** The live site's pages (the wiring's origin lookup). */
  fetchImpl?: typeof fetch
}

const githubOf = (deps: StartDeps, token: string): GithubDeps => deps.github?.(token) ?? { token }
const tokenOf = (deps: StartDeps, svc: Svc, userId: string) => (deps.token ?? storedGithubToken)(svc, userId)
const sendOf = (deps: StartDeps) => deps.send ?? ((event: { name: string; id?: string; data: WebsiteEventData }) => inngest.send(event))

export type Outcome = { success: true; [k: string]: unknown } | { success: false; code: string; error: string; [k: string]: unknown }

const fail = (code: string, error: string, extra: Record<string, unknown> = {}): Outcome => ({ success: false, code, error, ...extra })

const NO_GITHUB = fail('NO_GITHUB', 'GitHub isn’t connected. Text them a GitHub link first (connect_link with provider github).')

/** The live origins a site's form may post from: the site, with and without www, plus any it redirects to. Pure. */
export function siteOrigins(siteUrl: string | null, alsoUrls: readonly (string | null | undefined)[] = []): string[] {
  if (!siteUrl) return []
  try {
    const host = new URL(siteUrl).hostname
    const bare = host.replace(/^www\./, '')
    const extra = alsoUrls.flatMap((u) => {
      try {
        return u ? [new URL(u).origin] : []
      } catch {
        return []
      }
    })
    return cleanOrigins([`https://${bare}`, `https://www.${bare}`, ...extra])
  } catch {
    return []
  }
}

/** The person's role in the workspace, or null. */
async function roleOf(svc: Svc, who: Who): Promise<string | null> {
  const { data } = await svc.from('member').select('role').eq('workspace_id', who.workspaceId).eq('user_id', who.userId).maybeSingle()
  return (data as { role?: string } | null)?.role ?? null
}

/** Who may connect the business's website, or connect its form (which swaps its live intake key): an owner or admin. */
const MANAGES_SITE = new Set(['owner', 'admin'])

/** Whether two site URLs are the same site's host, with or without www. Pure. */
function sameSiteHost(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b
  const host = (u: string) => new URL(u).hostname.replace(/^www\./, '')
  return host(a) === host(b)
}

/** Where the live site's address ends up after its redirects (a bare domain to www, a host's domain to the real one), or null. */
async function finalSiteUrl(siteUrl: string, deps: StartDeps): Promise<string | null> {
  const got = await fetchPublic(siteUrl, { fetchImpl: deps.fetchImpl, maxBytes: 3_000_000 }).catch(() => null)
  return got && got.status < 400 ? got.url : null
}

// ── Connect ──────────────────────────────────────────────────────────────────

/** The workspace's own company's domain (research_my_company), as a site URL, or null. */
async function companySiteUrl(svc: Svc, workspaceId: string): Promise<string | null> {
  const { data } = await svc.from('company').select('domain').eq('workspace_id', workspaceId).eq('is_workspace_company', true).limit(1)
  const domain = ((data as Array<{ domain?: unknown }> | null) ?? [])[0]?.domain
  return typeof domain === 'string' && /\./.test(domain) ? `https://${domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : null
}

/**
 * Connect the owner's site: the repo must be one they can push to. Inspected
 * and saved; the project and environment its runs use are made now, so a
 * problem shows at connect, not at the first change.
 */
export async function connectWebsite(svc: Svc, who: Who, input: { repo: string; siteUrl?: string | null; remoteTurn?: boolean }, deps: StartDeps = {}): Promise<Outcome> {
  const token = await tokenOf(deps, svc, who.userId)
  if (!token) return NO_GITHUB
  // Who may connect the business's site: an owner or admin; who may re-point it: the person who connected it, or an owner or admin.
  const live = await getLiveSite(svc, who.workspaceId)
  if (!live || live.connectedBy !== who.userId) {
    if (!MANAGES_SITE.has((await roleOf(svc, who)) ?? '')) {
      return live
        ? fail('NOT_SITE_OWNER', 'Someone else connected this business’s website. Only they, or an owner or admin, can change which repo it is.')
        : fail('NOT_ALLOWED', 'Only an owner or admin of the workspace connects its website. Tell them.')
    }
  }
  const sameRepo = !!live && live.repoFullName.toLowerCase() === input.repo.toLowerCase()
  // By text or call (a caller ID can be spoofed): a site that has had changes keeps its repo and address (the app changes those),
  // and a repo is picked only from the list they were texted (the likeliest website repos), never any repo they can push to.
  // Re-reading the same repo keeps the address it has (one they typed stays) unless they give another.
  let keepAddress = !!live && sameRepo && !input.siteUrl && !!live.siteUrl
  if (input.remoteTurn) {
    const changed = live ? (await recentChanges(svc, who.workspaceId, live.id, 1)).length > 0 : false
    keepAddress ||= !!live && changed && sameRepo
    if (live && changed && !sameRepo) {
      return fail('SWITCH_IN_APP', `Their website is already connected (${live.repoFullName}) and has had changes. Switching it to another repo happens in the Dial8 app, not by text: tell them.`)
    }
    if (live && changed && input.siteUrl && !sameSiteHost(siteUrlOf(input.siteUrl), live.siteUrl)) {
      return fail('SWITCH_IN_APP', 'Their website’s address is set and it has had changes. Changing the address happens in the Dial8 app, not by text: tell them.')
    }
    if (!sameRepo && !(await isListedChoice(svc, who, token, input.repo, deps))) {
      return fail('NOT_LISTED', 'By text I can connect one of the repos on the numbered list (list_website_repos). Another repo is connected in the Dial8 app: tell them.')
    }
  }
  // A change in flight runs against this repo and address: neither moves under it.
  if (live && (!sameRepo || (input.siteUrl && !sameSiteHost(siteUrlOf(input.siteUrl), live.siteUrl)))) {
    const found = await getOpenChange(svc, who.workspaceId, live.id)
    const open = found ? await reconcileOpenChange(svc, found) : null
    if (open) return fail('OPEN_CHANGE', `${openChangeWords(open)} The website's repo and address stay as they are until it is done.`, { change_id: open.id, state: open.state })
  }
  const gh = githubOf(deps, token)
  const repo = await getRepo(gh, input.repo)
  if (!repo.ok) {
    return repo.status === 404
      ? fail('REPO_NOT_FOUND', `Their GitHub account can't see ${input.repo}. Ask them to check the name (list_website_repos lists what it can see).`)
      : fail('GITHUB_UNAVAILABLE', `GitHub didn't answer about ${input.repo} just now. Try again in a moment.`)
  }
  if (!repo.value.canPush) return fail('NO_PUSH', `Their GitHub account can read ${repo.value.fullName} but can't change it. Whoever owns the repo has to give them write access, or connect the account that owns it.`)
  if (repo.value.archived) return fail('ARCHIVED', `${repo.value.fullName} is archived on GitHub, so it can't take changes.`)
  const inspected = await inspectRepo(gh, repo.value.fullName, repo.value.defaultBranch, { homepage: repo.value.homepage })
  if (!inspected.ok) return fail('INSPECT_FAILED', inspected.error)
  const inspection: SiteInspection = inspected.inspection
  // The live address: what they said, the repo's own (a CNAME file, package.json), its GitHub homepage, then the business's domain;
  // from a host's own address (x.vercel.app), the business's domain the site names as its canonical one (./address.ts).
  const candidate = input.siteUrl ?? inspection.siteUrl ?? siteUrlOf(repo.value.homepage) ?? (await companySiteUrl(svc, who.workspaceId).catch(() => null))
  const address = candidate ? await liveAddress(candidate, { fetchImpl: deps.fetchImpl, stated: !!input.siteUrl }) : null
  // A kept address stays (by text, a changed site's: the repo's files, its canonical address, can change with it).
  const siteUrl = keepAddress && live ? live.siteUrl : (address?.siteUrl ?? null)
  inspection.alsoUrls = keepAddress && live ? (live.inspection?.alsoUrls ?? []) : (address?.alsoUrls ?? [])
  const site = await connectSite(svc, {
    workspaceId: who.workspaceId,
    connectedBy: who.userId,
    repoFullName: repo.value.fullName,
    defaultBranch: repo.value.defaultBranch,
    siteUrl,
    inspection,
  })
  const ready = await ensureSiteWorkspace(svc, site)
  if (!ready.ok) return fail('SETUP_FAILED', ready.error, { site_id: site.id })
  return {
    success: true,
    site_id: site.id,
    repo: site.repoFullName,
    site_url: site.siteUrl,
    found: inspectionWords(site, inspection),
    forms: inspection.forms.slice(0, 3).map((f) => ({ path: f.path, kind: f.kind, sends_to: f.submits, fields: f.fields.slice(0, 10) })),
    next: inspection.forms.length
      ? inspection.forms[0].submits === 'dial8'
        ? 'The form already posts to Dial8: nothing to wire. Tell them, and that you can change the site for them by text now.'
        : 'Tell them what you found in two short lines (the words in `found`), then ask whether you should connect the form so its requests reach you too, keeping what it does today. On their yes, call wire_website_form.'
      : 'Tell them you could not find a form customers fill in, and ask which page has it (then call wire_website_form with form_path), or carry on: you can still change the site by text.',
    // A changed site's address is changed in the app, not by text: no hint that would lead into a refusal.
    ...(input.remoteTurn && keepAddress
      ? {}
      : site.siteUrl
        ? platformHostOf(site.siteUrl) !== null
          ? { check_site_url: `The live address is the host’s own (${site.siteUrl.replace(/^https:\/\//, '')}). Ask them whether customers reach the site at a domain of their own; if so, call connect_website again with site_url.` }
          : {}
        : { ask_site_url: 'You don’t know the live address yet: ask them for it and call connect_website again with site_url.' }),
  }
}

/** Whether `repo` is one of the numbered choices the owner is texted (src/lib/website/repos.ts, the same ranking). */
async function isListedChoice(svc: Svc, who: Who, token: string, repo: string, deps: StartDeps): Promise<boolean> {
  const listed = await listOwnerRepos(githubOf(deps, token))
  if (!listed.ok) return false
  const choices = rankWebsiteRepos(listed.value, await rankingHints(svc, who.workspaceId)).slice(0, WEBSITE_REPO_CHOICES)
  return choices.some((r) => r.fullName.toLowerCase() === repo.toLowerCase())
}

/** The project and environment a site's coding runs use: found or made, and saved on the site. */
export async function ensureSiteWorkspace(svc: Svc, site: WebsiteSite): Promise<{ ok: true; projectId: string; environmentId: string } | { ok: false; error: string }> {
  try {
    const who = { userId: site.connectedBy, workspaceId: site.workspaceId }
    let projectId = site.projectId
    if (projectId) {
      const { data } = await svc.from('projects').select('id, github_repo').eq('id', projectId).eq('workspace_id', site.workspaceId).maybeSingle()
      const row = data as { github_repo?: string | null } | null
      if (!row || (row.github_repo ?? '').trim().toLowerCase() !== site.repoFullName.toLowerCase()) projectId = null
    }
    if (!projectId) {
      const { data, error } = await svc.from('projects').select('id, github_repo').eq('workspace_id', site.workspaceId).not('github_repo', 'is', null).limit(200)
      if (error) throw new Error(`projects read failed: ${error.message}`)
      const match = ((data ?? []) as Array<{ id: string; github_repo: string | null }>).find((p) => (p.github_repo ?? '').trim().toLowerCase() === site.repoFullName.toLowerCase())
      if (match) projectId = match.id
    }
    // Always a clean environment of the site's own: never a project's or the workspace's default (their env vars and setup scripts are theirs).
    const clean = (await listCloudEnvironments(svc, who)).filter(isCleanSiteEnvironment)
    let environmentId = site.environmentId && clean.some((e) => e.id === site.environmentId) ? site.environmentId : null
    environmentId ??= clean.find((e) => e.name === WEBSITE_ENVIRONMENT_NAME)?.id ?? null
    if (!environmentId) {
      const made = await createCloudEnvironment(svc, { ...who, name: WEBSITE_ENVIRONMENT_NAME, shared: true, networkAccess: 'restricted' })
      environmentId = made.id
    }
    if (!projectId) {
      const { data: last } = await svc.from('projects').select('sort_order').eq('workspace_id', site.workspaceId).order('sort_order', { ascending: false }).limit(1)
      const sortOrder = ((last as Array<{ sort_order?: number }> | null)?.[0]?.sort_order ?? -1) + 1
      const { data, error } = await svc
        .from('projects')
        .insert({ user_id: site.connectedBy, workspace_id: site.workspaceId, name: WEBSITE_PROJECT_NAME, sort_order: sortOrder, github_repo: site.repoFullName, environment_id: environmentId, description: 'Changes to the business’s website, made by text.' })
        .select('id')
        .single()
      if (error || !data) throw new Error(`project insert failed: ${error?.message ?? 'no row'}`)
      projectId = (data as { id: string }).id
    }
    await updateSite(svc, site.workspaceId, site.id, { project_id: projectId, environment_id: environmentId })
    return { ok: true, projectId, environmentId }
  } catch (err) {
    console.error('[website] site setup failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, error: 'The site connected, but its workspace setup failed. Try again in a moment.' }
  }
}

/** An environment a site's runs may use: shared, not open to the whole internet, and holding no secrets or setup of anyone's. Pure. */
export function isCleanSiteEnvironment(e: Pick<CloudEnvironment, 'shared' | 'networkAccess' | 'hasEnvVars' | 'hasSetupScript'>): boolean {
  return e.shared && e.networkAccess !== 'trusted' && !e.hasEnvVars && !e.hasSetupScript
}

// ── Changes ──────────────────────────────────────────────────────────────────

/** The site, its owner check and its open change, or the refusal the agent reads. */
async function siteFor(svc: Svc, who: Who): Promise<{ ok: true; site: WebsiteSite } | { ok: false; outcome: Outcome }> {
  const site = await getLiveSite(svc, who.workspaceId)
  if (!site) return { ok: false, outcome: fail('NO_SITE', 'No website is connected yet. Ask which GitHub repo is their site (list_website_repos), then connect_website.') }
  if (site.connectedBy !== who.userId) return { ok: false, outcome: fail('NOT_CONNECTOR', 'Only the person who connected the website (with their GitHub) can change it. Tell them.') }
  if (!MANAGES_SITE.has((await roleOf(svc, who)) ?? '')) return { ok: false, outcome: fail('NOT_ALLOWED', 'Only an owner or admin of the workspace changes its website. Tell them.') }
  const found = await getOpenChange(svc, who.workspaceId, site.id)
  // A change nothing will move any more (its run died, a settle was lost) is settled first, so it never blocks the site.
  const open = found ? await reconcileOpenChange(svc, found) : null
  if (open) return { ok: false, outcome: fail('OPEN_CHANGE', openChangeWords(open), { change_id: open.id, state: open.state }) }
  return { ok: true, site }
}

/** What the agent says when a change is still open. */
function openChangeWords(open: WebsiteChange): string {
  switch (open.state) {
    case 'preparing':
      return 'A website change is still being made. Nothing new was started: tell them you will text when it is ready.'
    case 'awaiting_yes':
      return 'A website change is waiting for their yes (by text, yes with the code they were sent; or the card in the app). Nothing new was started: ask them to answer that one first, or say no to it.'
    default:
      return 'A website change is going live right now. Nothing new was started: try again in a few minutes.'
  }
}

/** A coding run for a change, and what the agent tells the owner. */
async function launchRun(svc: Svc, who: Who, site: WebsiteSite, change: WebsiteChange, title: string, deps: StartDeps): Promise<Outcome> {
  // Re-checked every time: someone may have added env vars to the site's environment since.
  const ready = await ensureSiteWorkspace(svc, site)
  const markFailed = async (error: string) => {
    await updateChange(svc, who.workspaceId, change.id, { state: 'failed', error }, ['preparing']).catch(() => null)
  }
  if (!ready.ok) {
    await markFailed(ready.error)
    return fail('SETUP_FAILED', ready.error)
  }
  let out: Record<string, unknown>
  try {
    out = await (deps.launch ?? startSiteCodingRun)(svc, who, { projectId: ready.projectId, environmentId: ready.environmentId, title, request: change.request, changeId: change.id })
  } catch (err) {
    await markFailed(err instanceof Error ? err.message : 'the run failed to start')
    return fail('START_FAILED', 'The change could not be started just now. Nothing on their site changed; try again in a moment.')
  }
  if (out.status !== 'started') {
    const reason = typeof out.reason === 'string' ? out.reason : 'the run was refused'
    await markFailed(reason)
    return fail(String(out.code ?? 'REFUSED'), `Nothing was started: ${reason}`)
  }
  const action = out.action && typeof out.action === 'object' ? (out.action as { id?: string }) : null
  await updateChange(svc, who.workspaceId, change.id, { agent_run_id: typeof out.agent_run_id === 'string' ? out.agent_run_id : null, action_id: action?.id ?? null }, ['preparing'])
  return {
    success: true,
    change_id: change.id,
    message: 'Started: it usually takes a few minutes. When the change is ready they get a text with what changed, a preview link if their host makes one, and a code to put it live. Tell them that in one line; never say it is done.',
  }
}

/** The form a wiring change wires: the one named, else the inspection's best. */
export function pickForm(inspection: SiteInspection | null, formPath?: string | null): FormCandidate | null {
  const forms = inspection?.forms ?? []
  const named = formPath?.replace(/^\/+/, '').trim()
  if (named) {
    const want = named.toLowerCase()
    return forms.find((f) => f.path.toLowerCase() === want) ?? { path: named.slice(0, 300), kind: 'quote', fields: [], submits: 'none', target: null, score: 0 }
  }
  return forms[0] ?? null
}

/** Wire the site's form to the business's intake (step 3). */
export async function startWiring(svc: Svc, who: Who, input: { formPath?: string | null; replaceCurrent?: boolean }, deps: StartDeps = {}): Promise<Outcome> {
  const found = await siteFor(svc, who)
  if (!found.ok) return found.outcome
  const { site } = found
  if (!site.siteUrl) return fail('NO_SITE_URL', 'Ask them for their live website address first, then call connect_website again with site_url: the form is checked live once the change is up.')
  const form = pickForm(site.inspection, input.formPath)
  if (!form) return fail('NO_FORM', 'No form was found on the site. Ask them which page has it, then call wire_website_form with form_path.')
  if (form.submits === 'dial8' && !input.formPath) return fail('ALREADY_WIRED', 'That form already posts to Dial8. Nothing was started.')
  const key = generateIntakeKey()
  // The address's redirects count too (a bare domain to www, a host's domain to the real one): customers post from where they land.
  const origins = siteOrigins(site.siteUrl, [await finalSiteUrl(site.siteUrl, deps), ...(site.inspection?.alsoUrls ?? [])])
  const request = wiringBrief({
    businessName: await businessName(svc, who.workspaceId),
    site,
    inspection: site.inspection ?? { framework: 'unknown', host: 'unknown', siteUrl: site.siteUrl, forms: [form], truncated: false },
    form,
    intakeUrl: intakeUrl(appOrigin(), key),
    allowedOrigins: origins,
    replaceCurrent: input.replaceCurrent === true,
  })
  const inserted = await insertChange(svc, {
    workspaceId: who.workspaceId,
    siteId: site.id,
    kind: 'wire_form',
    request,
    requestedBy: who.userId,
    formPath: form.path,
    formKind: form.kind,
    replaceCurrent: input.replaceCurrent === true,
    intakeKeyHash: hashIntakeKey(key),
    intakeKeyPrefix: key.slice(0, 9),
    intakeOrigins: origins,
  })
  if (!inserted.ok) return fail('OPEN_CHANGE', inserted.open ? openChangeWords(inserted.open) : 'Another website change is open. Nothing new was started.')
  return launchRun(svc, who, site, inserted.change, `Send website ${form.kind === 'other' ? 'form' : form.kind} requests to Dial8`, deps)
}

/** An edit the owner asked for by text (step 6). */
export async function startEdit(svc: Svc, who: Who, input: { request: string; remoteTurn?: boolean }, deps: StartDeps = {}): Promise<Outcome> {
  const words = input.request.trim()
  if (!words) return fail('BAD_INPUT', 'Say what to change, in their words.')
  // By text the card quotes the whole request back, so it must fit there.
  if (input.remoteTurn && words.length > TEXT_EDIT_REQUEST_MAX) {
    return fail('TOO_LONG', `By text, a website change is at most ${TEXT_EDIT_REQUEST_MAX} characters (the text asking for their yes quotes it back whole). Ask them for one change at a time, in a sentence or two.`)
  }
  const found = await siteFor(svc, who)
  if (!found.ok) return found.outcome
  const { site } = found
  const request = editRequest({ businessName: await businessName(svc, who.workspaceId), site, inspection: site.inspection, ownerWords: words })
  const inserted = await insertChange(svc, { workspaceId: who.workspaceId, siteId: site.id, kind: 'edit', request: words, requestedBy: who.userId })
  if (!inserted.ok) return fail('OPEN_CHANGE', inserted.open ? openChangeWords(inserted.open) : 'Another website change is open. Nothing new was started.')
  // The change row keeps the owner's words (what the card and the section show); the run gets the full request.
  return launchRun(svc, who, site, { ...inserted.change, request }, words.split('\n')[0].slice(0, 120), deps)
}

/**
 * Undo by text: GitHub's own revert of the newest change that went live (or
 * the one named), as a pull request, through the same yes. Nothing else is
 * touched.
 */
export async function startUndo(svc: Svc, who: Who, input: { changeId?: string | null }, deps: StartDeps = {}): Promise<Outcome> {
  const found = await siteFor(svc, who)
  if (!found.ok) return found.outcome
  const { site } = found
  const recent = await recentChanges(svc, who.workspaceId, site.id, 10)
  // The newest change that reached the repo, whatever happened after (a failed deploy included).
  const target = input.changeId ? recent.find((c) => c.id === input.changeId) : recent.find((c) => !!c.mergedAt)
  if (!target || !target.prNumber || !target.mergedAt) {
    return fail('NOTHING_TO_UNDO', 'There is no website change of yours that went live to undo. Tell them.')
  }
  const token = await tokenOf(deps, svc, who.userId)
  if (!token) return NO_GITHUB
  const gh = githubOf(deps, token)
  const pull = await getPull(gh, site.repoFullName, target.prNumber)
  if (!pull.ok || !pull.value.merged) return fail('NOTHING_TO_UNDO', 'That change was never merged on GitHub, so there is nothing to undo.')
  const inserted = await insertChange(svc, {
    workspaceId: who.workspaceId,
    siteId: site.id,
    kind: 'revert',
    request: `Undo: ${target.summary ?? target.request}`.slice(0, 2000),
    requestedBy: who.userId,
    revertsChangeId: target.id,
  })
  if (!inserted.ok) return fail('OPEN_CHANGE', inserted.open ? openChangeWords(inserted.open) : 'Another website change is open. Nothing new was started.')
  const reverted = await revertPull(gh, { nodeId: pull.value.nodeId, title: `Undo: ${pull.value.title}`.slice(0, 200), body: `Owner summary: This puts your website back the way it was before "${pull.value.title}".\n\nAsked for by text through Dial8.` })
  if (!reverted.ok) {
    await updateChange(svc, who.workspaceId, inserted.change.id, { state: 'failed', error: reverted.error }, ['preparing'])
    return fail('REVERT_FAILED', `${failedText({ kind: 'revert', reason: 'GitHub could not make the undo' })} Tell them.`)
  }
  await updateChange(svc, who.workspaceId, inserted.change.id, { pr_number: reverted.value.number, pr_url: reverted.value.url }, ['preparing'])
  await sendOf(deps)({ name: WEBSITE_PR_OPENED, id: prOpenedEventId(inserted.change.id, null), data: { workspaceId: who.workspaceId, changeId: inserted.change.id } })
  return {
    success: true,
    change_id: inserted.change.id,
    message: 'The undo is ready as a change on GitHub. They get a text with a code to put it live in a moment. Tell them in one line.',
  }
}
