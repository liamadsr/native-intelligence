import { beforeEach, describe, expect, it, vi } from 'vitest'

const afterFns: Array<() => Promise<void>> = []
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>()
  return { ...real, after: (fn: () => Promise<void>) => afterFns.push(fn) }
})

const who = { db: {} as never, svc: {} as never, workspaceId: 'ws-1', userId: 'user-1', memberId: 'member-1' }
const requireImporter = vi.fn(async (): Promise<unknown> => who)
vi.mock('@/lib/imports/route-auth', async (orig) => ({ ...(await orig<typeof import('@/lib/imports/route-auth')>()), requireImporter: () => requireImporter() }))

const loadImport = vi.fn()
const claimImport = vi.fn(async () => true)
vi.mock('@/lib/imports/journal', () => ({ loadImport: (...a: unknown[]) => loadImport(...a), claimImport: (...a: unknown[]) => claimImport(...(a as [])) }))
const runApply = vi.fn(async () => true)
const runUndo = vi.fn(async () => true)
vi.mock('@/lib/imports/run', () => ({ runApply: (...a: unknown[]) => runApply(...(a as [])), runUndo: (...a: unknown[]) => runUndo(...(a as [])) }))
vi.mock('@/lib/imports/route-run', () => ({ runDepsFor: () => ({}) }))
vi.mock('@/lib/imports/preview', () => ({ importView: async () => ({ id: 'x' }) }))

import { POST as apply } from '../[id]/apply/route'
import { POST as undo } from '../[id]/undo/route'
import { DELETE as discard } from '../[id]/route'

const ID = '11111111-1111-4111-8111-111111111111'
const ctx = { params: Promise.resolve({ id: ID }) }
const req = new Request('http://x', { method: 'POST' })

beforeEach(() => {
  afterFns.length = 0
  vi.clearAllMocks()
  requireImporter.mockResolvedValue(who)
})

describe('imports routes', () => {
  it('reads an import only as its own person, in this workspace', async () => {
    loadImport.mockResolvedValue(null)
    const res = await apply(req, ctx)
    expect(res.status).toBe(404)
    expect(loadImport).toHaveBeenCalledWith(who.svc, ID, who)
    expect(runApply).not.toHaveBeenCalled()
  })

  it('runs a staged import after answering, once', async () => {
    loadImport.mockResolvedValue({ id: ID, status: 'staged' })
    const res = await apply(req, ctx)
    expect(res.status).toBe(202)
    expect(runApply).not.toHaveBeenCalled()
    await afterFns[0]()
    expect(runApply).toHaveBeenCalledTimes(1)
    loadImport.mockResolvedValue({ id: ID, status: 'running' })
    expect((await apply(req, ctx)).status).toBe(409)
    loadImport.mockResolvedValue({ id: ID, status: 'done' })
    expect((await apply(req, ctx)).status).toBe(409)
  })

  it('undoes only a finished import', async () => {
    for (const [status, code] of [['staged', 409], ['running', 409], ['undone', 409], ['done', 202], ['failed', 202]] as const) {
      loadImport.mockResolvedValue({ id: ID, status })
      expect((await undo(req, ctx)).status).toBe(code)
    }
    expect(afterFns).toHaveLength(2)
  })

  it('discards only a staged import', async () => {
    loadImport.mockResolvedValue({ id: ID, status: 'done' })
    claimImport.mockResolvedValueOnce(false)
    const svc = { storage: { from: () => ({ remove: async () => ({}) }) } }
    requireImporter.mockResolvedValue({ ...who, svc })
    expect((await discard(req, ctx)).status).toBe(409)
    loadImport.mockResolvedValue({ id: ID, status: 'staged' })
    expect((await discard(req, ctx)).status).toBe(200)
    expect(claimImport).toHaveBeenLastCalledWith(svc, ID, ['staged'], 'discarded')
  })

  it('turns a refused caller away before anything is read', async () => {
    requireImporter.mockResolvedValue(new Response(JSON.stringify({ error: 'A guest can’t import into this workspace.' }), { status: 403 }))
    expect((await apply(req, ctx)).status).toBe(403)
    expect(loadImport).not.toHaveBeenCalled()
  })
})
