/**
 * Where a create starts, and what that gives the new record
 * (docs/plans/create-everything.md, "Context-aware defaults").
 *
 * A page's New button, or a record's own "add" button, opens the composer
 * with a context (lib/create/open-create.ts): the place it was opened in
 * (`container`: "Create in <name>", shown as a chip the person can remove)
 * and, for a quick create from a message or an email, the `source` the new
 * task links back to. What each kind of place gives each type is here, and
 * only here, so the composer and its tests agree:
 *
 *   project     an action belongs to it; a doc lands in it
 *   initiative  a project belongs to it; an action is about it
 *   team        an action is on its board; a channel is the team's
 *   company     a contact works there; an action is about it
 *   contact     an action is about them
 *   deal, row   an action is about it (a deal is a pipeline row; any table row)
 *
 * Every link goes through the type's own route and its own checks: an
 * action's `about` (POST /api/account/actions, fenced by task-about.ts), a
 * project's `initiative_id`, a doc's `project_id`, a contact's `company_id`.
 * A type a place gives nothing (a table in a company, say) is still made,
 * just not linked; the chip says "Create in" only where it links.
 *
 * Client-safe and pure.
 */
import type { CreateTypeId } from './create-types'

export type CreateContainerKind = 'project' | 'initiative' | 'team' | 'company' | 'contact' | 'deal' | 'row'

export interface CreateContainer {
  kind: CreateContainerKind
  id: string
  /** What the chip says: "Create in <name>". */
  name: string
}

/** A record a quick create starts from: the new task links back to it. */
export interface CreateSource {
  type: 'email_thread' | 'team_chat_message'
  id: string
  /** The prefilled title ("Follow up: <subject>", the message's opening). */
  title: string
}

export interface CreateContext {
  container?: CreateContainer | null
  source?: CreateSource | null
  /** Prefills. */
  title?: string
  description?: string
  /** A table's starter (lib/tables/templates.ts), picked before opening. */
  template?: string | null
  /**
   * An action's chips, picked before opening: the list group whose + it came
   * from (a status column, a priority, a project, an assignee; group-create.ts).
   */
  preset?: ActionPreset | null
}

export interface ActionPreset {
  statusId?: string
  /** The status's team (a workflow state is one team's). */
  teamId?: string
  priority?: string
  projectId?: string
  assigneeId?: string
}

/** A record an action can be `about` (lib/entities/task-about.ts). */
export interface AboutRef {
  type: 'company' | 'contact' | 'data_row' | 'initiative' | 'email_thread' | 'team_chat_message'
  id: string
}

/** What a context sets on a new record of one type. Empty: nothing to link. */
export interface ContextDefaults {
  projectId?: string
  initiativeId?: string
  teamId?: string
  companyId?: string
  about?: AboutRef
}

const ABOUT_KIND: Partial<Record<CreateContainerKind, AboutRef['type']>> = {
  company: 'company',
  contact: 'contact',
  deal: 'data_row',
  row: 'data_row',
  initiative: 'initiative',
}

export function contextDefaults(type: CreateTypeId, ctx: CreateContext | null | undefined): ContextDefaults {
  const c = ctx?.container ?? null
  const out: ContextDefaults = {}
  switch (type) {
    case 'action':
      if (ctx?.source) out.about = { type: ctx.source.type, id: ctx.source.id }
      if (!c) break
      if (c.kind === 'project') out.projectId = c.id
      else if (c.kind === 'team') out.teamId = c.id
      else if (!out.about && ABOUT_KIND[c.kind]) out.about = { type: ABOUT_KIND[c.kind]!, id: c.id }
      break
    case 'project':
      if (c?.kind === 'initiative') out.initiativeId = c.id
      break
    case 'document':
      if (c?.kind === 'project') out.projectId = c.id
      break
    case 'contact':
      if (c?.kind === 'company') out.companyId = c.id
      break
    case 'channel':
      if (c?.kind === 'team') out.teamId = c.id
      break
  }
  return out
}

/** Does this place link a new record of this type (the composer shows "Create in <name>")? */
export function containerApplies(type: CreateTypeId, ctx: CreateContext | null | undefined): boolean {
  if (!ctx?.container) return false
  const d = contextDefaults(type, { container: ctx.container })
  return Object.keys(d).length > 0
}

/** The chip's words: "Create in Website relaunch". */
export function containerLabel(container: CreateContainer): string {
  return `Create in ${container.name.trim() || 'this ' + container.kind}`
}
