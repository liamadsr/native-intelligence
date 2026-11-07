'use client'

/**
 * Two-way toggle between the two AI-usage reporting sources:
 *   - 'gateway' — the Vercel AI Gateway /v1/report (Phase B source of truth)
 *   - 'logs'    — the legacy ai_usage_logs table view
 *
 * It's a client component so it can read the CURRENT range params
 * (preset/from/to) off the URL and carry them across the switch — flipping the
 * source must never reset the range the admin picked. Rendered as button-styled
 * <Link>s (not JS nav) so each side is a real, shareable URL.
 */

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import { cn } from '@/lib/utils'

type Source = 'gateway' | 'logs'

const OPTIONS: { id: Source; label: string }[] = [
  { id: 'gateway', label: 'Gateway' },
  { id: 'logs', label: 'Logs' },
]

export function AiUsageSourceToggle({ source }: { source: Source }) {
  const searchParams = useSearchParams()

  function hrefFor(next: Source): string {
    const params = new URLSearchParams(searchParams.toString())
    params.set('source', next)
    return `?${params.toString()}`
  }

  return (
    <div className="inline-flex items-center rounded-md border bg-muted/40 p-0.5">
      {OPTIONS.map((opt) => {
        const active = opt.id === source
        return (
          <Link
            key={opt.id}
            href={hrefFor(opt.id)}
            scroll={false}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'rounded px-3 py-1 text-sm font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </Link>
        )
      })}
    </div>
  )
}
