/**
 * Skill preconditions + honest empty-states (GEN-145).
 *
 * Some catalog skills are data-hungry: Morning Brief needs a calendar and an
 * inbox, Meeting Prep needs upcoming calendar events, Occasion Planner needs
 * contacts. On a workspace where those aren't connected/populated, the skill
 * doesn't fail — it does something worse: it runs, finds nothing, and emits a
 * hollow "I couldn't find anything" report. That teaches the user the skill is
 * broken when really it's just un-fed.
 *
 * A skill can declare `agent_config.preconditions: string[]`. Before a run, we
 * check each one; if any required capability is missing, the run short-circuits
 * with an HONEST empty-state ("Morning Brief needs a connected calendar — link
 * Google or Outlook Calendar first") instead of invoking the model. The user
 * gets a clear next step, and we don't burn tokens producing a non-answer.
 *
 * Checks are cheap existence probes against the run-as user's connections and
 * the workspace's data. They are scoped explicitly (service client bypasses
 * RLS) and never mutate anything.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The closed vocabulary of checkable preconditions. */
export type PreconditionKey =
  | 'calendar_connected'
  | 'inbox_synced'
  | 'has_contacts'
  | 'has_captures'
  | 'has_actions'

/** The closed vocabulary as a runtime tuple — the agent_config schema validates against it. */
export const PRECONDITION_KEYS = [
  'calendar_connected',
  'inbox_synced',
  'has_contacts',
  'has_captures',
  'has_actions',
] as const satisfies readonly PreconditionKey[]

const ALL_KEYS: ReadonlySet<string> = new Set<PreconditionKey>(PRECONDITION_KEYS)

/** The honest, action-oriented message shown when a precondition isn't met. */
const UNMET_MESSAGE: Record<PreconditionKey, string> = {
  calendar_connected:
    'This needs a connected calendar — link Google or Outlook Calendar in Settings, then it can run.',
  inbox_synced:
    'This needs a synced inbox — connect Gmail or Outlook in Settings, then it can run.',
  has_contacts:
    'This needs people in your CRM — contacts build up automatically as you capture meetings, or add some in Contacts.',
  has_captures:
    'This needs some captured meetings to work from — record or import a meeting first.',
  has_actions:
    'This needs some tracked work to act on — create a few actions (or let a capture extract them) first.',
}

export interface UnmetPrecondition {
  key: PreconditionKey
  message: string
}

export interface PreconditionResult {
  met: boolean
  unmet: UnmetPrecondition[]
}

/**
 * Parse + validate a skill's declared preconditions. Unknown keys are ignored
 * (forward-compatible: a newer skill can name a precondition an older deploy
 * doesn't check without erroring — it just isn't enforced).
 */
export function parsePreconditions(raw: unknown): PreconditionKey[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((k): k is PreconditionKey => typeof k === 'string' && ALL_KEYS.has(k))
}

// ── Individual capability probes (cheap existence checks) ──

async function hasCalendarConnected(
  service: SupabaseClient,
  runAsUserId: string,
): Promise<boolean> {
  const { count } = await service
    .from('connected_account')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', runAsUserId)
    .eq('capability', 'calendar')
    .eq('is_enabled', true)
  return (count ?? 0) > 0
}

async function hasInboxSynced(
  service: SupabaseClient,
  runAsUserId: string,
  workspaceId: string,
): Promise<boolean> {
  // Connected email account is the primary signal. Fall back to "any indexed
  // thread exists" so a workspace that synced then disconnected still counts as
  // having an inbox to summarize.
  const { count: acctCount } = await service
    .from('connected_account')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', runAsUserId)
    .eq('capability', 'email')
    .eq('is_enabled', true)
  if ((acctCount ?? 0) > 0) return true

  const { count: threadCount } = await service
    .from('email_thread_index')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .limit(1)
  return (threadCount ?? 0) > 0
}

async function workspaceHasRows(
  service: SupabaseClient,
  table: 'contact' | 'captures' | 'actions',
  workspaceId: string,
): Promise<boolean> {
  const { count } = await service
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
  return (count ?? 0) > 0
}

/**
 * Check a skill's declared preconditions against the run-as user's connections
 * and the workspace's data. Returns which (if any) are unmet, each with an
 * honest message. An empty precondition list is always met.
 */
export async function checkPreconditions(
  service: SupabaseClient,
  keys: PreconditionKey[],
  ctx: { runAsUserId: string; workspaceId: string },
): Promise<PreconditionResult> {
  if (keys.length === 0) return { met: true, unmet: [] }

  const unmet: UnmetPrecondition[] = []
  for (const key of keys) {
    let ok = true
    switch (key) {
      case 'calendar_connected':
        ok = await hasCalendarConnected(service, ctx.runAsUserId)
        break
      case 'inbox_synced':
        ok = await hasInboxSynced(service, ctx.runAsUserId, ctx.workspaceId)
        break
      case 'has_contacts':
        ok = await workspaceHasRows(service, 'contact', ctx.workspaceId)
        break
      case 'has_captures':
        ok = await workspaceHasRows(service, 'captures', ctx.workspaceId)
        break
      case 'has_actions':
        ok = await workspaceHasRows(service, 'actions', ctx.workspaceId)
        break
    }
    if (!ok) unmet.push({ key, message: UNMET_MESSAGE[key] })
  }
  return { met: unmet.length === 0, unmet }
}

/** The user-facing empty-state body when a run is skipped for unmet preconditions. */
export function buildEmptyStateMessage(skillName: string, unmet: UnmetPrecondition[]): string {
  const lines = unmet.map((u) => `- ${u.message}`)
  return `**${skillName}** didn't run because it's missing what it needs:\n\n${lines.join('\n')}`
}
