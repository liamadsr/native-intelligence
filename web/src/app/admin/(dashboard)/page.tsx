import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getAdminServiceClient } from '@/lib/admin'
import { fetchAllRows } from '@/lib/supabase/paging'
import { AdminPageHeader, MetricCard, truncateId } from '@/components/admin/shared'

export const dynamic = 'force-dynamic'

export default async function AdminDashboard() {
  const supabase = await getAdminServiceClient()

  // Fetch all metrics in parallel. PostgREST caps a response at 1000 rows and
  // truncates silently, so counts are head counts and the revenue sum pages.
  const [
    { count: totalDevices },
    { count: activeTrials },
    completedPurchasesRead,
    { count: earlyAccessTotal },
    { count: earlyAccessWaitlisted },
    { count: earlyAccessInvited },
    { data: recentPurchases },
    { data: recentSignups },
  ] = await Promise.all([
    supabase.from('devices').select('*', { count: 'exact', head: true }),
    supabase
      .from('devices')
      .select('*', { count: 'exact', head: true })
      .gt('trial_expires_at', new Date().toISOString()),
    fetchAllRows<{ price_paid: number | string }>(() =>
      supabase.from('purchases').select('price_paid').eq('status', 'completed'),
    ),
    supabase.from('early_access').select('*', { count: 'exact', head: true }),
    supabase
      .from('early_access')
      .select('*', { count: 'exact', head: true })
      .or('status.eq.waitlisted,status.is.null'),
    supabase
      .from('early_access')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'invited'),
    supabase
      .from('purchases')
      .select('device_id, feature_id, price_paid, status, purchased_at')
      .order('purchased_at', { ascending: false })
      .limit(5),
    supabase
      .from('early_access')
      .select('email, status, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  const activeTrialCount = activeTrials ?? 0
  if (completedPurchasesRead.error) {
    console.error('[admin/dashboard] purchases read failed:', completedPurchasesRead.error.message)
  }
  const completedPurchases = completedPurchasesRead.data
  const totalRevenue = completedPurchases.reduce((sum, p) => sum + Number(p.price_paid), 0)

  const earlyAccessStats = {
    total: earlyAccessTotal ?? 0,
    waitlisted: earlyAccessWaitlisted ?? 0,
    invited: earlyAccessInvited ?? 0,
  }

  return (
    <div>
      <AdminPageHeader title="Dashboard" description="Overview of Native Intelligence metrics" />

      {/* Metric cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title="Total Devices" value={totalDevices ?? 0} />
        <MetricCard title="Active Trials" value={activeTrialCount} />
        <MetricCard
          title="Revenue"
          value={`$${totalRevenue.toFixed(2)}`}
          subtitle={`${completedPurchases.length} purchases`}
        />
        <MetricCard
          title="Early Access"
          value={earlyAccessStats.total}
          subtitle={`${earlyAccessStats.waitlisted} waitlisted, ${earlyAccessStats.invited} invited`}
        />
      </div>

      {/* Recent activity */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recent purchases */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Purchases</CardTitle>
          </CardHeader>
          <CardContent>
            {recentPurchases && recentPurchases.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device</TableHead>
                    <TableHead>Feature</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentPurchases.map((p, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">
                        {truncateId(p.device_id)}
                      </TableCell>
                      <TableCell>{p.feature_id}</TableCell>
                      <TableCell>${Number(p.price_paid).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={p.status === 'completed' ? 'default' : 'secondary'}>
                          {p.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No purchases yet.</p>
            )}
          </CardContent>
        </Card>

        {/* Recent signups */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Signups</CardTitle>
          </CardHeader>
          <CardContent>
            {recentSignups && recentSignups.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Signed Up</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentSignups.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell>{s.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{s.status ?? 'waitlisted'}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(s.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No signups yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
