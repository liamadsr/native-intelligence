import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DECISION_RANGE_PRESETS, type DecisionRange } from './range'

export function DecisionFilters({ range }: { range: DecisionRange }) {
  return (
    <form action="/admin/decisions" method="get" aria-label="Decision report filters" className="mt-6 rounded-xl border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="decision-preset">Date range</Label>
          <select id="decision-preset" name="preset" defaultValue={range.preset}
            className="flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm">
            {DECISION_RANGE_PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="decision-from">Custom start (UTC)</Label>
          <Input id="decision-from" name="from" type="date" defaultValue={range.fromDate} aria-describedby="decision-range-help" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="decision-to">Custom end (UTC)</Label>
          <Input id="decision-to" name="to" type="date" defaultValue={range.toDate} aria-describedby="decision-range-help" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="decision-workspace">Workspace UUID (optional)</Label>
          <Input id="decision-workspace" name="workspace" defaultValue={range.workspaceId ?? ''} placeholder="All workspaces" maxLength={36} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p id="decision-range-help" className="text-xs text-muted-foreground">Select Custom dates to use the date fields. End date included; maximum 90 days.</p>
        <Button type="submit" size="sm">Apply filters</Button>
      </div>
    </form>
  )
}
