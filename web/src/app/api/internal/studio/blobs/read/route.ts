/**
 * POST /api/internal/studio/blobs/read — {jobId, workerId, key} → a signed link per part of a stored file in the job's workspace.
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts)
 * (src/lib/studio/server/job-contract.ts).
 */
import { getServiceClient } from '@/lib/admin'
import { workerBlobRead } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return workerBlobRead(request, { supabase: getServiceClient() })
}
