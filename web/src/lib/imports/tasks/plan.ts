/**
 * Tasks from a CSV (docs/plans/imports.md, phase 1): a sheet and its mapping
 * become an import plan, matched against the workspace the person can see.
 *
 *   labels     matched by name (case-blind); missing ones are made, once each.
 *   projects   matched by name; missing ones are made. A project column wins
 *              over the one chosen for every row.
 *   statuses   a state of the chosen team by name, then by kind ("done" → a
 *              completed state), else the team's default state (counted).
 *   assignees  a member by email, then by name; else unassigned (listed).
 *   rows       with no title are skipped (counted).
 *
 * Pure: the context is read by the caller, on the person's own client.
 */
import { categoryForStatus, parseDueDate, parsePriority, splitLabels, type TaskField, type WorkflowCategory } from './columns'
import { countOf, type ActionRecord, type ImportPlan, type PlanNote, type PlannedItem, type Ref } from '../types'

export interface StateOption {
  id: string
  name: string
  category: WorkflowCategory
  is_default?: boolean
  sort_order?: number
}

export interface MemberOption {
  id: string
  name: string | null
  email: string | null
}

export interface NamedOption {
  id: string
  name: string
}

/** What a plan is matched against: the destination team's states and the workspace's members, labels and projects. */
export interface MatchContext {
  teamId: string
  states: StateOption[]
  members: MemberOption[]
  labels: NamedOption[]
  projects: NamedOption[]
}

/** The most rows one task import takes. */
export const TASK_IMPORT_MAX_ROWS = 5000
/** The longest title kept (longer ones are cut). */
export const MAX_TITLE = 500
/** The longest description kept. */
export const MAX_DESCRIPTION = 20_000
/** The longest project name kept. */
export const MAX_PROJECT_NAME = 120

const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Who a cell names: a member by email, then by full name (case-blind), then by first name when only one has it. */
export function matchMember(members: readonly MemberOption[], cell: string): MemberOption | null {
  const s = key(cell)
  if (!s) return null
  const email = /[^\s<>]+@[^\s<>]+\.[a-z]{2,}/i.exec(cell)?.[0]?.toLowerCase()
  if (email) {
    const byEmail = members.find((m) => m.email?.toLowerCase() === email)
    if (byEmail) return byEmail
  }
  const byName = members.filter((m) => m.name && key(m.name) === s)
  if (byName.length === 1) return byName[0]
  const byFirst = members.filter((m) => m.name && key(m.name).split(' ')[0] === s)
  return byFirst.length === 1 ? byFirst[0] : null
}

/** The state a status cell lands in, and whether it was a real match. */
export function matchState(states: readonly StateOption[], cell: string): { state: StateOption; matched: boolean } | null {
  if (!states.length) return null
  const ordered = [...states].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const fallback = ordered.find((s) => s.is_default) ?? ordered.find((s) => s.category === 'unstarted') ?? ordered[0]
  const s = key(cell)
  if (!s) return { state: fallback, matched: true }
  const byName = ordered.find((st) => key(st.name) === s)
  if (byName) return { state: byName, matched: true }
  const cat = categoryForStatus(cell)
  if (cat) {
    const byCat = ordered.filter((st) => st.category === cat)
    const pick = byCat.find((st) => st.is_default) ?? byCat[0]
    if (pick) return { state: pick, matched: true }
  }
  return { state: fallback, matched: false }
}

export interface TaskPlanInput {
  headers: string[]
  rows: string[][]
  mapping: TaskField[]
  context: MatchContext
  /** One project for every row (a project column wins). */
  projectId?: string | null
}

export function planTaskImport(input: TaskPlanInput): ImportPlan {
  const { mapping, context } = input
  const col = (field: TaskField) => mapping.indexOf(field)
  const at = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
  const iTitle = col('title')
  const iDesc = col('description')
  const iStatus = col('status')
  const iPriority = col('priority')
  const iAssignee = col('assignee')
  const iDue = col('due_date')
  const iProject = col('project')
  const labelCols = mapping.map((f, i) => (f === 'labels' ? i : -1)).filter((i) => i >= 0)

  const items: PlannedItem[] = []
  const labelRefs = new Map<string, Ref>()
  for (const l of context.labels) labelRefs.set(key(l.name), { id: l.id })
  const projectRefs = new Map<string, Ref>()
  for (const p of context.projects) projectRefs.set(key(p.name), { id: p.id })
  const newLabels: string[] = []
  const newProjects: string[] = []
  const matchedProjects = new Set<string>()
  const unknownStatuses = new Map<string, number>()
  const unknownPeople = new Map<string, number>()
  let skipped = 0
  let badDates = 0
  let badPriorities = 0
  let actions = 0
  const rows = input.rows.slice(0, TASK_IMPORT_MAX_ROWS)

  const labelRef = (name: string): Ref => {
    const k = key(name)
    let ref = labelRefs.get(k)
    if (!ref) {
      ref = { ref: `label:${newLabels.length}` }
      labelRefs.set(k, ref)
      items.push({ ref: ref.ref, external_id: null, record: { kind: 'label', name } })
      newLabels.push(name)
    }
    return ref
  }
  const projectRef = (raw: string): Ref => {
    const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PROJECT_NAME)
    const k = key(name)
    let ref = projectRefs.get(k)
    if (!ref) {
      ref = { ref: `project:${newProjects.length}` }
      projectRefs.set(k, ref)
      items.push({ ref: ref.ref, external_id: null, record: { kind: 'project', name } })
      newProjects.push(name)
    } else if ('id' in ref) matchedProjects.add(ref.id)
    return ref
  }

  rows.forEach((row, n) => {
    const rowNumber = n + 2 // the header is row 1
    const title = at(row, iTitle).replace(/\s+/g, ' ').slice(0, MAX_TITLE)
    if (!title) {
      skipped++
      return
    }
    const statusCell = at(row, iStatus)
    const state = matchState(context.states, statusCell)
    if (!state) return
    if (!state.matched && statusCell) unknownStatuses.set(statusCell, (unknownStatuses.get(statusCell) ?? 0) + 1)

    const priorityCell = at(row, iPriority)
    const priority = parsePriority(priorityCell)
    if (priorityCell && !priority) badPriorities++

    const assigneeCell = at(row, iAssignee)
    const member = assigneeCell ? matchMember(context.members, assigneeCell) : null
    if (assigneeCell && !member) unknownPeople.set(assigneeCell, (unknownPeople.get(assigneeCell) ?? 0) + 1)

    const dueCell = at(row, iDue)
    const due = dueCell ? parseDueDate(dueCell) : null
    if (dueCell && !due) badDates++

    const projectCell = at(row, iProject)
    const project: Ref | null = projectCell ? projectRef(projectCell) : input.projectId ? { id: input.projectId } : null

    const labelNames: string[] = []
    for (const i of labelCols) for (const name of splitLabels(at(row, i))) if (!labelNames.some((x) => key(x) === key(name))) labelNames.push(name)
    const labels = labelNames.slice(0, 10).map(labelRef)

    const description = at(row, iDesc).slice(0, MAX_DESCRIPTION) || null
    const record: ActionRecord = {
      kind: 'action',
      team_id: context.teamId,
      title,
      description,
      status: { id: state.state.id },
      priority: priority ?? 'none',
      assignee_member_id: member?.id ?? null,
      due_date: due,
      project,
      labels,
      parent: null,
      estimate: null,
      source_label: `Row ${rowNumber}`,
    }
    items.push({ ref: `row:${rowNumber}`, external_id: String(rowNumber), record })
    actions++
  })

  const notes: PlanNote[] = []
  if (input.rows.length > TASK_IMPORT_MAX_ROWS) notes.push({ level: 'warn', text: `Only the first ${countOf(TASK_IMPORT_MAX_ROWS, 'row', 'rows')} are imported; the file has ${input.rows.length.toLocaleString('en-US')}.` })
  if (skipped) notes.push({ level: 'warn', text: `${countOf(skipped, 'row has', 'rows have')} no title and will be skipped.` })
  if (newLabels.length) notes.push({ level: 'info', text: `${countOf(newLabels.length, 'new label', 'new labels')} will be made: ${listed(newLabels)}.` })
  if (matchedProjects.size || newProjects.length) {
    notes.push({ level: 'info', text: `Projects: ${matchedProjects.size} found${newProjects.length ? `, ${newProjects.length} new (${listed(newProjects)})` : ''}.` })
  }
  if (unknownStatuses.size) {
    const fallback = matchState(context.states, '')?.state.name ?? 'the default state'
    const n = [...unknownStatuses.values()].reduce((a, b) => a + b, 0)
    notes.push({ level: 'warn', text: `${countOf(n, 'row has a status', 'rows have a status')} the team doesn’t have (${listed([...unknownStatuses.keys()])}); they go to ${fallback}.` })
  }
  if (unknownPeople.size) {
    const n = [...unknownPeople.values()].reduce((a, b) => a + b, 0)
    notes.push({ level: 'warn', text: `${countOf(n, 'row names an assignee', 'rows name assignees')} who isn’t in the workspace (${listed([...unknownPeople.keys()])}); they stay unassigned.` })
  }
  if (badDates) notes.push({ level: 'warn', text: `${countOf(badDates, 'due date', 'due dates')} couldn’t be read and will be left empty.` })
  if (badPriorities) notes.push({ level: 'warn', text: `${countOf(badPriorities, 'priority', 'priorities')} couldn’t be read and will be None.` })

  return {
    items,
    counts: { action: actions, label: newLabels.length, project: newProjects.length, skipped },
    notes,
  }
}

/** "a, b, c and 4 more". */
export function listed(names: readonly string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => `“${n.length > 40 ? `${n.slice(0, 39)}…` : n}”`)
  return names.length > max ? `${shown.join(', ')} and ${names.length - max} more` : shown.join(', ')
}
