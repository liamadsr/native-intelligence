/**
 * POST /api/internal/studio/jobs/[id]/fail — {workerId, error} → {ok: true}.
 *
 * The Studio worker only (STUDIO_WORKER_SECRET, src/lib/studio/server/worker-auth.ts), for a job it holds
 * (src/lib/studio/server/job-contract.ts).
 */
import { after } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { workerFail } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // What the job sets off (a recording put together, its pieces removed) runs after the answer: the worker is never held.
  return workerFail(request, (await params).id, { supabase: getServiceClient(), defer: (task) => after(task) })
}
