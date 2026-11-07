'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { parseEvaluationReport, summarizeEvaluationReport, type DecisionEvaluationReport } from '@/lib/ai/decisions/evaluation-report'
import { count, decisionLabel, duration, fraction, usd } from './format'

export function DecisionQualityPanel() {
  const [report, setReport] = useState<DecisionEvaluationReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const selection = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const summaries = report ? summarizeEvaluationReport(report) : []

  async function readReport(file: File | undefined) {
    const current = ++selection.current
    setError(null); setReport(null)
    if (!file) { setLoading(false); return }
    if (file.size > 2 * 1024 * 1024) { setError('Choose an evaluation JSON file smaller than 2 MB.'); setLoading(false); return }
    setLoading(true)
    try {
      const parsed = parseEvaluationReport(await file.text())
      if (current === selection.current) setReport(parsed)
    } catch {
      if (current === selection.current) setError('This file is not a valid Jev evaluation report. Export a report from the evaluation harness and try again.')
    } finally {
      if (current === selection.current) setLoading(false)
    }
  }

  function clearReport() {
    selection.current++
    setReport(null); setError(null); setLoading(false)
    if (input.current) input.current.value = ''
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><h2 className="text-base">Synthetic evaluation</h2></CardTitle>
        <CardDescription>Labeled examples measure the supplied test cases. They do not establish production accuracy.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="decision-evaluation-file">Open an evaluation report</Label>
            <Input ref={input} id="decision-evaluation-file" type="file" accept="application/json,.json"
              aria-describedby="decision-evaluation-help" onChange={event => { void readReport(event.currentTarget.files?.[0]) }} />
          </div>
          {report || error || loading ? <Button type="button" variant="outline" onClick={clearReport}>Clear report</Button> : null}
        </div>
        <p id="decision-evaluation-help" className="text-xs text-muted-foreground">Processed only in this browser. The file is not uploaded or saved to the application. Production date and workspace filters do not filter these examples.</p>
        {loading ? <p role="status" className="text-sm">Validating evaluation report…</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {!report && !loading ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No evaluation report loaded. Production decision accuracy is unknown; provider acceptance alone does not measure correctness.</p> : null}
        {report ? <>
          <dl className="grid gap-3 rounded-lg bg-muted/40 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-muted-foreground">Dataset</dt><dd className="break-words font-medium">{report.dataset}</dd></div>
            <div><dt className="text-muted-foreground">Model</dt><dd className="break-words font-medium">{report.model}</dd></div>
            <div><dt className="text-muted-foreground">Recorded (UTC)</dt><dd>{new Date(report.createdAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}</dd></div>
            <div><dt className="text-muted-foreground">Provenance</dt><dd>Synthetic · schema {report.schemaVersion}</dd></div>
            <div><dt className="text-muted-foreground">Base revision</dt><dd className="break-all font-mono text-xs">{report.gitCommit ?? 'Unknown'}</dd></div>
            <div><dt className="text-muted-foreground">Choice order</dt><dd>{report.reverseChoices ? 'Reversed' : 'Normal'}</dd></div>
          </dl>
          <p className="text-xs text-muted-foreground">Uncommitted source changes are not captured in the base revision. The revision alone is insufficient to reproduce this evaluation.</p>
          <p className="text-sm">{count(report.cases.length)} of {count(report.plannedCases)} planned examples recorded.
            {report.cases.length < report.plannedCases ? ' This is an incomplete evaluation; omitted examples have no result.' : ''}</p>
          {!report.cases.length ? <p className="text-sm text-muted-foreground">There are no completed examples to assess.</p> : null}
          <Table aria-label="Synthetic evaluation results">
            <TableHeader><TableRow>
              <TableHead scope="col">Decision</TableHead><TableHead scope="col">Examples</TableHead>
              <TableHead scope="col">Accepted: correct / incorrect</TableHead><TableHead scope="col">False suppressions</TableHead>
              <TableHead scope="col">Escalations / errors</TableHead><TableHead scope="col">Over deadline</TableHead>
              <TableHead scope="col">Provider p50 / p95</TableHead><TableHead scope="col">Known usage</TableHead>
            </TableRow></TableHeader>
            <TableBody>{summaries.map(row => <TableRow key={row.kind}>
              <TableHead scope="row" className="max-w-52 break-words font-medium text-foreground">{decisionLabel(row.kind)}
                <p className="mt-1 text-xs font-normal text-muted-foreground">{[...new Set(report.cases.filter(item => item.kind === row.kind).map(item => item.taskVersion))].join(' · ')}</p></TableHead>
              <TableCell>{count(row.total)}</TableCell>
              <TableCell>{count(row.acceptedCorrect)} / {count(row.acceptedIncorrect)}</TableCell>
              <TableCell className={row.falseSuppressions ? 'font-semibold text-destructive' : undefined}>{count(row.falseSuppressions)}</TableCell>
              <TableCell><p>{fraction(row.escalated, row.total)} escalated</p><p className="mt-1 text-xs text-muted-foreground">{count(row.errors)} errors</p></TableCell>
              <TableCell>{fraction(row.overDeadline, row.total)}</TableCell>
              <TableCell className="whitespace-nowrap">{duration(row.p50ProviderMs)} / {duration(row.p95ProviderMs)}</TableCell>
              <TableCell className="min-w-44"><p>{usd(row.knownCostUsd)} · {count(row.inputTokens)} in / {count(row.outputTokens)} out</p>
                <p className="mt-1 text-xs text-muted-foreground">{count(row.unknownCostCases)} cost unknown · {count(row.unknownTokenCases)} tokens unknown</p></TableCell>
            </TableRow>)}</TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">Timings cover the provider roundtrip, not a browser task or user-visible response. Known usage is a subtotal; missing usage is not zero. No matched baseline is included, so this report does not establish token or cost savings.</p>
        </> : null}
      </CardContent>
    </Card>
  )
}
