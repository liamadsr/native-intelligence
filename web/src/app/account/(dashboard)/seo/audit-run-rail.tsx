'use client'

/**
 * The audit's run rail: one line while an audit is live, on the index above
 * the list and on the audit itself (prospecting/run-rail.tsx's look).
 *
 *   ◉ Checking pages · 42 of about 100 · example.com                [Stop]
 *
 * Stop asks the server to stop it; what it found stays (the toast says so).
 */
import { Loader2 } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import type { SiteAuditView } from '@/lib/seo/audit/view'
import { auditRailLine } from './ui-helpers'

export function AuditRunRail({
  audit,
  stopping = false,
  onStop,
}: {
  audit: SiteAuditView
  stopping?: boolean
  onStop?: () => void
}) {
  const { verb, clauses } = auditRailLine(audit)
  return (
    <div data-seo-run-rail={audit.id} className="mx-5 mb-2 flex items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
      <ThinkingOrb state="searching" size={20} theme="auto" className="-my-1 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{verb}</span>
        {clauses.map((clause, index) => (
          <span key={index}>
            <span aria-hidden className="text-muted-foreground/40">
              {' · '}
            </span>
            <span className="tabular-nums">{clause}</span>
          </span>
        ))}
      </p>
      {onStop && (
        <Button
          variant="ghost"
          size="sm"
          data-seo-stop=""
          className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {stopping ? 'Stopping…' : 'Stop'}
        </Button>
      )}
    </div>
  )
}
