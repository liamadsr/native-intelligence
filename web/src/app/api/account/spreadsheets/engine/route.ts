import { readFile } from 'node:fs/promises'
import { requireUser } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { engineBinaryPath } from '@/lib/spreadsheets/engine-server'

export const runtime = 'nodejs'

let cached: Buffer | null = null

/**
 * GET: the spreadsheet engine's binary (IronCalc, MIT or Apache-2.0), for the
 * editor. It is the file the package ships, byte for byte; a browser keeps it
 * for a day and asks again with its tag after that.
 */
export async function GET(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  try {
    cached ??= await readFile(engineBinaryPath())
    const etag = `"ironcalc-0.9.1-${cached.length}"`
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } })
    return new Response(new Uint8Array(cached), {
      headers: {
        'Content-Type': 'application/wasm',
        'Cache-Control': 'private, max-age=86400',
        ETag: etag,
      },
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the spreadsheet engine')
  }
}
