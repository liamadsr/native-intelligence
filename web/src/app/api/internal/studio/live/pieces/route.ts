/**
 * POST /api/internal/studio/live/pieces — {jobId, workerId, after} → the pieces of a take's track that the held
 * live-import job reads next, a link per piece (src/lib/studio/server/job-contract.ts LivePieces).
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts), for a job it holds, and only
 * that job's own track.
 */
import { getServiceClient } from '@/lib/admin'
import { workerLivePieces } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return workerLivePieces(request, { supabase: getServiceClient() })
}
