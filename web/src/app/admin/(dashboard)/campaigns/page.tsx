import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getAdminServiceClient } from '@/lib/admin'
import { AdminPageHeader, MetricCard } from '@/components/admin/shared'
import { CreateCampaignButton } from './create-campaign-button'
import { Mail, MessageSquare } from 'lucide-react'
import { readAll } from '@/lib/prospecting/exclusions'

export const dynamic = 'force-dynamic'

export default async function CampaignsPage() {
  const supabase = await getAdminServiceClient()

  // Fetch campaigns from unified table with step counts
  // The log and message reads are PAGED (readAll): PostgREST truncates at
  // 1000 rows, and every total and per-campaign count below comes from them.
  const [{ data: dbCampaigns }, campaignLog, inAppMessages] = await Promise.all([
    supabase
      .from('campaigns')
      .select('*, campaign_steps(id, delivery_channel)')
      .order('created_at', { ascending: true }),
    readAll<{ id: string; campaign_step: string | null; campaign_id: string | null; sent_at: string }>(
      'email_campaign_log',
      (lo, hi) =>
        supabase
          .from('email_campaign_log')
          .select('id, campaign_step, campaign_id, sent_at')
          .order('sent_at', { ascending: false })
          .order('id')
          .range(lo, hi),
    ),
    readAll<{ id: string; campaign_id: string | null }>('in_app_messages', (lo, hi) =>
      supabase
        .from('in_app_messages')
        .select('id, campaign_id')
        .not('campaign_id', 'is', null)
        .order('id')
        .range(lo, hi),
    ),
  ])

  const logs = campaignLog
  const totalEmailsSent = logs.length
  const totalMessagesSent = inAppMessages.length

  // Count emails per campaign
  const emailCountsByCampaign: Record<string, number> = {}
  const lastActivityByCampaign: Record<string, string> = {}
  for (const log of logs) {
    if (log.campaign_id) {
      emailCountsByCampaign[log.campaign_id] = (emailCountsByCampaign[log.campaign_id] ?? 0) + 1
      if (!lastActivityByCampaign[log.campaign_id]) {
        lastActivityByCampaign[log.campaign_id] = log.sent_at
      }
    }
  }

  // Count in-app messages per campaign
  const messageCountsByCampaign: Record<string, number> = {}
  for (const msg of inAppMessages) {
    if (msg.campaign_id) {
      messageCountsByCampaign[msg.campaign_id] = (messageCountsByCampaign[msg.campaign_id] ?? 0) + 1
    }
  }

  const campaigns = (dbCampaigns ?? []).map((c) => {
    const steps = Array.isArray(c.campaign_steps) ? c.campaign_steps : []
    const hasEmail = steps.some((s: { delivery_channel: string }) => s.delivery_channel === 'email' || s.delivery_channel === 'both')
    const hasInApp = steps.some((s: { delivery_channel: string }) => s.delivery_channel === 'in_app' || s.delivery_channel === 'both')

    return {
      id: c.id,
      name: c.title,
      slug: c.slug,
      type: c.trigger_type === 'cron' ? 'Automated' : 'Manual',
      steps: steps.length,
      emailsSent: emailCountsByCampaign[c.id] ?? 0,
      messagesSent: messageCountsByCampaign[c.id] ?? 0,
      lastActivity: lastActivityByCampaign[c.id] ?? null,
      active: c.is_active,
      hasEmail,
      hasInApp,
    }
  })

  const activeCampaigns = campaigns.filter((c) => c.active).length

  // Build a lookup from campaign_id to title for the activity log
  const campaignTitles: Record<string, string> = {}
  for (const c of dbCampaigns ?? []) {
    campaignTitles[c.id] = c.title
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <AdminPageHeader
          title="Campaigns"
          description="Manage email and in-app messaging campaigns"
        />
        <CreateCampaignButton />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricCard title="Campaigns" value={campaigns.length} />
        <MetricCard title="Active" value={activeCampaigns} />
        <MetricCard title="Emails Sent" value={totalEmailsSent} />
        <MetricCard title="Messages Sent" value={totalMessagesSent} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">All Campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No campaigns yet. Create one to get started.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Last Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/admin/campaigns/${c.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {c.hasEmail && (
                          <Badge variant="outline" className="gap-1 text-xs">
                            <Mail className="h-2.5 w-2.5" />
                            Email
                          </Badge>
                        )}
                        {c.hasInApp && (
                          <Badge variant="outline" className="gap-1 text-xs">
                            <MessageSquare className="h-2.5 w-2.5" />
                            In-App
                          </Badge>
                        )}
                        {!c.hasEmail && !c.hasInApp && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.type}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.active ? 'default' : 'secondary'}>
                        {c.active ? 'Active' : 'Paused'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.steps}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.emailsSent + c.messagesSent}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.lastActivity
                        ? new Date(c.lastActivity).toLocaleDateString()
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent email activity */}
      {logs.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
            <p className="text-sm text-muted-foreground">
              Last 20 emails sent across all campaigns
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Step</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Sent At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.slice(0, 20).map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      <Badge variant="outline">{log.campaign_step}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {log.campaign_id && campaignTitles[log.campaign_id]
                        ? campaignTitles[log.campaign_id]
                        : log.campaign_step}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(log.sent_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
