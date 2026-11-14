/**
 * POST /api/local-agent/studio-export/<take | progress | complete | fail | blobs/read | blobs/write | blobs/commit>:
 * the desktop app (macOS or Windows) working a Studio export on the person's own computer.
 *
 * Authenticated by a token for that one job only (src/lib/studio/server/local-token.ts), checked before the body is
 * read; never a cookie and never the shared worker secret. Every call reads the job again and fences it to the person,
 * the workspace and the attempt (src/lib/studio/server/local-jobs.ts). The contract is in
 * src/lib/studio/server/job-contract.ts ("the person's own computer").
 */
import { getServiceClient } from '@/lib/admin'
import { handleLocalRunner } from '@/lib/studio/server/local-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ op: string[] }> }

export async function POST(request: Request, { params }: Params) {
  const { op } = await params
  return handleLocalRunner(request, op, { supabase: getServiceClient() })
}
