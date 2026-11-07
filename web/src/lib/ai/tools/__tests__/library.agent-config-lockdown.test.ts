/**
 * The chat skill tools no longer accept `agent_config` (Sequence step 1, the
 * D.1 lockdown): a model authoring a skill cannot widen its tools or flip its
 * contract keys. Both input schemas are strict, so a model that still sends
 * the field gets a validation error it can read rather than a silent drop.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createLibraryTools } from '../library'

const tools = createLibraryTools('user-1', { from: vi.fn() } as never, 'ws-1')
const schemaOf = (name: 'create_skill' | 'update_skill') =>
  (tools[name] as unknown as { inputSchema: z.ZodTypeAny }).inputSchema

describe('create_skill / update_skill input schemas', () => {
  it('reject agent_config', () => {
    const create = schemaOf('create_skill').safeParse({
      name: 'S',
      description: 'd',
      system_prompt: 'p',
      agent_config: { enabled_tools: ['emails'] },
    })
    expect(create.success).toBe(false)
    const update = schemaOf('update_skill').safeParse({ id: 'rec-1', agent_config: { output_contract: 'prose' } })
    expect(update.success).toBe(false)
  })

  it('reject any other unknown key (strict), and still accept the documented fields', () => {
    expect(schemaOf('update_skill').safeParse({ id: 'rec-1', is_system: false }).success).toBe(false)
    expect(schemaOf('update_skill').safeParse({ id: 'rec-1', name: 'n', visibility: 'workspace' }).success).toBe(true)
    expect(
      schemaOf('create_skill').safeParse({ name: 'S', description: 'd', system_prompt: 'p', slug: 's', icon: '🧭', color: '#000' })
        .success,
    ).toBe(true)
  })
})
