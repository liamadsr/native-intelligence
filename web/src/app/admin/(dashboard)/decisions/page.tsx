import { AdminPageHeader } from '@/components/admin/shared'
import { loadDecisionReport } from '@/lib/ai/decisions/reporting/load'
import { loadNudgeWorthReadout } from '@/lib/ai/decisions/reporting/nudge-worth'
import { DecisionFilters } from './filters'
import { DecisionQualityPanel } from './quality-panel'
import { NudgeWorthPanel } from './nudge-worth-panel'
import { DecisionReportView } from './report-view'
import { resolveDecisionRange, type DecisionSearchParams } from './range'

export const dynamic = 'force-dynamic'

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<DecisionSearchParams> }) {
  const resolved = resolveDecisionRange(await searchParams)
  // The loader authenticates before reading either reporting source. Invalid
  // filters do not issue an unfiltered query or silently broaden workspace scope.
  const [report, nudgeWorth] = resolved.ok ? await Promise.all([
    loadDecisionReport({ from: resolved.range.from, to: resolved.range.to,
      ...(resolved.range.workspaceId ? { workspaceId: resolved.range.workspaceId } : {}),
    }),
    // The shadow nudge.worth readout: always the last 30 days (its own window), the workspace filter applied.
    loadNudgeWorthReadout(resolved.range.workspaceId ? { workspaceId: resolved.range.workspaceId } : {}),
  ]) : [null, null]
  return <div className="min-w-0 space-y-6">
    <AdminPageHeader title="Jev Performance" description="Measured decision speed, usage, and browser outcomes across the application." />
    <DecisionFilters range={resolved.range} />
    {!resolved.ok ? <div role="alert" className="space-y-1 rounded-xl border border-destructive/40 p-4 text-sm">
      <p className="font-medium">Correct the filters to load a report.</p>
      {resolved.errors.map(error => <p key={error}>{error}</p>)}
    </div> : null}
    {report ? <><p className="text-xs text-muted-foreground">{resolved.range.fromDate} through {resolved.range.toDate} (UTC) · {resolved.range.workspaceId ? 'Selected workspace' : 'All workspaces'} · Generated {report.generatedAt.slice(0, 19).replace('T', ' ')} UTC</p>
      <DecisionReportView report={report} /></> : null}
    {nudgeWorth ? <NudgeWorthPanel readout={nudgeWorth} /> : null}
    <DecisionQualityPanel />
  </div>
}
