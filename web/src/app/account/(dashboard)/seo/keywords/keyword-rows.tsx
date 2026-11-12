'use client'

/**
 * The Keywords page's rows, shared by Research and Saved: CSS-grid rows of
 * numbers (../audit-pages.tsx's look) with a quiet header, a checkbox that
 * shows on hover or while anything is selected (the views list rows'
 * treatment), the difficulty as a chip coloured by band, the intent as a
 * neutral chip, and the 12-month trend as a Sparkline.
 *
 * On a narrow card the least important columns drop, by container query,
 * in this order: the trend, the cost per click, the intent. Never a
 * sideways scroll.
 *
 * And the selection island: what the selected rows can do, floating over the
 * bottom of the page in the views layout's island look
 * (bulk-actions/bulk-action-bar.tsx).
 */
import * as React from 'react'
import { X } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { SELECTION_ISLAND_CLASS } from '@/components/views/bulk-actions/bulk-action-bar'
import type { KeywordIntent, KeywordTrendPoint } from '@/lib/seo/keywords/view'
import { cn } from '@/lib/utils'
import { Sparkline } from '../shared/trend-chart'
import {
  DIFFICULTY_CHIP,
  DIFFICULTY_WORD,
  INTENT_HINT,
  INTENT_LABEL,
  difficultyBand,
  formatCpc,
  formatVolume,
  trendOf,
} from './keyword-helpers'

/** Every column: checkbox, keyword, searches, difficulty; intent from @lg, cost per click from @xl, trend from @2xl. */
const GRID_FULL =
  'grid grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_3.25rem] @lg:grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_3.25rem_6.5rem] @xl:grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_3.25rem_6.5rem_3.75rem] @2xl:grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_3.25rem_6.5rem_3.75rem_4rem]'
/** A country served by Google Ads data: no difficulty, no intent, so cost per click from @md and the trend from @lg. */
const GRID_ADS =
  'grid grid-cols-[1.25rem_minmax(0,1fr)_4.5rem] @md:grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_3.75rem] @lg:grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_3.75rem_4rem]'

export const gridFor = (full: boolean) => (full ? GRID_FULL : GRID_ADS)
/** When the cost per click and the trend show, matching the grid. */
const SHOW_CPC = { full: '@xl:flex', ads: '@md:flex' }
const SHOW_TREND = { full: '@2xl:flex', ads: '@lg:flex' }
const SHOW_CPC_LABEL = { full: '@xl:block', ads: '@md:block' }
const SHOW_TREND_LABEL = { full: '@2xl:block', ads: '@lg:block' }
const kind = (full: boolean) => (full ? 'full' : 'ads')

const NUM = 'text-right text-xs tabular-nums text-muted-foreground'
/** A cell's first line: as tall as the keyword's, its content centred on it. */
const CELL = 'flex h-5 items-center'

export interface KeywordRowData {
  keyword: string
  search_volume: number | null
  cpc: number | null
  keyword_difficulty: number | null
  intent: KeywordIntent | null
  trend: readonly KeywordTrendPoint[]
}

/** The quiet column labels, each with what it means in plain words. */
export function KeywordGridHeader({
  full,
  allChecked,
  someChecked,
  onToggleAll,
}: {
  full: boolean
  allChecked: boolean
  someChecked: boolean
  onToggleAll: () => void
}) {
  return (
    <div className={cn(gridFor(full), 'items-center gap-2 px-1 pb-1 text-[11px] text-muted-foreground')}>
      <span className={cn('flex items-center', someChecked ? 'opacity-100' : 'opacity-60 hover:opacity-100')}>
        <Checkbox
          data-kw-check-all=""
          checked={allChecked ? true : someChecked ? 'indeterminate' : false}
          onCheckedChange={onToggleAll}
          aria-label={allChecked ? 'Clear the selection' : 'Select every keyword shown'}
          className="h-3.5 w-3.5 cursor-pointer"
        />
      </span>
      <span>Keyword</span>
      <span className="text-right" title="Average searches a month over the last year (an estimate)">
        Searches
      </span>
      {full && (
        <span className="text-right" title="How hard it is to reach the first page of Google, from 0 (easy) to 100 (hard)">
          Difficulty
        </span>
      )}
      {full && (
        <span className="hidden @lg:block" title="Why people search it">
          Intent
        </span>
      )}
      <span className={cn('hidden text-right', SHOW_CPC_LABEL[kind(full)])} title="Cost per click: what advertisers pay for one click on an ad for this search">
        CPC
      </span>
      <span className={cn('hidden text-right', SHOW_TREND_LABEL[kind(full)])} title="Searches a month over the last year">
        Trend
      </span>
    </div>
  )
}

export function DifficultyChip({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <span className={NUM} title="No difficulty for this keyword">
        —
      </span>
    )
  }
  const band = difficultyBand(score)
  return (
    <span
      data-kw-difficulty={band}
      title={`${DIFFICULTY_WORD[band]} · ${Math.round(score)} of 100`}
      className={cn('inline-flex min-w-8 items-center justify-center rounded-full border px-1.5 py-px text-[10px] leading-4 font-medium tabular-nums', DIFFICULTY_CHIP[band])}
    >
      {Math.round(score)}
    </span>
  )
}

export function IntentChip({ intent }: { intent: KeywordIntent | null }) {
  const label = intent ? INTENT_LABEL[intent] : null
  if (!intent || !label) return null
  return (
    <span
      data-kw-intent={intent}
      title={INTENT_HINT[intent]}
      className="inline-flex items-center rounded-full border border-border px-2 py-px text-[10px] leading-4 whitespace-nowrap text-muted-foreground"
    >
      {label}
    </span>
  )
}

/** One keyword: the checkbox, the keyword (and what goes under it), then its numbers. */
export function KeywordGridRow({
  row,
  rowId,
  full,
  checked,
  selecting,
  onToggle,
  sub,
  numbersTitle,
  missingTitle = 'No number for this keyword: too few searches to measure',
  action,
}: {
  row: KeywordRowData
  rowId: string
  full: boolean
  checked: boolean
  /** Anything is selected: every checkbox shows. */
  selecting: boolean
  onToggle: () => void
  /** A second line under the keyword (tags, market). */
  sub?: React.ReactNode
  /** Where the numbers come from ("Numbers from 3 days ago"). */
  numbersTitle?: string
  missingTitle?: string
  /** A quiet button shown on hover beside the keyword. */
  action?: React.ReactNode
}) {
  const trend = trendOf(row.trend)
  return (
    <li
      data-kw-row={rowId}
      data-checked={checked ? '' : undefined}
      className={cn(gridFor(full), 'group items-start gap-2 rounded-md px-1 py-1 transition-colors', checked ? 'bg-muted/60' : 'hover:bg-muted/40')}
    >
      <span className={cn('flex h-5 items-center', selecting || checked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}>
        <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={`Select ${row.keyword}`} className="h-3.5 w-3.5 cursor-pointer" />
      </span>
      <span className="min-w-0">
        <span className={cn(CELL, 'min-w-0 gap-2')}>
          <span className="min-w-0 truncate text-sm text-foreground" title={row.keyword}>
            {row.keyword}
          </span>
          {action && <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{action}</span>}
        </span>
        {sub}
      </span>
      <span className={cn(CELL, NUM, 'justify-end')} title={row.search_volume === null ? missingTitle : numbersTitle}>
        {formatVolume(row.search_volume)}
      </span>
      {full && (
        <span className={cn(CELL, 'justify-end')}>
          <DifficultyChip score={row.keyword_difficulty} />
        </span>
      )}
      {full && (
        <span className={cn(CELL, 'hidden @lg:flex')}>
          <IntentChip intent={row.intent} />
        </span>
      )}
      <span className={cn(CELL, NUM, 'hidden justify-end', SHOW_CPC[kind(full)])} title={row.cpc === null ? 'No cost per click for this keyword' : numbersTitle}>
        {formatCpc(row.cpc)}
      </span>
      <span className={cn('hidden h-5 items-center justify-end', SHOW_TREND[kind(full)])}>
        {trend && <Sparkline values={trend.values} label={trend.summary} className="h-4 w-14" />}
      </span>
    </li>
  )
}

/** "Show more", in the Site audit's look. */
export function ShowMore({ loading, onClick, attr }: { loading: boolean; onClick: () => void; attr: string }) {
  return (
    <div className="flex justify-center pt-3">
      <button
        type="button"
        {...{ [attr]: '' }}
        disabled={loading}
        onClick={onClick}
        className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Show more'}
      </button>
    </div>
  )
}

/** The selection island: the count with its clear ×, Select all, then the page's verbs. */
export function SelectionIsland({
  count,
  total,
  onClear,
  onSelectAll,
  children,
}: {
  count: number
  /** Rows on show; Select all is offered while some are still unchecked. */
  total: number
  onClear: () => void
  onSelectAll: () => void
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div data-kw-island="" className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3">
      <div role="toolbar" aria-label="Selection" className={cn(SELECTION_ISLAND_CLASS, 'pointer-events-auto animate-island-in')}>
        <div className="inline-flex h-7 shrink-0 items-center rounded-full bg-foreground pl-3 pr-1 text-xs font-medium text-background">
          <span className="tabular-nums">{count.toLocaleString()} selected</span>
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection"
            className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-background/70 transition-colors hover:bg-background/20 hover:text-background"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {total > count && (
          <button
            type="button"
            onClick={onSelectAll}
            className="inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Select all
          </button>
        )}
        {children}
      </div>
    </div>
  )
}

/** A pill button in the island (prospecting/list-detail.tsx's selection verbs). */
export const ISLAND_BUTTON = 'h-7 shrink-0 gap-1.5 rounded-full text-xs'
