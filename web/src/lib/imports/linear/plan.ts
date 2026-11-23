/**
 * Linear issues as an import plan (docs/plans/imports.md, phase 2), matched
 * against the workspace the person can see.
 *
 *   states     a Linear state matches one of our team's by name; with no
 *              name match it is made in our team (when `createStates`) or
 *              folded into a state of the same kind (backlog, unstarted,
 *              started, completed, canceled; triage reads as backlog).
 *   labels     by name, case-blind; missing ones are made once.
 *   projects   by name; missing ones are made once.
 *   assignees  a member by the Linear user's email; anyone else unassigned.
 *   priority   Linear's 0–4: none, urgent, high, medium, low.
 *   parents    kept where both issues come in: a parent is planned before
 *              its sub-issues.
 *   repeats    an issue an earlier import (not undone) brought in is skipped.
 *
 * The description keeps its markdown, with a last line naming the Linear
 * issue (and its cycle, which isn't imported). Pure.
 */
import { listed, matchMember, type MemberOption, type NamedOption, type StateOption } from '../tasks/plan'
import type { WorkflowCategory } from '../tasks/columns'
import { countOf, type ActionRecord, type ImportPlan, type PlanNote, type PlannedItem, type Ref } from '../types'
import type { LinearImportIssue } from './read'

export interface LinearTeamPlan {
  /** Our team the Linear team's issues go into. */
  teamId: string
  linearTeamName: string
  issues: LinearImportIssue[]
  /** Our team's workflow states. */
  states: StateOption[]
  truncated?: boolean
}

export interface LinearPlanInput {
  teams: LinearTeamPlan[]
  members: MemberOption[]
  labels: NamedOption[]
  projects: NamedOption[]
  /** Make a Linear state our team lacks (by name), rather than folding it into one of its kind. */
  createStates: boolean
  /** Linear issue ids an earlier import already brought in. */
  alreadyImported: ReadonlySet<string>
}

const PRIORITY = ['none', 'urgent', 'high', 'medium', 'low'] as const
const MAX_DESCRIPTION = 20_000
const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

export function categoryForLinearType(type: string | null | undefined): WorkflowCategory {
  switch (type) {
    case 'backlog':
    case 'triage':
      return 'backlog'
    case 'started':
      return 'started'
    case 'completed':
      return 'completed'
    case 'canceled':
      return 'canceled'
    default:
      return 'unstarted'
  }
}

/** Parents before their sub-issues (a sub-issue whose parent isn't in the list keeps its place). */
export function parentsFirst(issues: readonly LinearImportIssue[]): LinearImportIssue[] {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const out: LinearImportIssue[] = []
  const placed = new Set<string>()
  const place = (issue: LinearImportIssue, guard: number) => {
    if (placed.has(issue.id)) return
    const parent = issue.parent?.id ? byId.get(issue.parent.id) : undefined
    if (parent && guard < 50) place(parent, guard + 1)
    if (placed.has(issue.id)) return
    placed.add(issue.id)
    out.push(issue)
  }
  for (const i of issues) place(i, 0)
  return out
}

export function planLinearImport(input: LinearPlanInput): ImportPlan {
  const items: PlannedItem[] = []
  const notes: PlanNote[] = []
  const labelRefs = new Map<string, Ref>(input.labels.map((l) => [key(l.name), { id: l.id }]))
  const projectRefs = new Map<string, Ref>(input.projects.map((p) => [key(p.name), { id: p.id }]))
  const newLabels: string[] = []
  const newProjects: string[] = []
  const newStates: string[] = []
  const folded = new Set<string>()
  const unknownPeople = new Set<string>()
  const issueRef = new Map<string, string>()
  let repeats = 0
  let actions = 0

  const labelRef = (name: string): Ref => {
    let ref = labelRefs.get(key(name))
    if (!ref) {
      ref = { ref: `label:${newLabels.length}` }
      labelRefs.set(key(name), ref)
      items.push({ ref: ref.ref, external_id: null, record: { kind: 'label', name: name.slice(0, 60) } })
      newLabels.push(name)
    }
    return ref
  }
  const projectRef = (p: { id: string; name: string }): Ref => {
    let ref = projectRefs.get(key(p.name))
    if (!ref) {
      ref = { ref: `project:${newProjects.length}` }
      projectRefs.set(key(p.name), ref)
      items.push({ ref: ref.ref, external_id: p.id, record: { kind: 'project', name: p.name.slice(0, 120) } })
      newProjects.push(p.name)
    }
    return ref
  }

  for (const team of input.teams) {
    // Our team's states, by name, plus what this import makes in it.
    const stateRefs = new Map<string, Ref>(team.states.map((s) => [key(s.name), { id: s.id }]))
    const byCategory = (cat: WorkflowCategory): StateOption | undefined => {
      const of = team.states.filter((s) => s.category === cat).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      return of.find((s) => s.is_default) ?? of[0]
    }
    const fallback = team.states.find((s) => s.is_default) ?? team.states[0]
    const stateRef = (st: LinearImportIssue['state']): Ref | null => {
      if (!st) return fallback ? { id: fallback.id } : null
      const found = stateRefs.get(key(st.name))
      if (found) return found
      const cat = categoryForLinearType(st.type)
      if (input.createStates) {
        const ref: Ref = { ref: `state:${newStates.length}` }
        stateRefs.set(key(st.name), ref)
        items.push({ ref: ref.ref, external_id: st.id, record: { kind: 'workflow_state', team_id: team.teamId, name: st.name.slice(0, 60), category: cat } })
        newStates.push(st.name)
        return ref
      }
      const into = byCategory(cat) ?? fallback
      if (!into) return null
      folded.add(`${st.name} → ${into.name}`)
      stateRefs.set(key(st.name), { id: into.id })
      return { id: into.id }
    }

    for (const issue of parentsFirst(team.issues)) {
      if (input.alreadyImported.has(issue.id)) {
        repeats++
        continue
      }
      const status = stateRef(issue.state)
      if (!status) continue
      const member = issue.assignee?.email ? matchMember(input.members, issue.assignee.email) : null
      if (issue.assignee && !member) unknownPeople.add(issue.assignee.name || issue.assignee.email || 'someone')
      const footer = [`Imported from Linear: ${issue.identifier}${issue.url ? ` (${issue.url})` : ''}`, issue.cycle?.number ? `Cycle: ${issue.cycle.name || `Cycle ${issue.cycle.number}`}` : null]
        .filter(Boolean)
        .join('. ')
      const body = (issue.description ?? '').trim()
      const description = `${body ? `${body.slice(0, MAX_DESCRIPTION)}\n\n` : ''}${footer}.`
      const parentRef = issue.parent?.id ? issueRef.get(issue.parent.id) : undefined
      const ref = `issue:${actions}`
      const record: ActionRecord = {
        kind: 'action',
        team_id: team.teamId,
        title: (issue.title || issue.identifier).replace(/\s+/g, ' ').trim().slice(0, 500),
        description,
        status,
        priority: PRIORITY[issue.priority ?? 0] ?? 'none',
        assignee_member_id: member?.id ?? null,
        due_date: issue.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate) ? issue.dueDate : null,
        project: issue.project ? projectRef(issue.project) : null,
        labels: (issue.labels?.nodes ?? []).slice(0, 10).map((l) => labelRef(l.name)),
        parent: parentRef ? { ref: parentRef } : null,
        estimate: typeof issue.estimate === 'number' ? issue.estimate : null,
        source_label: issue.identifier,
      }
      issueRef.set(issue.id, ref)
      items.push({ ref, external_id: issue.id, record })
      actions++
    }
    if (team.truncated) notes.push({ level: 'warn', text: `${team.linearTeamName} has more issues than one import takes; the oldest ${team.issues.length.toLocaleString('en-US')} come in.` })
  }

  if (repeats) notes.push({ level: 'info', text: `${countOf(repeats, 'issue was', 'issues were')} imported before and will be skipped.` })
  if (newStates.length) notes.push({ level: 'info', text: `${countOf(newStates.length, 'new status', 'new statuses')} will be made: ${listed(newStates)}.` })
  if (folded.size) notes.push({ level: 'info', text: `Statuses folded into ours: ${[...folded].slice(0, 6).join(', ')}${folded.size > 6 ? ` and ${folded.size - 6} more` : ''}.` })
  if (newLabels.length) notes.push({ level: 'info', text: `${countOf(newLabels.length, 'new label', 'new labels')} will be made: ${listed(newLabels)}.` })
  if (newProjects.length) notes.push({ level: 'info', text: `${countOf(newProjects.length, 'new project', 'new projects')} will be made: ${listed(newProjects)}.` })
  if (unknownPeople.size) notes.push({ level: 'warn', text: `Assignees not in this workspace stay unassigned: ${listed([...unknownPeople])}.` })

  return {
    items,
    counts: { action: actions, label: newLabels.length, project: newProjects.length, workflow_state: newStates.length, skipped: repeats },
    notes,
  }
}
