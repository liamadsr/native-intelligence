/**
 * The cloud browser injects the agent runtime that came from the desktop, byte
 * for byte (src/lib/cloud-browser/cdp/agent-runtime.ts): the copy must still
 * be the one its origin record names, so an edit can't drift silently. Since
 * C5 it is the only copy: change it on purpose, with its hash.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AGENT_RUNTIME_ORIGIN, agentRuntimeSource } from '../agent-runtime'

describe('the vendored agent runtime', () => {
  it('matches the desktop commit it was copied from', () => {
    const source = agentRuntimeSource()
    expect(createHash('sha256').update(source, 'utf8').digest('hex')).toBe(AGENT_RUNTIME_ORIGIN.sha256)
  })
  it('defines the API the driver calls', () => {
    const source = agentRuntimeSource()
    for (const name of ['snapshot', 'taskAction', 'frameGate', 'getText']) expect(source).toContain(`    ${name},`)
  })
})
