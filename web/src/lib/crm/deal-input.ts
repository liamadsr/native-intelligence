/**
 * A request body (the deals routes, the board's drag, an inline cell edit)
 * read into a DealInput, type by type. Keys it does not know are ignored;
 * a known key of the wrong type is refused.
 */
import type { DealInput } from './deals'

type Parsed = { ok: true; input: DealInput } | { ok: false; error: string }

const str = (v: unknown) => typeof v === 'string'
const strOrNull = (v: unknown) => v === null || typeof v === 'string'

export function dealInputFromBody(body: unknown): Parsed {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object' }
  const b = body as Record<string, unknown>
  const input: DealInput = {}

  if ('name' in b) {
    if (!str(b.name)) return { ok: false, error: 'name must be text' }
    input.name = b.name as string
  }
  if ('value' in b) {
    const v = b.value
    if (v === null || v === '') input.value = null
    else {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s$€£]/g, '')) : NaN
      if (!Number.isFinite(n)) return { ok: false, error: 'value must be a number' }
      input.value = n
    }
  }
  if ('currency' in b) {
    if (!str(b.currency)) return { ok: false, error: 'currency must be a three-letter code' }
    input.currency = b.currency as string
  }
  const stage = 'stage_id' in b ? b.stage_id : b.stage
  if (stage !== undefined) {
    if (!str(stage)) return { ok: false, error: 'stage must be a stage id or name' }
    input.stage = stage as string
  }
  const pipeline = 'pipeline_id' in b ? b.pipeline_id : b.pipeline
  if (pipeline !== undefined) {
    if (!str(pipeline)) return { ok: false, error: 'pipeline must be a pipeline id or name' }
    input.pipeline = pipeline as string
  }
  if ('expected_close_date' in b) {
    const v = b.expected_close_date
    if (!strOrNull(v)) return { ok: false, error: 'expected_close_date must be YYYY-MM-DD' }
    // A date picker may send a full timestamp; the day is what a close date is.
    input.expected_close_date = v === null || v === '' ? null : (v as string).slice(0, 10)
  }
  for (const key of ['owner_id', 'company_id', 'notes'] as const) {
    if (!(key in b)) continue
    if (!strOrNull(b[key])) return { ok: false, error: `${key} must be text or null` }
    input[key] = b[key] === '' ? null : (b[key] as string | null)
  }
  for (const key of ['contact_ids', 'add_contact_ids'] as const) {
    if (!(key in b)) continue
    const v = b[key]
    if (!Array.isArray(v) || !v.every(str)) return { ok: false, error: `${key} must be a list of ids` }
    input[key] = v as string[]
  }
  if ('custom_fields' in b) {
    const v = b.custom_fields
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'custom_fields must be an object' }
    input.custom_fields = v as Record<string, unknown>
  }
  return { ok: true, input }
}
