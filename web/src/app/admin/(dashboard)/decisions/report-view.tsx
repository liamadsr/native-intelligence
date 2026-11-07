import { MetricCard } from '@/components/admin/shared'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { DecisionReport, Distribution, SourceCoverage, UsageTotals } from '@/lib/ai/decisions/reporting/types'
import { count, duration, fraction, usd } from './format'

const available = (source: SourceCoverage) => source.rows > 0 || (!source.error && !source.partial)

function Usage({ usage, known = true }: { usage: UsageTotals; known?: boolean }) {
  if (!known) return <span className="text-muted-foreground">Unknown</span>
  return <div className="space-y-1">
    <p>{usd(usage.knownCostUsd)} known</p>
    <p className="text-xs">{count(usage.knownInputTokens)} in / {count(usage.knownOutputTokens)} out</p>
    <p className="text-xs text-muted-foreground">Unknown rows: {count(usage.unknownCostRows)} cost, {count(usage.unknownInputTokenRows)} input, {count(usage.unknownOutputTokenRows)} output</p>
    <p className="text-xs text-muted-foreground">{count(usage.incompleteUsageRows)} rows with incomplete attempt accounting</p>
    {usage.catalogCostRows > 0 ? <p className="text-xs text-muted-foreground">{count(usage.catalogCostRows)} rows use catalog estimates</p> : null}
  </div>
}

function Quantiles({ distribution }: { distribution: Distribution }) {
  return <div className="whitespace-nowrap"><p>{duration(distribution.p50)} / {duration(distribution.p95)}</p>
    <p className="mt-1 text-xs text-muted-foreground">{count(distribution.samples)} measured samples</p></div>
}

function Coverage({ report }: { report: DecisionReport }) {
  const sources = [['decisions', 'Decision usage'], ['browserCommands', 'Browser commands'], ['parentUsage', 'Parent model usage'], ['fieldTextUsage', 'Browser field text usage']] as const
  return <div className="space-y-2 rounded-xl border p-4 text-sm" role={report.coverage.partial ? 'status' : undefined}>
    <p className="font-medium">{report.coverage.partial ? 'Partial report — totals may be incomplete' : 'Reporting coverage'}</p>
    <div className="flex flex-wrap gap-x-5 gap-y-2">{sources.map(([key, label]) => {
      const source = report.coverage[key]
      return <p key={key}>{label}: <span className={source.error ? 'text-destructive' : 'text-muted-foreground'}>
        {source.error ? `${source.error === 'timeout' ? 'read timed out' : 'unavailable'}; ${count(source.rows)} rows loaded`
          : `${count(source.rows)} rows loaded${source.truncated ? '; row/time limit reached' : source.partial ? '; incomplete coverage' : ''}`}</span></p>
    })}</div>
    <p className="text-xs text-muted-foreground">Usage rows measure logged provider attempts. Cache hits, deterministic skips, and exits before provider invocation are absent; a cache hit rate or effective suppression rate cannot be inferred.</p>
    {report.coverage.notes.map((note, index) => <p key={index} className="text-xs text-muted-foreground">{note}</p>)}
  </div>
}

export function DecisionReportView({ report }: { report: DecisionReport }) {
  const decisionKnown = available(report.coverage.decisions)
  const browserKnown = available(report.coverage.browserCommands)
  const parentKnown = available(report.coverage.parentUsage)
  const { overview, browser } = report
  const timings: Array<[string, Distribution, string]> = [
    ['Queue pickup', browser.queueMs, 'Command created → claimed by the app'],
    ['Browser setup', browser.setupMs, 'Explicitly recorded setup span only'],
    ['Executor', browser.executorMs, 'Reported browser task execution time'],
    ['Command lifecycle', browser.endToEndMs, 'Command created → finished on the server'],
  ]

  return <div className="space-y-6">
    <Coverage report={report} />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard title="Logged Jev attempts" value={decisionKnown ? count(overview.attempts) : 'Unknown'} subtitle="Provider usage rows in this range" />
      <MetricCard title="Known Jev cost" value={decisionKnown ? usd(overview.usage.knownCostUsd) : 'Unknown'}
        subtitle={decisionKnown ? `${count(overview.usage.unknownCostRows)} rows with unknown cost` : 'Usage source unavailable'} />
      <MetricCard title="Known input tokens" value={decisionKnown ? count(overview.usage.knownInputTokens) : 'Unknown'}
        subtitle={decisionKnown ? `${count(overview.usage.unknownInputTokenRows)} rows with unknown input` : 'Usage source unavailable'} />
      <MetricCard title="Known output tokens" value={decisionKnown ? count(overview.usage.knownOutputTokens) : 'Unknown'}
        subtitle={decisionKnown ? `${count(overview.usage.unknownOutputTokenRows)} rows with unknown output` : 'Usage source unavailable'} />
    </div>
    <Card>
      <CardHeader><CardTitle><h2 className="text-base">Decisions by feature</h2></CardTitle>
        <CardDescription>Policy acceptance means the configured confidence rule passed. It is not a measure of accuracy or completed downstream work.</CardDescription></CardHeader>
      <CardContent>
        {decisionKnown && overview.attempts === 0 ? <p className="mb-4 text-sm text-muted-foreground">No logged Jev attempts in this range.</p> : null}
        <Table aria-label="Decision feature metrics"><TableHeader><TableRow>
          <TableHead scope="col">Feature</TableHead><TableHead scope="col">Attempts</TableHead>
          <TableHead scope="col">Policy accepted / escalated</TableHead><TableHead scope="col">Known usage</TableHead>
          <TableHead scope="col">Provider p50 / p95</TableHead><TableHead scope="col">Service p50 / p95</TableHead>
        </TableRow></TableHeader><TableBody>{report.features.map(feature => <TableRow key={feature.key}>
          <TableHead scope="row" className="font-medium text-foreground">{feature.label}</TableHead>
          <TableCell>{decisionKnown ? count(feature.attempts) : 'Unknown'}</TableCell>
          <TableCell>{decisionKnown ? <><p>{count(feature.policy.accepted)} / {count(feature.policy.escalated)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{count(feature.policy.cancelled)} cancelled · {count(feature.policy.other)} other/unknown</p></> : 'Unknown'}</TableCell>
          <TableCell className="min-w-48"><Usage usage={feature.usage} known={decisionKnown} /></TableCell>
          <TableCell><Quantiles distribution={feature.providerMs} /></TableCell>
          <TableCell><Quantiles distribution={feature.serviceBeforeAccountingMs} /></TableCell>
        </TableRow>)}</TableBody></Table>
        <p className="mt-4 text-xs text-muted-foreground">Service time ends before accounting. Neither service time nor provider time represents the complete user-visible response. Known costs and tokens are subtotals; unknown entries are not treated as free usage.</p>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle><h2 className="text-base">Browser outcomes and speed</h2></CardTitle>
        <CardDescription>Verified completion comes from the browser task result, independent of whether Jev accepted an individual action.</CardDescription></CardHeader>
      <CardContent className="space-y-5">
        {browserKnown && browser.commands === 0 ? <p className="text-sm text-muted-foreground">No browser task commands in this range.</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg bg-muted/40 p-4"><p className="text-sm text-muted-foreground">Verified / all commands</p>
            <p className="mt-1 text-xl font-semibold">{browserKnown ? fraction(browser.verified, browser.commands) : 'Unknown'}</p>
            <p className="mt-2 text-xs text-muted-foreground">{browserKnown ? `${count(browser.escalated)} escalated · ${count(browser.failed)} failed · ${count(browser.cancelled)} cancelled · ${count(browser.pending)} pending · ${count(browser.unknown)} unknown` : 'Browser command source unavailable'}</p></div>
          <div className="rounded-lg bg-muted/40 p-4"><p className="text-sm text-muted-foreground">Commands with matched parent usage</p>
            <p className="mt-1 text-xl font-semibold">{browserKnown && parentKnown ? fraction(browser.commandsWithParentUsage, browser.commands) : 'Unknown'}</p>
            <p className="mt-2 text-xs text-muted-foreground">{browserKnown ? `${count(browser.correlatedCommands)} commands have explicit run correlation; ${count(browser.unattributedCommands)} lack attribution.` : 'Attribution coverage unavailable'}</p></div>
        </div>
        <Table aria-label="Browser task timing"><TableHeader><TableRow>
          <TableHead scope="col">Stage</TableHead><TableHead scope="col">p50</TableHead><TableHead scope="col">p95</TableHead><TableHead scope="col">Measured samples</TableHead>
        </TableRow></TableHeader><TableBody>{timings.map(([label, distribution, explanation]) => <TableRow key={label}>
          <TableHead scope="row" className="font-medium text-foreground"><p>{label}</p><p className="mt-1 text-xs font-normal text-muted-foreground">{explanation}</p></TableHead>
          <TableCell>{duration(distribution.p50)}</TableCell><TableCell>{duration(distribution.p95)}</TableCell><TableCell>{count(distribution.samples)}</TableCell>
        </TableRow>)}</TableBody></Table>
        <p className="text-xs text-muted-foreground">User-submit to final-answer latency is not measured here. Command lifecycle starts after the parent agent has queued a browser task; setup is unknown unless explicitly instrumented.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border p-4"><h3 className="mb-2 text-sm font-medium">Jev usage matched to browser commands</h3><Usage usage={browser.jev} known={decisionKnown && browserKnown} /></div>
          <div className="rounded-lg border p-4"><h3 className="mb-2 text-sm font-medium">Browser field text usage</h3><Usage usage={browser.fieldText} known={available(report.coverage.fieldTextUsage) && browserKnown} /></div>
          <div className="rounded-lg border p-4"><h3 className="mb-2 text-sm font-medium">Matched parent model usage</h3><Usage usage={browser.parent} known={parentKnown && browserKnown} />
            <p className="mt-2 text-xs text-muted-foreground">{count(browser.parentTurns.filter(turn => turn.usageRows > 0).length)} parent turns with matched usage, counted once even when a turn creates multiple browser commands. The parent may do other work in the same turn.</p></div>
        </div>
        <p className="text-xs text-muted-foreground">Only explicit IDs establish attribution; nearby timestamps are not a match. Parent usage outside the date range or not yet recorded is absent. No matched baseline is available, so cost or token savings are unknown.</p>
        {browser.runs.length > 0 ? <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Recent browser commands ({count(browser.runs.length)})</summary>
          <div className="mt-4"><Table aria-label="Recent browser commands"><TableHeader><TableRow>
            <TableHead scope="col">Command / created (UTC)</TableHead><TableHead scope="col">Outcome</TableHead><TableHead scope="col">Queue / executor</TableHead>
            <TableHead scope="col">Command lifecycle</TableHead><TableHead scope="col">Matched Jev usage</TableHead>
          </TableRow></TableHeader><TableBody>{browser.runs.map(run => <TableRow key={run.commandId}>
            <TableHead scope="row" className="font-normal"><code className="text-xs" title={run.commandId}>{run.commandId.slice(0, 12)}</code>
              <p className="mt-1 whitespace-nowrap text-xs">{run.createdAt.slice(0, 19).replace('T', ' ')}</p>
              <p className="mt-1 text-xs">{run.parentRunId ? 'Explicit parent ID' : 'Parent ID unknown'}</p></TableHead>
            <TableCell><Badge variant={run.outcome === 'verified' ? 'default' : 'secondary'}>{run.outcome}</Badge></TableCell>
            <TableCell className="whitespace-nowrap">{duration(run.queueMs)} / {duration(run.executorMs)}</TableCell>
            <TableCell>{duration(run.endToEndMs)}</TableCell><TableCell className="min-w-48"><Usage usage={run.jev} known={decisionKnown} /></TableCell>
          </TableRow>)}</TableBody></Table></div>
          {browser.runsOmitted ? <p className="mt-3 text-xs text-muted-foreground">{count(browser.runsOmitted)} additional commands omitted from this list; aggregates cover all loaded rows.</p> : null}
        </details> : null}
      </CardContent>
    </Card>
  </div>
}
