/**
 * POST /api/internal/studio/blobs/write — {jobId, workerId, key, bytes, contentType, sha256?} → upload links per part, in the job's workspace.
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts)
 * (src/lib/studio/server/job-contract.ts).
 */
import { getServiceClient } from '@/lib/admin'
import { workerBlobWrite } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return workerBlobWrite(request, { supabase: getServiceClient() })
}
