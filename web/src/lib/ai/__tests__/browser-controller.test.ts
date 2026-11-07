import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createBrowserTools } from '../tools/browser'
import { BROWSER_TOOL_NAMES, createSearchToolsTool } from '../tool-discovery'
import { ALL_TOOL_NAMES } from '../tool-registry'
import { registryToolInputSchemas } from '../tool-schemas'
import { enqueueBrowserCommand } from '@/lib/browser-agent/queue'

const service = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: service }))

describe('Jev is the browser action controller', () => {
  it('exposes a goal tool with a starting URL, never the former per-action tools', async () => {
    const tools = createBrowserTools('user', {} as SupabaseClient, 'workspace')
    const schemas = registryToolInputSchemas()
    const discovery = createSearchToolsTool()
    const result = await discovery.execute!({ query: 'browser' }, { toolCallId: 'discovery', messages: [], context: {} })
    expect(tools.run_browser_task).toBeDefined()
    expect(schemas.get('run_browser_task')).toMatchObject({ properties: { startUrl: { type: 'string' } } })
    expect(schemas.get('run_browser_task')?.required).toContain('goal')
    expect(schemas.get('run_browser_task')?.properties).not.toHaveProperty('bindings')
    expect(JSON.stringify(result)).toContain('run_browser_task')
    for (const name of ['navigate_browser', 'click_browser', 'type_browser']) {
      expect(tools).not.toHaveProperty(name)
      expect(ALL_TOOL_NAMES).not.toContain(name)
      expect(BROWSER_TOOL_NAMES).not.toContain(name)
      expect(schemas.has(name)).toBe(false)
      expect(JSON.stringify(result)).not.toContain(name)
    }
  })
  it('rejects stale per-action producers before queuing or contacting the database', async () => {
    for (const command of ['navigate', 'click', 'type']) {
      await expect(enqueueBrowserCommand({ userId: 'user', workspaceId: 'workspace', command }))
        .rejects.toThrow('run_browser_task')
    }
    expect(service).not.toHaveBeenCalled()
  })
})
