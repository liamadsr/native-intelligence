/**
 * A work run's prompt carries the workspace's words (src/lib/editions/words.ts)
 * right after its base prompt: what a helper writes for a service business's
 * owner says jobs and customers, as their chat does. An edition that says
 * nothing adds nothing.
 */
import { describe, it, expect, vi } from 'vitest'

const ws: { settings: unknown } = { settings: {} }
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () =>
          table === 'workspace'
            ? { data: { settings: ws.settings }, error: null }
            : { data: { id: 'run-1', kind: 'workspace', origin: 'user', model_tier: null, helper_model: null, server_helper: null }, error: null },
      }
      return api
    },
  }),
}))
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: vi.fn(async () => 'BASE_PROMPT') }))
vi.mock('@/lib/ai/gateway-telemetry', () => ({ gatewayTelemetryValues: () => null }))
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: vi.fn(async () => false) }))

import { rebuildWorkRunSpec } from '../run-work-spec-rebuild'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 600_000 }

describe('rebuildWorkRunSpec — the edition’s words', () => {
  it('a service business’s run says its words, right after the base prompt', async () => {
    ws.settings = { edition: 'service' }
    const spec = await rebuildWorkRunSpec(CLAIMS)
    expect(spec?.systemPrompt).toMatch(/^BASE_PROMPT\n\n## Words to use\n/)
    expect(spec?.systemPrompt).toContain('- a contact is a customer')
  })

  it('an edition that says nothing adds nothing', async () => {
    for (const settings of [{ edition: 'full' }, { edition: 'sales' }, {}]) {
      ws.settings = settings
      const spec = await rebuildWorkRunSpec(CLAIMS)
      expect(spec?.systemPrompt).not.toContain('Words to use')
      expect(spec?.systemPrompt.startsWith('BASE_PROMPT')).toBe(true)
    }
  })
})
