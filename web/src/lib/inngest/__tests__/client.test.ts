/**
 * The one switch on the Inngest client: `INNGEST_CHECKPOINTING`.
 *
 * It has to do what it says through the SDK itself, not just parse: the
 * second half asks a function built on the client whether the SDK would
 * checkpoint it (`shouldAsyncCheckpoint` is what `serve()` consults on every
 * request), so an SDK upgrade that stops honouring the client option fails
 * here instead of in production with the switch set.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkpointingDisabledByEnv } from '../client'

type Probe = { shouldAsyncCheckpoint(requestedRunStep: undefined, internalFnId: string, disableImmediateExecution: boolean): unknown }

/** The client as a deployment with this env value would build it. */
async function clientWith(value: string) {
  vi.resetModules()
  vi.stubEnv('INNGEST_CHECKPOINTING', value)
  const { inngest } = await import('../client')
  return inngest
}

function wouldCheckpoint(fn: unknown): boolean {
  return Boolean((fn as Probe).shouldAsyncCheckpoint(undefined, 'fn-1', false))
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('checkpointingDisabledByEnv', () => {
  it.each(['0', 'false', 'off', ' OFF ', 'False'])('%j turns checkpointing off', (value) => {
    expect(checkpointingDisabledByEnv(value)).toBe(true)
  })

  it.each([undefined, '', '1', 'true', 'on', 'anything else'])('%j leaves the SDK default', (value) => {
    expect(checkpointingDisabledByEnv(value)).toBe(false)
  })
})

describe('the Inngest client', () => {
  it('registers as native-intelligence', async () => {
    const inngest = await clientWith('')
    expect(inngest.id).toBe('native-intelligence')
  })

  it('checkpoints by default', async () => {
    const inngest = await clientWith('')
    const fn = inngest.createFunction({ id: 'probe', triggers: [{ event: 'test/probe' }] }, async () => 'ok')
    expect(wouldCheckpoint(fn)).toBe(true)
  })

  it('INNGEST_CHECKPOINTING=0 turns it off for a function that does not say', async () => {
    const inngest = await clientWith('0')
    const fn = inngest.createFunction({ id: 'probe', triggers: [{ event: 'test/probe' }] }, async () => 'ok')
    expect(wouldCheckpoint(fn)).toBe(false)
  })

  it("a function's own setting still wins over the switch", async () => {
    const inngest = await clientWith('0')
    const fn = inngest.createFunction(
      { id: 'probe', checkpointing: true, triggers: [{ event: 'test/probe' }] },
      async () => 'ok',
    )
    expect(wouldCheckpoint(fn)).toBe(true)
  })
})
