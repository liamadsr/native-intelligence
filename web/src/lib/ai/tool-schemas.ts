/**
 * Registry tool input schemas as plain JSON Schema — what the eve tool proxies
 * advertise to the model.
 *
 * ── Why this exists (the blank-schema regression) ───────────────────────────
 * The eve agents (chat-agent, skill-runner) can't compile the Next-coupled tool
 * factories into their Nitro runtime, so they advertise thin PROXIES built from
 * the spec routes' `ceilingTools`. Those originally carried {name, description}
 * only, so every proxy shipped a contentless `z.record(z.string(), z.unknown())`
 * input schema — on the wire the model saw `{"type":"object",
 * "additionalProperties":{}}` and had to GUESS parameter names and shapes from
 * the description. Verified failure mode (2026-07-14, prod): `find` called with
 * `types` as the string '["capture"]' and `max_results` instead of `limit` →
 * INPUT_INVALID. The cloud path never had this problem: streamText advertised
 * the real zod-derived JSON schemas.
 *
 * This module extracts those SAME schemas (via the SAME `asSchema` conversion
 * the AI SDK applies inside streamText) so the spec rebuilds can ship one JSON
 * schema per ceiling tool and the proxies can advertise the real shape. eve's
 * `defineTool` accepts a raw JSON-Schema object as `inputSchema`
 * (PublicToolInputSchema = StandardSchema | JsonObject), and its normalizer
 * passes plain objects through verbatim — so what the model sees on the eve
 * path is byte-equivalent to what the cloud path advertises.
 *
 * ── The dummy-args probe ─────────────────────────────────────────────────────
 * `createTools(userId, supabase, workspaceId)` factories are PURE constructors:
 * they close over their args and return tool-object literals — no I/O, no arg
 * validation at construction time. Input schemas are static per tool, so one
 * probe construction with placeholder args yields the canonical schema for
 * every (userId, workspaceId). The whole map is memoized per process; a factory
 * that ever starts doing work at construction would surface here as an empty
 * map (fail-open to the blank-schema behavior, never a crashed spec route).
 */
import { asSchema } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTools } from './tools'

/** A tool input schema as a plain JSON-Schema object (draft-07, AI SDK shape). */
export type ToolInputJsonSchema = Record<string, unknown>

/**
 * Extract one tool's input schema as plain JSON Schema, or null when the tool
 * has no input schema or the conversion fails. Works for both zod schemas
 * (registry tools) and `jsonSchema(...)` FlexibleSchemas (external MCP tools) —
 * `asSchema` is the AI SDK's own normalizer for exactly these two shapes.
 */
export function toolInputJsonSchema(tool: Tool): ToolInputJsonSchema | null {
  try {
    if (!tool.inputSchema) return null
    const schema = asSchema(tool.inputSchema as never).jsonSchema
    // Must be a plain object to ride the spec JSON + eve's JsonObject contract.
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null
    return withoutUuidPatterns(schema) as ToolInputJsonSchema
  } catch {
    // A schema that can't convert (exotic refinement/transform) degrades to the
    // proxy's permissive fallback — never a failed spec rebuild.
    return null
  }
}

/**
 * The regex zod itself writes as `pattern` beside `format: "uuid"` (read off
 * zod through the same conversion, once), so only zod's own pattern is ever
 * matched.
 */
let zodUuidPattern: string | null | undefined
function zodUuid(): string | null {
  if (zodUuidPattern === undefined) {
    try {
      const probe = asSchema(z.object({ id: z.string().uuid() })).jsonSchema as { properties?: { id?: { pattern?: unknown } } }
      const pattern = probe.properties?.id?.pattern
      zodUuidPattern = typeof pattern === 'string' ? pattern : null
    } catch {
      zodUuidPattern = null
    }
  }
  return zodUuidPattern
}

/**
 * The schema with zod's own uuid regex dropped from every `format: "uuid"`
 * string, as a copy (the input, possibly an external MCP tool's own object, is
 * never touched). zod writes its long uuid regex beside `format: "uuid"` on
 * every uuid field, so a tool with several id fields advertises the same ~140
 * characters several times over (settle_card: five), which makes its id
 * fields read alike to a weaker model and costs tokens on every turn.
 * `format: "uuid"` still says what the field is, and nothing is loosened: a
 * pattern zod wrote sits on a zod schema, and the route validates every call
 * against the tool's real zod schema (the uuid check included) before it
 * runs. Any other pattern stays, on a uuid field too: an external MCP tool's
 * schema is not zod, nothing here validates its calls, and its own pattern
 * may be stricter than zod's.
 */
export function withoutUuidPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUuidPatterns)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  const zodPattern = zodUuid()
  const uuid = (value as Record<string, unknown>).format === 'uuid'
  for (const [key, child] of Object.entries(value)) {
    if (uuid && key === 'pattern' && zodPattern !== null && child === zodPattern) continue
    // defineProperty, not assignment: a key named `__proto__` stays an own key.
    Object.defineProperty(out, key, { value: withoutUuidPatterns(child), enumerable: true, writable: true, configurable: true })
  }
  return out
}

let registrySchemas: Map<string, ToolInputJsonSchema> | null = null

/**
 * The memoized registry-wide map: tool name → input JSON Schema. Built once per
 * process from a probe `createTools` construction (see module docs). Tools whose
 * schema can't convert are simply absent (proxies fall back to permissive).
 *
 * A probe-construction THROW is logged loudly and NOT memoized — the next call
 * retries. Caching the empty map would silently pin every session on this
 * instance back to blank proxy schemas (the regression this module fixes) for
 * the process lifetime, indistinguishable from the per-tool soft-fail.
 */
export function registryToolInputSchemas(): ReadonlyMap<string, ToolInputJsonSchema> {
  if (registrySchemas) return registrySchemas
  const map = new Map<string, ToolInputJsonSchema>()
  try {
    // Placeholder args: factories only close over these — construction is pure.
    const probe = createTools(
      '00000000-0000-0000-0000-000000000000',
      {} as SupabaseClient,
      '00000000-0000-0000-0000-000000000000',
    )
    for (const [name, tool] of Object.entries(probe)) {
      const schema = toolInputJsonSchema(tool as Tool)
      if (schema) map.set(name, schema)
    }
  } catch (err) {
    // Fail open for THIS call (proxies keep their permissive fallback), but
    // don't cache the failure — and never silently: a factory doing work at
    // construction time is a bug to surface, not absorb.
    console.error('[tool-schemas] registry probe failed — schemas degraded to permissive this call:', err)
    return map
  }
  registrySchemas = map
  return map
}
