/**
 * A call_tool step's input, checked against the connected app's own input
 * schema (the JSON Schema its tools/list gave, cached on the connection), at
 * save time and again at run time (F4).
 *
 *   save  the input is still a template: a string that is exactly one token
 *         (`{{steps.draft.output}}`) can become any value, so it passes any
 *         type; a string with text around a token is a string. The checks:
 *         an object; every required property present; no unknown property
 *         when the schema closes them (additionalProperties: false); each
 *         literal value of a known property has its type and is in its enum.
 *   run   the rendered input, in full: through zod's JSON Schema reader
 *         (z.fromJSONSchema) when it can read the schema; when it can't (a
 *         $ref it can't resolve, a keyword it doesn't know), the same subset
 *         checks as save time, on every value. Never throws.
 *
 * Pure: no I/O.
 */
import { z } from 'zod'

export type SchemaCheck = { ok: true } | { ok: false; error: string }

type JsonSchema = Record<string, unknown>

const WHOLE_TOKEN_RE = /^\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}$/

function isTemplateToken(v: unknown): boolean {
  return typeof v === 'string' && WHOLE_TOKEN_RE.test(v)
}

function typeOk(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type]
  if (types.length === 0 || types[0] === undefined) return true
  return types.some((t) => {
    switch (t) {
      case 'string':
        return typeof value === 'string'
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      case 'boolean':
        return typeof value === 'boolean'
      case 'array':
        return Array.isArray(value)
      case 'object':
        return !!value && typeof value === 'object' && !Array.isArray(value)
      case 'null':
        return value === null
      default:
        return true
    }
  })
}

/** The subset checks (see the header), recursing into nested objects. */
function subsetCheck(value: unknown, schema: JsonSchema, at: string, templated: boolean, depth = 0): SchemaCheck {
  if (depth > 12) return { ok: true }
  if (templated && isTemplateToken(value)) return { ok: true }
  if (!typeOk(schema.type, value)) {
    return { ok: false, error: `${at || 'input'} must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : String(schema.type)}` }
  }
  if (Array.isArray(schema.enum) && !(templated && typeof value === 'string' && value.includes('{{'))) {
    if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      return { ok: false, error: `${at || 'input'} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const props = schema.properties && typeof schema.properties === 'object' ? (schema.properties as Record<string, JsonSchema>) : {}
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string') : []
    for (const key of required) {
      if (!Object.hasOwn(obj, key)) return { ok: false, error: `${at ? `${at}.` : ''}${key} is required` }
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(obj).find((k) => !Object.hasOwn(props, k))
      if (extra) return { ok: false, error: `${at ? `${at}.` : ''}${extra} is not an input this tool takes` }
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = props[key]
      if (!sub || typeof sub !== 'object') continue
      const r = subsetCheck(v, sub, at ? `${at}.${key}` : key, templated, depth + 1)
      if (!r.ok) return r
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const r = subsetCheck(value[i], schema.items as JsonSchema, `${at || 'input'}[${i}]`, templated, depth + 1)
      if (!r.ok) return r
    }
  }
  return { ok: true }
}

/** The schema as an object schema (a tool with none takes any object). */
function objectSchema(schema: unknown): JsonSchema {
  if (schema && typeof schema === 'object' && !Array.isArray(schema) && Object.keys(schema).length > 0) return schema as JsonSchema
  return { type: 'object' }
}

/** The save-time check of a templated input. */
export function checkToolInputAtSave(input: unknown, schema: unknown): SchemaCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'input must be an object' }
  return subsetCheck(input, { ...objectSchema(schema), type: 'object' }, '', true)
}

/** The run-time check of a rendered input (see the header). */
export function checkToolInputAtRun(input: unknown, schema: unknown): SchemaCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'input must be an object' }
  const s = objectSchema(schema)
  type Parser = { safeParse: (v: unknown) => { success: boolean; error?: { issues?: Array<{ path?: unknown[]; message?: string }> } } }
  let parser: Parser | null = null
  try {
    parser = z.fromJSONSchema(s as Parameters<typeof z.fromJSONSchema>[0]) as unknown as Parser
  } catch {
    parser = null
  }
  if (parser) {
    const r = parser.safeParse(input)
    if (r.success) return { ok: true }
    const issue = r.error?.issues?.[0]
    const path = Array.isArray(issue?.path) && issue.path.length ? `${issue.path.join('.')}: ` : ''
    return { ok: false, error: `${path}${issue?.message ?? 'does not match the tool’s inputs'}` }
  }
  return subsetCheck(input, { ...s, type: 'object' }, '', false)
}
