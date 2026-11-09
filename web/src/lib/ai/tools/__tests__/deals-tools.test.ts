import { describe, it, expect } from 'vitest'
import { createDealTools, DEAL_TOOL_NAMES } from '../deals'
import { getToolDefinition } from '../../tool-registry'
import { withToolGuide, MAX_ADVERTISED_DESCRIPTION } from '../../tool-guides'

describe('deal tools', () => {
  const tools = createDealTools('u1', {} as never, 'w1')

  it('each is registered in the CRM category with the right side effect', () => {
    expect(Object.keys(tools).sort()).toEqual([...DEAL_TOOL_NAMES].sort())
    for (const name of DEAL_TOOL_NAMES) {
      const def = getToolDefinition(name)
      expect(def, name).toBeDefined()
      expect(def!.sideEffect, name).toBe(name === 'find_deals' || name === 'get_deal' ? 'read' : 'internal-write')
    }
  })

  it('no description is over what OpenAI takes', () => {
    for (const [name, t] of Object.entries(tools)) {
      expect(withToolGuide(name, (t as { description?: string }).description ?? '').length, name).toBeLessThanOrEqual(MAX_ADVERTISED_DESCRIPTION)
    }
  })

  it('tells the agent to apply with undo, never to ask first', () => {
    const update = (tools.update_deal as { description?: string }).description ?? ''
    expect(update).toContain('update it directly')
    expect(update).toContain('they can undo it')
    expect(update).toContain("Don't ask first")
  })
})
