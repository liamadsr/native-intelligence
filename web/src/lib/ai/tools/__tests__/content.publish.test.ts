/**
 * publish_post / schedule_post (C2a, P9): they run ONLY as the person's
 * approved call; any other call posts nothing. The approved call screens the
 * post once more (never a name from their calls) before Typefully.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ send: vi.fn(), names: [] as string[] }))
vi.mock('@/lib/content/typefully', () => ({ sendToTypefully: h.send }))
const screened = vi.hoisted(() => ({ opts: [] as unknown[] }))
vi.mock('@/lib/content/post-sources', () => ({
  screenPostSources: async (_s: unknown, _w: unknown, _src: unknown, opts: unknown) => {
    screened.opts.push(opts)
    return { problems: [], blockedPhrases: h.names, blockedWords: [], fromCall: false, verifiedCount: 0, ownPricingSource: false }
  },
}))

const { createContentTools, isPostSendTool } = await import('../content')
const EXEC = { toolCallId: 'c', messages: [] }
const run = (tools: ReturnType<typeof createContentTools>, name: 'publish_post' | 'schedule_post', input: Record<string, unknown>) =>
  (tools[name].execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)({ surface: 'x', ...input }, EXEC)

beforeEach(() => {
  h.send.mockReset()
  h.send.mockResolvedValue({ success: true, when: 'now', account: null, message: 'Sent to Typefully to post on X now.' })
  h.names = []
})

describe('publish_post / schedule_post', () => {
  it('called by the model (no approved call): refused, nothing is posted', async () => {
    const tools = createContentTools('u-1', {} as never, 'ws-1')
    expect(await run(tools, 'publish_post', { text: 'We shipped calendar sync.' })).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(await run(tools, 'schedule_post', { text: 'We shipped calendar sync.' })).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('an approval for the OTHER tool does not run this one', async () => {
    const tools = createContentTools('u-1', {} as never, 'ws-1', { approvedCall: { approvalId: 'a-1', tool: 'schedule_post' } })
    expect(await run(tools, 'publish_post', { text: 'Hi there, we shipped it.' })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('the person’s approved call posts once through Typefully, now or into the queue, a thread in order', async () => {
    const now = createContentTools('u-1', {} as never, 'ws-1', { approvedCall: { approvalId: 'a-1', tool: 'publish_post' } })
    expect(await run(now, 'publish_post', { text: 'We shipped calendar sync.' })).toMatchObject({ success: true })
    expect(h.send).toHaveBeenLastCalledWith({}, { userId: 'u-1', surface: 'x', parts: ['We shipped calendar sync.'], when: 'now', accountId: null })
    const queue = createContentTools('u-1', {} as never, 'ws-1', { approvedCall: { approvalId: 'a-2', tool: 'schedule_post' } })
    await run(queue, 'schedule_post', { parts: ['One thing.', 'Two things.'] })
    expect(h.send).toHaveBeenLastCalledWith({}, { userId: 'u-1', surface: 'x', parts: ['One thing.', 'Two things.'], when: 'next_free_slot', accountId: null })
  })

  it('a model-named account is ignored from the chat; only a post card’s own resolved account is honoured', async () => {
    const chat = createContentTools('u-1', {} as never, 'ws-1', { approvedCall: { approvalId: 'a-1', tool: 'publish_post' } })
    await run(chat, 'publish_post', { text: 'We shipped calendar sync.', account_id: 8, account: '@ceo' })
    expect(h.send).toHaveBeenLastCalledWith({}, expect.objectContaining({ accountId: null }))
    const card = createContentTools('u-1', {} as never, 'ws-1', { approvedCall: { approvalId: 'a-2', tool: 'publish_post', postCard: true } })
    await run(card, 'publish_post', { text: 'We shipped calendar sync.', account_id: 8 })
    expect(h.send).toHaveBeenLastCalledWith({}, expect.objectContaining({ accountId: 8 }))
  })

  it('never a name from their calls, even on an approved call', async () => {
    h.names = ['northwind']
    const tools = createContentTools('u-1', {} as never, 'ws-1', { approvedCall: { approvalId: 'a-1', tool: 'publish_post' } })
    expect(await run(tools, 'publish_post', { text: 'Northwind moved their team onto our calendar sync.' })).toMatchObject({ success: false, code: 'NOT_PUBLIC_SAFE' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('lint_post in an unattended run leaves out the person’s recent-call names; in the chat it reads them', async () => {
    screened.opts.length = 0
    const lint = (t: ReturnType<typeof createContentTools>) => (t.lint_post.execute as unknown as (i: unknown, o: unknown) => Promise<unknown>)({ surface: 'x', text: 'We shipped it.' }, EXEC)
    await lint(createContentTools('u-1', {} as never, 'ws-1', { unattended: true }))
    await lint(createContentTools('u-1', {} as never, 'ws-1'))
    expect(screened.opts).toEqual([{}, { userId: 'u-1' }])
  })

  it('names the two sending tools (and their ni_ names)', () => {
    expect(isPostSendTool('publish_post') && isPostSendTool('ni_schedule_post')).toBe(true)
    expect(isPostSendTool('lint_post')).toBe(false)
  })
})
