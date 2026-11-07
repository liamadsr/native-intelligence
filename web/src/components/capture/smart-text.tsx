'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  deriveEntityChips,
  type EntityChip,
} from '@/lib/proposed-changes/derive-ui'
import type { ProposedChange } from '@/lib/proposed-changes/types'

/**
 * Renders display_text with entity chips (names, dates) highlighted inline.
 * Scans the text for known values from the proposed change fields and wraps
 * matches with interactive chip components.
 */
export function SmartText({ change }: { change: ProposedChange }) {
  const chips = useMemo(() => deriveEntityChips(change), [change])

  const segments = useMemo(() => {
    if (chips.length === 0) return [{ type: 'text' as const, value: change.display_text }]
    return splitTextWithChips(change.display_text, chips)
  }, [change.display_text, chips])

  return (
    <span className="leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <span key={i}>{seg.value}</span>
        }
        return <ChipRenderer key={i} chip={seg.chip} />
      })}
    </span>
  )
}

// ─── Chip rendering ──────────────────────────────────────────

function ChipRenderer({ chip }: { chip: EntityChip }) {
  switch (chip.type) {
    case 'member':
      return (
        <span className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-blue-400">
          <span className="text-xs font-medium">{chip.label}</span>
        </span>
      )
    case 'contact':
      return (
        <span className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-purple-500/10 px-1.5 py-0.5 text-purple-400">
          <span className="text-xs font-medium">{chip.label}</span>
        </span>
      )
    case 'person_text':
      return (
        <span className="mx-0.5 inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">
          {chip.label}
        </span>
      )
    case 'date':
      // Its own provider: a suggestion card renders anywhere (a document card,
      // the chat), and no ancestor is promised to hold one. A Tooltip without
      // one throws, and the dashboard's error boundary blanks the app.
      return (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mx-0.5 inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-400">
                {chip.label}
              </span>
            </TooltipTrigger>
            <TooltipContent>{chip.value}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    default:
      return <Badge variant="secondary" className="mx-0.5">{chip.label}</Badge>
  }
}

// ─── Text splitting ──────────────────────────────────────────

type Segment =
  | { type: 'text'; value: string }
  | { type: 'chip'; chip: EntityChip }

/**
 * Splits display_text into segments of plain text and chip matches.
 * Uses case-insensitive matching to find chip labels in the text.
 */
function splitTextWithChips(text: string, chips: EntityChip[]): Segment[] {
  if (chips.length === 0) return [{ type: 'text', value: text }]

  // Build a list of match positions
  const matches: { start: number; end: number; chip: EntityChip }[] = []

  for (const chip of chips) {
    const searchText = chip.type === 'date' ? chip.label : chip.label
    const idx = text.toLowerCase().indexOf(searchText.toLowerCase())
    if (idx !== -1) {
      matches.push({ start: idx, end: idx + searchText.length, chip })
    }
  }

  // Sort by position, remove overlaps
  matches.sort((a, b) => a.start - b.start)
  const filtered: typeof matches = []
  for (const m of matches) {
    const last = filtered[filtered.length - 1]
    if (!last || m.start >= last.end) {
      filtered.push(m)
    }
  }

  if (filtered.length === 0) return [{ type: 'text', value: text }]

  // Build segments
  const segments: Segment[] = []
  let cursor = 0

  for (const m of filtered) {
    if (m.start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, m.start) })
    }
    segments.push({ type: 'chip', chip: m.chip })
    cursor = m.end
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }

  return segments
}
