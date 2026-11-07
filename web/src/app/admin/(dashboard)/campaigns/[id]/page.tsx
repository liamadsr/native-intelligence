import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getAdminServiceClient, listAllAuthUsers } from '@/lib/admin'
import { CampaignLogTable } from '@/components/admin/campaign-log-table'
import { CampaignStepsEditor } from './campaign-steps-editor'
import { CampaignSettingsBar } from './campaign-settings-bar'
import { CampaignAudienceSection } from './campaign-audience-section'
import { SendInvitesForm } from '../send-invites-form'
import { EarlyAccessTable } from '../early-access/early-access-table'
import { getUserAvatar, buildUserTierMap } from '@/lib/campaign-utils'
import { readAll } from '@/lib/prospecting/exclusions'
import { fetchAllRows } from '@/lib/supabase/paging'
import type { CampaignUser, UserTier } from '@/lib/campaign-types'

export const dynamic = 'force-dynamic'

type AuthUser = any

interface EarlyAccessUser {
  id: string
  email: string
  status: string | null
  created_at: string
  invited_at: string | null
  last_email_step: string | null
  last_email_sent_at: string | null
  unsubscribed: boolean
  feedback: Record<string, unknown> | null
  user_id: string | null
  converted_at: string | null
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-base font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  waitlisted: 'outline',
  invited: 'default',
  signed_up: 'default',
  downloaded: 'default',
  setup_complete: 'default',
  active: 'default',
}

function normalizeEarlyAccessUser(u: EarlyAccessUser): CampaignUser {
  const status = u.status ?? 'waitlisted'
  return {
    id: u.id,
    email: u.email,
    avatarUrl: null,
    tier: 'free',
    createdAt: u.created_at,
    lastSignInAt: null,
    campaignStatus: status,
    campaignStatusVariant: statusVariant[status] ?? 'outline',
    extra: {
      lastEmailStep: u.last_email_step,
      lastEmailSentAt: u.last_email_sent_at,
      invitedAt: u.invited_at,
      unsubscribed: u.unsubscribed,
      feedback: u.feedback,
      convertedAt: u.converted_at,
      userId: u.user_id,
    },
  }
}

function normalizeAuthUser(user: AuthUser, tier: UserTier): CampaignUser {
  const override = user.user_metadata?.trial_end_override as string | undefined
  const overrideDate = override ? new Date(override) : null
  const isActive = overrideDate ? overrideDate > new Date() : false

  let campaignStatus: string
  let campaignStatusVariant: CampaignUser['campaignStatusVariant']

  if (overrideDate && isActive) {
    campaignStatus = 'extended_active'
    campaignStatusVariant = 'default'
  } else if (overrideDate && !isActive) {
    campaignStatus = 'extended_expired'
    campaignStatusVariant = 'secondary'
  } else {
    campaignStatus = 'active'
    campaignStatusVariant = 'outline'
  }

  return {
    id: user.id,
    email: user.email ?? '',
    avatarUrl: getUserAvatar(user),
    tier,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    campaignStatus,
    campaignStatusVariant,
    extra: {
      trialEndOverride: override ?? null,
    },
  }
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await getAdminServiceClient()

  // Fetch campaign + steps
  const [{ data: campaign, error: campaignError }, { data: steps }] = await Promise.all([
    supabase.from('campaigns').select('*').eq('id', id).single(),
    supabase
      .from('campaign_steps')
      .select('*')
      .eq('campaign_id', id)
      .order('step_order', { ascending: true }),
  ])

  if (campaignError || !campaign) {
    notFound()
  }

  // Email campaign log: the newest 50 for the table, and the real total.
  const [{ data: campaignLog }, { count: emailsSent }] = await Promise.all([
    supabase
      .from('email_campaign_log')
      .select('*')
      .eq('campaign_id', id)
      .order('sent_at', { ascending: false })
      .limit(50),
    supabase
      .from('email_campaign_log')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', id),
  ])

  // In-app message stats, paged past PostgREST's 1000-row cap so the sent
  // counts and response rate cover every message.
  const allMessages = await readAll<{
    id: string
    status: string | null
    step_id: string | null
    message_responses: { id: string }[] | null
  }>('in_app_messages', (lo, hi) =>
    supabase
      .from('in_app_messages')
      .select('id, status, step_id, message_responses(id)')
      .eq('campaign_id', id)
      .order('id')
      .range(lo, hi),
  )
  const logs = campaignLog ?? []
  const allSteps = steps ?? []

  // Step-level sent counts (in-app messages per step)
  const stepSentCounts: Record<string, number> = {}
  for (const msg of allMessages) {
    if (msg.step_id) {
      stepSentCounts[msg.step_id] = (stepSentCounts[msg.step_id] ?? 0) + 1
    }
  }

  // In-app response stats
  const responded = allMessages.filter(
    (m) => Array.isArray(m.message_responses) && m.message_responses.length > 0,
  ).length
  const responseRate =
    allMessages.length > 0
      ? Math.round((responded / allMessages.length) * 100)
      : 0

  // Campaign-specific audience data
  let earlyAccessData: {
    users: CampaignUser[]
    counts: { all: number; waitlisted: number; invited: number; signedUp: number; active: number; unsubscribed: number }
  } | null = null

  let authUsersData: {
    users: CampaignUser[]
    activeExtensions: number
    expiredExtensions: number
    lapsedCount: number
  } | null = null

  if (campaign.audience_source === 'early_access') {
    // Paged: PostgREST caps a response at 1000 rows, which cut the audience
    // counts and the recipient list off at the first 1000 entries.
    const { data: earlyAccess, error: earlyAccessError } = await fetchAllRows<EarlyAccessUser>(
      () =>
        supabase
          .from('early_access')
          .select('*')
          .order('created_at', { ascending: false })
          .order('id', { ascending: true }),
      { orderBy: null },
    )
    if (earlyAccessError) {
      console.error('[admin/campaigns] early_access read failed:', earlyAccessError.message)
    }

    const users = earlyAccess
    const campaignUsers = users.map(normalizeEarlyAccessUser)
    earlyAccessData = {
      users: campaignUsers,
      counts: {
        all: users.length,
        waitlisted: users.filter((u) => u.status === 'waitlisted' || !u.status).length,
        invited: users.filter((u) => u.status === 'invited').length,
        signedUp: users.filter((u) => u.status === 'signed_up').length,
        active: users.filter((u) => u.status && ['downloaded', 'setup_complete', 'active'].includes(u.status)).length,
        unsubscribed: users.filter((u) => u.unsubscribed).length,
      },
    }
  }

  if (campaign.audience_source === 'auth_users') {
    const [users, { data: purchases, error: purchasesError }] = await Promise.all([
      listAllAuthUsers(supabase),
      fetchAllRows<{ user_id: string; status: string; price_paid: number | string; metadata: Record<string, unknown> | null }>(
        () => supabase.from('purchases').select('user_id, status, price_paid, metadata'),
      ),
    ])
    if (purchasesError) {
      console.error('[admin/campaigns] purchases read failed:', purchasesError.message)
    }

    const now = new Date()
    const userTiers = buildUserTierMap(purchases)
    const campaignUsers = users.map((u) => normalizeAuthUser(u, userTiers[u.id] ?? 'free'))

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    authUsersData = {
      users: campaignUsers,
      activeExtensions: campaignUsers.filter((u) => u.campaignStatus === 'extended_active').length,
      expiredExtensions: campaignUsers.filter((u) => u.campaignStatus === 'extended_expired').length,
      lapsedCount: users.filter((u) => {
        if (u.user_metadata?.trial_end_override) return false
        if (!u.last_sign_in_at) return false
        return new Date(u.last_sign_in_at) < thirtyDaysAgo
      }).length,
    }
  }

  return (
    <div>
      <Link
        href="/admin/campaigns"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All Campaigns
      </Link>

      {/* Header card */}
      <Card>
        <CardContent className="p-5">
          {/* Title row */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{campaign.title}</h1>
              {campaign.description && (
                <p className="mt-1 text-sm text-muted-foreground">{campaign.description}</p>
              )}
            </div>
            <CampaignSettingsBar
              campaignId={campaign.id}
              isActive={campaign.is_active}
              triggerType={campaign.trigger_type}
            />
          </div>

          {/* Stats row */}
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-4 text-sm">
            <Stat label="Steps" value={allSteps.length} />
            <Stat label="Emails Sent" value={emailsSent ?? logs.length} />
            <Stat label="Messages Sent" value={allMessages.length} />
            {allMessages.length > 0 && (
              <Stat label="Response Rate" value={`${responseRate}%`} />
            )}

            {earlyAccessData && (
              <>
                <div className="h-4 w-px bg-border" />
                <Stat label="Waitlisted" value={earlyAccessData.counts.waitlisted} />
                <Stat label="Invited" value={earlyAccessData.counts.invited} />
                <Stat label="Signed Up" value={earlyAccessData.counts.signedUp} />
                <Stat label="Active" value={earlyAccessData.counts.active} />
                <Stat label="Unsubscribed" value={earlyAccessData.counts.unsubscribed} />
              </>
            )}

            {authUsersData && (
              <>
                <div className="h-4 w-px bg-border" />
                <Stat label="Users" value={authUsersData.users.length} />
                <Stat label="Active Ext." value={authUsersData.activeExtensions} />
                <Stat label="Expired Ext." value={authUsersData.expiredExtensions} />
                <Stat label="Lapsed 30d+" value={authUsersData.lapsedCount} />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Send Invites (Early Access only) */}
      {earlyAccessData && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Send Invites</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              {earlyAccessData.counts.waitlisted} users waiting for an invite.
            </p>
            <SendInvitesForm waitlistedCount={earlyAccessData.counts.waitlisted} />
          </CardContent>
        </Card>
      )}

      {/* Campaign Sequence Builder */}
      <div className="mt-6">
        <h3 className="mb-3 text-base font-semibold">Campaign Sequence</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Define the order and timing of steps in this campaign. Each step can be an email, an in-app message, or both.
        </p>
        <CampaignStepsEditor
          campaignId={campaign.id}
          initialSteps={allSteps}
          stepSentCounts={stepSentCounts}
        />
      </div>

      {/* Audience Section (for auth_users campaigns — send steps to users) */}
      {authUsersData && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Audience</CardTitle>
            <p className="text-sm text-muted-foreground">
              Select a step and send it to all users or specific users
            </p>
          </CardHeader>
          <CardContent>
            <CampaignAudienceSection
              campaignId={campaign.id}
              users={authUsersData.users}
              steps={allSteps.map((s) => ({
                id: s.id,
                step_name: s.step_name,
                step_order: s.step_order,
                delivery_channel: s.delivery_channel,
              }))}
            />
          </CardContent>
        </Card>
      )}

      {/* Campaign-specific user tables */}
      {earlyAccessData && (
        <div className="mt-6">
          <h3 className="mb-3 text-base font-semibold">
            Early Access Users ({earlyAccessData.users.length})
          </h3>
          <EarlyAccessTable users={earlyAccessData.users} />
        </div>
      )}

      {/* Campaign Log */}
      {logs.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Email Campaign Log</CardTitle>
          </CardHeader>
          <CardContent>
            <CampaignLogTable
              logs={logs}
              emptyMessage="No emails sent in this campaign yet."
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
