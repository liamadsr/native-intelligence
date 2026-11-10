/**
 * One name for mail (migration 503): the kind is `email_thread`, and every
 * edge that takes a kind from outside reads the retired `email` as it. An old
 * client, an older browser tab or a model quoting an earlier turn keeps
 * working; the fences treat the old name as the kind it names, never as an
 * unknown (open) one.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

vi.mock('@/lib/ai/tool-registry', () => ({ getToolSideEffect: () => 'internal-write' }))

import {
  ENTITY_REGISTRY_BY_ID,
  LINKABLE_ENTITY_TYPES,
  canonicalEntityType,
  canonicalEntityTypeInput,
  entityDescriptor,
} from '../entity-registry'
import { entityKindEnum } from '../entity-kind-schema'
import { LINK_FENCED_KINDS, isLinkFencedKind } from '../entity-fences'
import { isMailSourceType } from '../claim-visibility'
import { cardEntityRef } from '@/lib/flows/card-entity'
import { touchesForToolCall } from '@/lib/work/touch'

const THREAD = '7d1c2e8a-5f3b-4c0d-9a1e-2b3c4d5e6f70'
const PROJECT = '1a2b3c4d-5e6f-4a0b-8c1d-2e3f4a5b6c7d'

describe('the registry', () => {
  it('registers mail once, as email_thread, on the same row as before', () => {
    expect(ENTITY_REGISTRY_BY_ID.email_thread.table).toBe('email_thread_index')
    expect((ENTITY_REGISTRY_BY_ID as Record<string, unknown>).email).toBeUndefined()
    expect(LINKABLE_ENTITY_TYPES.filter((t) => t.startsWith('email'))).toEqual(['email_thread'])
  })

  it('looks a retired name up as its successor', () => {
    expect(entityDescriptor('email')?.id).toBe('email_thread')
    expect(entityDescriptor('email_thread')?.id).toBe('email_thread')
    expect(entityDescriptor('nonsense')).toBeUndefined()
  })

  it('canonicalEntityTypeInput passes non-strings through', () => {
    expect(canonicalEntityTypeInput('email')).toBe('email_thread')
    expect(canonicalEntityTypeInput(undefined)).toBeUndefined()
    expect(canonicalEntityTypeInput(7)).toBe(7)
    expect(canonicalEntityType('__proto__')).toBe('__proto__')
  })
})

describe('entityKindEnum (tool arguments)', () => {
  const schema = z.object({ entity_type: entityKindEnum(LINKABLE_ENTITY_TYPES) })

  it('reads email as email_thread and rejects what is no kind', () => {
    expect(schema.parse({ entity_type: 'email' })).toEqual({ entity_type: 'email_thread' })
    expect(schema.parse({ entity_type: 'email_thread' })).toEqual({ entity_type: 'email_thread' })
    expect(schema.safeParse({ entity_type: 'mail' }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('shows the model the current names only', () => {
    for (const io of ['input', 'output'] as const) {
      const json = z.toJSONSchema(schema, { io }) as unknown as { properties: { entity_type: { enum: string[] } } }
      expect(json.properties.entity_type.enum).toContain('email_thread')
      expect(json.properties.entity_type.enum).not.toContain('email')
    }
  })

  it('stays optional and describable', () => {
    const opt = z.object({ t: entityKindEnum(LINKABLE_ENTITY_TYPES).optional().describe('a kind') })
    expect(opt.parse({})).toEqual({})
    expect(opt.parse({ t: 'email' })).toEqual({ t: 'email_thread' })
  })
})

describe('the fences', () => {
  it('fence mail under both names: an old name is never an open kind', () => {
    expect(LINK_FENCED_KINDS).toContain('email_thread')
    expect(isLinkFencedKind('email_thread')).toBe(true)
    expect(isLinkFencedKind('email')).toBe(true)
    expect(isMailSourceType('email_thread')).toBe(true)
    expect(isMailSourceType('email')).toBe(true)
    expect(isLinkFencedKind('project')).toBe(false)
  })
})

describe('kinds the app stores from model output', () => {
  it("a card's entity takes the current name", () => {
    expect(cardEntityRef('action_card', { entity_type: 'email', entity_id: THREAD }).entityType).toBe('email_thread')
    expect(
      cardEntityRef('work_proposal', { resources: [{ type: 'email', id: THREAD, label: 'Thread from Avery' }] }).entityType,
    ).toBe('email_thread')
  })

  it("a tool call's touches take the current name", () => {
    const touches = touchesForToolCall({
      toolName: 'link_entities',
      input: { source_type: 'project', source_id: PROJECT, target_type: 'email', target_id: THREAD },
      output: null,
    })
    expect(touches.map((t) => t.entityType).sort()).toEqual(['email_thread', 'project'])
  })
})
