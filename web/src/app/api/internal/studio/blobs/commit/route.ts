/**
 * POST /api/internal/studio/blobs/commit — {jobId, workerId, key} → {ok: true} once every part is up.
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts)
 * (src/lib/studio/server/job-contract.ts).
 */
import { getServiceClient } from '@/lib/admin'
import { workerBlobCommit } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return workerBlobCommit(request, { supabase: getServiceClient() })
}
