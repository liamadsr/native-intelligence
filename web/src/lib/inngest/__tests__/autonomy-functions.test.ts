/**
 * autonomyActionRun: one event per action the agent will take on its own; it
 * sleeps to the end of the undo window (Liam, 11-27, decision 1: "the
 * 5-minute undo window before each send"), then runs the action in a durable
 * step, and is registered with the Inngest route.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, unknown>,
  run: vi.fn(async () => 'ran'),
  serviceClient: { service: true },
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string; triggers: Array<{ event: string }> }, handler: unknown) => {
      h.handlers[config.id] = handler
      return { id: config.id, triggers: config.triggers }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.serviceClient }))
vi.mock('@/lib/autonomy/actions', () => ({ AUTONOMY_ACTION_EVENT: 'autonomy/action.scheduled', runAutonomousAction: h.run }))

const { autonomyActionRun } = await import('../autonomy-functions')

describe('autonomyActionRun', () => {
  it('listens on autonomy/action.scheduled, sleeps to run_at, then runs the action', async () => {
    expect((autonomyActionRun as unknown as { triggers: Array<{ event: string }> }).triggers).toEqual([{ event: 'autonomy/action.scheduled' }])
    const order: string[] = []
    const step = {
      sleepUntil: vi.fn(async (id: string) => { order.push(`sleep:${id}`) }),
      run: vi.fn(async (id: string, fn: () => Promise<unknown>) => { order.push(`run:${id}`); return fn() }),
    }
    const handler = h.handlers['autonomy-action-run'] as (arg: { event: unknown; step: unknown }) => Promise<unknown>
    const out = await handler({ event: { data: { action_id: 'act-1', run_at: '2026-12-01T00:05:00Z' } }, step })
    expect(step.sleepUntil).toHaveBeenCalledWith('undo-window', new Date('2026-12-01T00:05:00Z'))
    expect(order).toEqual(['sleep:undo-window', 'run:run-action'])
    expect(h.run).toHaveBeenCalledWith(h.serviceClient, 'act-1')
    expect(out).toEqual({ action_id: 'act-1', outcome: 'ran' })
  })

  it('is served by the Inngest route', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/inngest/route.ts'), 'utf8')
    expect(route).toContain("import { autonomyActionRun } from '@/lib/inngest/autonomy-functions'")
    expect(route).toMatch(/\n\s+autonomyActionRun,\n/)
  })
})
