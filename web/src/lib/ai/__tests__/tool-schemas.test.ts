import { describe, it, expect } from 'vitest'
import { tool, jsonSchema } from 'ai'
import { z } from 'zod'
import { registryToolInputSchemas, toolInputJsonSchema, withoutUuidPatterns } from '../tool-schemas'

/**
 * The blank-schema regression fix (2026-07-14 parity audit): eve tool proxies
 * used to advertise `z.record(z.string(), z.unknown())` for EVERY workspace
 * tool, so the model guessed parameter shapes and produced invalid input
 * (verified prod failure: `find` with `types` as the string '["capture"]').
 * These tests pin the extraction that ships each tool's REAL JSON schema on
 * the spec's ceilingTools.
 */
describe('registryToolInputSchemas', () => {
  it('extracts the real schema for `find` — named params, enum array types, limit', () => {
    const schemas = registryToolInputSchemas()
    const find = schemas.get('find')
    expect(find).toBeDefined()
    const props = find!.properties as Record<string, Record<string, unknown>>
    // The exact parameters the incident model had to guess (and got wrong).
    expect(props.query).toMatchObject({ type: 'string' })
    expect(props.types).toMatchObject({ type: 'array' })
    expect((props.types.items as Record<string, unknown>).enum).toContain('capture')
    expect(props.limit).toBeDefined() // the real name — the model guessed max_results
    expect(props.max_results).toBeUndefined()
    expect(find!.required).toContain('query')
  })

  it('covers the broad registry surface (not just one lucky tool)', () => {
    const schemas = registryToolInputSchemas()
    // The whole core set the chat advertises upfront must carry real schemas.
    for (const name of ['find', 'list_actions', 'create_action', 'update_action', 'complete_action', 'get_calendar_events', 'list_captures', 'get_notifications']) {
      expect(schemas.get(name), `schema for ${name}`).toBeDefined()
      expect((schemas.get(name) as Record<string, unknown>).type).toBe('object')
    }
    // And the map should cover essentially the full registry.
    expect(schemas.size).toBeGreaterThan(50)
  })

  it('advertises a complete goal without requiring a speculative form plan', () => {
    const schema = registryToolInputSchemas().get('run_browser_task')!
    expect(schema.required).toEqual(['goal'])
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.milestones).toBeUndefined()
    expect(props.bindings).toBeUndefined()
    expect(props.goalDriven).toBeUndefined()
    expect(props.completion.default).toEqual([])
    // The controller owns its decision and time budget; the parent cannot shrink it.
    expect(props.maxSteps).toBeUndefined()
    expect(props.timeoutMs).toBeUndefined()
  })

  it('is memoized (same map instance across calls)', () => {
    expect(registryToolInputSchemas()).toBe(registryToolInputSchemas())
  })
})

describe('toolInputJsonSchema', () => {
  it('converts a zod inputSchema to plain JSON Schema', () => {
    const t = tool({
      description: 'x',
      inputSchema: z.object({ q: z.string(), n: z.number().optional() }),
      execute: async () => ({}),
    })
    const schema = toolInputJsonSchema(t)
    expect(schema).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string' }, n: { type: 'number' } },
      required: ['q'],
    })
  })

  it('passes a jsonSchema() FlexibleSchema through (external MCP tool shape)', () => {
    const raw = { type: 'object', properties: { ticket: { type: 'string' } } }
    const t = tool({
      description: 'x',
      inputSchema: jsonSchema<{ ticket: string }>(raw as never),
      execute: async () => ({}),
    })
    expect(toolInputJsonSchema(t)).toMatchObject(raw)
  })

  it('returns null (degrade, never throw) for a missing/broken schema', () => {
    expect(toolInputJsonSchema({} as never)).toBeNull()
    const poisoned = {
      inputSchema: {
        get jsonSchema(): never {
          throw new Error('boom')
        },
      },
    }
    expect(toolInputJsonSchema(poisoned as never)).toBeNull()
  })
})

/**
 * zod writes its long uuid regex as a `pattern` beside `format: "uuid"` on
 * every uuid field; settle_card advertised it five times over, and a weak
 * model put the card's id in the wrong one of its alike id fields (PROD,
 * 2026-10-08). The advertised schema keeps `format: "uuid"` and drops the
 * pattern; the route still validates every call against the real zod schema.
 */
describe('uuid fields are advertised without the uuid regex', () => {
  const patterns = (v: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
    if (Array.isArray(v)) v.forEach((x) => patterns(x, out))
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.pattern === 'string') out.push(o)
      Object.values(o).forEach((x) => patterns(x, out))
    }
    return out
  }

  it("settle_card: every id field is format uuid with no pattern, and zod still refuses a non-uuid", () => {
    const schema = registryToolInputSchemas().get('settle_card')!
    const props = schema.properties as Record<string, Record<string, unknown>>
    for (const field of ['card_id', 'proposal_id', 'target_entity_id']) {
      expect(props[field]).toMatchObject({ type: 'string', format: 'uuid' })
      expect(props[field].pattern).toBeUndefined()
    }
    expect(patterns(schema)).toEqual([])
  })

  it('no registry schema advertises a pattern on a uuid field', () => {
    for (const [name, schema] of registryToolInputSchemas()) {
      expect(patterns(schema).filter((o) => o.format === 'uuid'), name).toEqual([])
    }
  })

  it('the real zod schema still validates the uuid server-side', () => {
    const t = tool({ description: 'x', inputSchema: z.object({ id: z.string().uuid() }), execute: async () => ({}) })
    expect((t.inputSchema as z.ZodTypeAny).safeParse({ id: 'not-a-uuid' }).success).toBe(false)
    expect(toolInputJsonSchema(t)!.properties).toEqual({ id: { type: 'string', format: 'uuid' } })
  })

  it("drops only zod's own uuid regex: an external tool's custom uuid pattern (not zod-validated here) is kept; the input is never touched", () => {
    const zodPattern = (toolInputJsonSchema(tool({ description: 'x', inputSchema: z.object({ id: z.string().uuid() }) }))!.properties as never as { id: { pattern?: string } }).id.pattern
    // Read from a schema built without the strip, so the test knows zod's real regex.
    const zodRaw = (z.toJSONSchema(z.object({ id: z.string().uuid() })) as unknown as { properties: { id: { pattern: string } } }).properties.id.pattern
    expect(zodPattern).toBeUndefined()
    const raw = {
      type: 'object',
      properties: {
        slug: { type: 'string', pattern: '^[a-z]+$' },
        id: { type: 'string', format: 'uuid', pattern: zodRaw },
        list: { type: 'array', items: { type: 'string', format: 'uuid', pattern: zodRaw } },
        // An external MCP tool's own, stricter uuid rule: v4 only.
        v4: { type: 'string', format: 'uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
      },
    }
    const before = JSON.stringify(raw)
    expect(withoutUuidPatterns(raw)).toEqual({
      type: 'object',
      properties: {
        slug: { type: 'string', pattern: '^[a-z]+$' },
        id: { type: 'string', format: 'uuid' },
        list: { type: 'array', items: { type: 'string', format: 'uuid' } },
        v4: raw.properties.v4,
      },
    })
    expect(JSON.stringify(raw)).toBe(before)
  })

  it('an external MCP tool (jsonSchema) keeps its custom uuid pattern end to end', () => {
    const raw = { type: 'object', properties: { ticket: { type: 'string', format: 'uuid', pattern: '^T-[0-9a-f-]{36}$' } } }
    const t = tool({ description: 'x', inputSchema: jsonSchema<{ ticket: string }>(raw as never), execute: async () => ({}) })
    expect(toolInputJsonSchema(t)).toMatchObject(raw)
  })

  it('a schema key named __proto__ survives the copy as an own key', () => {
    const raw = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')
    const out = withoutUuidPatterns(raw) as { properties: Record<string, unknown> }
    expect(Object.keys(out.properties)).toEqual(['__proto__'])
    expect(JSON.stringify(out)).toBe(JSON.stringify(raw))
  })
})
