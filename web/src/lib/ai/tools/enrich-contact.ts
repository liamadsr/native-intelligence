import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { isContactWritableTo } from '@/lib/crm/contact-visibility'
import { readBlob } from '@/lib/crm/enrichment-details'
import { ENRICHMENT_PERMANENTLY_FAILED, liveEnrichmentRunKey, startContactEnrichment } from '@/lib/crm/manual-enrichment'
import { findWork } from '@/lib/work/recorder'
import { WORK_KINDS, isWorkTerminal, type WorkItem } from '@/lib/work/types'
import { resolveEntityWorkspace } from './_shared'
import { ENRICH_CONTACT_DESCRIPTION } from './enrich-contact-text'
import { CONTACT_WEB_FIELDS, fenceWebFields, webText } from './web-derived'

/**
 * `enrich_contact`: the chat's half of "enrich only when a person asks"
 * (2026-10-27). Nothing enriches a contact on its own any more; a person asks
 * with the Enrich button on the contact page, or says yes in the chat (for
 * example to the meeting prep's offer to pull details on someone before a
 * call). This is the tool the chat calls on that yes.
 *
 * SAME RUN AS THE BUTTON. The start is startContactEnrichment
 * (src/lib/crm/manual-enrichment.ts), the function the button's route calls:
 * permanent-failure refusal, the pending mark, the Activity row, the
 * `crm/enrich-contact.manual` event and its settle-on-failed-send.
 *
 * THE GO-AHEAD, as the paid prospecting tools take it (prospecting.ts
 * goAheadRefusal): `confirmed_with_user`, true only after the person said yes
 * to this contact in this conversation, refuses and runs nothing otherwise. A
 * forcing function, not a security boundary: the usage guard and the workspace
 * ceilings stay the server's. Where nobody can have said yes, the routes
 * refuse before the tool runs: an unattended loop run's true flag at the
 * skill-run tool route and a loop-started job's at the Mac's tool route
 * (go-ahead.ts unattendedGoAheadRefusal), and any call
 * from a background update in the home thread at the chat tool route
 * (chat-ceiling.ts HOME_TURN_SETTLE_TOOLS: the meeting prep's report offers
 * the enrichment, and the person's reply runs it).
 *
 * ACCESS, as update_contact and update_crm_contact fence it (contacts.ts,
 * crm.ts): the id is routed to its own workspace (resolveEntityWorkspace,
 * hard-fenced under strictWorkspace), then the contact must be visible to the
 * caller (contact_visible_to, service-role safe). A contact the caller can't
 * see is indistinguishable from a missing one, and nothing runs for it.
 *
 * ONE RUN AT A TIME. A contact already pending with a live Activity row (the
 * button clicked a moment ago, or an earlier call still running) is waited on,
 * not searched again: a second run would pay for the same search.
 *
 * THE WAIT. The run happens in Inngest and usually settles in 10-30 s, so the
 * tool polls the row for up to ENRICH_WAIT_MS and returns what changed; if it
 * is still going, it says so and the details land on the card by themselves.
 */

/**
 * How long one call waits for the run to settle. 45 s covers the usual
 * 10-30 s run with room to spare, and stays far inside the routes that run
 * this tool (the 60 s device ask can't hold it, so its surface leaves the tool
 * out: chat-ceiling.ts SURFACE_EXCLUDED_TOOLS): the chat tool route states maxDuration 300 s
 * (src/app/api/internal/chat/tool/route.ts), the MCP route 800 s
 * (src/app/api/mcp/route.ts), and the work-run and skill-run tool routes take
 * the platform default (300 s on Fluid compute). The eve proxy's fetch has no
 * timeout of its own (agents/chat-agent/lib/spec-client.ts dispatchChatTool).
 * Longer would only hold the person's turn on a spinner for a run that has
 * already outlived its usual time.
 */
export const ENRICH_WAIT_MS = 45_000

/** Quick at first, then every 5 s: ten reads in the 45 s budget. */
export const ENRICH_POLL_DELAYS_MS = [2_000, 3_000, 4_000, 5_000] as const

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The contact columns a run can fill (src/lib/crm/enrichment.ts enrichContact's patch). */
const FILLABLE_COLUMNS = ['full_name', 'job_title', 'department', 'linkedin_url'] as const

const NOT_FOUND = { success: false as const, error: 'Contact not found' }

/** The go-ahead refusal, in prospecting's shape (prospecting.ts goAheadRefusal). */
function goAheadRefusal() {
  return {
    success: false as const,
    needs_go_ahead: true,
    error:
      "Refused, nothing ran: enriching a contact runs a web search and needs the person's yes. Ask whether to pull details on this contact from the web (it takes under a minute), wait for their yes, then call this tool again with confirmed_with_user: true.",
  }
}

interface PolledContact {
  id: string
  full_name: string | null
  email: string | null
  enrichment_status: string | null
  job_title: string | null
  department: string | null
  linkedin_url: string | null
  metadata: unknown
}

const POLL_COLUMNS = 'id, full_name, email, enrichment_status, job_title, department, linkedin_url, metadata'

function enrichmentBlob(metadata: unknown): unknown {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).enrichment
    : null
}

/** The columns enrichment has written on the row, across every run (`metadata.enrichment.applied_fields`). */
function appliedFields(metadata: unknown): string[] {
  return readBlob(enrichmentBlob(metadata)).applied
}

async function readContact(
  supabase: SupabaseClient,
  contactId: string,
  workspaceId: string,
): Promise<PolledContact | null> {
  try {
    const { data, error } = await supabase
      .from('contact')
      .select(POLL_COLUMNS)
      .eq('id', contactId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) return null
    return (data as PolledContact | null) ?? null
  } catch {
    return null
  }
}

/**
 * The run already going for this contact, if any: the row is pending AND a
 * manual enrichment Activity row for it is still queued or running
 * (liveEnrichmentRunKey). A pending mark alone is not enough: a lost event or
 * a refused run leaves it pending with nothing running, and
 * startContactEnrichment takes such a row back.
 */
async function runInFlight(
  supabase: SupabaseClient,
  contactId: string,
  workspaceId: string,
): Promise<{ runKey: string; applied: string[]; name: string } | null> {
  const row = await readContact(supabase, contactId, workspaceId)
  if (!row || row.enrichment_status !== 'pending') return null
  const runKey = await liveEnrichmentRunKey(workspaceId, contactId)
  return runKey ? { runKey, applied: appliedFields(row.metadata), name: nameOf(row) } : null
}

type Waited =
  | { settled: true; row: PolledContact | null; work?: WorkItem }
  | { settled: false; row: PolledContact | null }

/**
 * Poll until the run's outcome is final, or ENRICH_WAIT_MS runs out:
 *   - the row leaves 'pending' (every terminal write sets the status), except
 *     that a 'failed' row is final only once the run's Activity row has ended
 *     too: a transient failure (a 429, a 5xx) writes 'failed' and then throws
 *     for Inngest to retry, and the retry may still enrich the contact;
 *   - or the Activity row ends without touching the row (a run the usage
 *     guard refused).
 */
async function waitForRun(
  supabase: SupabaseClient,
  args: { contactId: string; workspaceId: string; workRunKey: string | null },
): Promise<Waited> {
  const startedAt = Date.now()
  let attempt = 0
  let last: PolledContact | null = null
  for (;;) {
    const delay = ENRICH_POLL_DELAYS_MS[Math.min(attempt, ENRICH_POLL_DELAYS_MS.length - 1)]
    if (Date.now() - startedAt + delay > ENRICH_WAIT_MS) break
    await sleep(delay)
    attempt += 1
    const row = await readContact(supabase, args.contactId, args.workspaceId)
    if (row) last = row
    const settledRow = !!row && row.enrichment_status !== 'pending'
    if (settledRow && (row.enrichment_status !== 'failed' || !args.workRunKey)) return { settled: true, row }
    if (args.workRunKey) {
      const work = await findWork(getServiceClient(), { kind: WORK_KINDS.crmEnrichment, runKey: args.workRunKey })
      if (work && isWorkTerminal(work.status)) return { settled: true, row: last, work }
    }
  }
  return { settled: false, row: last }
}

function nameOf(row: { full_name?: string | null; email?: string | null } | null): string {
  return row?.full_name?.trim() || row?.email?.trim() || 'this contact'
}

function clip(text: string | null | undefined, max = 300): string | null {
  if (!text) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** What a skip means, for the model to tell the person. */
function skipMessage(reason: string | null, name: string): string {
  const r = (reason ?? '').toLowerCase()
  if (r.includes('insufficient_identity_signal') || r.includes('insufficient identity signal')) {
    return `Nothing was searched: there is not enough on ${name}'s card to find them (an email at their company, a LinkedIn URL or a company). Once one is added, they can be enriched.`
  }
  if (r.includes('merged')) return `Nothing was searched: ${name} was merged into another contact. Enrich that one instead.`
  if (r.includes('usage')) return 'Nothing was searched: the AI usage limit is reached.'
  return `Nothing was searched${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}.`
}

/** The tool's answer once the run settled. */
function settledResult(contactId: string, waited: Extract<Waited, { settled: true }>, beforeApplied: string[], fallbackName: string) {
  const { row, work } = waited
  const name = row ? nameOf(row) : fallbackName
  const blob = readBlob(enrichmentBlob(row?.metadata))
  const applied = blob.applied
  const before = new Set(beforeApplied)
  const filled = applied.filter((f) => !before.has(f))
  const rowStatus = row?.enrichment_status ?? null
  // The row's status is the outcome; the Activity row speaks only when the row
  // was never written (a skipped or failed run that left it pending).
  const status: 'enriched' | 'failed' | 'skipped' =
    rowStatus === 'enriched' || rowStatus === 'failed' || rowStatus === 'skipped'
      ? rowStatus
      : work?.status === 'done'
        ? 'enriched'
        : work?.status === 'skipped'
          ? 'skipped'
          : 'failed'
  const base = { success: true as const, contact_id: contactId, name, status, filled_fields: filled, applied_fields: applied }

  if (status === 'enriched') {
    const found: Record<string, unknown> = {}
    for (const column of FILLABLE_COLUMNS) {
      if (filled.includes(column) && row && row[column] != null) found[column] = row[column]
    }
    // The short bio the card holds (folded into their notes), off public pages too.
    const summary = blob.summary ? webText(blob.summary) : null
    return {
      ...base,
      // Job title and department come off public pages: fenced (web-derived.ts).
      found: fenceWebFields(found, CONTACT_WEB_FIELDS),
      ...(summary ? { summary } : {}),
      message:
        filled.length > 0
          ? `Enriched ${name}: filled ${filled.join(', ')} on their card.`
          : `Searched for ${name}; there were no empty fields left to fill on their card.`,
    }
  }
  if (status === 'skipped') {
    const reason = row && rowStatus === 'skipped' ? blob.error : (work?.skip_reason ?? null)
    return { ...base, reason: clip(reason), message: skipMessage(reason, name) }
  }
  const reason = row && rowStatus === 'failed' ? blob.error : (work?.error_message ?? work?.status ?? null)
  return {
    ...base,
    reason: clip(reason),
    message: `The search for ${name} failed${reason ? ` (${clip(reason, 120)})` : ''}; their card is unchanged. Do not retry it now.`,
  }
}

function runningResult(contactId: string, name: string, alreadyRunning: boolean) {
  return {
    success: true as const,
    contact_id: contactId,
    name,
    status: 'running' as const,
    ...(alreadyRunning ? { already_running: true } : {}),
    message: `${alreadyRunning ? 'A search for this contact was already running' : 'Still searching'} after about ${Math.round(ENRICH_WAIT_MS / 1000)} seconds. What it finds will appear on ${name}'s card by itself; do not call enrich_contact again for them.`,
  }
}

export function createEnrichContactTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  // Hard-fences the cross-workspace resolve to `workspaceId` for unattended
  // runs (resolveEntityWorkspace in ./_shared.ts), as every contact write does.
  strictWorkspace = false,
  // A guest's or a linked agent's turn (CreateToolsOptions.omitGrants): what
  // was shared with the owner (an edit grant, 512) never lets it write.
  omitGrants = false,
) {
  return {
    enrich_contact: tool({
      description: ENRICH_CONTACT_DESCRIPTION,
      inputSchema: z.object({
        contact_id: z
          .string()
          .describe('UUID of the ONE contact to enrich (from get_contact, list_contacts, find or the meeting prep).'),
        confirmed_with_user: z
          .boolean()
          .describe(
            'Set true ONLY after the person said yes to enriching THIS contact in this conversation (they asked, or said yes to your offer to pull details on them). False, or omitted, refuses and runs nothing.',
          ),
      }),
      execute: async ({ contact_id, confirmed_with_user }) => {
        if (confirmed_with_user !== true) return goAheadRefusal()

        const resolved = await resolveEntityWorkspace(supabase, userId, 'contact', contact_id, workspaceId, strictWorkspace)
        if (!resolved) return NOT_FOUND
        // No run on a contact the caller cannot see: this may run service-role,
        // where RLS does not hide it (contact-visibility.ts). Same error as missing.
        // An enrichment writes the contact: a per-item grant (read only) is not
        // enough (migration 495).
        if (!(await isContactWritableTo(supabase, contact_id, userId, { grants: !omitGrants && !strictWorkspace }))) return NOT_FOUND
        const targetWs = resolved.workspaceId

        const inFlight = await runInFlight(supabase, contact_id, targetWs)
        if (inFlight) {
          const waited = await waitForRun(supabase, { contactId: contact_id, workspaceId: targetWs, workRunKey: inFlight.runKey })
          return waited.settled
            ? { ...settledResult(contact_id, waited, inFlight.applied, inFlight.name), already_running: true }
            : runningResult(contact_id, inFlight.name, true)
        }

        let started: Awaited<ReturnType<typeof startContactEnrichment>>
        try {
          started = await startContactEnrichment(supabase, { contactId: contact_id, workspaceId: targetWs, userId })
        } catch (err) {
          console.error('[ai/enrich_contact] crm/enrich-contact.manual send failed', err)
          return {
            success: false as const,
            error: 'The search could not be queued, so nothing ran. Tell the person, and offer to try again in a moment.',
          }
        }
        if (!started.ok) {
          if (started.reason === 'not_found') return NOT_FOUND
          // Claimed a moment ago by another request (the button, another call): wait on that run.
          if (started.reason === 'already_running') {
            const holder = await readContact(supabase, contact_id, targetWs)
            const waited = await waitForRun(supabase, { contactId: contact_id, workspaceId: targetWs, workRunKey: started.workRunKey })
            return waited.settled
              ? { ...settledResult(contact_id, waited, appliedFields(holder?.metadata), nameOf(holder)), already_running: true }
              : runningResult(contact_id, nameOf(holder), true)
          }
          if (started.reason === 'permanent_failure') {
            return {
              success: false as const,
              code: ENRICHMENT_PERMANENTLY_FAILED,
              error: `${started.error} Nothing ran. Tell the person; do not retry.`,
            }
          }
          return { success: false as const, error: started.error }
        }

        // What the card held before this run, so the answer names only what it filled.
        const beforeApplied = appliedFields(started.contact.metadata)
        const name = nameOf(started.contact)
        const waited = await waitForRun(supabase, { contactId: contact_id, workspaceId: targetWs, workRunKey: started.workRunKey })
        return waited.settled
          ? settledResult(contact_id, waited, beforeApplied, name)
          : runningResult(contact_id, name, false)
      },
    }),
  }
}
