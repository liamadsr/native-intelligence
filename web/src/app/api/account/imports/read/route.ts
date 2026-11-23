/**
 * POST /api/account/imports/read   (multipart: file)
 * Read a task CSV or .xlsx for the mapping step: its columns, a guessed
 * field for each, a few sample values, how many rows. Nothing is kept.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, badRequest } from '@/lib/api-errors'
import { requireImporter } from '@/lib/imports/route-auth'
import { describeSheet, readTaskFile, TASK_FILE_MAX_BYTES } from '@/lib/imports/stage'

export async function POST(request: NextRequest) {
  const who = await requireImporter()
  if (who instanceof Response) return who
  if (Number(request.headers.get('content-length') ?? 0) > TASK_FILE_MAX_BYTES + 64 * 1024) return apiError('That file is over 5 MB. Split it and import each part.', { status: 413, code: 'TOO_LARGE' })
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return badRequest('Send the file.')
  const read = await readTaskFile(new Uint8Array(await file.arrayBuffer()), file.name)
  if (!read.ok) return badRequest(read.error)
  return NextResponse.json({ file_name: file.name, ...describeSheet(read.sheet) })
}
