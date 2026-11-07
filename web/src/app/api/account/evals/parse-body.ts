/**
 * One JSON-body reader for every Evals route.
 *
 * Two failure modes collapse into the same 400 here — a body that is not JSON
 * at all, and a body that is JSON but not the shape the schema names — because
 * from the caller's side they are the same mistake, and separating them at
 * eight call sites is eight chances to return a 500 for a typo. The zod issue
 * list rides along in `details`, which `apiError` already carries, so the
 * client can point at the offending field.
 */
import { z } from 'zod'
import { badRequest } from '@/lib/api-errors'

export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { ok: false, response: badRequest('Invalid JSON body') }
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, response: badRequest('Invalid request', z.flattenError(parsed.error)) }
  }
  return { ok: true, data: parsed.data }
}
