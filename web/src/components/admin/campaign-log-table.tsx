import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { truncateId } from '@/components/admin/shared'

interface CampaignLogTableProps {
  logs: Array<{
    id: string
    email: string
    campaign_step: string
    resend_id: string | null
    sent_at: string
  }>
  emptyMessage?: string
}

export function CampaignLogTable({
  logs,
  emptyMessage = 'No emails sent yet.',
}: CampaignLogTableProps) {
  if (logs.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Step</TableHead>
          <TableHead>Resend ID</TableHead>
          <TableHead>Sent At</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => (
          <TableRow key={log.id}>
            <TableCell>{log.email}</TableCell>
            <TableCell>
              <Badge variant="outline">{log.campaign_step}</Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">
              {truncateId(log.resend_id, 20)}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {new Date(log.sent_at).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
