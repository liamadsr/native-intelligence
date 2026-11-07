import { getAdminEnv } from '@/lib/admin'
import { AdminPageHeader } from '@/components/admin/shared'
import { EvalsReview } from './evals-review'

export const dynamic = 'force-dynamic'

/**
 * The evals flywheel's review (docs/plans/always-on-agent.md §8; migration
 * 349): every thumbs, bad chat turn, heavily rewritten draft and failed loop,
 * to dismiss or promote into a chat skill eval case. Reads the environment
 * the switcher selects; switching remounts the queue.
 */
export default async function EvalsPage() {
  const adminEnv = await getAdminEnv()
  return (
    <div className="min-w-0 space-y-6">
      <AdminPageHeader
        title="Evals"
        description="Thumbs, failed turns, rewritten drafts and failed loops: dismiss them, or promote them into skill eval cases."
      />
      <EvalsReview key={`evals-${adminEnv}`} />
    </div>
  )
}
