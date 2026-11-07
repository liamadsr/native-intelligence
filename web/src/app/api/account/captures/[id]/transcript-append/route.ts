import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Delta-append transcript auto-save.
 *
 * The live-recording client normally re-serialized and PATCHed the WHOLE
 * transcript on every save tick (30s interval + 2s post-segment debounce). At
 * minute 90 that's tens of KB re-sent every few seconds. This route instead
 * accepts only the NEW tail of the transcript and appends it server-side:
 *
 *   { append_text, base_length } → transcript = stored + append_text
 *
 * `base_length` is the char length of the transcript the client believes the
 * server currently holds. We compare it to the stored transcript's length:
 *   - match  → append, return { new_length }
 *   - mismatch → 409 + { server_length } so the client can fall back to a
 *     full-text PATCH (the no-shrink /captures/[id] route) and re-seed.
 *
 * ── Safety (this is the product's most data-loss-sensitive path) ──
 *  - This route can ONLY grow the transcript: it writes stored + append_text and
 *    never a shorter/empty value, so it structurally cannot clobber a good
 *    transcript (unlike a blind full-text overwrite, the 2026-06 incident).
 *  - The client advances its acked counters ONLY on a confirmed 2xx here, so a
 *    lost/failed append never leaves a hole — the next tick re-sends the same
 *    delta (base_length still matches) or falls back to the full PATCH.
 *  - Post-lock (ended_at set / is_transcript_locked): we reject with a stable
 *    409 code the client treats as TERMINAL (stops appending). The DB triggers
 *    `lock_transcript_on_end` / `prevent_transcript_edit` are the final backstop;
 *    if a lock lands in the TOCTOU window between our read and write, the DB
 *    exception surfaces here and we map it to the same terminal signal.
 *
 * ── Concurrency ──
 *  This is a read-modify-write (load stored length, then UPDATE with the
 *  concatenation). That's acceptable because a capture has a SINGLE recording
 *  client, the client serializes its own appends behind an in-flight guard, and
 *  the periodic full-text PATCH fallback self-heals any divergence. The
 *  base_length check turns any unexpected interleaving into a 409 rather than a
 *  silent bad write.
 */

/** Hard cap on a single append payload. A normal delta is a handful of new
 *  final segments (hundreds of chars to low KB); 256KB is orders of magnitude
 *  above that and still bounds a hostile/buggy caller. */
const MAX_APPEND_BYTES = 256 * 1024

/** Response code the client keys off to STOP appending permanently (capture is
 *  finalized). Distinct from a plain base-length 409 (which triggers a retry via
 *  full-text PATCH). */
const TERMINAL_LOCKED_CODE = 'TRANSCRIPT_LOCKED'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  let body: { append_text?: unknown; base_length?: unknown }
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  // Validate append_text: must be a non-empty string within the size cap. An
  // empty append is a client bug (the save tick should skip when nothing new
  // finalized) — reject rather than issue a no-op write.
  const appendText = body.append_text
  if (typeof appendText !== 'string' || appendText.length === 0) {
    return badRequest('append_text must be a non-empty string')
  }
  // Byte length (not char length) for the size cap — a transcript can hold
  // multi-byte UTF-8.
  if (Buffer.byteLength(appendText, 'utf8') > MAX_APPEND_BYTES) {
    return badRequest('append_text exceeds the maximum size')
  }

  // base_length is the char length the client believes the server holds.
  const baseLength = body.base_length
  if (typeof baseLength !== 'number' || !Number.isInteger(baseLength) || baseLength < 0) {
    return badRequest('base_length must be a non-negative integer')
  }

  // Atomic compare-and-swap append via the append_capture_transcript RPC
  // (migration 192). CRITICAL: we do NOT predicate the UPDATE on the full
  // transcript text from JS — supabase-js would serialize that `.eq` filter into
  // the PostgREST URL query string, and once the transcript grows past the
  // proxy's URL limit (~20KB) every request becomes un-servable and 500s FOREVER
  // (the 2026-07-10 prod outage). The RPC does the identical read-modify-write
  // CAS inside one SQL statement, so the full text never leaves the DB — it's
  // immune to transcript size. All the branch semantics below are unchanged; the
  // route just maps the RPC's `status` back onto the same HTTP responses.
  //
  // A concurrent writer (the force full-text PATCH on stop / flushTranscriptForAgent,
  // or the pagehide beacon) that lands between the RPC's read and write changes
  // the stored value → the CAS matches zero rows → status 'conflict' (409), never
  // a clobber. The DB lock triggers (lock_transcript_on_end / prevent_transcript_edit)
  // still raise inside the RPC if a lock lands in the write window; that surfaces
  // here as a P0001 error mapped to the terminal locked signal, exactly as before.
  const { data: rpcRows, error: rpcError } = await supabase.rpc('append_capture_transcript', {
    p_capture_id: id,
    p_workspace_id: workspaceId,
    p_append: appendText,
    p_base_length: baseLength,
  })

  if (rpcError) {
    // TOCTOU lock: the prevent_transcript_edit trigger raised mid-write. Postgres
    // surfaces a bare RAISE EXCEPTION as code 'P0001'; also match the message as a
    // belt-and-suspenders check. Terminal → client stops appending.
    const code = (rpcError as { code?: string }).code
    const message = (rpcError as { message?: string }).message ?? ''
    if (code === 'P0001' || /transcript is locked/i.test(message)) {
      return NextResponse.json(
        { error: 'Transcript is locked', code: TERMINAL_LOCKED_CODE },
        { status: 409 },
      )
    }
    // Log the failure so a future outage is visible in error tracking (the old
    // route returned serverError silently — the 2026-07-10 outage left NOTHING in
    // the logs). Include the capture id so it's greppable.
    console.error(
      `[transcript-append] RPC failed for capture ${id}: ${message || 'unknown error'}`,
    )
    return serverError(rpcError.message)
  }

  // The RPC returns exactly one row: { status, server_length }.
  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows
  const status = (result as { status?: string } | undefined)?.status
  const serverLength = (result as { server_length?: number } | undefined)?.server_length ?? 0

  switch (status) {
    case 'applied':
      // server_length here is the NEW total length after the append.
      return NextResponse.json({ new_length: serverLength })

    case 'not_found':
      return notFound('Capture not found')

    case 'locked':
      // Capture ended / transcript locked. Terminal — client stops appending.
      return NextResponse.json(
        { error: 'Transcript is locked', code: TERMINAL_LOCKED_CODE },
        { status: 409 },
      )

    case 'base_mismatch':
      // Client's view of the server transcript diverged. Hand back the true
      // length so it falls back to a full-text PATCH and re-seeds. Never shrinks.
      return NextResponse.json(
        { error: 'Base length mismatch', code: 'BASE_LENGTH_MISMATCH', server_length: serverLength },
        { status: 409 },
      )

    case 'conflict':
      // A concurrent writer won the CAS between the RPC's read and write. Re-read
      // length (returned by the RPC) hands the client the true state to re-sync.
      return NextResponse.json(
        { error: 'Concurrent write', code: 'CONCURRENT_WRITE', server_length: serverLength },
        { status: 409 },
      )

    default:
      // An unexpected/empty status is a contract violation — log and 500 rather
      // than silently claiming success.
      console.error(
        `[transcript-append] unexpected RPC status "${status}" for capture ${id}`,
      )
      return serverError('Unexpected transcript-append result')
  }
}
