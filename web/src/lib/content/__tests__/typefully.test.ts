/**
 * Posting through the person's Typefully (C2a, P9: typefully.ts): the tools
 * found by name or by shape, the draft input checked against the tool's own
 * schema, a thread's parts in order, the first social set, the approval
 * card's words; and publish_post / schedule_post, which run only as the
 * person's approved call and are always held by the outward gate.
 */
import { describe, it, expect, vi } from 'vitest'
import { admitsPublishAt, createDraftTool, draftInput, listSocialSetsTool, pickAccount, resolveTypefullyAccount, sendToTypefully, socialSets, typefullyCardCopy } from '../typefully'
import { outwardHoldOf } from '@/lib/safety/outward-gate'

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    social_set_id: { type: 'number' },
    platforms: { type: 'object' },
    publish_at: { type: 'string' },
  },
  required: ['social_set_id', 'platforms'],
}

const server = (tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>, extra: Record<string, unknown> = {}) => ({
  id: 'srv-1',
  user_id: 'u-1',
  display_name: 'Typefully',
  server_url: 'https://mcp.typefully.com/mcp',
  is_enabled: true,
  tools_cache: tools,
  ...extra,
})

/** A client whose connected_mcp_server list is `servers`. */
function client(servers: unknown[]) {
  const q: Record<string, unknown> = {}
  Object.assign(q, { select: () => q, eq: () => q, limit: async () => ({ data: servers, error: null }) })
  return { from: () => q } as never
}

describe('finding Typefully’s tools', () => {
  it('by the template’s names first, then by shape', () => {
    expect(createDraftTool(server([{ name: 'typefully_create_draft' }, { name: 'createDraft' }]))?.name).toBe('typefully_create_draft')
    expect(createDraftTool(server([{ name: 'saveDraft' }]))?.name).toBe('saveDraft')
    // An edit or a publish is never taken for the create.
    expect(createDraftTool(server([{ name: 'edit_draft' }, { name: 'publish_draft' }]))).toBeNull()
    expect(listSocialSetsTool(server([{ name: 'typefully_list_social_sets' }]))?.name).toBe('typefully_list_social_sets')
    expect(listSocialSetsTool(server([{ name: 'getSocialSets' }]))?.name).toBe('getSocialSets')
  })

  it('reads the social sets, with their handles', () => {
    expect(socialSets(JSON.stringify({ results: [{ id: 42, username: 'liam' }, { id: 43 }] }))).toEqual([{ id: 42, label: '@liam' }, { id: 43, label: null }])
    expect(socialSets(JSON.stringify([{ id: 'abc', name: 'Native Intelligence team' }]))).toEqual([{ id: 'abc', label: 'Native Intelligence team' }])
    expect(socialSets('not json')).toBeNull()
    expect(socialSets('[]')).toEqual([])
  })

  it('never guesses the account (S2): the card’s own, else the only one; several and none named is NEEDS_ACCOUNT', () => {
    const one = [{ id: 7, label: '@liam' }]
    const two = [{ id: 7, label: '@liam' }, { id: 8, label: '@dial8' }]
    expect(pickAccount(one)).toEqual(one[0])
    expect(pickAccount(two)).toBe('NEEDS_ACCOUNT')
    expect(pickAccount(two, 8)).toEqual(two[1])
    expect(pickAccount(two, '8')).toEqual(two[1])
    expect(pickAccount(two, 9)).toBe('NEEDS_ACCOUNT')
    expect(pickAccount([])).toBe('NO_SOCIAL_SET')
  })

  it('a create tool must take our publish time (S1): an enum that lists it, or a string', () => {
    const tool = (publish_at: unknown) => ({ inputSchema: { type: 'object', properties: { platforms: { type: 'object' }, ...(publish_at ? { publish_at } : {}) } } })
    expect(admitsPublishAt(tool({ type: 'string' }), 'now')).toBe(true)
    expect(admitsPublishAt(tool({ enum: ['now', 'next-free-slot'] }), 'next-free-slot')).toBe(true)
    expect(admitsPublishAt(tool({ enum: ['next-free-slot'] }), 'now')).toBe(false)
    expect(admitsPublishAt(tool({ anyOf: [{ type: 'null' }, { type: 'string' }] }), 'now')).toBe(true)
    expect(admitsPublishAt(tool({ type: 'number' }), 'now')).toBe(false)
    // No publish_at at all: a create would save a draft that publishes nothing.
    expect(admitsPublishAt(tool(null), 'now')).toBe(false)
  })

  it('builds the draft: the platform’s posts in order (a thread), and the publish time', () => {
    expect(draftInput({ surface: 'x', parts: ['One', 'Two'], when: 'now', socialSetId: 42 })).toEqual({
      social_set_id: 42,
      platforms: { x: { enabled: true, posts: [{ text: 'One' }, { text: 'Two' }] } },
      publish_at: 'now',
    })
    expect(draftInput({ surface: 'linkedin', parts: ['Hi'], when: 'next_free_slot' })).toEqual({
      platforms: { linkedin: { enabled: true, posts: [{ text: 'Hi' }] } },
      publish_at: 'next-free-slot',
    })
  })
})

describe('sendToTypefully', () => {
  it('not connected: nothing is posted', async () => {
    expect(await sendToTypefully(client([]), { userId: 'u-1', surface: 'x', parts: ['Hi'], when: 'now' })).toMatchObject({ success: false, code: 'NOT_CONNECTED' })
  })

  it('posts on the first social set, checked against the tool’s schema, and says what it did', async () => {
    const call = vi.fn(async (_s: unknown, _id: string, tool: string) =>
      tool === 'typefully_list_social_sets' ? { content: [{ type: 'text', text: JSON.stringify([{ id: 7, username: 'liam' }]) }], isError: false } : { content: [{ type: 'text', text: '{"id":99}' }], isError: false },
    )
    const s = server([{ name: 'typefully_list_social_sets', inputSchema: { type: 'object' } }, { name: 'typefully_create_draft', inputSchema: DRAFT_SCHEMA }])
    // The card's account is resolved the same way, before anyone clicks.
    expect(await resolveTypefullyAccount(client([s]), 'u-1', { call: call as never })).toEqual({ id: 7, label: '@liam' })
    const out = await sendToTypefully(client([s]), { userId: 'u-1', surface: 'x', parts: ['We shipped calendar sync.'], when: 'next_free_slot', deps: { call: call as never } })
    expect(out).toEqual({ success: true, when: 'next_free_slot', account: '@liam', message: 'Added to your Typefully queue for X as @liam: it posts at your next free slot.' })
    expect(call).toHaveBeenLastCalledWith(expect.anything(), 'srv-1', 'typefully_create_draft', { social_set_id: 7, platforms: { x: { enabled: true, posts: [{ text: 'We shipped calendar sync.' }] } }, publish_at: 'next-free-slot' }, 'u-1')
  })

  it('a tool whose input differs from what we send is refused, never guessed at', async () => {
    const call = vi.fn()
    const s = server([{ name: 'typefully_create_draft', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }])
    const out = await sendToTypefully(client([s]), { userId: 'u-1', surface: 'x', parts: ['Hi'], when: 'now', deps: { call: call as never } })
    expect(out).toMatchObject({ success: false, code: 'SHAPE_MISMATCH' })
    expect(call).not.toHaveBeenCalled()
  })

  it('a create tool with no publish time is refused, never reported as posted (S1)', async () => {
    const call = vi.fn()
    const noPublish = { type: 'object', properties: { social_set_id: { type: 'number' }, platforms: { type: 'object' } } }
    const out = await sendToTypefully(client([server([{ name: 'typefully_create_draft', inputSchema: noPublish }])]), { userId: 'u-1', surface: 'x', parts: ['Hi'], when: 'now', deps: { call: call as never } })
    expect(out).toMatchObject({ success: false, code: 'SHAPE_MISMATCH' })
    expect(call).not.toHaveBeenCalled()
  })

  it('two accounts and none named: NEEDS_ACCOUNT, nothing posted; the card’s named one posts as it (S2)', async () => {
    const call = vi.fn(async (_s: unknown, _id: string, tool: string) =>
      tool === 'typefully_list_social_sets' ? { content: [{ type: 'text', text: JSON.stringify([{ id: 7, username: 'liam' }, { id: 8, username: 'dial8' }]) }], isError: false } : { content: [], isError: false },
    )
    const s = server([{ name: 'typefully_list_social_sets', inputSchema: { type: 'object' } }, { name: 'typefully_create_draft', inputSchema: DRAFT_SCHEMA }])
    expect(await sendToTypefully(client([s]), { userId: 'u-1', surface: 'x', parts: ['Hi'], when: 'now', deps: { call: call as never } })).toMatchObject({ code: 'NEEDS_ACCOUNT' })
    expect(call).toHaveBeenCalledTimes(1)
    expect(await resolveTypefullyAccount(client([s]), 'u-1', { call: call as never })).toBeNull()
    const named = await sendToTypefully(client([s]), { userId: 'u-1', surface: 'x', parts: ['Hi'], when: 'now', accountId: 8, deps: { call: call as never } })
    expect(named).toMatchObject({ success: true, account: '@dial8' })
  })

  it('a switched-off connection or no draft tool posts nothing', async () => {
    expect(await sendToTypefully(client([server([{ name: 'list_drafts' }])]), { userId: 'u-1', surface: 'x', parts: ['Hi'], when: 'now' })).toMatchObject({ code: 'TOOL_NOT_FOUND' })
    // Another app on the person's list is never taken for Typefully.
    expect(await sendToTypefully(client([server([{ name: 'create_draft' }], { server_url: 'https://mcp.notion.com/mcp' })]), { userId: 'u-1', surface: 'x', parts: ['Hi'], when: 'now' })).toMatchObject({ code: 'NOT_CONNECTED' })
  })
})

describe('posts always card (decision 2)', () => {
  it('the outward gate holds every publish_post and schedule_post, with exactly what goes out', async () => {
    const now = await outwardHoldOf({ workspaceId: 'ws-1', toolName: 'publish_post', input: { surface: 'x', text: 'We shipped calendar sync.' } })
    expect(now).toMatchObject({ reason: 'public_post', card: { title: "Post to X via Typefully now: 'We shipped calendar sync.'" } })
    const queued = await outwardHoldOf({ workspaceId: 'ws-1', toolName: 'dial8_schedule_post', input: { surface: 'linkedin', parts: ['One', 'Two'] } })
    expect(queued?.card.title).toBe("Add to your Typefully queue for LinkedIn (a thread of 2), next free slot: 'One'")
    expect(now?.refusal).toMatch(/Nothing was posted/)
  })

  it('the card copy says it posts publicly, once, as them', () => {
    expect(typefullyCardCopy('publish_post', { text: 'Hi' }).why).toMatch(/posts publicly on X as you, through your Typefully, once/)
  })
})
