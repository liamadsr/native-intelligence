import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getAdminServiceClient, getAdminEnv } from '@/lib/admin'
import { fetchAllRows } from '@/lib/supabase/paging'
import { AdminPageHeader } from '@/components/admin/shared'
import { PlanDefinitionsTable } from '@/components/admin/plan-definitions-table'

export const dynamic = 'force-dynamic'

export default async function AIPlansPage() {
  const adminEnv = await getAdminEnv()
  const supabase = await getAdminServiceClient()

  // Fetch plans and user counts in parallel.
  // Model pricing is owned by the Vercel AI Gateway now (see docs/plans/gateway-usage-tracking.md).
  // The user rows page: PostgREST caps a response at 1000 rows, which
  // under-counted "users per plan" (and so the delete guard) past that.
  const [{ data: plans }, { data: userPlans, error: userPlansError }] = await Promise.all([
    supabase
      .from('ai_plan_definitions')
      .select('*')
      .order('monthly_cost_limit_usd', { ascending: true }),
    fetchAllRows<{ plan_id: string | null; user_id: string }>(() =>
      supabase.from('ai_user_plans').select('plan_id, user_id'),
    ),
  ])
  if (userPlansError) {
    console.error('[admin/ai-plans] ai_user_plans read failed:', userPlansError.message)
  }

  // Count users per plan
  const userCountByPlan: Record<string, number> = {}
  for (const up of userPlans ?? []) {
    const pid = up.plan_id
    if (pid) {
      userCountByPlan[pid] = (userCountByPlan[pid] || 0) + 1
    }
  }

  return (
    <div>
      <AdminPageHeader title="AI Plans" description="Manage AI usage plans" />

      {/* Plan Definitions */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Plan Definitions</CardTitle>
        </CardHeader>
        <CardContent>
          <PlanDefinitionsTable key={`plans-${adminEnv}`} initialPlans={plans ?? []} userCountByPlan={userCountByPlan} />
        </CardContent>
      </Card>
    </div>
  )
}
