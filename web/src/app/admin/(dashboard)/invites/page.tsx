import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { AdminPageHeader, MetricCard } from '@/components/admin/shared'
import {
  signupInviteStatus,
  signupInviteUrl,
  type SignupInviteRow,
} from '@/lib/admin/signup-invites'
import { formatRelativeTime } from '@/lib/campaign-utils'
import { SignupInviteForm } from './signup-invite-form'
import { SignupInviteActions } from './signup-invite-actions'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT = {
  pending: 'default',
  used: 'secondary',
  expired: 'outline',
} as const

export default async function InvitesPage() {
  const supabase = await getAdminServiceClient()
  const { data } = await supabase
    .from('signup_invite')
    .select('*')
    .order('created_at', { ascending: false })
  const invites = (data ?? []) as SignupInviteRow[]

  const counts = { pending: 0, used: 0, expired: 0 }
  for (const invite of invites) counts[signupInviteStatus(invite)]++

  return (
    <div>
      <AdminPageHeader
        title="Invites"
        description="Invite someone to create a Native Intelligence account. Invited people bypass the business-email requirement; per invite you choose whether they also skip the paywall."
      />

      <div className="mt-6 grid grid-cols-3 gap-4">
        <MetricCard title="Pending" value={counts.pending} />
        <MetricCard title="Signed up" value={counts.used} />
        <MetricCard title="Expired" value={counts.expired} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Send an invite</CardTitle>
          <CardDescription>
            They get an email with a link that opens the signup form with their address filled in.
            Invites last 30 days; inviting the same address again refreshes it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignupInviteForm />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">All invites ({invites.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {invites.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invites yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Paywall</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => {
                  const status = signupInviteStatus(invite)
                  return (
                    <TableRow key={invite.id}>
                      <TableCell className="font-medium">{invite.email}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[status]} className="capitalize">
                          {status === 'used' ? 'Signed up' : status}
                        </Badge>
                        {invite.used_at && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {formatRelativeTime(new Date(invite.used_at))}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {invite.skip_payment ? (
                          <Badge variant="secondary">Skipped</Badge>
                        ) : (
                          <Badge variant="outline">Card required</Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {invite.note ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRelativeTime(new Date(invite.updated_at))}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(invite.expires_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <SignupInviteActions
                          invite={{
                            id: invite.id,
                            email: invite.email,
                            note: invite.note,
                            skipPayment: invite.skip_payment,
                            status,
                            url: signupInviteUrl(invite.token),
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
