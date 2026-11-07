/**
 * Gateway-report-backed AI-usage view (Phase B —
 * docs/plans/gateway-usage-tracking.md).
 *
 * Reads the Vercel AI Gateway /v1/report instead of ai_usage_logs. The Gateway
 * owns cost now (market_cost = list price incl. BYOK = our billing basis), so
 * this view surfaces market cost as the headline and what Vercel actually
 * charged us (total_cost) alongside it.
 *
 * It fires FIVE report queries in parallel (day, user, model, tag,
 * credential_type) — each /v1/report call costs money, so we keep the count
 * bounded and never poll. On a 403 (reporting API is Pro/Enterprise-only) it
 * shows a plan-gating explainer with a link back to the logs view; other
 * failures show an error card; a genuinely empty range shows a friendly empty
 * state (tagging may not be rolled out yet).
 */

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
import { getAdminServiceClient, listAllAuthUsers } from '@/lib/admin'
import { MetricCard } from '@/components/admin/shared'
import { UserCell } from '@/components/admin/user-cell'
import { getUserAvatar } from '@/lib/campaign-utils'
import {
  getGatewayUsageReport,
  GatewayReportError,
  type GatewayReportRow,
} from '@/lib/ai/gateway-report'
import {
  toGatewayDateRange,
  aggregateTotals,
  tagBreakdown,
  topUsers,
  countTaggedUsers,
  modelBreakdown,
  credentialBreakdown,
  perDay,
  FEATURE_TAG_PREFIX,
  ENV_TAG_PREFIX,
} from './gateway-helpers'

function fmtUsd(n: number, digits = 4): string {
  return `$${n.toFixed(digits)}`
}

export async function GatewayUsageView({
  from,
  to,
  label,
}: {
  from: Date
  to: Date
  label: string
}) {
  const { startDate, endDate } = toGatewayDateRange(from, to)

  // Fire the five grouped reports in parallel. Bounded (5) and no polling —
  // each /v1/report query is billable.
  let dayRows: GatewayReportRow[]
  let userRows: GatewayReportRow[]
  let modelRows: GatewayReportRow[]
  let tagRows: GatewayReportRow[]
  let credRows: GatewayReportRow[]
  try {
    ;[dayRows, userRows, modelRows, tagRows, credRows] = await Promise.all([
      getGatewayUsageReport({ startDate, endDate, groupBy: 'day' }),
      getGatewayUsageReport({ startDate, endDate, groupBy: 'user' }),
      getGatewayUsageReport({ startDate, endDate, groupBy: 'model' }),
      getGatewayUsageReport({ startDate, endDate, groupBy: 'tag' }),
      getGatewayUsageReport({ startDate, endDate, groupBy: 'credential_type' }),
    ])
  } catch (err) {
    return <GatewayErrorCard error={err} />
  }

  const totals = aggregateTotals(dayRows)
  const users = topUsers(userRows)
  const models = modelBreakdown(modelRows)
  const featureRows = tagBreakdown(tagRows, FEATURE_TAG_PREFIX)
  const envRows = tagBreakdown(tagRows, ENV_TAG_PREFIX)
  const creds = credentialBreakdown(credRows)
  const days = perDay(dayRows)

  // Distinct users with a real user tag (untagged bucket doesn't count as one),
  // over every row — `users` is only the top 15.
  const activeUsers = countTaggedUsers(userRows)

  // Nothing at all came back → friendly empty state (likely pre-tagging).
  const hasAnyData =
    totals.requestCount > 0 || dayRows.length > 0 || userRows.length > 0
  if (!hasAnyData) {
    return <GatewayEmptyState />
  }

  // Resolve tagged user ids → email/avatar, exactly like the legacy view.
  const realUserIds = new Set(
    users.filter((u) => !u.untagged).map((u) => u.userId),
  )
  const userMap = new Map<string, { email: string; avatarUrl: string | null }>()
  if (realUserIds.size > 0) {
    const supabase = await getAdminServiceClient()
    const authUsers = await listAllAuthUsers(supabase)
    for (const user of authUsers) {
      if (realUserIds.has(user.id)) {
        userMap.set(user.id, {
          email: user.email ?? user.id,
          avatarUrl: getUserAvatar(user),
        })
      }
    }
  }

  const totalTokens = totals.inputTokens + totals.outputTokens
  const tokenSubtitleParts = [
    `${totals.inputTokens.toLocaleString()} in · ${totals.outputTokens.toLocaleString()} out`,
  ]
  if (totals.cachedInputTokens > 0)
    tokenSubtitleParts.push(`${totals.cachedInputTokens.toLocaleString()} cached`)
  if (totals.cacheCreationInputTokens > 0)
    tokenSubtitleParts.push(`${totals.cacheCreationInputTokens.toLocaleString()} cache-write`)
  if (totals.reasoningTokens > 0)
    tokenSubtitleParts.push(`${totals.reasoningTokens.toLocaleString()} reasoning`)

  return (
    <>
      {/* Metric cards — market cost is the headline (our billing basis). */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          title="Market Cost"
          value={fmtUsd(totals.marketCost)}
          subtitle={`List price · ${label}`}
        />
        <MetricCard
          title="Gateway Charged"
          value={fmtUsd(totals.totalCost)}
          subtitle={
            totals.surchargeCost > 0
              ? `incl. ${fmtUsd(totals.surchargeCost)} surcharge`
              : 'What Vercel billed us'
          }
        />
        <MetricCard
          title="Total Tokens"
          value={totalTokens.toLocaleString()}
          subtitle={tokenSubtitleParts.join(' · ')}
        />
        <MetricCard
          title="Requests"
          value={totals.requestCount.toLocaleString()}
        />
        <MetricCard
          title="Active Users"
          value={activeUsers}
          subtitle="Tagged with a user id"
        />
      </div>

      {/* Model + Feature breakdown */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost by Model */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by Model</CardTitle>
          </CardHeader>
          <CardContent>
            {models.length > 0 ? (
              <div className="space-y-3">
                {models.map((m) => (
                  <div key={m.model} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{m.model}</span>
                      <span className="text-sm text-muted-foreground">
                        {m.requestCount.toLocaleString()} requests
                      </span>
                    </div>
                    <span className="font-mono text-sm font-medium">{fmtUsd(m.marketCost)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No model data in this range.</p>
            )}
          </CardContent>
        </Card>

        {/* Cost by Feature — from Phase A `feature:` tags. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by Feature</CardTitle>
          </CardHeader>
          <CardContent>
            {featureRows.length > 0 ? (
              <div className="space-y-3">
                {featureRows.map((f) => (
                  <div key={f.label} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium capitalize">
                        {f.label.replace(/_/g, ' ')}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {f.requestCount.toLocaleString()} requests
                      </span>
                    </div>
                    <span className="font-mono text-sm font-medium">{fmtUsd(f.marketCost)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No <code className="text-xs">feature:</code> tags yet — per-request tagging may not
                be rolled out for this range.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Env split + BYOK vs system */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Environment split — from `env:` tags. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Environment</CardTitle>
          </CardHeader>
          <CardContent>
            {envRows.length > 0 ? (
              <div className="space-y-3">
                {envRows.map((e) => (
                  <div key={e.label} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs capitalize">
                        {e.label}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {e.requestCount.toLocaleString()} requests
                      </span>
                    </div>
                    <span className="font-mono text-sm font-medium">{fmtUsd(e.marketCost)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No <code className="text-xs">env:</code> tags yet.
              </p>
            )}
          </CardContent>
        </Card>

        {/* BYOK vs system credentials. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">BYOK vs System</CardTitle>
          </CardHeader>
          <CardContent>
            {creds.length > 0 ? (
              <div className="space-y-3">
                {creds.map((c) => (
                  <div key={c.credentialType} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge
                        className={
                          c.credentialType === 'byok'
                            ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
                            : c.credentialType === 'system'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                              : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                        }
                      >
                        {c.credentialType === 'byok'
                          ? 'BYOK'
                          : c.credentialType === 'system'
                            ? 'System'
                            : 'Unknown'}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {c.requestCount.toLocaleString()} requests
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="font-mono text-sm font-medium">
                        {fmtUsd(c.marketCost)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {fmtUsd(c.totalCost)} charged
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No credential data in this range.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top Users by market cost */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Top Users by Market Cost</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Market Cost</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.userId}>
                    <TableCell>
                      {u.untagged ? (
                        <span className="text-sm italic text-muted-foreground">(untagged)</span>
                      ) : (
                        <UserCell
                          id={u.userId}
                          email={userMap.get(u.userId)?.email ?? u.userId}
                          avatarUrl={userMap.get(u.userId)?.avatarUrl ?? null}
                        />
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{fmtUsd(u.marketCost)}</TableCell>
                    <TableCell>{u.tokens.toLocaleString()}</TableCell>
                    <TableCell>{u.requestCount.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No user usage data in this range.</p>
          )}
        </CardContent>
      </Card>

      {/* Per-day table */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Daily Usage</CardTitle>
        </CardHeader>
        <CardContent>
          {days.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day (UTC)</TableHead>
                  <TableHead>Requests</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Market Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {days.map((d) => (
                  <TableRow key={d.day}>
                    <TableCell className="text-xs text-muted-foreground">{d.day}</TableCell>
                    <TableCell>{d.requestCount.toLocaleString()}</TableCell>
                    <TableCell>{d.tokens.toLocaleString()}</TableCell>
                    <TableCell className="font-mono">{fmtUsd(d.marketCost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No daily data in this range.</p>
          )}
        </CardContent>
      </Card>

      {/* Coverage + freshness notes */}
      <Card className="mt-8 border-dashed">
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">Coverage:</strong> Deepgram transcription does not
            route through the Gateway — audio usage appears only in the legacy{' '}
            <span className="font-medium">Logs</span> view. Direct-provider fallback traffic
            (<code className="text-xs">USE_GATEWAY=false</code>) is likewise absent here.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            <strong className="text-foreground">Freshness:</strong> the Gateway report aggregates
            asynchronously — expect a few minutes of lag before the newest requests appear.
          </p>
        </CardContent>
      </Card>
    </>
  )
}

/** 403 → plan explainer; anything else → generic error. Links back to Logs. */
function GatewayErrorCard({ error }: { error: unknown }) {
  const status = error instanceof GatewayReportError ? error.status : undefined
  const message = error instanceof Error ? error.message : String(error)

  if (status === 403) {
    return (
      <Card className="mt-6 border-amber-300 dark:border-amber-800">
        <CardHeader>
          <CardTitle className="text-base">Gateway reporting unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The Vercel AI Gateway reporting API returned <strong>403 Forbidden</strong>. This API is
            available on <strong>Pro / Enterprise</strong> Vercel plans only, and requires a valid{' '}
            <code className="text-xs">AI_GATEWAY_API_KEY</code>. Hobby / trial teams can&apos;t query
            it.
          </p>
          <p className="text-sm text-muted-foreground">
            Switch to the{' '}
            <span className="font-medium">Logs</span> view (toggle above) to see usage from the
            local <code className="text-xs">ai_usage_logs</code> table instead.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mt-6 border-red-300 dark:border-red-800">
      <CardHeader>
        <CardTitle className="text-base">Couldn&apos;t load the Gateway report</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {status ? `HTTP ${status}. ` : ''}
          {message}
        </p>
        <p className="text-sm text-muted-foreground">
          Switch to the <span className="font-medium">Logs</span> view (toggle above) as a fallback.
        </p>
      </CardContent>
    </Card>
  )
}

/** Empty state when the report returns nothing (likely pre-tagging). */
function GatewayEmptyState() {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">No Gateway usage in this range</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          The Gateway report returned no rows for this range. If you expected data, per-request
          user/feature tagging may not be rolled out yet — untagged traffic still counts toward
          totals, but won&apos;t break down by user or feature. You can also check the{' '}
          <span className="font-medium">Logs</span> view (toggle above) for the same period.
        </p>
      </CardContent>
    </Card>
  )
}
