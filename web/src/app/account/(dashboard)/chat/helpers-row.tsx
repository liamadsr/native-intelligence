'use client'

/**
 * The row a `helpers` call draws in a reply (A4 slice 3, quick helpers): one
 * line, "3 helpers working · 1/3 done", then each task's label with its
 * state. While the call runs it reads the tool's preliminary output (the
 * workflow body's `yield`, projected by the eve transport from
 * `action.partial`); before the first snapshot it reads the labels off the
 * call's input; once done it reads the results. A refusal or an error falls
 * through to the generic chip (helpersRowModel returns null). A task that
 * runs on the strong model (auto model selection) carries a muted "Strong
 * helper" label; no model is ever named.
 */
import { Check, Clock, Loader2, X } from 'lucide-react'
import type { ToolPart } from './tool-renderers'
import { cn } from '@/lib/utils'

export type HelperRowStatus = 'working' | 'done' | 'failed' | 'timed_out'

export interface HelpersRowModel {
  running: boolean
  headline: string
  tasks: Array<{ label: string; status: HelperRowStatus; strong?: true }>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function labelsFromInput(input: unknown): string[] {
  const tasks = isRecord(input) && Array.isArray(input.tasks) ? input.tasks : []
  return tasks.map((t, i) => (isRecord(t) && typeof t.label === 'string' && t.label.trim() ? t.label.trim() : `Task ${i + 1}`))
}

const STATUSES: ReadonlySet<string> = new Set(['working', 'done', 'failed', 'timed_out'])

function rowsFrom(list: unknown): Array<{ label: string; status: HelperRowStatus; strong?: true }> | null {
  if (!Array.isArray(list)) return null
  const rows = list
    .filter(isRecord)
    .map((r, i) => ({
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : `Task ${i + 1}`,
      status: (typeof r.status === 'string' && STATUSES.has(r.status) ? r.status : 'working') as HelperRowStatus,
      ...(r.strong === true ? { strong: true as const } : {}),
    }))
  return rows.length > 0 ? rows : null
}

function helpersWord(n: number): string {
  return n === 1 ? '1 helper' : `${n} helpers`
}

/** The row's content from the part, or null to let the generic chip draw it. */
export function helpersRowModel(part: ToolPart): HelpersRowModel | null {
  if (part.state === 'output-error') return null
  const preliminary = part.state === 'output-available' && (part as { preliminary?: boolean }).preliminary === true
  if (part.state === 'output-available' && !preliminary) {
    const out = part.output
    if (!isRecord(out) || typeof out.refused === 'string') return null
    const tasks = rowsFrom(out.results)
    if (!tasks) return null
    const done = tasks.filter((t) => t.status === 'done').length
    const missed = tasks.length - done
    const headline =
      missed === 0
        ? `${helpersWord(tasks.length)} done`
        : `${helpersWord(tasks.length)} finished · ${done}/${tasks.length} done`
    return { running: false, headline, tasks }
  }
  // Running: the latest snapshot, else the labels the call was given.
  const snapshot = preliminary && isRecord(part.output) ? rowsFrom(part.output.tasks) : null
  const tasks = snapshot ?? labelsFromInput(part.input).map((label) => ({ label, status: 'working' as const }))
  if (tasks.length === 0) return null
  const settled = tasks.filter((t) => t.status !== 'working').length
  return { running: true, headline: `${helpersWord(tasks.length)} working · ${settled}/${tasks.length} done`, tasks }
}

const STATUS_TEXT: Record<HelperRowStatus, string> = {
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
  timed_out: 'Ran out of time',
}

function StatusIcon({ status }: { status: HelperRowStatus }) {
  const cls = 'h-3.5 w-3.5 shrink-0'
  if (status === 'working') return <Loader2 className={cn(cls, 'animate-spin text-muted-foreground')} aria-hidden />
  if (status === 'done') return <Check className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} aria-hidden />
  if (status === 'timed_out') return <Clock className={cn(cls, 'text-muted-foreground')} aria-hidden />
  return <X className={cn(cls, 'text-red-600 dark:text-red-400')} aria-hidden />
}

export function HelpersRow({ model }: { model: HelpersRowModel }) {
  return (
    <div
      data-testid="helpers-row"
      data-running={model.running ? '' : undefined}
      className="my-1 flex max-w-full flex-col gap-1 self-start rounded-2xl border border-border/60 bg-background/60 px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {model.running && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />}
        <span>{model.headline}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {model.tasks.map((task, i) => (
          <li key={`${i}-${task.label}`} className="flex min-w-0 items-center gap-1.5" data-status={task.status}>
            <StatusIcon status={task.status} />
            <span className="min-w-0 truncate" title={task.label}>
              {task.label}
            </span>
            {task.strong && <span className="shrink-0 text-xs text-muted-foreground">Strong helper</span>}
            <span className="sr-only">{STATUS_TEXT[task.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
