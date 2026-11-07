/**
 * finish_getting_started (src/lib/ai/tools/getting-started.ts): ends the
 * person's getting started for the tool's own workspace and user, with the
 * reason the agent gives. Attended only, by the registry's set.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolExecutionOptions } from 'ai'

const finish = vi.hoisted(() => vi.fn(async () => ({ success: true as const, ended: true })))
vi.mock('@/lib/onboarding/getting-started', () => ({ finishGettingStarted: finish }))

import { createGettingStartedTools } from '../getting-started'
import { ATTENDED_ONLY_TOOL_NAMES, getToolSideEffect } from '@/lib/ai/tool-registry'

const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

describe('finish_getting_started', () => {
  it("ends it for the tool's own workspace and user, with the agent's reason", async () => {
    const supabase = {} as SupabaseClient
    const { finish_getting_started } = createGettingStartedTools('user-1', supabase, 'ws-1')
    const out = await finish_getting_started.execute!({ reason: 'skipped' }, OPTS)
    expect(out).toEqual({ success: true, ended: true })
    expect(finish).toHaveBeenCalledWith(supabase, { workspaceId: 'ws-1', userId: 'user-1', by: 'skipped' })
  })

  it('is an attended-only internal write', () => {
    expect(ATTENDED_ONLY_TOOL_NAMES.has('finish_getting_started')).toBe(true)
    expect(getToolSideEffect('finish_getting_started')).toBe('internal-write')
  })
})
