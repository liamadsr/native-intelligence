import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { NudgeWorthReadout } from '@/lib/ai/decisions/reporting/nudge-worth'
import { count, fraction } from './format'

/**
 * The shadow nudge.worth readout (reporting/nudge-worth.ts provenFromThumbs):
 * Jev's answers on delivered live nudges against the person's thumbs, per
 * version, over the last 30 days. Nothing enforces it.
 */
export function NudgeWorthPanel({ readout }: { readout: NudgeWorthReadout }) {
  const pct = Math.round(readout.bar.minAgreement * 100)
  return (
    <Card>
      <CardHeader>
        <CardTitle><h2 className="text-base">Live nudges: worth interrupting for?</h2></CardTitle>
        <CardDescription>
          Jev&apos;s shadow nudge.worth answers against the person&apos;s thumbs on the same nudges, last {readout.windowDays} days.
          Shadow only: no nudge is held. A thumbs-down marked &ldquo;Too late&rdquo; is a timing problem and is left out of agreement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {readout.partial ? <p role="status" className="text-sm text-destructive">A read hit its bound or failed: these counts are partial.</p> : null}
        {!readout.versions.length ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No nudge.worth answers in this window.</p>
        ) : (
          <Table aria-label="Nudge worth readout">
            <TableHeader><TableRow>
              <TableHead scope="col">Version</TableHead>
              <TableHead scope="col">Answers (send / hold / unsure / failed)</TableHead>
              <TableHead scope="col">Rated (👍 / 👎)</TableHead>
              <TableHead scope="col">Too late</TableHead>
              <TableHead scope="col">Agreement</TableHead>
              <TableHead scope="col">False suppressions</TableHead>
              <TableHead scope="col">False sends</TableHead>
              <TableHead scope="col">Proof bar ({readout.bar.minCases} at {pct}%)</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {readout.versions.map((v) => (
                <TableRow key={v.version}>
                  <TableCell className="font-mono text-xs">{v.version}</TableCell>
                  <TableCell>{count(v.answers)} ({count(v.send)} / {count(v.hold)} / {count(v.unsure)} / {count(v.failed)})</TableCell>
                  <TableCell>{count(v.thumbed)} ({count(v.thumbsUp)} / {count(v.thumbsDown)})</TableCell>
                  <TableCell>{count(v.tooLate)}</TableCell>
                  <TableCell>{fraction(v.agreed, v.scored)}</TableCell>
                  <TableCell>{count(v.falseSuppressions)}</TableCell>
                  <TableCell>{count(v.falseSends)}</TableCell>
                  <TableCell>{v.meetsBar ? 'Would meet it' : 'Not yet'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">
          Agreement counts trusted answers on rated nudges: send on 👍, hold on 👎 (Not useful, Repeated, Wrong, or no reason).
          A false suppression is a hold on a 👍 nudge. The proof bar is the router&apos;s, shown for reference only.
        </p>
      </CardContent>
    </Card>
  )
}
