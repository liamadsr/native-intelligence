import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Locks the researcher's activity-capture hook (agent/hooks/capture-activity.ts):
 *   - it labels only the NARRATED tool calls (web + save_*), skipping control
 *     tools (finish_research) and non-tool-call actions;
 *   - it derives tenancy from the verified session principal (never model input),
 *     and no-ops gracefully when the principal has no workspace;
 *   - it NEVER throws (a thrown hook would escalate to session.failed), swallowing
 *     any downstream persistence error.
 *
 * appendResearchActivity + the owner/service helpers are mocked so the test drives
 * the hook's projection + guard logic in isolation.
 */

const appendResearchActivity = vi.fn(
  async (..._a: unknown[]): Promise<unknown> => [],
)
const requireOwner = vi.fn()
const serviceClient = vi.fn(() => ({}) as never)

vi.mock('../research-progress.js', () => ({
  appendResearchActivity: (...a: unknown[]) => appendResearchActivity(...(a as [])),
}))
vi.mock('../tool-context.js', () => {
  // Declared INSIDE the factory: vi.mock is hoisted above module-scope decls, so
  // NoOwnerError must be constructed here to be available to the mock.
  class NoOwnerError extends Error {
    constructor(m: string) {
      super(m)
      this.name = 'NoOwnerError'
    }
  }
  return {
    requireOwner: (...a: unknown[]) => requireOwner(...(a as [])),
    serviceClient: () => serviceClient(),
    NoOwnerError,
  }
})

import hook from '../../hooks/capture-activity'
import { NoOwnerError } from '../tool-context.js'

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void
const handler = (hook as { events: Record<string, Handler> }).events['actions.requested']

function actionsEvent(actions: unknown[]) {
  return { type: 'actions.requested', data: { actions } }
}
const ctx = { session: { id: 'sess-1', auth: {} } }

beforeEach(() => {
  vi.clearAllMocks()
  requireOwner.mockReturnValue({ userId: 'u1', workspaceId: 'w1' })
})

describe('capture-activity hook', () => {
  it('labels narrated tool calls and appends them', async () => {
    await handler(
      actionsEvent([
        { kind: 'tool-call', toolName: 'web_search', callId: 'c1', input: { query: 'Acme' } },
        { kind: 'tool-call', toolName: 'web_fetch', callId: 'c2', input: { url: 'https://acme.com' } },
        { kind: 'tool-call', toolName: 'save_starter_content', callId: 'c3', input: { projectName: 'Q3' } },
      ]),
      ctx,
    )
    expect(appendResearchActivity).toHaveBeenCalledTimes(1)
    const arg = appendResearchActivity.mock.calls[0][1] as unknown as {
      userId: string
      workspaceId: string
      entries: { callId: string; toolName: string; label: string }[]
    }
    expect(arg.userId).toBe('u1')
    expect(arg.workspaceId).toBe('w1')
    expect(arg.entries.map((e) => e.callId)).toEqual(['c1', 'c2', 'c3'])
    expect(arg.entries[0].label).toContain('Searching the web for Acme')
    expect(arg.entries[1].label).toContain('Reading acme.com')
    expect(arg.entries[2].label).toContain('Creating your first project — Q3')
  })

  it('skips finish_research, non-tool-call actions, and calls with no id', async () => {
    await handler(
      actionsEvent([
        { kind: 'tool-call', toolName: 'finish_research', callId: 'c1', input: {} },
        { kind: 'load-skill', callId: 'c2', input: {} },
        { kind: 'tool-call', toolName: 'web_search', input: { query: 'x' } }, // no callId
      ]),
      ctx,
    )
    // Nothing narratable → no append at all.
    expect(appendResearchActivity).not.toHaveBeenCalled()
  })

  it('no-ops (no throw) when the principal has no workspace', async () => {
    requireOwner.mockImplementation(() => {
      throw new NoOwnerError('no workspace')
    })
    await expect(
      handler(
        actionsEvent([{ kind: 'tool-call', toolName: 'web_search', callId: 'c1', input: { query: 'x' } }]),
        ctx,
      ),
    ).resolves.toBeUndefined()
    expect(appendResearchActivity).not.toHaveBeenCalled()
  })

  it('swallows a persistence error — never throws (would fail the run)', async () => {
    appendResearchActivity.mockRejectedValueOnce(new Error('db down'))
    await expect(
      handler(
        actionsEvent([{ kind: 'tool-call', toolName: 'web_search', callId: 'c1', input: { query: 'x' } }]),
        ctx,
      ),
    ).resolves.toBeUndefined()
  })

  it('ignores an event with no actions', async () => {
    await handler({ type: 'actions.requested', data: {} }, ctx)
    expect(appendResearchActivity).not.toHaveBeenCalled()
  })
})
