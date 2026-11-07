/**
 * The words the merge shows people, derived from the preflight's numbers.
 * Pure, client-safe: the dialog and the server-side notice both use it.
 */
import type {
  MergeBlocker,
  PreflightCollisions,
  PreflightDefaultCloud,
  PreflightIntegrations,
  PreflightPeople,
  PreflightTeam,
} from './types'

const COUNT_NAMES: Record<string, [string, string]> = {
  actions: ['action', 'actions'],
  captures: ['capture', 'captures'],
  document: ['document', 'documents'],
  projects: ['project', 'projects'],
  contact: ['contact', 'contacts'],
  company: ['company', 'companies'],
  email_thread_index: ['mail thread', 'mail threads'],
  claim: ['claim', 'claims'],
  flow: ['loop', 'loops'],
}

/** The tables people recognise, biggest first, each with its count and its word ("12", "actions"). Memberships are not counted (the merging person is one). */
export function mergeCountItems(rowsBefore: Record<string, number>): Array<{ table: string; n: number; label: string }> {
  return Object.entries(COUNT_NAMES)
    .map(([table, [one, many]]) => {
      const n = rowsBefore[table] ?? 0
      return { table, n, label: n === 1 ? one : many }
    })
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n)
}

/** The same, as one line: "12 actions, 1 capture". */
export function mergeCountsLine(rowsBefore: Record<string, number>): string {
  return mergeCountItems(rowsBefore)
    .map((p) => `${p.n.toLocaleString('en-US')} ${p.label}`)
    .join(', ')
}

/** The same rule the merge route applies: the source's name, case and surrounding spaces aside, and never empty. */
export function confirmNameMatches(name: string, typed: string): boolean {
  const t = typed.trim().toLowerCase()
  return t.length > 0 && t === name.trim().toLowerCase()
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function providerName(provider: string): string {
  const known: Record<string, string> = { linear: 'Linear', jira: 'Jira', asana: 'Asana', hubspot: 'HubSpot', salesforce: 'Salesforce', attio: 'Attio', pipedrive: 'Pipedrive' }
  return known[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/** Why the merge cannot start, one line each. */
export function describeBlockers(blockers: MergeBlocker[]): string[] {
  const out: string[] = []
  for (const b of blockers) {
    if (b.code === 'source_busy') {
      const d = b.detail
      for (const c of d.live_captures.slice(0, 3)) out.push(`A capture is still recording: “${c.title?.trim() || 'Untitled'}”. Stop it first.`)
      if (d.live_captures.length > 3) out.push(`${d.live_captures.length - 3} more captures are still recording.`)
      if (d.agent_runs > 0) out.push(`${plural(d.agent_runs, 'agent run is', 'agent runs are')} still going. Wait for them to finish.`)
      if (d.flow_runs > 0) out.push(`${plural(d.flow_runs, 'loop run is', 'loop runs are')} waiting on an approval card. Accept or skip it first.`)
      if (d.tracked_jobs > 0) out.push(`${plural(d.tracked_jobs, 'background job is', 'background jobs are')} in progress. Wait for them to finish.`)
    } else if (b.code === 'drift') {
      for (const [side, rows] of [['other', b.source], ['this', b.destination]] as const) {
        if (rows.length === 0) continue
        const checks = rows.map((r) => r.check).slice(0, 3).join(', ')
        out.push(`The ${side} workspace fails ${plural(rows.length, 'integrity check')} (${checks}${rows.length > 3 ? ', …' : ''}). The repair has to run first; nothing was changed.`)
      }
    }
  }
  return out
}

/** Who gains access to what. */
export function peopleLines(p: PreflightPeople): string[] {
  const out: string[] = []
  if (p.joining.length > 0) {
    const roles = [...new Set(p.joining.map((m) => m.role ?? 'member'))]
    out.push(`${plural(p.joining.length, 'person joins', 'people join')} this workspace as ${roles.join(' or ')}.`)
  }
  if (p.in_both.length > 0) out.push(`${plural(p.in_both.length, 'person is', 'people are')} already here; each keeps the higher of their two roles.`)
  if (p.invites_moving > 0) out.push(`${plural(p.invites_moving, 'pending invite moves', 'pending invites move')} over.`)
  if (p.invites_dropped > 0) out.push(`${plural(p.invites_dropped, 'invite is', 'invites are')} dropped (already a member here, already invited, or expired).`)
  return out
}

/** What one team's choice does. */
export function teamLine(t: PreflightTeam): string {
  if (t.mode === 'fold') {
    const parts = [`Folds into ${t.destination_team?.name ?? 'a team here'}${t.destination_team?.prefix ? ` (${t.destination_team.prefix})` : ''}`]
    if (t.identifiers.renumbered > 0) parts.push(`${plural(t.identifiers.renumbered, 'identifier is', 'identifiers are')} renumbered`)
    for (const s of t.states_remapped) parts.push(`“${s.from}” → “${s.to ?? 'the default status'}” (${s.actions})`)
    if (t.active_cycle_conflict) parts.push('both teams have an active cycle')
    return `${parts.join('; ')}.`
  }
  const parts = [`Arrives as its own team, “${t.name ?? t.source_name}” (${t.prefix ?? t.source_prefix})`]
  if (t.identifiers.reprefixed > 0) parts.push(`${plural(t.identifiers.reprefixed, 'identifier changes', 'identifiers change')} ${t.source_prefix}- to ${t.prefix}-, numbers kept`)
  if (t.collides.slug && (t.name ?? t.source_name) !== t.source_name) parts.push(`renamed from “${t.source_name}” (a team here has that name)`)
  return `${parts.join('; ')}.`
}

/** Integrations: what moves, where this workspace's connection wins. */
export function integrationLines(i: PreflightIntegrations): string[] {
  const out: string[] = []
  for (const t of i.tasks) {
    if (t.outcome === 'moves') out.push(`${providerName(t.provider)} task sync comes over.`)
    else out.push(`${providerName(t.provider)}: this workspace keeps its own connection; ${plural(t.links_severed ?? 0, 'linked task keeps', 'linked tasks keep')} the link as a URL.`)
  }
  for (const c of i.crm) {
    if (c.outcome === 'moves') out.push(`${providerName(c.provider)} CRM sync comes over.`)
    else out.push(`${providerName(c.provider)}: this workspace keeps its own CRM connection; ${plural(c.provider_ids_cleared ?? 0, 'synced record is', 'synced records are')} unlinked from the provider.`)
  }
  if (i.connected_accounts > 0) out.push(`${plural(i.connected_accounts, 'connected mail or calendar account comes', 'connected mail or calendar accounts come')} over, with their sign-ins.`)
  if (i.mcp_servers > 0) out.push(`${plural(i.mcp_servers, 'MCP server comes', 'MCP servers come')} over.`)
  if (i.cloud_environments > 0) out.push(`${plural(i.cloud_environments, 'cloud environment comes', 'cloud environments come')} over.`)
  out.push(...defaultCloudLines(i.default_cloud_environment))
  if (i.github_prs > 0) out.push(`${plural(i.github_prs, 'linked pull request stays', 'linked pull requests stay')} linked.`)
  return out
}

function envLabel(e: { name: string; network_access: string }): string {
  return `“${e.name}” (${e.network_access} network)`
}

/**
 * The default cloud environment across the merge (migration 420), and so
 * where the other workspace's loops and projects with no environment run.
 * Its projects are pinned to its default and keep running there; its loops
 * have no project, so they run in this workspace's default afterwards.
 */
export function defaultCloudLines(d: PreflightDefaultCloud | undefined): string[] {
  if (!d) return []
  const out: string[] = []
  if (d.outcome === 'destination_keeps' && d.destination) {
    out.push(`This workspace keeps its default cloud environment, ${envLabel(d.destination)}; the other workspace’s comes over as an ordinary one.`)
  } else if (d.outcome === 'source_adopted' && d.source) {
    out.push(`The other workspace’s default cloud environment, ${envLabel(d.source)}, becomes this workspace’s default.`)
  }
  if (d.projects_pinned > 0 && d.source) {
    out.push(`${plural(d.projects_pinned, 'project', 'projects')} from the other workspace with no environment of ${d.projects_pinned === 1 ? 'its' : 'their'} own ${d.projects_pinned === 1 ? 'keeps' : 'keep'} running in its default, ${envLabel(d.source)}.`)
  }
  if (d.source_loops > 0 && d.destination) {
    out.push(`The other workspace’s ${plural(d.source_loops, 'loop runs', 'loops run')} in this workspace’s default cloud environment, ${envLabel(d.destination)}, from now on.`)
  }
  return out
}

/** Where the two workspaces already overlap, and what wins. Nothing here is lost. */
export function collisionLines(c: PreflightCollisions): string[] {
  const out: string[] = []
  if (c.contacts_folded > 0) out.push(`${plural(c.contacts_folded, 'contact matches', 'contacts match')} by email and ${c.contacts_folded === 1 ? 'is' : 'are'} folded into the ones here (undo stays possible).`)
  if (c.companies_folded > 0) out.push(`${plural(c.companies_folded, 'company matches', 'companies match')} by domain and ${c.companies_folded === 1 ? 'is' : 'are'} folded.`)
  if (c.workspace_company_demoted) out.push('The other workspace’s own company becomes an ordinary company; this workspace keeps its own.')
  if (c.documents_canon_demoted.length > 0) {
    const titles = c.documents_canon_demoted.slice(0, 3).map((d) => `“${d.title?.trim() || d.canon_key}”`).join(', ')
    out.push(`${plural(c.documents_canon_demoted.length, 'canonical document exists', 'canonical documents exist')} here already (${titles}${c.documents_canon_demoted.length > 3 ? ', …' : ''}); the other copies stay as ordinary documents.`)
  }
  const reslugged = c.documents_reslugged + c.views_reslugged + c.recipes_reslugged + c.packages_reslugged
  if (reslugged > 0) out.push(`${plural(reslugged, 'document, view, recipe or package gets', 'documents, views, recipes or packages get')} a new link address (a name here is the same).`)
  if (c.prospect_lists_renamed > 0) out.push(`${plural(c.prospect_lists_renamed, 'prospect list is', 'prospect lists are')} renamed.`)
  if (c.home_threads_demoted > 0) out.push(`${plural(c.home_threads_demoted, 'home chat becomes', 'home chats become')} an ordinary conversation; everyone keeps this workspace’s.`)
  if (c.teammate_threads_demoted > 0) out.push(`${plural(c.teammate_threads_demoted, 'teammate chat becomes', 'teammate chats become')} an ordinary conversation.`)
  if (c.system_teammates_folded > 0) out.push(`${plural(c.system_teammates_folded, 'built-in teammate is', 'built-in teammates are')} the same here; their work carries on under this workspace’s.`)
  if (c.seeded_flows_dropped > 0) out.push(`${plural(c.seeded_flows_dropped, 'seeded loop is', 'seeded loops are')} dropped; this workspace’s run instead.`)
  if (c.default_projects_folded > 0) out.push(`${plural(c.default_projects_folded, 'default project folds', 'default projects fold')} into this workspace’s.`)
  if (c.thread_copies_folded > 0) out.push(`${plural(c.thread_copies_folded, 'mail thread is', 'mail threads are')} already indexed here and ${c.thread_copies_folded === 1 ? 'is' : 'are'} folded.`)
  if (c.account_links_deduped > 0) out.push(`${plural(c.account_links_deduped, 'connected account is', 'connected accounts are')} already linked here.`)
  if (c.sequence_enrollments_exited > 0) out.push(`${plural(c.sequence_enrollments_exited, 'sequence enrollment ends', 'sequence enrollments end')} (the contact is already enrolled here).`)
  const singles = Object.values(c.singletons_dropped ?? {}).reduce((a, n) => a + (n || 0), 0)
  if (singles > 0) out.push(`${plural(singles, 'per-person record that exists', 'per-person records that exist')} here already (reminders, goals, logs, default environments) ${singles === 1 ? 'is' : 'are'} dropped.`)
  return out
}
