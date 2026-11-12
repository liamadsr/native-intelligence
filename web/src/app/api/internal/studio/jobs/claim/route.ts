/**
 * POST /api/internal/studio/jobs/claim — {workerId, kinds} → {job | null}: the oldest queued job of those kinds, now held by this worker.
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts)
 * (src/lib/studio/server/job-contract.ts).
 */
import { getServiceClient } from '@/lib/admin'
import { workerClaim } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return workerClaim(request, { supabase: getServiceClient() })
}
