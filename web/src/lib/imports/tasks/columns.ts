/**
 * Tasks from a CSV (docs/plans/imports.md, phase 1): which field each column
 * is, and how a cell reads as that field.
 *
 * The first guess comes from the header; the person can change any column in
 * the mapping step. A cell that does not read as its field (a word in a date
 * column) reads as nothing and is counted in the preview, never a refusal of
 * the whole file.
 *
 * Pure and client-safe: the mapping step runs the same guesses in the browser.
 */
import { headerKey } from '@/lib/crm/import/sources/spreadsheet'

/** What a column of a task CSV can be. */
export const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'assignee', 'due_date', 'project', 'labels', 'skip'] as const
export type TaskField = (typeof TASK_FIELDS)[number]

export function isTaskField(value: unknown): value is TaskField {
  return typeof value === 'string' && (TASK_FIELDS as readonly string[]).includes(value)
}

/** Header words (after headerKey) for each field, most certain first. */
const HEADER_WORDS: Record<Exclude<TaskField, 'skip'>, readonly string[]> = {
  title: ['title', 'name', 'taskname', 'task', 'summary', 'issue', 'issuetitle', 'subject', 'todo'],
  description: ['description', 'details', 'body', 'notes', 'note', 'content', 'text'],
  status: ['status', 'state', 'stage', 'column', 'workflowstate', 'progress'],
  priority: ['priority', 'importance', 'urgency', 'severity'],
  assignee: ['assignee', 'assignedto', 'assigned', 'owner', 'responsible', 'assigneeemail', 'person'],
  due_date: ['duedate', 'due', 'dueon', 'deadline', 'dueat', 'targetdate', 'enddate'],
  project: ['project', 'projectname', 'epic', 'list', 'board'],
  labels: ['labels', 'label', 'tags', 'tag', 'categories', 'category', 'type'],
}

/** The field a header plainly is, or null. */
export function fieldForHeader(header: string): Exclude<TaskField, 'skip'> | null {
  const key = headerKey(header)
  if (!key) return null
  for (const [field, words] of Object.entries(HEADER_WORDS) as [Exclude<TaskField, 'skip'>, readonly string[]][]) {
    if (words.includes(key)) return field
  }
  return null
}

/**
 * The first guess for every column: each field taken by the first column
 * whose header names it; the rest skipped. With no title column, the first
 * text column that isn't anything else is the title.
 */
export function guessMapping(headers: readonly string[]): TaskField[] {
  const taken = new Set<TaskField>()
  const out: TaskField[] = headers.map((h) => {
    const field = fieldForHeader(h)
    if (!field || taken.has(field)) return 'skip'
    taken.add(field)
    return field
  })
  if (!taken.has('title')) {
    const free = out.findIndex((f, i) => f === 'skip' && headers[i]?.trim())
    if (free >= 0) out[free] = 'title'
  }
  return out
}

/** A mapping the person sent: one known field per column, at most one title. */
export function checkMapping(mapping: readonly unknown[], columnCount: number): { ok: true; mapping: TaskField[] } | { ok: false; error: string } {
  if (mapping.length !== columnCount) return { ok: false, error: `The mapping names ${mapping.length} columns; the file has ${columnCount}.` }
  const out: TaskField[] = []
  const seen = new Set<TaskField>()
  for (const m of mapping) {
    if (!isTaskField(m)) return { ok: false, error: `Unknown field "${String(m).slice(0, 40)}".` }
    if (m !== 'skip' && m !== 'labels' && seen.has(m)) return { ok: false, error: `Only one column can be the ${m.replace('_', ' ')}.` }
    seen.add(m)
    out.push(m)
  }
  if (!seen.has('title')) return { ok: false, error: 'Choose the column that holds each task’s title.' }
  return { ok: true, mapping: out }
}

// ── Cells ────────────────────────────────────────────────────────────────────

export type WorkflowCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

const CATEGORY_WORDS: Record<WorkflowCategory, readonly string[]> = {
  backlog: ['backlog', 'icebox', 'someday', 'later', 'triage'],
  unstarted: ['todo', 'to do', 'open', 'new', 'not started', 'planned', 'ready', 'unstarted', 'pending'],
  started: ['in progress', 'doing', 'started', 'active', 'in review', 'review', 'wip', 'working', 'blocked', 'testing', 'qa'],
  completed: ['done', 'complete', 'completed', 'closed', 'finished', 'resolved', 'shipped', 'merged'],
  canceled: ['canceled', 'cancelled', "won't do", 'wont do', 'wontfix', "won't fix", 'duplicate', 'abandoned', 'rejected', 'declined'],
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The kind of state a status word plainly is, or null. */
export function categoryForStatus(value: string): WorkflowCategory | null {
  const s = squash(value)
  if (!s) return null
  for (const [cat, words] of Object.entries(CATEGORY_WORDS) as [WorkflowCategory, readonly string[]][]) {
    if (words.includes(s)) return cat
  }
  return null
}

/** A priority cell: a word, or Linear's numbers (0 none, 1 urgent … 4 low), or P0–P4. */
export function parsePriority(value: string): TaskPriority | null {
  const s = squash(value)
  if (!s) return null
  const words: Record<string, TaskPriority> = {
    none: 'none', 'no priority': 'none',
    low: 'low', minor: 'low', trivial: 'low',
    medium: 'medium', normal: 'medium', med: 'medium', moderate: 'medium',
    high: 'high', major: 'high', important: 'high',
    urgent: 'urgent', critical: 'urgent', highest: 'urgent', blocker: 'urgent',
    lowest: 'low',
  }
  if (words[s]) return words[s]
  const n = /^p?([0-4])$/.exec(s)
  if (n) {
    // Linear's 0–4 (0 none) and P0–P4 (P0 most urgent) read differently.
    if (s.startsWith('p')) return (['urgent', 'high', 'medium', 'low', 'low'] as const)[Number(n[1])]
    return (['none', 'urgent', 'high', 'medium', 'low'] as const)[Number(n[1])]
  }
  return null
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A date cell, as YYYY-MM-DD, or null. Reads ISO (with or without a time),
 * MM/DD/YYYY (US, the commoner export), DD.MM.YYYY, "Nov 23, 2026",
 * "23 Nov 2026", and Excel's serial days.
 */
export function parseDueDate(value: string): string | null {
  const s = value.trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+[\d:]+\s*(?:am|pm)?)?$/i.exec(s)
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    // US first; when the first part can't be a month, it's the day.
    return +m[1] > 12 ? iso(y, +m[2], +m[1]) : iso(y, +m[1], +m[2])
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s)
  if (m) return iso(+m[3], +m[2], +m[1])
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s)
  if (m && MONTHS.includes(m[1].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2])
  m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i.exec(s)
  if (m && MONTHS.includes(m[2].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1])
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    // Excel serial: day 25569 is 1970-01-01.
    const days = Math.floor(Number(s))
    if (days > 20000 && days < 120000) {
      const dt = new Date((days - 25569) * 86_400_000)
      return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
    }
  }
  return null
}

/** The most labels one task takes from its cell. */
export const MAX_LABELS_PER_TASK = 10
/** The longest label name kept. */
export const MAX_LABEL_NAME = 60

/** A labels cell: split on , ; | (and newlines), trimmed, deduped (case-blind), capped. */
export function splitLabels(value: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of value.split(/[,;|\n]/)) {
    const name = part.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_NAME)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
    if (out.length >= MAX_LABELS_PER_TASK) break
  }
  return out
}
