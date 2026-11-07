/**
 * Legacy ai_usage_logs-backed AI-usage view.
 *
 * This is the ORIGINAL dashboard, extracted verbatim from page.tsx so the
 * Gateway-report view (Phase B — docs/plans/gateway-usage-tracking.md) can sit
 * beside it, switchable via the source toggle. Behavior and queries are
 * unchanged: it reads ai_usage_logs directly, aggregates per user/provider/
 * feature/cost-source, and renders the metric cards + tables.
 *
 * It receives the already-resolved [from, to) range + label from the page so
 * both views share one range picker.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ESCALATION_FEATURE } from '@/lib/ai/model-route'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getAdminServiceClient, listAllAuthUsers } from '@/lib/admin'
import { MetricCard } from '@/components/admin/shared'
import { UserCell } from '@/components/admin/user-cell'
import { getUserAvatar, buildUserTierMap } from '@/lib/campaign-utils'
import { readAll } from '@/lib/prospecting/exclusions'
import { Crown, Gift, Star } from 'lucide-react'
import type { UserTier } from '@/lib/campaign-types'

interface UsageLogRow {
  user_id: string | null
  provider: string | null
  model: string | null
  feature: string | null
  input_tokens: number | null
  output_tokens: number | null
  audio_seconds: number | null
  estimated_cost_usd: number | string | null
  cost_source: string | null
}

interface PurchaseRow {
  user_id: string
  status: string
  price_paid: number | string
  metadata: Record<string, unknown> | null
}

export async function LogsUsageView({
  from,
  to,
  label,
}: {
  from: Date
  to: Date
  label: string
}) {
  const supabase = await getAdminServiceClient()

  const fromISO = from.toISOString()
  const toISO = to.toISOString()

  // Fetch all metrics in parallel. The aggregate reads are PAGED (readAll):
  // PostgREST caps a response at 1000 rows and truncates silently, which
  // would under-report every total once a range has more logs than that.
  const [
    rangeLogs,
    { data: recentLogs },
    purchases,
    subscriptions,
  ] = await Promise.all([
    // Every log in the selected range — used for aggregate stats AND top-user rollup
    readAll<UsageLogRow>('ai_usage_logs range', (lo, hi) =>
      supabase
        .from('ai_usage_logs')
        .select('user_id, provider, model, feature, input_tokens, output_tokens, audio_seconds, estimated_cost_usd, cost_source')
        // The Strong-escalation markers are counts, not usage (model-escalation-budget.ts).
        .neq('feature', ESCALATION_FEATURE)
        .gte('created_at', fromISO)
        .lt('created_at', toISO)
        .order('id')
        .range(lo, hi),
    ),
    // Recent individual requests within the range
    supabase
      .from('ai_usage_logs')
      .select('user_id, provider, model, feature, input_tokens, output_tokens, audio_seconds, estimated_cost_usd, cost_source, created_at')
      .neq('feature', ESCALATION_FEATURE)
      .gte('created_at', fromISO)
      .lt('created_at', toISO)
      .order('created_at', { ascending: false })
      .limit(20),
    // Purchases & subscriptions for tier calculation
    readAll<PurchaseRow>('purchases', (lo, hi) =>
      supabase
        .from('purchases')
        .select('user_id, status, price_paid, metadata')
        .eq('status', 'completed')
        .order('id')
        .range(lo, hi),
    ),
    readAll<{ user_id: string; status: string }>('subscriptions', (lo, hi) =>
      supabase
        .from('subscriptions')
        .select('user_id, status')
        .in('status', ['active', 'trialing'])
        .order('id')
        .range(lo, hi),
    ),
  ])

  const userTiers = buildUserTierMap(purchases, subscriptions)
  const logs = rangeLogs

  // Aggregate per user from the logs themselves — no dependency on ai_user_plans counters.
  const userAggregates: Record<string, { cost: number; tokens: number; requests: number }> = {}
  for (const l of logs) {
    if (!l.user_id) continue
    const bucket = (userAggregates[l.user_id] ??= { cost: 0, tokens: 0, requests: 0 })
    bucket.cost += Number(l.estimated_cost_usd || 0)
    bucket.tokens += (l.input_tokens || 0) + (l.output_tokens || 0)
    bucket.requests += 1
  }

  const usersWithUsage = Object.entries(userAggregates)
    .map(([user_id, stats]) => ({ user_id, ...stats }))
    .filter((u) => u.cost > 0 || u.requests > 0)
  const topUsers = [...usersWithUsage].sort((a, b) => b.cost - a.cost).slice(0, 15)

  // Build user lookup map for displaying names/emails instead of IDs
  const allUserIds = new Set<string>()
  for (const u of topUsers) allUserIds.add(u.user_id)
  for (const l of recentLogs ?? []) if (l.user_id) allUserIds.add(l.user_id)

  const userMap = new Map<string, { email: string; avatarUrl: string | null }>()
  if (allUserIds.size > 0) {
    const authUsers = await listAllAuthUsers(supabase)
    for (const user of authUsers) {
      if (allUserIds.has(user.id)) {
        userMap.set(user.id, {
          email: user.email ?? user.id,
          avatarUrl: getUserAvatar(user),
        })
      }
    }
  }

  // Calculate aggregate stats
  const totalCost = logs.reduce((sum, l) => sum + Number(l.estimated_cost_usd || 0), 0)
  const totalRequests = logs.length
  const totalTokens = logs.reduce((sum, l) => sum + (l.input_tokens || 0) + (l.output_tokens || 0), 0)
  const totalAudioSeconds = logs.reduce((sum, l) => sum + (l.audio_seconds || 0), 0)
  const totalAudioMinutes = totalAudioSeconds / 60
  const activeUsers = usersWithUsage.length

  // Cost by provider
  const costByProvider: Record<string, { cost: number; requests: number }> = {}
  for (const log of logs) {
    const p = log.provider ?? 'unknown'
    if (!costByProvider[p]) costByProvider[p] = { cost: 0, requests: 0 }
    costByProvider[p].cost += Number(log.estimated_cost_usd || 0)
    costByProvider[p].requests += 1
  }

  // Cost by feature
  const costByFeature: Record<string, { cost: number; requests: number }> = {}
  for (const log of logs) {
    const f = log.feature ?? 'unknown'
    if (!costByFeature[f]) costByFeature[f] = { cost: 0, requests: 0 }
    costByFeature[f].cost += Number(log.estimated_cost_usd || 0)
    costByFeature[f].requests += 1
  }

  // Cost-source mix — lets us see what share of spend is coming from Gateway
  // (authoritative) vs pricing_table (estimated from ai_model_costs) vs other.
  const costBySource: Record<string, { cost: number; requests: number }> = {}
  for (const log of logs) {
    const src = log.cost_source ?? 'unknown'
    if (!costBySource[src]) costBySource[src] = { cost: 0, requests: 0 }
    costBySource[src].cost += Number(log.estimated_cost_usd || 0)
    costBySource[src].requests += 1
  }

  const providerColors: Record<string, string> = {
    claude: 'bg-purple-100 text-purple-800',
    groq: 'bg-orange-100 text-orange-800',
    openai: 'bg-green-100 text-green-800',
  }

  const costSourceLabels: Record<string, { label: string; className: string }> = {
    gateway: { label: 'Gateway', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
    pricing_table: { label: 'Pricing table', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
    metadata: { label: 'SDK metadata', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
    fallback_conservative: { label: 'Fallback (Opus)', className: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
    none: { label: 'No cost', className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    unknown: { label: 'Unknown', className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  }

  return (
    <>
      {/* Metric cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Cost"
          value={`$${totalCost.toFixed(4)}`}
          subtitle={`${totalRequests} requests · ${label}`}
        />
        <MetricCard
          title="Total Tokens"
          value={totalTokens.toLocaleString()}
          subtitle={
            totalAudioMinutes >= 1
              ? `+ ${totalAudioMinutes.toFixed(1)} audio min`
              : 'Input + output'
          }
        />
        <MetricCard
          title="Avg Cost/Request"
          value={totalRequests > 0 ? `$${(totalCost / totalRequests).toFixed(6)}` : '$0'}
        />
        <MetricCard
          title="Active Users"
          value={activeUsers}
          subtitle="With usage in range"
        />
      </div>

      {/* Cost source mix — surfaces Gateway migration progress */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Cost Source</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(costBySource).length > 0 ? (
            <div className="space-y-3">
              {Object.entries(costBySource)
                .sort((a, b) => b[1].requests - a[1].requests)
                .map(([source, stats]) => {
                  const meta = costSourceLabels[source] ?? costSourceLabels.unknown
                  const pct = totalRequests > 0 ? (stats.requests / totalRequests) * 100 : 0
                  return (
                    <div key={source} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className={meta.className}>{meta.label}</Badge>
                        <span className="text-sm text-muted-foreground">
                          {stats.requests} requests ({pct.toFixed(0)}%)
                        </span>
                      </div>
                      <span className="font-mono text-sm font-medium">${stats.cost.toFixed(4)}</span>
                    </div>
                  )
                })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No usage in this range.</p>
          )}
        </CardContent>
      </Card>

      {/* Provider and Feature breakdown */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost by Provider */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by Provider</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(costByProvider).length > 0 ? (
              <div className="space-y-3">
                {Object.entries(costByProvider)
                  .sort((a, b) => b[1].cost - a[1].cost)
                  .map(([provider, stats]) => (
                    <div key={provider} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className={providerColors[provider] ?? 'bg-gray-100 text-gray-800'}>
                          {provider}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {stats.requests} requests
                        </span>
                      </div>
                      <span className="font-mono text-sm font-medium">
                        ${stats.cost.toFixed(4)}
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No usage in this range.</p>
            )}
          </CardContent>
        </Card>

        {/* Cost by Feature */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by Feature</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(costByFeature).length > 0 ? (
              <div className="space-y-3">
                {Object.entries(costByFeature)
                  .sort((a, b) => b[1].cost - a[1].cost)
                  .map(([feature, stats]) => (
                    <div key={feature} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium capitalize">{feature.replace(/_/g, ' ')}</span>
                        <span className="text-sm text-muted-foreground">
                          {stats.requests} requests
                        </span>
                      </div>
                      <span className="font-mono text-sm font-medium">
                        ${stats.cost.toFixed(4)}
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No usage in this range.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top Users */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Top Users by Cost</CardTitle>
        </CardHeader>
        <CardContent>
          {topUsers.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topUsers.map((u) => {
                  const tier: UserTier = userTiers[u.user_id] ?? 'free'
                  return (
                    <TableRow key={u.user_id}>
                      <TableCell>
                        <UserCell
                          id={u.user_id}
                          email={userMap.get(u.user_id)?.email ?? u.user_id}
                          avatarUrl={userMap.get(u.user_id)?.avatarUrl ?? null}
                        />
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
                      <TableCell className="font-mono">${u.cost.toFixed(4)}</TableCell>
                      <TableCell>{u.tokens.toLocaleString()}</TableCell>
                      <TableCell>{u.requests}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No user usage data in this range.</p>
          )}
        </CardContent>
      </Card>

      {/* Recent Requests */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Recent Requests</CardTitle>
        </CardHeader>
        <CardContent>
          {recentLogs && recentLogs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Feature</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentLogs.map((log, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(log.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <UserCell
                        id={log.user_id}
                        email={userMap.get(log.user_id)?.email ?? log.user_id}
                        avatarUrl={userMap.get(log.user_id)?.avatarUrl ?? null}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge className={providerColors[log.provider] ?? 'bg-gray-100 text-gray-800'}>
                        {log.provider}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{log.model}</TableCell>
                    <TableCell className="text-xs capitalize">{(log.feature ?? '').replace(/_/g, ' ')}</TableCell>
                    <TableCell className="text-xs">
                      {log.audio_seconds && log.audio_seconds > 0
                        ? `${(log.audio_seconds / 60).toFixed(1)} min audio`
                        : ((log.input_tokens || 0) + (log.output_tokens || 0)).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      ${Number(log.estimated_cost_usd || 0).toFixed(6)}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const meta =
                          costSourceLabels[log.cost_source ?? 'unknown'] ?? costSourceLabels.unknown
                        return (
                          <Badge className={`text-xs ${meta.className}`}>{meta.label}</Badge>
                        )
                      })()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No requests in this range.</p>
          )}
        </CardContent>
      </Card>
    </>
  )
}
