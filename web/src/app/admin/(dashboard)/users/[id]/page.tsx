import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ArrowLeft, Clock, Crown, Gift, Star } from 'lucide-react'
import { getAdminServiceClient } from '@/lib/admin'
import { ESCALATION_FEATURE } from '@/lib/ai/model-route'
import { resolveWorkspaceEditionFromSettings } from '@/lib/editions'
import { truncateId } from '@/components/admin/shared'
import { WorkspaceFeaturesPanel } from './workspace-features-panel'
import { EditUserPanel } from './edit-user-panel'
import { PurchaseActions } from './purchase-actions'
import { GrantPurchase } from './grant-purchase'
import { DeleteUserButton } from './delete-user-button'
import { ProfileAvatar } from './profile-avatar'
import { SendMessagePanel } from './send-message-panel'
import { CancelSubscriptionButton, GrantSubscription } from './subscription-actions'
import { GrantCredits } from './grant-credits'

export const dynamic = 'force-dynamic'

const purchaseStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  pending: 'outline',
  refunded: 'destructive',
  failed: 'secondary',
}

function getUserDisplayName(user: { email?: string; user_metadata?: Record<string, unknown> }) {
  const meta = user.user_metadata ?? {}
  const fullName = meta.full_name ?? meta.name
  if (typeof fullName === 'string' && fullName.trim()) return fullName.trim()
  if (user.email) return user.email.split('@')[0].replace(/[._]/g, ' ')
  return 'Unknown'
}

function getUserAvatar(user: { user_metadata?: Record<string, unknown> }): string | null {
  const meta = user.user_metadata ?? {}
  const url = meta.avatar_url ?? meta.picture ?? meta.photo_url
  return typeof url === 'string' ? url : null
}

function getInitials(name: string): string {
  return name
    .split(/[\s._]+/)
    .map((s) => s[0]?.toUpperCase())
    .filter(Boolean)
    .join('')
    .slice(0, 2)
}

type AccountTier = 'subscriber' | 'pro_paid' | 'pro_granted' | 'free'

function isGrantedPurchase(p: Record<string, unknown>): boolean {
  if (Number(p.price_paid) === 0) return true
  const meta = p.metadata as Record<string, unknown> | null
  if (meta?.promotional === true) return true
  if (meta?.granted_by) return true
  return false
}

function getAccountTier(
  purchases: Record<string, unknown>[] | null,
  subscription: Record<string, unknown> | null,
): AccountTier {
  // Active subscription takes priority
  if (subscription && ['active', 'trialing'].includes(subscription.status as string)) {
    return 'subscriber'
  }
  if (!purchases?.length) return 'free'
  const active = purchases.filter((p) => p.status === 'completed')
  if (active.length === 0) return 'free'
  const hasPaid = active.some((p) => !isGrantedPurchase(p))
  return hasPaid ? 'pro_paid' : 'pro_granted'
}

/**
 * Read-receipt for an admin message: what happened and when. The lifecycle
 * timestamps (delivered_at/read_at/dismissed_at/responded_at) are set by the
 * user-side delivery channel, so this is a precise account of whether the user
 * saw, opened, dismissed, or answered the message. Near-monochrome to match the
 * app: a dot conveys state, no loud colors.
 */
type MessageRow = {
  status?: string | null
  delivered_at?: string | null
  read_at?: string | null
  dismissed_at?: string | null
  responded_at?: string | null
}

function MessageReceipt({ message }: { message: MessageRow }) {
  // Resolve to the furthest-along state, preferring the explicit timestamp.
  const stages: { key: string; label: string; at: string | null | undefined; dot: string }[] = [
    { key: 'responded', label: 'Responded', at: message.responded_at, dot: 'bg-foreground' },
    { key: 'dismissed', label: 'Dismissed', at: message.dismissed_at, dot: 'bg-muted-foreground/40' },
    { key: 'read', label: 'Opened', at: message.read_at, dot: 'bg-foreground' },
    { key: 'delivered', label: 'Delivered', at: message.delivered_at, dot: 'bg-muted-foreground' },
  ]

  // A status can be set without (older) timestamps, so fall back to status text.
  const matched =
    stages.find((s) => s.at) ??
    stages.find((s) => s.key === message.status) ??
    { label: 'Not seen', at: null, dot: 'bg-muted-foreground/30' }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-1.5 w-1.5 rounded-full ${matched.dot}`} />
      <span className="font-medium text-foreground">{matched.label}</span>
      {matched.at && (
        <span className="text-muted-foreground">
          ·{' '}
          {new Date(matched.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      )}
    </span>
  )
}

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await getAdminServiceClient()

  const [
    { data: userData, error: userError },
    { data: userDevices },
    { data: purchases },
    { data: workflows },
    { data: features },
    { data: userPlanData },
    { data: recentAIUsage },
    { data: userMessages },
    { data: subscriptionData },
    { data: creditsData },
    { data: memberships },
  ] = await Promise.all([
    supabase.auth.admin.getUserById(id),
    supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', id)
      .order('last_active_at', { ascending: false }),
    supabase
      .from('purchases')
      .select('*')
      .eq('user_id', id)
      .order('purchased_at', { ascending: false }),
    supabase
      .from('workflows')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false }),
    supabase.from('features').select('id, display_name').eq('is_active', true),
    supabase
      .from('ai_user_plans')
      .select('*, ai_plan_definitions(name, display_name, monthly_cost_limit_usd, monthly_token_limit, purchase_action, is_default)')
      .eq('user_id', id)
      .maybeSingle(),
    supabase
      .from('ai_usage_logs')
      .select('provider, model, feature, input_tokens, output_tokens, estimated_cost_usd, created_at')
      .eq('user_id', id)
      // The Strong-escalation markers are counts, not usage (model-escalation-budget.ts).
      .neq('feature', ESCALATION_FEATURE)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('in_app_messages')
      .select('*, message_responses(*)')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('ai_user_credits')
      .select('balance_usd, lifetime_granted_usd, lifetime_consumed_usd, last_synced_at, stripe_customer_id')
      .eq('user_id', id)
      .maybeSingle(),
    // `settings` rides along so each workspace's edition and feature overrides
    // can be resolved server-side, with no per-workspace round trip from the
    // panel below.
    supabase
      .from('member')
      .select('role, workspace:workspace_id(id, name, slug, plan, settings)')
      .eq('user_id', id),
  ])

  if (userError || !userData?.user) {
    notFound()
  }

  const user = userData.user
  // GoTrue exposes a ban as `banned_until` (a lifted or expired ban is past/null).
  const isBanned = !!user.banned_until && new Date(user.banned_until) > new Date()
  const displayName = getUserDisplayName(user)
  const avatarUrl = getUserAvatar(user)
  const initials = getInitials(displayName)
  const tier = getAccountTier(purchases, subscriptionData)
  const meta = user.user_metadata ?? {}
  const provider = user.app_metadata?.provider ?? 'email'

  // Derive the effective AI plan using the same priority rules as check_ai_usage_limit:
  //   1. Admin override → stored plan
  //   2. Active subscription → subscriber plan
  //   3. Stored plan (from webhook or log_ai_usage)
  //   4. Default (free)
  // Each workspace this user belongs to, with its persona edition and feature
  // overrides resolved from the settings blob we already read.
  // `resolveWorkspaceEditionFromSettings` is pure and never throws, so a
  // workspace whose settings predate the feature simply reads back the `full`
  // default with no overrides.
  const workspaceRows = (memberships ?? []).flatMap((m) => {
    const ws = m.workspace as unknown as Record<string, unknown> | null
    if (!ws?.id) return []
    const resolved = resolveWorkspaceEditionFromSettings(ws.settings)
    return [
      {
        id: String(ws.id),
        name: (ws.name as string | null) ?? 'Untitled workspace',
        slug: (ws.slug as string | null) ?? null,
        plan: (ws.plan as string | null) ?? null,
        role: m.role as string,
        edition: resolved.id,
        overrides: resolved.overrides,
      },
    ]
  })

  const storedPlanDef = userPlanData?.ai_plan_definitions as Record<string, unknown> | null
  const hasActiveSubscription = subscriptionData && ['active', 'trialing'].includes(subscriptionData.status as string)
  const isAdminOverride = userPlanData?.admin_override === true

  let effectivePlanName: string
  let effectiveCostLimit: number | null

  if (isAdminOverride && storedPlanDef) {
    effectivePlanName = storedPlanDef.display_name as string
    effectiveCostLimit = storedPlanDef.monthly_cost_limit_usd as number | null
  } else if (hasActiveSubscription) {
    effectivePlanName = 'Subscriber'
    effectiveCostLimit = 50.00 // matches ai_plan_definitions subscriber row
  } else if (storedPlanDef) {
    effectivePlanName = storedPlanDef.display_name as string
    effectiveCostLimit = storedPlanDef.monthly_cost_limit_usd as number | null
  } else {
    effectivePlanName = 'Free'
    effectiveCostLimit = 2.00
  }

  return (
    <div>
      {/* Back link */}
      <Link
        href="/admin/users"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Users
      </Link>

      {/* Profile header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-5">
            {/* Avatar */}
            <ProfileAvatar avatarUrl={avatarUrl} displayName={displayName} initials={initials} />

            {/* Name + email + badges */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold capitalize truncate">{displayName}</h1>
                {tier === 'subscriber' ? (
                  <Badge variant="default" className="shrink-0 bg-purple-600">
                    <Star className="mr-1 h-3 w-3" /> Subscriber
                  </Badge>
                ) : tier === 'pro_paid' ? (
                  <Badge variant="default" className="shrink-0">
                    <Crown className="mr-1 h-3 w-3" /> BYOK
                  </Badge>
                ) : tier === 'pro_granted' ? (
                  <Badge variant="outline" className="shrink-0 border-purple-500/30 text-purple-600 dark:text-purple-400">
                    <Gift className="mr-1 h-3 w-3" /> BYOK (Granted)
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="shrink-0">Free</Badge>
                )}
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground truncate">{user.email ?? '—'}</p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">{user.id}</p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              <EditUserPanel
                userId={user.id}
                currentEmail={user.email ?? ''}
                currentMetadata={meta}
                isBanned={isBanned}
              />
              <DeleteUserButton userId={user.id} userEmail={user.email ?? 'this user'} />
            </div>
          </div>

          <Separator className="my-5" />

          {/* Key details grid */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <p className="text-xs text-muted-foreground">Auth Provider</p>
              <p className="text-sm capitalize">{String(provider)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Created</p>
              <p className="text-sm">{new Date(user.created_at).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last Sign In</p>
              <p className="text-sm">
                {user.last_sign_in_at
                  ? new Date(user.last_sign_in_at).toLocaleString()
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Devices</p>
              <p className="text-sm">{userDevices?.length ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Purchases</p>
              <p className="text-sm">{purchases?.length ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Trial</p>
              {meta.trial_end_override ? (
                (() => {
                  const overrideDate = new Date(String(meta.trial_end_override))
                  const isActive = overrideDate > new Date()
                  return (
                    <div className="flex items-center gap-1">
                      <Clock className={`h-3 w-3 ${isActive ? 'text-green-600' : 'text-muted-foreground'}`} />
                      <p className={`text-sm ${isActive ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
                        {isActive
                          ? `Extended to ${overrideDate.toLocaleDateString()}`
                          : `Expired ${overrideDate.toLocaleDateString()}`}
                      </p>
                    </div>
                  )
                })()
              ) : (
                <p className="text-sm text-muted-foreground">Standard (14 days)</p>
              )}
            </div>
          </div>

          {/* Admin notes */}
          {meta.admin_notes && (
            <div className="mt-4 rounded-md bg-muted p-3">
              <p className="text-xs font-medium text-muted-foreground">Admin Notes</p>
              <p className="mt-1 text-sm whitespace-pre-wrap">
                {String(meta.admin_notes)}
              </p>
            </div>
          )}

          {/* User metadata */}
          {Object.keys(meta).filter(
            (k) => !['admin_notes', 'avatar_url', 'picture', 'photo_url', 'full_name', 'name', 'email', 'email_verified', 'iss', 'sub', 'provider_id', 'custom_claims', 'trial_end_override'].includes(k),
          ).length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-muted-foreground">Custom Metadata</p>
              <pre className="mt-1 rounded-md bg-muted p-3 text-xs overflow-auto">
                {JSON.stringify(
                  Object.fromEntries(
                    Object.entries(meta).filter(
                      ([k]) => !['admin_notes', 'avatar_url', 'picture', 'photo_url', 'full_name', 'name', 'email', 'email_verified', 'iss', 'sub', 'provider_id', 'custom_claims', 'trial_end_override'].includes(k),
                    ),
                  ),
                  null,
                  2,
                )}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Devices */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">
            Devices ({userDevices?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {userDevices && userDevices.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device ID</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>OS</TableHead>
                  <TableHead>App Version</TableHead>
                  <TableHead>Last Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {userDevices.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">
                      {truncateId(d.device_id)}
                    </TableCell>
                    <TableCell>{d.device_model ?? '—'}</TableCell>
                    <TableCell>{d.os_version ?? '—'}</TableCell>
                    <TableCell>{d.app_version ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {d.last_active_at
                        ? new Date(d.last_active_at).toLocaleDateString()
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No devices linked to this user.</p>
          )}
        </CardContent>
      </Card>

      {/* Workspaces & Features — the admin home of the persona-edition
          switcher. Users keep the per-feature toggles in their own workspace
          settings; the edition, which changes the app's whole surface for every
          member, is set here on their behalf. */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">
            Workspaces &amp; Features ({workspaceRows.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WorkspaceFeaturesPanel workspaces={workspaceRows} />
        </CardContent>
      </Card>

      {/* Billing & Purchases */}
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Billing & Purchases</CardTitle>
          <div className="flex items-center gap-2">
            <GrantPurchase userId={user.id} features={features ?? []} />
            {!subscriptionData || !['active', 'trialing'].includes(String(subscriptionData.status)) ? (
              <GrantSubscription userId={user.id} />
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {/* Subscription */}
          {subscriptionData ? (
            <div className="mb-5 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Subscription</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge
                      variant={
                        subscriptionData.status === 'active' || subscriptionData.status === 'trialing'
                          ? 'default'
                          : subscriptionData.status === 'past_due'
                            ? 'destructive'
                            : 'secondary'
                      }
                      className={
                        subscriptionData.status === 'active' ? 'bg-green-600' :
                        subscriptionData.status === 'trialing' ? 'bg-blue-600' : ''
                      }
                    >
                      {String(subscriptionData.status).replace('_', ' ')}
                    </Badge>
                    {subscriptionData.cancel_at_period_end && (
                      <Badge variant="outline" className="border-orange-500/30 text-orange-600">
                        Cancels at period end
                      </Badge>
                    )}
                    {String(subscriptionData.stripe_subscription_id).startsWith('granted_') && (
                      <Badge variant="outline" className="border-purple-500/30 text-purple-600 dark:text-purple-400">
                        <Gift className="mr-1 h-2.5 w-2.5" /> Granted
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {(subscriptionData.status === 'active' || subscriptionData.status === 'trialing') &&
                    !subscriptionData.cancel_at_period_end && (
                    <CancelSubscriptionButton subscriptionId={String(subscriptionData.id)} />
                  )}
                  <div className="text-right text-xs text-muted-foreground">
                    {subscriptionData.current_period_end && (
                      <p>Period ends: {new Date(String(subscriptionData.current_period_end)).toLocaleDateString()}</p>
                    )}
                    <p className="font-mono">{truncateId(String(subscriptionData.stripe_subscription_id))}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="mb-5 flex items-center rounded-md border border-dashed p-3">
              <p className="text-xs text-muted-foreground">No active subscription</p>
            </div>
          )}

          {/* Purchases table */}
          <p className="mb-2 text-sm font-medium">Purchases ({purchases?.length ?? 0})</p>
          {purchases && purchases.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead>Option</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Stripe ID</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((p) => {
                  const granted = isGrantedPurchase(p)
                  const meta = p.metadata as Record<string, unknown> | null
                  const campaign = meta?.campaign as string | undefined
                  const grantedBy = meta?.granted_by as string | undefined
                  const reason = meta?.reason as string | undefined

                  return (
                    <TableRow key={p.id}>
                      <TableCell>{p.feature_id}</TableCell>
                      <TableCell>{p.purchase_option ?? '—'}</TableCell>
                      <TableCell>
                        {Number(p.price_paid) === 0 ? (
                          <span className="text-muted-foreground">$0.00</span>
                        ) : (
                          `$${Number(p.price_paid).toFixed(2)}`
                        )}
                      </TableCell>
                      <TableCell>
                        {granted ? (
                          <div className="space-y-0.5">
                            <Badge variant="outline" className="text-xs border-purple-500/30 text-purple-600 dark:text-purple-400">
                              <Gift className="mr-1 h-2.5 w-2.5" />
                              Granted
                            </Badge>
                            {campaign && (
                              <p className="text-[10px] text-muted-foreground">{campaign}</p>
                            )}
                            {grantedBy && (
                              <p className="text-[10px] text-muted-foreground">by {grantedBy}</p>
                            )}
                            {reason && (
                              <p className="text-[10px] text-muted-foreground">{reason}</p>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            Paid
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={purchaseStatusVariant[p.status] ?? 'outline'}>
                          {p.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.stripe_payment_intent_id
                          ? truncateId(p.stripe_payment_intent_id, 20)
                          : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.purchased_at
                          ? new Date(p.purchased_at).toLocaleDateString()
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <PurchaseActions
                          purchaseId={p.id}
                          currentStatus={p.status}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No purchases.</p>
          )}
        </CardContent>
      </Card>

      {/* Messages */}
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            Messages ({userMessages?.length ?? 0})
          </CardTitle>
          <SendMessagePanel
            userId={user.id}
            userEmail={user.email ?? ''}
          />
        </CardHeader>
        <CardContent>
          {userMessages && userMessages.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Response</TableHead>
                  <TableHead>Sent At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {userMessages.map((m) => {
                  const responses = Array.isArray(m.message_responses)
                    ? m.message_responses
                    : []
                  const response = responses[0] as
                    | { rating?: number; response_text?: string }
                    | undefined

                  return (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">
                        {m.message_title}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {(m.message_type ?? 'feedback_prompt').replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <MessageReceipt message={m} />
                      </TableCell>
                      <TableCell>
                        {response ? (
                          <div className="space-y-0.5">
                            {response.rating != null && (
                              <div className="flex items-center gap-0.5">
                                {[1, 2, 3, 4, 5].map((star) => (
                                  <Star
                                    key={star}
                                    className={`h-3 w-3 ${
                                      star <= (response.rating ?? 0)
                                        ? 'fill-yellow-400 text-yellow-400'
                                        : 'text-muted-foreground'
                                    }`}
                                  />
                                ))}
                              </div>
                            )}
                            {response.response_text && (
                              <p className="max-w-[200px] truncate text-xs text-muted-foreground">
                                {response.response_text}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {m.created_at
                          ? new Date(m.created_at).toLocaleDateString()
                          : '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No messages sent to this user.</p>
          )}
        </CardContent>
      </Card>

      {/* Workflows */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">
            Workflows ({workflows?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {workflows && workflows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{w.trigger_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={w.is_enabled ? 'default' : 'secondary'}>
                        {w.is_enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {w.last_run_at
                        ? new Date(w.last_run_at).toLocaleDateString()
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(w.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No workflows.</p>
          )}
        </CardContent>
      </Card>

      {/* AI Usage */}
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">AI Usage</CardTitle>
          <GrantCredits userId={user.id} />
        </CardHeader>
        <CardContent>
          {/* Plan & Usage Summary */}
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div>
              <p className="text-xs text-muted-foreground">Effective Plan</p>
              <p className="font-medium">
                {effectivePlanName}
                {isAdminOverride && (
                  <span className="ml-1 text-xs text-amber-600">(admin override)</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cost This Period</p>
              <p className="font-mono font-medium">
                ${Number(userPlanData?.current_period_cost_usd ?? 0).toFixed(4)}
                {effectiveCostLimit != null && (
                  <span className="text-xs text-muted-foreground">
                    {' '}/ ${Number(effectiveCostLimit).toFixed(2)}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Tokens This Period</p>
              <p className="font-mono font-medium">
                {(userPlanData?.current_period_tokens ?? 0).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Requests This Period</p>
              <p className="font-mono font-medium">
                {userPlanData?.current_period_requests ?? 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Credit Balance</p>
              <p className="font-mono font-medium">
                ${Number(creditsData?.balance_usd ?? 0).toFixed(2)}
              </p>
              {creditsData?.lifetime_granted_usd != null && (
                <p className="text-[10px] text-muted-foreground">
                  ${Number(creditsData.lifetime_granted_usd).toFixed(2)} granted lifetime
                </p>
              )}
            </div>
          </div>

          {/* Usage cost bar */}
          {userPlanData && effectiveCostLimit != null && (
            <div className="mb-4">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{
                    width: `${Math.min(100, (Number(userPlanData.current_period_cost_usd) / Number(effectiveCostLimit)) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {((Number(userPlanData.current_period_cost_usd) / Number(effectiveCostLimit)) * 100).toFixed(1)}% of limit used
              </p>
            </div>
          )}

          <Separator className="my-4" />

          {/* Recent AI requests */}
          <p className="mb-2 text-sm font-medium">Recent Requests</p>
          {recentAIUsage && recentAIUsage.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Feature</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentAIUsage.map((log, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(log.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{log.provider}</Badge>
                    </TableCell>
                    <TableCell className="text-xs capitalize">
                      {(log.feature ?? '').replace(/_/g, ' ')}
                    </TableCell>
                    <TableCell className="text-xs">
                      {((log.input_tokens || 0) + (log.output_tokens || 0)).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      ${Number(log.estimated_cost_usd || 0).toFixed(6)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No AI usage yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
