/**
 * Workspace routing for `create_email_draft` (src/lib/ai/tools/email.ts).
 *
 * `create_email_draft` is a ROOT create, but an unusual one: the resolved
 * workspace only decides which workspace the draft gets INDEXED under
 * (`email_thread_index`, for search) — it never changes which mailbox sends
 * it, since `connected_account` is looked up by `user_id` alone, with no
 * workspace scoping at all. `email.ts` takes no `supabase` param, so the
 * routing resolve runs on the SERVICE client (`getServiceClient()`, mocked
 * here) purely for the membership check — the same client `createEmailDraft`
 * itself already reaches for internally.
 *
 * `createEmailDraft` and the OAuth token check are mocked so this file tests
 * ONLY the routing decision (which `workspace_id` reaches `createEmailDraft`),
 * not Gmail/Outlook plumbing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  createEmailDraft: vi.fn(),
  getValidToken: vi.fn(),
  memberOf: [] as string[],
}))

vi.mock('@/lib/integrations/email', () => ({
  listEmails: vi.fn(),
  createEmailDraft: hoisted.createEmailDraft,
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: hoisted.getValidToken,
}))
vi.mock('@/lib/email/email-read-service', () => ({
  readEmailThread: vi.fn(),
  readEmailMessage: vi.fn(),
}))

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Dial8 Marketing' },
  { id: WS_OTHER, name: 'Engineering' },
  { id: WS_THIRD, name: 'Personal' },
]

type Row = Record<string, unknown>

/** The service client `getServiceClient()` hands back — only ever asked about
 *  `member`, for the workspace-routing membership check. */
function makeServiceClient(memberOf: string[]) {
  const rows: Row[] = memberOf.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id) ?? { id, name: id },
  }))
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (col: string, val: unknown) => {
      preds.push((r) => r[col] === val)
      return chain
    }
    const run = () => (table === 'member' ? rows : []).filter((r) => preds.every((p) => p(r)))
    chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(resolve)
    return chain
  }
  return { from } as never
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => makeServiceClient(hoisted.memberOf),
}))

const { createEmailTools } = await import('../email')

const DRAFT_ARGS = { to: ['a@example.test'], subject: 'Hi', body: 'Hello' }

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(
    { ...DRAFT_ARGS, ...args },
    {} as never,
  )

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getValidToken.mockImplementation(async (_userId: string, provider: string) =>
    provider === 'google' ? { token: 'tok' } : null,
  )
  hoisted.createEmailDraft.mockResolvedValue({ id: 'draft-1', threadId: undefined, message: 'Draft created' })
})

describe('create_email_draft — workspace routing', () => {
  it('(a) explicit foreign workspace_id while a member — the draft is filed under it', async () => {
    hoisted.memberOf = [WS_ACTIVE, WS_OTHER]
    const tools = createEmailTools(USER_ID, WS_ACTIVE)
    const res = await run(tools.create_email_draft, { workspace_id: WS_OTHER })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_OTHER, name: 'Engineering' } })
    expect(hoisted.createEmailDraft).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ subject: 'Hi' }),
      WS_OTHER,
      undefined,
    )
  })

  it('(b) explicit non-member workspace_id — "Workspace not found", no draft created', async () => {
    hoisted.memberOf = [WS_ACTIVE]
    const tools = createEmailTools(USER_ID, WS_ACTIVE)
    const res = await run(tools.create_email_draft, { workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(hoisted.createEmailDraft).not.toHaveBeenCalled()
  })

  it("(c) policy 'explicit', 2+ workspaces, no id — needs_workspace, no draft created", async () => {
    hoisted.memberOf = [WS_ACTIVE, WS_OTHER, WS_THIRD]
    const tools = createEmailTools(USER_ID, WS_ACTIVE, false, 'explicit')
    const res = await run(tools.create_email_draft, {})

    expect(res).toMatchObject({ success: false, error_type: 'needs_workspace' })
    expect(hoisted.createEmailDraft).not.toHaveBeenCalled()
  })

  it("(d) policy 'session', no id — files under the session workspace, unchanged call chain", async () => {
    hoisted.memberOf = [WS_ACTIVE, WS_OTHER, WS_THIRD]
    const tools = createEmailTools(USER_ID, WS_ACTIVE)
    const res = await run(tools.create_email_draft, {})

    expect(res).toMatchObject({ success: true, workspace: { id: WS_ACTIVE, name: null } })
    expect(hoisted.createEmailDraft).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ subject: 'Hi' }),
      WS_ACTIVE,
      undefined,
    )
  })

  it('(e) strictWorkspace + explicit foreign workspace_id — not found, no draft created', async () => {
    hoisted.memberOf = [WS_ACTIVE, WS_OTHER]
    const tools = createEmailTools(USER_ID, WS_ACTIVE, true)
    const res = await run(tools.create_email_draft, { workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(hoisted.createEmailDraft).not.toHaveBeenCalled()
  })
})
