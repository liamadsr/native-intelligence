/**
 * POST /api/internal/studio/jobs/[id]/progress — {workerId, progress, log?} → {cancelRequested}.
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts), for a job it holds
 * (src/lib/studio/server/job-contract.ts).
 */
import { getServiceClient } from '@/lib/admin'
import { workerProgress } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workerProgress(request, (await params).id, { supabase: getServiceClient() })
}
