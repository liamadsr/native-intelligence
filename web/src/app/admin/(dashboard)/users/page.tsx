import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Crown, Gift, Star } from 'lucide-react'
import { getAdminServiceClient, listAllAuthUsers } from '@/lib/admin'
import { fetchAllRows } from '@/lib/supabase/paging'
import { AdminPageHeader, MetricCard, truncateId } from '@/components/admin/shared'
import { UserCell } from '@/components/admin/user-cell'
import { ExtendTrialInline } from './extend-trial-inline'
import { getUserAvatar, formatRelativeTime, buildUserTierMap } from '@/lib/campaign-utils'
import type { UserTier } from '@/lib/campaign-types'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const supabase = await getAdminServiceClient()

  // Every aggregate below is over ALL rows: PostgREST caps a response at 1000
  // rows and truncates silently, so each read pages (fetchAllRows).
  const [
    users,
    devicesRead,
    userDevicesRead,
    purchasesRead,
    subscriptionsRead,
  ] = await Promise.all([
    listAllAuthUsers(supabase),
    fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from('devices')
          .select('*')
          .order('created_at', { ascending: false })
          .order('id', { ascending: true }),
      { orderBy: null },
    ),
    fetchAllRows<{ user_id: string; device_id: string }>(
      () =>
        supabase
          .from('user_devices')
          .select('user_id, device_id')
          .order('user_id', { ascending: true })
          .order('device_id', { ascending: true }),
      { orderBy: null },
    ),
    fetchAllRows<{ user_id: string; status: string; price_paid: number | string; metadata: Record<string, unknown> | null }>(
      () => supabase.from('purchases').select('user_id, status, price_paid, metadata'),
    ),
    fetchAllRows<{ user_id: string; status: string }>(
      () => supabase.from('subscriptions').select('user_id, status').in('status', ['active', 'trialing']),
    ),
  ])
  for (const [label, read] of [
    ['devices', devicesRead],
    ['user_devices', userDevicesRead],
    ['purchases', purchasesRead],
    ['subscriptions', subscriptionsRead],
  ] as const) {
    if (read.error) console.error(`[admin/users] ${label} read failed:`, read.error.message)
  }
  const devices = devicesRead.data
  const deviceCount = devices.length
  const userDevices = userDevicesRead.data
  const purchases = purchasesRead.data
  const subscriptions = subscriptionsRead.data
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  // Count devices per user
  const deviceCountByUser: Record<string, number> = {}
  for (const ud of userDevices ?? []) {
    deviceCountByUser[ud.user_id] = (deviceCountByUser[ud.user_id] ?? 0) + 1
  }

  // Track purchases per user
  const purchaseCountByUser: Record<string, number> = {}
  for (const p of purchases ?? []) {
    if (p.status === 'completed') {
      purchaseCountByUser[p.user_id] = (purchaseCountByUser[p.user_id] ?? 0) + 1
    }
  }
  const userTier = buildUserTierMap(purchases, subscriptions)

  // Total revenue from completed purchases
  const totalRevenue = (purchases ?? [])
    .filter((p) => p.status === 'completed')
    .reduce((sum, p) => sum + Number(p.price_paid), 0)

  const activeUsers = users.filter(
    (u) => u.last_sign_in_at && new Date(u.last_sign_in_at) > thirtyDaysAgo,
  ).length

  const subscriberUsers = users.filter((u) => userTier[u.id] === 'subscriber').length
  const paidProUsers = users.filter((u) => userTier[u.id] === 'pro_paid').length
  const grantedProUsers = users.filter((u) => userTier[u.id] === 'pro_granted').length
  const totalPaying = subscriberUsers + paidProUsers
  const conversionRate =
    users.length > 0 ? ((totalPaying / users.length) * 100).toFixed(1) : '0.0'

  // Device analytics: rank OS versions, app versions, device models
  const allDevices = devices ?? []
  const osCounts: Record<string, number> = {}
  const appVersionCounts: Record<string, number> = {}
  const modelCounts: Record<string, number> = {}

  for (const d of allDevices) {
    const os = (d.os_version as string) || 'Unknown'
    const appVer = (d.app_version as string) || 'Unknown'
    const model = (d.device_model as string) || 'Unknown'
    osCounts[os] = (osCounts[os] ?? 0) + 1
    appVersionCounts[appVer] = (appVersionCounts[appVer] ?? 0) + 1
    modelCounts[model] = (modelCounts[model] ?? 0) + 1
  }

  const rankedOS = Object.entries(osCounts).sort((a, b) => b[1] - a[1])
  const rankedAppVersions = Object.entries(appVersionCounts).sort((a, b) => b[1] - a[1])
  const rankedModels = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])

  return (
    <div>
      <AdminPageHeader
        title="Users"
        description="Manage authenticated users and registered devices"
      />

      {/* Summary cards */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard title="Total Users" value={users.length} />
        <MetricCard title="Active (30d)" value={activeUsers} />
        <MetricCard title="Subscribers" value={subscriberUsers} />
        <MetricCard title="BYOK (Paid)" value={paidProUsers} />
        <MetricCard title="BYOK (Granted)" value={grantedProUsers} />
        <MetricCard title="Total Devices" value={deviceCount ?? 0} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetricCard
          title="Conversion"
          value={`${conversionRate}%`}
          subtitle={`${totalPaying} paying of ${users.length} users`}
        />
        <MetricCard title="Total Revenue" value={`$${totalRevenue.toFixed(2)}`} />
      </div>

      {/* Tabbed content */}
      <Card className="mt-6">
        <CardContent className="pt-6">
          <Tabs defaultValue="users">
            <TabsList>
              <TabsTrigger value="users">Users ({users.length})</TabsTrigger>
              <TabsTrigger value="devices">Devices ({deviceCount ?? 0})</TabsTrigger>
            </TabsList>

            <TabsContent value="users">
              <UsersTable
                users={users}
                deviceCounts={deviceCountByUser}
                purchaseCounts={purchaseCountByUser}
                userTiers={userTier}
              />
            </TabsContent>

            <TabsContent value="devices">
              {/* Device breakdown cards */}
              <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
                <RankingCard
                  title="OS Version"
                  items={rankedOS}
                  total={allDevices.length}
                />
                <RankingCard
                  title="App Version"
                  items={rankedAppVersions}
                  total={allDevices.length}
                />
                <RankingCard
                  title="Device Model"
                  items={rankedModels}
                  total={allDevices.length}
                />
              </div>

              <DevicesTable devices={allDevices} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

type AuthUser = any

function RankingCard({
  title,
  items,
  total,
}: {
  title: string
  items: [string, number][]
  total: number
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data</p>
        ) : (
          <div className="space-y-2">
            {items.slice(0, 5).map(([label, count], i) => {
              const pct = total > 0 ? (count / total) * 100 : 0
              return (
                <div key={label}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="truncate font-medium">
                      <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
                      {label}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {count} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
                    <div
                      className="h-1.5 rounded-full bg-primary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
            {items.length > 5 && (
              <p className="text-xs text-muted-foreground">
                +{items.length - 5} more
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function UsersTable({
  users,
  deviceCounts,
  purchaseCounts,
  userTiers,
}: {
  users: AuthUser[]
  deviceCounts: Record<string, number>
  purchaseCounts: Record<string, number>
  userTiers: Record<string, UserTier>
}) {
  if (users.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">No users yet.</p>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Tier</TableHead>
          <TableHead>Trial</TableHead>
          <TableHead>Devices</TableHead>
          <TableHead>Purchases</TableHead>
          <TableHead>Last Sign In</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => {
          const tier = userTiers[user.id] ?? 'free'

          return (
            <TableRow key={user.id} className="cursor-pointer">
              <TableCell>
                <div className="flex items-center gap-2">
                  <UserCell
                    id={user.id}
                    email={user.email ?? '—'}
                    avatarUrl={getUserAvatar(user)}
                  />
                  {user.banned_until && new Date(user.banned_until) > new Date() && (
                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                      Banned
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell>
                {tier === 'subscriber' ? (
                  <Badge variant="default" className="text-xs bg-purple-600">
                    <Star className="mr-0.5 h-2.5 w-2.5" /> Subscriber
                  </Badge>
                ) : tier === 'pro_paid' ? (
                  <Badge variant="default" className="text-xs">
                    <Crown className="mr-0.5 h-2.5 w-2.5" /> BYOK
                  </Badge>
                ) : tier === 'pro_granted' ? (
                  <Badge variant="outline" className="text-xs border-purple-500/30 text-purple-600 dark:text-purple-400">
                    <Gift className="mr-0.5 h-2.5 w-2.5" /> Granted
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">Free</Badge>
                )}
              </TableCell>
              <TableCell>
                <ExtendTrialInline
                  userId={user.id}
                  currentOverride={
                    typeof user.user_metadata?.trial_end_override === 'string'
                      ? user.user_metadata.trial_end_override
                      : null
                  }
                />
              </TableCell>
              <TableCell>
                <Badge variant="outline">{deviceCounts[user.id] ?? 0}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{purchaseCounts[user.id] ?? 0}</Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground" title={user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : undefined}>
                {user.last_sign_in_at
                  ? formatRelativeTime(new Date(user.last_sign_in_at))
                  : '—'}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(user.created_at).toLocaleDateString()}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function DevicesTable({ devices }: { devices: Record<string, unknown>[] }) {
  if (devices.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">No devices registered yet.</p>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Device ID</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>OS</TableHead>
          <TableHead>App Version</TableHead>
          <TableHead>Registered</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {devices.map((device) => (
          <TableRow key={device.id as string}>
            <TableCell className="font-mono text-xs">
              {truncateId(device.device_id as string)}
            </TableCell>
            <TableCell>{(device.device_model as string) ?? '—'}</TableCell>
            <TableCell>{(device.os_version as string) ?? '—'}</TableCell>
            <TableCell>{(device.app_version as string) ?? '—'}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {new Date(device.created_at as string).toLocaleDateString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
