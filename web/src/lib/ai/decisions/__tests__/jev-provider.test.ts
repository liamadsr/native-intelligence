import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const call = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('eve/ai', () => ({ decide: call }))
import { evaluateJev } from '../providers/jev'

it('uses the fixed Gateway decision model with cancellation, attribution and no SDK retry', async () => {
  const signal = new AbortController().signal
  const questions = { reply: { type: 'boolean' as const, instructions: 'Reply needed?' } }
  await evaluateJev('synthetic fixture', questions, signal, { user: 'owner', tags: ['feature:test'] })
  expect(call).toHaveBeenCalledWith({ model: 'typesafe-ai/jev', state: 'synthetic fixture', questions, abortSignal: signal,
    maxRetries: 0, providerOptions: { gateway: { user: 'owner', tags: ['feature:test'] } } })
})
