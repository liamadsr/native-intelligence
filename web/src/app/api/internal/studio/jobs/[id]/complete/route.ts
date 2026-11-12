/**
 * POST /api/internal/studio/jobs/[id]/complete — {workerId, result} → {ok: true}; what the job made is filed (422 when it cannot be).
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts), for a job it holds
 * (src/lib/studio/server/job-contract.ts).
 */
import { getServiceClient } from '@/lib/admin'
import { workerComplete } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workerComplete(request, (await params).id, { supabase: getServiceClient() })
}
