/**
 * The two email-draft tools call same-origin /api/account/* endpoints and
 * carry the caller's bearer when one was re-armed for the run (the device ask's
 * sealed JWT). Two invariants:
 *   1. draft_followup_email never lets a model-supplied capture_id shape the
 *      URL path the bearer is sent to: a non-UUID id (`../` traversal, query or
 *      fragment smuggling) never reaches fetch.
 *   2. Both tools pin the endpoint to the run's workspace with x-workspace-id,
 *      so getCurrentWorkspaceId() does not fall back to the oldest membership.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCalendarCaptureTools } from '../calendar-capture'
import { createEmailManagementTools } from '../email-management'
import { WORKSPACE_HEADER } from '@/lib/workspace'

vi.mock('@/lib/integrations/calendar-sync', () => ({
  syncCalendarToCaptures: vi.fn(),
  getUpcomingCaptures: vi.fn(),
}))
vi.mock('@/lib/integrations/calendar', () => ({
  listCalendarEvents: vi.fn(),
  getCalendarProvider: vi.fn(),
}))

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const TOKEN = 'caller.jwt.value'
const CAPTURE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const supabase = {} as unknown as SupabaseClient

type FetchCall = [string, RequestInit]
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test')
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ subject: 's', to: [], body: 'b', draft_id: null, count: 0, drafts: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function followup() {
  const tools = createCalendarCaptureTools(USER_ID, supabase, WORKSPACE_ID, TOKEN)
  const execute = tools.draft_followup_email.execute as unknown as (
    input: Record<string, unknown>,
    opts: typeof EXEC_OPTS,
  ) => Promise<Record<string, unknown>>
  return (capture_id: unknown) => execute({ capture_id, tone: 'professional' }, EXEC_OPTS)
}

describe('draft_followup_email capture_id', () => {
  it.each([
    ['../../device-tokens?x=', 'path traversal'],
    [`${CAPTURE_ID}/../../../device-tokens`, 'uuid prefix then traversal'],
    [`${CAPTURE_ID}?next=/api/x`, 'query smuggling'],
    [`${CAPTURE_ID}#frag`, 'fragment smuggling'],
    ['%2e%2e%2f%2e%2e%2fdevice-tokens', 'pre-encoded traversal'],
    ['not-a-uuid', 'plain garbage'],
    ['', 'empty'],
  ])('refuses %j (%s) without calling fetch', async (id) => {
    const res = await followup()(id)
    expect(res.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-UUID id at the input schema too', () => {
    const tools = createCalendarCaptureTools(USER_ID, supabase, WORKSPACE_ID, TOKEN)
    const schema = tools.draft_followup_email.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ capture_id: '../../x' }).success).toBe(false)
    expect(schema.safeParse({ capture_id: CAPTURE_ID }).success).toBe(true)
  })

  it('posts a UUID id to exactly the draft-followup route with the bearer and the run workspace', async () => {
    const res = await followup()(CAPTURE_ID)
    expect(res.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as FetchCall
    expect(new URL(url).pathname).toBe(`/api/account/captures/${CAPTURE_ID}/draft-followup`)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers[WORKSPACE_HEADER]).toBe(WORKSPACE_ID)
  })
})

describe('generate_email_drafts', () => {
  it('pins the endpoint to the run workspace with x-workspace-id', async () => {
    const tools = createEmailManagementTools(USER_ID, supabase, WORKSPACE_ID, TOKEN)
    const execute = tools.generate_email_drafts.execute as unknown as (
      input: Record<string, unknown>,
      opts: typeof EXEC_OPTS,
    ) => Promise<Record<string, unknown>>
    await execute({ max_drafts: 5, tone: 'professional' }, EXEC_OPTS)
    const [url, init] = fetchMock.mock.calls[0] as FetchCall
    expect(new URL(url).pathname).toBe('/api/account/email/generate-drafts')
    const headers = init.headers as Record<string, string>
    expect(headers[WORKSPACE_HEADER]).toBe(WORKSPACE_ID)
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })
})
