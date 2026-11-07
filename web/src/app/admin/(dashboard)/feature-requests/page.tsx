import { getAdminServiceClient, getAdminEnv } from '@/lib/admin'
import { AdminPageHeader, MetricCard } from '@/components/admin/shared'
import { FeatureRequestsTable } from '@/components/admin/feature-requests-table'
import type { AdminFeatureRequest } from '@/components/admin/feature-requests-table'

export const dynamic = 'force-dynamic'

export default async function FeatureRequestsPage() {
  const adminEnv = await getAdminEnv()
  const supabase = await getAdminServiceClient()

  const { data: requests } = await supabase
    .from('feature_requests')
    .select('*')
    .order('vote_count', { ascending: false })

  const rows = requests ?? []

  // Resolve poster emails for triage context. Admins legitimately need to
  // see who asked for what, so unlike the public board we surface the email.
  const userIds = [...new Set(rows.map((r) => r.user_id))]
  const emailById: Record<string, string> = {}
  await Promise.all(
    userIds.map(async (id) => {
      const { data } = await supabase.auth.admin.getUserById(id)
      if (data?.user?.email) emailById[id] = data.user.email
    }),
  )

  const enriched: AdminFeatureRequest[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    type: r.type ?? 'feature_request',
    visibility: r.visibility ?? 'public',
    status: r.status,
    vote_count: r.vote_count,
    comment_count: r.comment_count,
    created_at: r.created_at,
    user_email: emailById[r.user_id] ?? null,
  }))

  // Quick top-line metrics.
  const total = enriched.length
  const open = enriched.filter((r) => r.status === 'open').length
  const planned = enriched.filter((r) => r.status === 'planned' || r.status === 'in_progress').length
  const completed = enriched.filter((r) => r.status === 'completed').length

  return (
    <div>
      <AdminPageHeader
        title="Feature Requests"
        description="Triage the community feature-request board and set roadmap status."
      />

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard title="Total" value={total} />
        <MetricCard title="Open" value={open} />
        <MetricCard title="Planned / In Progress" value={planned} />
        <MetricCard title="Completed" value={completed} />
      </div>

      <div className="mt-8">
        <FeatureRequestsTable key={`fr-${adminEnv}`} initialRequests={enriched} />
      </div>
    </div>
  )
}
