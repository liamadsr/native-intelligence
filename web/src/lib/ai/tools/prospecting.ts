import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { establishAndResearchSourceCompany } from '@/lib/prospecting/establish'
import {
  createList,
  listEntries,
  listLists,
  saveEntriesToList,
  updateEntryStage,
  updateList,
  type PromotedEntry,
  type PromoteResult,
  type SkippedEntry,
} from '@/lib/prospecting/lists'
import { publishEntries, publishList } from '@/lib/prospecting/publish'
import { hasAccountCard } from '@/lib/prospecting/cards'
import { fitLabel } from '@/lib/prospecting/fit'
import { hasIcpCard } from '@/lib/prospecting/research'
import {
  createRun,
  getRun,
  listRunCandidates,
  listRuns,
  requestCancel,
  type ProspectingRunWithLive,
} from '@/lib/prospecting/runs'
import { MAX_ENTRIES_PER_TARGETED_RUN } from '@/lib/prospecting/spend'
import { resolveSourceCompany, suggestedDomainFor } from '@/lib/prospecting/source-company'
import {
  PROSPECT_DISMISSED_REASONS,
  PROSPECT_ENTRY_KINDS,
  PROSPECT_ENTRY_STAGES,
  PROSPECT_GLOBAL_DISMISS_REASONS,
  PROSPECT_LIST_PURPOSES,
  type ProspectDismissedReason,
  type ProspectListEntryRow,
} from '@/lib/prospecting/types'
import { getProspectListUrl } from '@/lib/prospecting/urls'
import { fenceWebValues, webText } from './web-derived'
import {
  resolveCreateWorkspace,
  resolveEntityWorkspace,
  workspaceEcho,
  type CreateWorkspacePolicy,
} from './_shared'

/**
 * Prospecting tools — the surface behind the `build-prospect-list` skill.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY TOOL THAT RUNS A SEARCH TAKES `confirmed_with_user`, AND REFUSES
 * WITHOUT IT.
 *
 * Four of these tools start paid runs. The chat never talks about money —
 * prices, budgets and ceilings live in the backend (per-run caps are clamped
 * server-side, the workspace month has a ceiling) and the user never manages
 * them from a conversation. What the user DOES own is the decision to run a
 * stage at all. So every run tool takes a boolean the model may set true only
 * after the user said yes to THIS run in their last message, and refuses —
 * starting nothing — when it is false. A forcing function, not a security
 * boundary: the real ceilings are the server's, and no tool argument reaches
 * them.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NO HTTP. Every tool calls the lib functions in-process — the same functions
 * the API routes call. A tool that fetched its own routes would need a session
 * cookie the agent does not have, re-authenticate work already done, and turn
 * a function call into a network hop that can time out mid-search.
 *
 * TENANCY, mostly, comes from the FACTORY ARGUMENTS, never from model input:
 * every lib call below passes the constructor-bound `workspaceId` / `userId`
 * by default, and the lib's own workspace filter is what turns a foreign id
 * into NOT_FOUND.
 *
 * WORKSPACE ROUTING is the one deliberate exception (see _shared.ts
 * "CREATE-TIME WORKSPACE ROUTING"). `create_prospect_list` is a ROOT create —
 * it takes an optional `workspace_id`, resolved through `resolveCreateWorkspace`.
 * Everything that already names a LIST or a RUN routes by resolving THAT id's
 * own workspace through `resolveEntityWorkspace` first, and re-points every
 * lib call at the resolved workspace rather than the constructor-bound one:
 * `update_prospect_list`, `publish_prospect_list`, `cancel_prospecting_run`,
 * and the run-starting tools (`run_prospect_discovery`,
 * `research_prospect_companies`, `find_prospect_people`, `find_prospects`),
 * all keyed on `list_id` / `run_id`. `save_prospect_entries` and
 * `dismiss_prospect_entries` take a bare list of `entry_ids` with no list_id
 * to anchor on, so each entry is routed INDIVIDUALLY, by its own resolved
 * workspace — the underlying batch functions still take one explicit
 * workspaceId each, so a batch spanning two workspaces becomes two calls,
 * grouped by resolved workspace, rather than one call scoped to the session's.
 */

/**
 * The go-ahead every run tool requires. One shape, one description, so the
 * rule reads the same on all four.
 */
const confirmedSchema = z
  .boolean()
  .describe(
    'Set true ONLY after the user said yes to this specific run in their last message (a typed "go"/"yes", or "Run it" picked in ask_user). Say what the run will do and roughly how long it takes, wait for the yes, then call with true. False, or omitted, refuses and starts nothing.',
  )

/** A tool error, in the shape every other tool family in this directory uses. */
function toolError(error: string, extra: Record<string, unknown> = {}) {
  return { success: false as const, error, ...extra }
}

/**
 * The go-ahead gate. Returns an error object to return verbatim, or null to
 * proceed. Never mentions money: the user is asked whether to run a stage,
 * not what it costs.
 */
function goAheadRefusal(confirmed: boolean | undefined, what: string) {
  if (confirmed === true) return null
  return toolError(
    `Refused, nothing ran: ${what} needs the user's go-ahead. Tell them what it will do and roughly how long it takes, wait for a yes, then call this tool again with confirmed_with_user: true.`,
    { needs_go_ahead: true },
  )
}

/** Trim an entry down to what the model needs to talk about it. The raw row
 *  carries `research` and `sources` blobs that are hundreds of tokens each and
 *  say nothing the agent uses when triaging a list. */
function entrySummary(entry: ProspectListEntryRow) {
  const candidate = (entry.candidate ?? {}) as Record<string, unknown>
  return {
    entry_id: entry.id,
    kind: entry.kind,
    name: typeof candidate.name === 'string' ? candidate.name : null,
    domain: typeof candidate.domain === 'string' ? candidate.domain : null,
    // A person's job title as the web had it: fenced (web-derived.ts).
    title: typeof candidate.title === 'string' ? webText(candidate.title) : null,
    linkedin_url: typeof candidate.linkedin_url === 'string' ? candidate.linkedin_url : null,
    stage: entry.stage,
    identity_state: entry.identity_state,
    /**
     * The full profile's 0–100 rating, or null for a company nobody has
     * profiled yet. Discovery does not score (fit.ts), so a null here is
     * "not profiled", never "a bad fit" — the prompt tells the model to say
     * so rather than to guess a number.
     */
    fit_score: entry.fit_score,
    /** The band the score reads in — strong / good / partial / weak — the same
     *  word the page shows beside the number, so chat and page agree. */
    fit_label: fitLabel(entry.fit_score),
    /** Discovery's why-match sentence until the profile lands, then the
     *  profile's why-fit paragraph (or the anti rule that zeroed the score). */
    // Written from the company's own pages and search results: fenced (web-derived.ts).
    fit_rationale: webText(entry.fit_rationale),
    /**
     * Whether the paid account card has landed.
     *
     * `hasAccountCard`, the SAME predicate the list page's gate uses — not the
     * bare stamp check this used to inline. The two must agree: this one tells
     * the model which companies still need researching, and `find_prospects`
     * uses it to decide which ones a card run may skip. A tool that considered
     * a pre-stamp row unresearched would re-bill it every time.
     */
    researched: hasAccountCard(entry),
    dismissed_reason: entry.dismissed_reason,
    company_id: entry.company_id,
    contact_id: entry.contact_id,
    parent_entry_id: entry.parent_entry_id,
  }
}

/** The run fields worth reporting. `progress` is passed through whole — it is
 *  the typed counter block the UI renders and the model narrates. */
function runSummary(run: {
  id: string
  list_id: string
  kind: string
  status: string
  stage: string
  round_index: number
  progress: unknown
  counts: unknown
  error: string | null
  is_live?: boolean
}) {
  return {
    run_id: run.id,
    list_id: run.list_id,
    kind: run.kind,
    status: run.status,
    stage: run.stage,
    round: run.round_index,
    progress: run.progress,
    counts: run.counts,
    error: run.error,
    is_live: run.is_live ?? false,
  }
}

/** Terminal statuses, as the wait tool sees them. `budget_exhausted` is an
 *  OUTCOME here, not a failure (§9) — a run that stopped at its cap kept every
 *  partial result and can be resumed with a fresh run. */
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'canceled',
  'budget_exhausted',
])

/**
 * The run a settled DISCOVERY run handed off to, or null.
 *
 * The Inngest function chains the profile run in the step right after
 * discovery's terminal write, so a poll that saw `completed` can be a few
 * hundred milliseconds ahead of the chained row. A look and two short retries,
 * only for a discover run: a live run on the same list that is not the one
 * just waited on. Never a search — one list read per look.
 */
async function followUpRun(
  supabase: SupabaseClient,
  workspaceId: string,
  run: { id: string; list_id: string; kind: string },
): Promise<ProspectingRunWithLive | null> {
  if (run.kind !== 'discover') return null
  for (let look = 0; look < 3; look++) {
    if (look > 0) await sleep(FOLLOW_UP_LOOK_MS)
    const result = await listRuns(supabase, { workspaceId, listId: run.list_id, limit: 1 })
    if (!result.ok) return null
    const newest = result.runs[0]
    if (newest && newest.is_live && newest.id !== run.id) return newest
  }
  return null
}

const FOLLOW_UP_LOOK_MS = 1_000

/** The polling schedule for `wait_for_prospecting_run`: quick at first, then
 *  backing off, capped so a four-minute wait is ~30 reads rather than 240. */
const POLL_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 10_000] as const
const MAX_WAIT_MS = 4 * 60 * 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createProspectingTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  return {
    // ─────────────────────────────────────────────────────────────────────
    // Step 1 — what do WE sell, and to whom?
    // ─────────────────────────────────────────────────────────────────────
    research_my_company: tool({
      description:
        `Establish and research the user's OWN company — the source company every ICP is seeded from. Resolves what the workspace already knows first: if the company is already established AND already carries its ICP card, this returns the profile and RUNS NOTHING — call it with no arguments for that check. Otherwise it creates/adopts the company row, flags it as the workspace company, kicks the full CRM enrichment, and fires ONE ICP card to learn who they sell to — that is a run, so it needs \`confirmed_with_user\` like any other. If you call it without the go-ahead and a card would fire, it refuses with needs_go_ahead and does nothing: tell the user you are about to read their site (about a minute), get a yes, call again. Pass \`domain\` for a first setup or to re-point to a different company ("that is not us"); omit it to use what the workspace already knows plus the user's email domain. If the user is on gmail/outlook and nothing is established, this returns needs_domain — ask them for their website with ask_user and call again.`,
      inputSchema: z.object({
        domain: z
          .string()
          .optional()
          .describe(
            'The company website, e.g. "acme.com" or "https://www.acme.com/pricing". Omit to use what the workspace already knows. Pass it to correct a wrong source company.',
          ),
        confirmed_with_user: confirmedSchema.optional().describe(
          'Optional ONLY so you can call this tool with nothing to check whether the company is already researched — that check runs no search. Required (true) whenever a card would actually fire: establishing a company, passing `domain`, or retrying after a needs_go_ahead refusal.',
        ),
      }),
      execute: async ({ domain, confirmed_with_user }) => {
        // The SERVICE client, deliberately: `company`'s SELECT policy is
        // visibility-aware and the workspace's own company routinely has one
        // contact, so a member's RLS client can fail to see it and the whole
        // sequence would mis-fire. Membership is already proven — this tool
        // set is constructed with a verified `workspaceId`.
        const service = getServiceClient()
        const userEmail = await callerEmail(supabase)

        if (confirmed_with_user !== true) {
          /*
           * NO GO-AHEAD. Optional on this tool only because the common path —
           * an established, already-carded company — runs nothing. The path
           * where the company exists but has never been carded DOES run a
           * search (`fireIcpCard`), and skipping the gate there would be the
           * one place in this file a search starts without the user's yes.
           *
           * So ask the cheap question first: resolve, and if the card would
           * fire, refuse. Resolve is reads only — nothing is established.
           */
          const named = domain?.trim() ?? ''
          const resolved = await resolveSourceCompany(service, { workspaceId, userId, userEmail })
          const carded = resolved.company ? hasIcpCard(resolved.company.metadata) : false

          // NOTHING TO RESEARCH YET. A personal-webmail caller with no company
          // in the workspace: ask for the website instead; the go-ahead is
          // owed on the retry, which WILL carry a domain.
          if (!resolved.company && named === '' && !suggestedDomainFor(userEmail)) {
            return toolError(
              "We could not guess the user's company from their email address. Ask them for their company website (ask_user, or just ask in prose if a picker makes no sense here) and call this tool again with `domain` and confirmed_with_user: true, since establishing a company reads their site.",
              { needs_domain: true },
            )
          }

          // A named domain may re-point to a DIFFERENT company, whose card
          // state the resolve above says nothing about — treat it as a run.
          const willRun = !carded || named !== ''
          if (willRun) {
            return toolError(
              'Refused, nothing ran: researching this company reads its website and builds the profile (about a minute). Tell the user, get their yes, then call this tool again with confirmed_with_user: true.',
              { needs_go_ahead: true, already_researched: carded },
            )
          }
        }

        const outcome = await establishAndResearchSourceCompany(service, {
          workspaceId,
          userId,
          userEmail,
          domain: domain ?? null,
        })

        if (!outcome.ok) {
          if (outcome.code === 'NEEDS_DOMAIN') {
            return toolError(
              "We could not guess the user's company from their email address. Ask them for their company website (ask_user, or just ask in prose if a picker makes no sense here) and call this tool again with `domain`.",
              { needs_domain: true },
            )
          }
          return toolError(outcome.error, { code: outcome.code })
        }

        const source = outcome.source as Record<string, unknown> | null
        const enrichment = readEnrichmentFields(source?.metadata)
        return {
          success: true,
          established: outcome.established,
          resolved_by: outcome.resolved_by,
          company_id: outcome.company_id,
          name: (source?.name as string | undefined) ?? null,
          domain: (source?.domain as string | undefined) ?? null,
          // Read off the company's website (and the web around it): every
          // prose field is fenced as untrusted WEB content (web-derived.ts).
          industry: webText((source?.industry as string | undefined) ?? null),
          description: webText((source?.description as string | undefined) ?? null),
          /** The ICP-card fields — "what we sell", "who we sell to". These are
           *  the sentence the user should be shown and asked to confirm. */
          icp_fields: fenceWebValues(enrichment),
          /** 'started' means the full CRM enrichment is running in the
           *  background; the columns above may still be thin for a minute. */
          enrichment: outcome.enrichment,
          icp_card: { status: outcome.icp_card.status },
          message:
            outcome.icp_card.status === 'skipped'
              ? 'Already researched — nothing ran.'
              : `Profile ${outcome.icp_card.status}.`,
        }
      },
    }),

    // ─────────────────────────────────────────────────────────────────────
    // Lists
    // ─────────────────────────────────────────────────────────────────────
    list_prospect_lists: tool({
      description:
        'Every prospect list in this workspace, newest first, with its purpose and its per-stage entry tally (discovered / shortlisted / saved / dismissed, plus how many saved entries are people and how many are still waiting to be published to the CRM). Runs no search. THIS IS THE FRONT DOOR to prospecting: "show me my prospects", "what am I working?", "how did the investors list do?" all start here, and every other prospect tool needs the list_id it returns.',
      inputSchema: z.object({
        include_archived: z
          .boolean()
          .optional()
          .describe('Include archived lists as well as active ones. Default false.'),
      }),
      execute: async ({ include_archived }) => {
        const result = await listLists(supabase, {
          workspaceId,
          includeArchived: include_archived,
        })
        if (!result.ok) return toolError(result.error, { code: result.code })
        return {
          success: true,
          count: result.lists.length,
          lists: result.lists.map((list) => ({
            list_id: list.id,
            list_name: list.name,
            description: list.description,
            purpose: list.purpose,
            status: list.status,
            entry_counts: list.entry_counts,
            published_at: list.published_at,
            created_at: list.created_at,
            url: getProspectListUrl(list.id),
          })),
        }
      },
    }),

    create_prospect_list: tool({
      description:
        'Create a prospect list — the container discovery fills. Runs no search. Give it the name the user would recognise ("Series A fintechs", "Investors"), the purpose, and an ICP describing who to look for. Seed the ICP from research_my_company\'s output rather than inventing one, and show the user what you are about to search for before you create it. The round/target fields set the DEFAULTS every run of this list inherits.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('What the user calls this list.'),
        description: z.string().max(1000).optional().describe('One line on what it is for.'),
        purpose: z
          .enum(PROSPECT_LIST_PURPOSES)
          .optional()
          .describe(
            `What kind of list this is; drives the search angles and the CRM relationship type on save. Defaults to buyers. One of: ${PROSPECT_LIST_PURPOSES.join(', ')}.`,
          ),
        icp: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'The ideal-customer profile object: who to look for. Pass the draft from research_my_company (icp_draft shape) edited to the user\'s answers. Unknown keys are normalized away rather than rejected.',
          ),
        source_company_id: z
          .string()
          .optional()
          .describe('The workspace\'s own company id, from research_my_company.'),
        exclude_crm: z
          .boolean()
          .optional()
          .describe('Skip companies already in the CRM. Default true.'),
        exclude_other_lists: z
          .boolean()
          .optional()
          .describe('Skip companies already on another prospect list. Default false.'),
        exclude_contacted: z
          .enum(['off', 'active', 'ever'])
          .optional()
          .describe(
            'Skip people already contacted: "ever" (default), "active" (only live sequences), or "off".',
          ),
        target_new_candidates: z
          .number()
          .int()
          .optional()
          .describe('Stop discovery once this many NEW companies exist (5–100, default 20).'),
        max_rounds: z.number().int().optional().describe('Search rounds per run (1–3, default 2).'),
        people_per_company: z
          .number()
          .int()
          .optional()
          .describe('People to keep per company (0–10, default 3). 0 = research only.'),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async (input) => {
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, input.workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        const result = await createList(supabase, {
          workspaceId: targetWs,
          userId,
          input: {
            name: input.name,
            description: input.description ?? null,
            purpose: input.purpose,
            icp: input.icp,
            source_company_id: input.source_company_id ?? null,
            exclude_crm: input.exclude_crm,
            exclude_other_lists: input.exclude_other_lists,
            exclude_contacted: input.exclude_contacted,
            target_new_candidates: input.target_new_candidates,
            max_rounds: input.max_rounds,
            people_per_company: input.people_per_company,
          },
        })
        if (!result.ok) {
          if (result.code === 'LIST_NAME_TAKEN') {
            return toolError(
              `${result.error}. Ask the user for a different name, or work with the existing list.`,
              { code: result.code },
            )
          }
          return toolError(result.error, { code: result.code })
        }
        return {
          success: true,
          list_id: result.list.id,
          name: result.list.name,
          /** The same string as `name`, under the key EVERY list-bearing tool
           *  output uses. The chat's chip reads one field, not five. */
          list_name: result.list.name,
          purpose: result.list.purpose,
          icp: result.list.icp,
          max_rounds: result.list.max_rounds,
          target_new_candidates: result.list.target_new_candidates,
          people_per_company: result.list.people_per_company,
          url: getProspectListUrl(result.list.id),
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_prospect_list: tool({
      description:
        'Edit a prospect list — its name, its ICP, its exclusion toggles, or its run defaults. Runs no search. Editing the ICP bumps its version: existing entries keep the version they were found under and the list badges the drift, so nothing is retro-invalidated. Use this when the user reacts to the first round ("too big", "US only") rather than making a second list.',
      inputSchema: z.object({
        list_id: z.string().describe('The list to edit.'),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(1000).optional(),
        purpose: z.enum(PROSPECT_LIST_PURPOSES).optional(),
        icp: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('The full replacement ICP object. Bumps icp_version if it actually differs.'),
        exclude_crm: z.boolean().optional(),
        exclude_other_lists: z.boolean().optional(),
        exclude_contacted: z.enum(['off', 'active', 'ever']).optional(),
        target_new_candidates: z.number().int().optional(),
        max_rounds: z.number().int().optional(),
        people_per_company: z.number().int().optional(),
        status: z
          .enum(['active', 'archived'])
          .optional()
          .describe('Archive a list the user is done with. Archived lists cannot be run.'),
      }),
      execute: async ({ list_id, ...patch }) => {
        // Route to the LIST's own workspace — a list_id copied out of another
        // workspace the user belongs to is edited there, never silently
        // missed because the write stayed pinned to the session workspace.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'prospect_list',
          list_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return toolError('List not found', { code: 'NOT_FOUND' })
        const targetWs = resolved.workspaceId

        const result = await updateList(supabase, {
          workspaceId: targetWs,
          listId: list_id,
          input: patch,
        })
        if (!result.ok) return toolError(result.error, { code: result.code })
        return {
          success: true,
          list_id: result.list.id,
          name: result.list.name,
          list_name: result.list.name,
          icp: result.list.icp,
          icp_version: result.list.icp_version,
          icp_version_bumped: result.icp_version_bumped,
          status: result.list.status,
          url: getProspectListUrl(result.list.id),
        }
      },
    }),

    list_prospect_entries: tool({
      description:
        'Read a prospect list\'s entries — the companies and people found so far, best match first, with their fit score (0–100, null until the full profile has run), fit label (strong / good / partial / weak match), rationale, stage, and whether the full profile has landed. Runs no search. This is how you answer "why is Vanta a 72?" (read fit_rationale) and how you build the selection for find_prospects / research_prospect_companies / find_prospect_people / save_prospect_entries. Every filter is applied in the database, so ask for exactly the slice you want. `whole_list_entry_counts` is always over the WHOLE list even when you filter, so the totals stay honest — never report it as the count of what you filtered to; that number is `matched`.',
      inputSchema: z.object({
        list_id: z.string().describe('The list to read.'),
        stage: z
          .enum(PROSPECT_ENTRY_STAGES)
          .optional()
          .describe(
            'Filter to one stage: discovered (found, untriaged), shortlisted, saved (promoted to the CRM), dismissed.',
          ),
        min_fit_score: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe(
            'Keep only entries scored at or above this, e.g. 80 for the hot ones. Filtered in the database. Entries with no score yet (not profiled) are excluded.',
          ),
        kind: z
          .enum(PROSPECT_ENTRY_KINDS)
          .optional()
          .describe('Companies or the people found at them. Filtered in the database.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Limit the entries returned (default 50). Counts are unaffected.'),
      }),
      execute: async ({ list_id, stage, min_fit_score, kind, limit }) => {
        // ALL THREE FILTERS ARE SQL now. They used to be: stage pushed down,
        // the score and kind applied to the array here — which meant answering
        // "show me the hot ones" on a 1200-entry list read all 1200 rows across
        // two paged round trips and threw most of them away. `listEntries`
        // still reports whole-list counts because its count read carries no
        // filters at all.
        // Route to the LIST's own workspace, as the run-starting tools do.
        const list = await resolveListWorkspace(supabase, userId, workspaceId, list_id, strictWorkspace)
        if (!list.ok) return list.error
        const listWs = list.workspaceId
        const result = await listEntries(supabase, {
          workspaceId: listWs,
          listId: list_id,
          stage,
          min_fit_score,
          kind,
        })
        if (!result.ok) return toolError(result.error, { code: result.code })

        const matched = result.entries.length
        // `limit` stays a TOOL concern rather than a SQL one: the cap exists to
        // bound the token cost of one reply, and `matched` has to be the honest
        // size of the filtered set so the model can say "showing 50 of 180".
        const capped = result.entries.slice(0, limit ?? 50)
        return {
          success: true,
          list_id,
          list_name: await listName(supabase, listWs, list_id),
          entries: capped.map(entrySummary),
          returned: capped.length,
          matched,
          truncated: matched > capped.length,
          /** Over the WHOLE list, never the filtered slice — named so that a
           *  model reading it aloud cannot mistake it for the filtered count. */
          whole_list_entry_counts: result.entry_counts,
          filters_applied: {
            stage: stage ?? null,
            min_fit_score: typeof min_fit_score === 'number' ? min_fit_score : null,
            kind: kind ?? null,
          },
          url: getProspectListUrl(list_id),
        }
      },
    }),

    // ─────────────────────────────────────────────────────────────────────
    // The three spending runs
    // ─────────────────────────────────────────────────────────────────────
    run_prospect_discovery: tool({
      description:
        'RUNS A SEARCH — needs the user\'s go-ahead. Start a discovery run on a list: searches Exa across several angles for up to max_rounds rounds and writes the companies it finds as list entries, deduped against the CRM, other lists, and everything this list has already seen — and THEN, automatically, hands off to a profile run that scores every company it found (fit_score 0–100). "Find companies" means find AND score, so one go-ahead covers both; say both halves when you ask, and allow four to eight minutes in total. Discovery settles first: wait_for_prospecting_run on this run returns follow_up_run for the profile run — wait on that too. Companies appear on the page as they land and re-sort best match first as scores arrive. Say what it will do, get a yes, then call this with confirmed_with_user: true. One live run per list: a second call while one is running is refused, which is correct, not an error to retry.',
      inputSchema: z.object({
        list_id: z.string().describe('The list to fill.'),
        confirmed_with_user: confirmedSchema,
      }),
      execute: async ({ list_id, confirmed_with_user }) => {
        const refusal = goAheadRefusal(confirmed_with_user, 'discovery')
        if (refusal) return refusal
        const list = await resolveListWorkspace(supabase, userId, workspaceId, list_id, strictWorkspace)
        if (!list.ok) return list.error
        return startRun(supabase, {
          workspaceId: list.workspaceId,
          userId,
          listId: list_id,
          kind: 'discover',
        })
      },
    }),

    research_prospect_companies: tool({
      description:
        `RUNS A SEARCH PER COMPANY — needs the user's go-ahead. Run the full profile (account card) on companies the user picked: one anchored Exa search each, ~10s per company, so 30 companies is about five minutes. Only pass entries the user actually chose; never the whole list by default. At most ${MAX_ENTRIES_PER_TARGETED_RUN} per run. Then call wait_for_prospecting_run.`,
      inputSchema: z.object({
        list_id: z.string().describe('The list the entries belong to.'),
        entry_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_ENTRIES_PER_TARGETED_RUN)
          .describe(
            `Company entry ids from list_prospect_entries — the ones the user selected. Max ${MAX_ENTRIES_PER_TARGETED_RUN}.`,
          ),
        confirmed_with_user: confirmedSchema,
      }),
      execute: async ({ list_id, entry_ids, confirmed_with_user }) => {
        const refusal = goAheadRefusal(confirmed_with_user, 'the full profiles')
        if (refusal) return refusal
        const list = await resolveListWorkspace(supabase, userId, workspaceId, list_id, strictWorkspace)
        if (!list.ok) return list.error
        return startRun(supabase, {
          workspaceId: list.workspaceId,
          userId,
          listId: list_id,
          kind: 'account_card',
          entryIds: entry_ids,
        })
      },
    }),

    find_prospect_people: tool({
      description:
        `RUNS A SEARCH PER COMPANY — needs the user's go-ahead. Find the people to contact at companies the user picked: one Exa search per company, anchored on that company's own domain. The list's people_per_company setting limits how many are KEPT per company; it does not multiply the searches. Anyone the domain anchor could not verify is written as needs_review and stays out of bulk save — that gate is what stops namesake drift, do not route around it. At most ${MAX_ENTRIES_PER_TARGETED_RUN} companies per run. If a people search is already running on this list, these companies JOIN it instead of starting another (the result says joined_live_run) — follow the run id it hands back. Then call wait_for_prospecting_run.`,
      inputSchema: z.object({
        list_id: z.string().describe('The list the entries belong to.'),
        entry_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_ENTRIES_PER_TARGETED_RUN)
          .describe(
            `COMPANY entry ids to find people at (not person ids). Max ${MAX_ENTRIES_PER_TARGETED_RUN}.`,
          ),
        confirmed_with_user: confirmedSchema,
      }),
      execute: async ({ list_id, entry_ids, confirmed_with_user }) => {
        const refusal = goAheadRefusal(confirmed_with_user, 'finding people')
        if (refusal) return refusal
        const list = await resolveListWorkspace(supabase, userId, workspaceId, list_id, strictWorkspace)
        if (!list.ok) return list.error
        return startRun(supabase, {
          workspaceId: list.workspaceId,
          userId,
          listId: list_id,
          kind: 'people',
          entryIds: entry_ids,
        })
      },
    }),

    find_prospects: tool({
      description:
        `RUNS TWO SEARCHES PER COMPANY — needs the user's go-ahead — and it is the RIGHT tool for "research these and find me people there", which is what the user actually wants at the gate. Runs BOTH per-company stages on one decision: the full profile (account card) and then the people search. Name both stages out loud and how long they take before you call it — one yes commits both. Companies that have ALREADY been profiled skip the card leg; only the people leg runs for them. It waits for the card leg (up to ~4 minutes) and then starts the people leg and RETURNS — call wait_for_prospecting_run on the people run id it hands back. If the card leg fails or is canceled the people leg never starts. At most ${MAX_ENTRIES_PER_TARGETED_RUN} companies.`,
      inputSchema: z.object({
        list_id: z.string().describe('The list the entries belong to.'),
        entry_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_ENTRIES_PER_TARGETED_RUN)
          .describe(
            `COMPANY entry ids the user selected (not person ids). Max ${MAX_ENTRIES_PER_TARGETED_RUN}. When the user is looking at a list and says "these", the system prompt tells you exactly which ids they mean — use those, never your own idea of the rows.`,
          ),
        confirmed_with_user: confirmedSchema.describe(
          'True only after the user said yes to BOTH stages — one go-ahead commits both legs.',
        ),
      }),
      execute: async ({ list_id, entry_ids, confirmed_with_user }) => {
        const refusal = goAheadRefusal(confirmed_with_user, 'profiling these companies and finding people')
        if (refusal) return refusal

        // Route to the LIST's own workspace BEFORE any read below — a foreign
        // or dismissed id is refused before a single dollar moves, and both
        // legs (and every lookup either one does) run against the list's real
        // workspace, never the session's.
        const list = await resolveListWorkspace(supabase, userId, workspaceId, list_id, strictWorkspace)
        if (!list.ok) return list.error
        const targetWs = list.workspaceId

        // ── The list, and the selection ────────────────────────────────
        //
        // Read HERE as well as inside createRun. createRun validates on the
        // way in, but this tool has to know which of the selected companies
        // are already carded BEFORE it starts anything — and the same read
        // answers both questions, so a foreign or dismissed id is refused
        // before a single dollar moves rather than between the two legs.
        const listRow = await supabase
          .from('prospect_list')
          .select('id, name')
          .eq('id', list_id)
          .eq('workspace_id', targetWs)
          .maybeSingle()
        if (listRow.error) {
          console.error('[prospecting-tools] find_prospects list read failed:', listRow.error.message)
          return toolError('Could not load that list. Nothing ran.')
        }
        if (!listRow.data) return toolError('List not found.', { code: 'NOT_FOUND' })
        const name = ((listRow.data as { name?: unknown }).name as string | undefined) ?? null

        const entryRows = await supabase
          .from('prospect_list_entry')
          .select('id, kind, stage, candidate, research')
          .eq('workspace_id', targetWs)
          .eq('list_id', list_id)
          .in('id', entry_ids)
        if (entryRows.error) {
          console.error(
            '[prospecting-tools] find_prospects entry read failed:',
            entryRows.error.message,
          )
          return toolError('Could not load the selected companies. Nothing ran.')
        }
        const rows = (entryRows.data ?? []) as Array<{
          id: string
          kind: string
          stage: string
          candidate?: unknown
          research?: unknown
        }>
        const byId = new Map(rows.map((r) => [r.id, r]))

        // Refused BEFORE either leg, and named specifically: a run that got
        // halfway and then rejected the selection has already spent the card
        // leg's money on a set the user cannot save.
        const missing = entry_ids.filter((id) => !byId.has(id))
        if (missing.length > 0) {
          return toolError(
            `Refused, nothing ran: ${missing.length} of the selected ids are not entries on this list. Re-read the list with list_prospect_entries and use ids from it.`,
            { code: 'INVALID_INPUT', invalid_entry_ids: missing },
          )
        }
        const people = entry_ids.filter((id) => byId.get(id)!.kind !== 'company')
        if (people.length > 0) {
          return toolError(
            'Refused, nothing ran: this tool takes COMPANY entry ids. Some of the ids you passed are people — pass the companies you want researched instead.',
            { code: 'INVALID_INPUT', invalid_entry_ids: people },
          )
        }
        const dismissed = entry_ids.filter((id) => byId.get(id)!.stage === 'dismissed')
        if (dismissed.length > 0) {
          return toolError(
            'Refused, nothing ran: some of the selected companies are dismissed. Restore them first (dismiss_prospect_entries with stage "discovered") if the user wants them researched.',
            { code: 'INVALID_INPUT', invalid_entry_ids: dismissed },
          )
        }

        // ── LEG 1: the account card, over the companies that need it ────
        //
        // THE ONE PLACE THE RE-SPEND IS AVOIDED. `account-run.ts` bills every
        // entry id it is handed — it does not check `account_card_at` — so a
        // selection of 30 companies where 25 are already carded costs the full
        // 30 unless the filtering happens here. `hasAccountCard` is the same
        // predicate the page's gate uses, so the chat and the page agree about
        // which companies still owe a card.
        const needCard = entry_ids.filter((id) => !hasAccountCard(byId.get(id)!))
        const skipped = entry_ids.length - needCard.length

        /** The card leg's run, in the shape every other tool reports a run in.
         *  Null when every selected company was already carded and the leg was
         *  skipped entirely. */
        let cardSummary: ReturnType<typeof runSummary> | null = null
        let cardRunId: string | null = null
        if (needCard.length > 0) {
          const cardRun = await startRun(supabase, {
            workspaceId: targetWs,
            userId,
            listId: list_id,
            kind: 'account_card',
            entryIds: needCard,
            listNameHint: name,
          })
          if (!('run_id' in cardRun)) {
            return { ...cardRun, phase: 'cards_failed_to_start', list_id, list_name: name }
          }
          cardRunId = cardRun.run_id

          const outcome = await pollRun(supabase, {
            workspaceId: targetWs,
            runId: cardRun.run_id,
            budgetMs: MAX_WAIT_MS,
          })
          if ('error' in outcome) return { ...outcome.error, phase: 'cards_unreadable' }

          if (!outcome.done) {
            // THE WAIT RAN OUT. The people leg is NOT started: the consent the
            // user gave is minutes old and the card leg is still spending
            // against it, so committing a second paid run on that basis would
            // be a decision the tool made, not the user. The model is told
            // exactly what to do instead, and told not to call this tool again
            // — a re-call would re-run the cards it just paid for.
            return {
              success: true,
              phase: 'cards_running',
              list_id,
              list_name: name,
              cards: { skipped_already_researched: skipped, run: runSummary(outcome.run) },
              people: null,
              url: getProspectListUrl(list_id),
              message: `The account cards are still running after four minutes (run_id ${cardRunId}). Call wait_for_prospecting_run on that run, tell the user what it found, then ask about the people leg and call find_prospect_people — do NOT call find_prospects again, it would re-run the cards that already ran.`,
            }
          }

          const settled = outcome.run
          if (settled.status === 'failed' || settled.status === 'canceled') {
            // NO LEG 2. A card leg that failed or was stopped means the user
            // either hit a real error or pressed stop; starting a paid people
            // run on top of either is the opposite of what they asked for.
            return {
              ...toolError(
                settled.status === 'canceled'
                  ? 'The account-card run was canceled, so the people search was not started. Nothing further ran.'
                  : `The account-card run failed (${settled.error ?? 'no reason recorded'}), so the people search was not started. Nothing further ran.`,
              ),
              phase: 'cards_failed',
              list_id,
              list_name: name,
              cards: { skipped_already_researched: skipped, run: runSummary(settled) },
              people: null,
              url: getProspectListUrl(list_id),
            }
          }
          // `budget_exhausted` falls through DELIBERATELY: the cap did its job,
          // the cards it did land are kept, and the people leg has its own
          // separate budget. Report it, do not treat it as a failure.
          cardSummary = runSummary(settled)
        }

        // ── LEG 2: the people search, over EVERY selected company ───────
        //
        // Every id, not just the ones that needed a card: a company that was
        // already researched is exactly the one the user is asking for people
        // at. Started and returned WITHOUT polling — one tool call already
        // held the model for up to four minutes on leg 1, and the model has
        // wait_for_prospecting_run for the rest.
        const peopleRun = await startRun(supabase, {
          workspaceId: targetWs,
          userId,
          listId: list_id,
          kind: 'people',
          entryIds: entry_ids,
          listNameHint: name,
        })
        if (!('run_id' in peopleRun)) {
          // The cards ALREADY LANDED and are already billed. Reporting the card
          // leg alongside the people-leg failure is the difference between
          // "nothing happened" and "you paid for cards, the people search did
          // not start" — and the second is what actually occurred.
          return {
            ...peopleRun,
            phase: 'people_failed_to_start',
            list_id,
            list_name: name,
            cards: { skipped_already_researched: skipped, run: cardSummary },
            people: null,
            url: getProspectListUrl(list_id),
          }
        }

        const cardsLine =
          needCard.length === 0
            ? `all ${entry_ids.length} were already profiled, so the card leg was skipped`
            : `${needCard.length} profiled${skipped > 0 ? `, ${skipped} already had a profile and were skipped` : ''}`
        return {
          success: true,
          phase: 'people_started',
          list_id,
          list_name: name,
          cards: { skipped_already_researched: skipped, run: cardSummary },
          people: {
            run: {
              run_id: peopleRun.run_id,
              list_id: peopleRun.list_id,
              kind: peopleRun.kind,
              status: peopleRun.status,
              stage: peopleRun.stage,
              round: peopleRun.round,
              progress: peopleRun.progress,
              counts: peopleRun.counts,
              error: peopleRun.error,
              is_live: peopleRun.is_live,
            },
          },
          url: getProspectListUrl(list_id),
          message: `Cards done (${cardsLine}). People run started over all ${entry_ids.length} companies — call wait_for_prospecting_run with run_id ${peopleRun.run_id}.`,
        }
      },
    }),

    // ─────────────────────────────────────────────────────────────────────
    // Watching a run
    // ─────────────────────────────────────────────────────────────────────
    wait_for_prospecting_run: tool({
      description:
        'Wait for a run to finish, polling with backoff for up to about four minutes. Runs no search. Returns as soon as the run reaches a terminal state: completed, failed, canceled, or budget_exhausted. budget_exhausted is an OUTCOME, not a failure — the run stopped early and KEPT every partial result; report what it found and ask whether to continue rather than apologising. Do not explain why it stopped: "it stopped early" is the whole story. If the wait times out you get still_running with the current progress: tell the user where it is up to and call this again, do NOT start a second run.',
      inputSchema: z.object({
        run_id: z.string().describe('The run id returned by a discovery/research/people call.'),
        max_wait_seconds: z
          .number()
          .int()
          .min(5)
          .max(240)
          .optional()
          .describe('How long to wait before returning still_running. Default 240 (4 minutes).'),
      }),
      execute: async ({ run_id, max_wait_seconds }) => {
        const budgetMs = Math.min(MAX_WAIT_MS, (max_wait_seconds ?? 240) * 1000)
        // Route to the RUN's own workspace: the run tools start a run in its
        // list's workspace, so a run started there must be watchable here.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'prospecting_run',
          run_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return toolError('Run not found', { code: 'NOT_FOUND' })
        const runWs = resolved.workspaceId
        const outcome = await pollRun(supabase, { workspaceId: runWs, runId: run_id, budgetMs })
        if ('error' in outcome) return outcome.error

        const name = await listName(supabase, runWs, outcome.run.list_id)
        if (outcome.done) {
          const run = outcome.run
          // A settled DISCOVERY run hands off to a profile run automatically
          // (the engine chains it the moment discovery finishes). Report it so
          // the model waits for the scores instead of reading an unscored list
          // back as the result.
          const followUp = await followUpRun(supabase, runWs, run)
          const settled =
            run.status === 'budget_exhausted'
              ? 'Stopped early. Everything it found so far is kept.'
              : `Run ${run.status}.`
          return {
            success: true,
            done: true,
            ...runSummary(run),
            list_name: name,
            /** Named separately so the model does not have to know which
             *  statuses are the "stopped early but fine" ones. */
            budget_exhausted: run.status === 'budget_exhausted',
            /** The profile run discovery handed off to, when there is one:
             *  live right now, scoring every company that was just found. */
            follow_up_run: followUp ? runSummary(followUp) : null,
            url: getProspectListUrl(run.list_id),
            message: followUp
              ? `${settled} Discovery has handed off to the profile run (run_id ${followUp.id}), which is scoring every company it found — call wait_for_prospecting_run on that run before reading the list back.`
              : settled,
          }
        }

        return {
          success: true,
          done: false,
          still_running: true,
          ...runSummary(outcome.run),
          list_name: name,
          url: getProspectListUrl(outcome.run.list_id),
          message:
            'Still running. Tell the user where it is up to and call wait_for_prospecting_run again — do not start another run.',
        }
      },
    }),

    get_prospecting_run_candidates: tool({
      description:
        'The full candidate ledger for one run, grouped by outcome and — within suppressed — by the rule that caught each one (already in this list, already in the CRM, on another list, dismissed as a competitor, already contacted, opted out, a personal domain, us, over the per-company limit, a platform host). Runs no search. This is how you answer "why did it only find six?" with the actual reasons instead of a guess.',
      inputSchema: z.object({
        run_id: z.string().describe('The run to explain.'),
      }),
      execute: async ({ run_id }) => {
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'prospecting_run',
          run_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return toolError('Run not found', { code: 'NOT_FOUND' })
        const runWs = resolved.workspaceId
        const result = await listRunCandidates(supabase, { workspaceId: runWs, runId: run_id })
        if (!result.ok) return toolError(result.error, { code: result.code })
        return {
          success: true,
          run_id,
          // The list this run was building. Carried so the chat can offer an
          // "Open list" chip off an explanation — the moment the user has just
          // been told why only six were found is the moment they want to look.
          list_id: result.run.list_id,
          list_name: await listName(supabase, runWs, result.run.list_id),
          url: getProspectListUrl(result.run.list_id),
          total: result.total,
          status: result.run.status,
          counts: result.run.counts,
          groups: result.groups.map((group) => ({
            outcome: group.outcome,
            reason: group.reason,
            count: group.count,
            // The candidates themselves carry a `raw` blob per row; only the
            // names are useful for explaining a suppression, and the full
            // ledger can run to hundreds of rows.
            examples: group.candidates.slice(0, 10).map((c) => ({
              name: c.display_name,
              identity_key: c.identity_key,
              angle: c.discovery_angle,
              link: c.link,
            })),
          })),
        }
      },
    }),

    cancel_prospecting_run: tool({
      description:
        'Stop a live run. Runs no search, and it KEEPS every partial result — the entries already written stay on the list. Use it when the user says stop, or when they change the ICP mid-run and the rest of the search would be wasted. Only queued and running runs can be canceled; anything else has already finished.',
      inputSchema: z.object({
        run_id: z.string().describe('The run to stop.'),
      }),
      execute: async ({ run_id }) => {
        // Route to the RUN's own workspace — a run_id copied out of another
        // workspace the user belongs to is canceled there, never silently
        // reported not-found because the lookup stayed pinned to the session
        // workspace.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'prospecting_run',
          run_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return toolError('Run not found', { code: 'NOT_FOUND' })
        const targetWs = resolved.workspaceId

        const result = await requestCancel(supabase, { workspaceId: targetWs, runId: run_id })
        if (!result.ok) return toolError(result.error, { code: result.code })
        return {
          success: true,
          ...runSummary(result.run),
          list_name: await listName(supabase, targetWs, result.run.list_id),
          url: getProspectListUrl(result.run.list_id),
          message: 'Cancel requested. Partial results are kept.',
        }
      },
    }),

    // ─────────────────────────────────────────────────────────────────────
    // Triage and the CRM handoff
    // ─────────────────────────────────────────────────────────────────────
    save_prospect_entries: tool({
      description:
        'Keep entries ON THE LIST — the curation step, only when the user asks. Runs no search and writes NOTHING to the CRM: a saved company keeps the people found beneath it, a saved person keeps its company, and saving a dismissed entry brings it back. The Saved chip on the page is the list the user is building; the CRM sees none of it until publish_prospect_list. Returns per-entry outcomes and per-list counts in `by_list` — read those numbers, do not tally `saved` yourself.',
      inputSchema: z.object({
        entry_ids: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe('Entry ids to keep on their list. Max 100 per call.'),
      }),
      execute: async ({ entry_ids }) => {
        // No list_id to anchor on — route EACH entry individually to its own
        // resolved workspace, then call saveEntriesToList once PER workspace
        // group (it only accepts one workspaceId per call). The common case
        // (one selection, one list, one workspace) is exactly one group and
        // one call, byte-identical to before.
        const { groups, notFound } = await groupEntriesByWorkspace(
          supabase,
          userId,
          workspaceId,
          entry_ids,
          strictWorkspace,
        )
        const saved: PromotedEntry[] = []
        const skipped: SkippedEntry[] = notFound.map((entry_id) => ({
          entry_id,
          list_id: '',
          reason: 'not_found',
        }))
        const listWorkspaces = new Map<string, string>()
        for (const [ws, ids] of groups) {
          const result = await saveEntriesToList(supabase, { workspaceId: ws, userId, entryIds: ids })
          if (!result.ok) return toolError(result.error, { code: result.code })
          saved.push(...result.saved)
          skipped.push(...result.skipped)
          for (const e of [...result.saved, ...result.skipped]) {
            if (e.list_id) listWorkspaces.set(e.list_id, ws)
          }
        }
        return {
          success: true,
          saved,
          skipped,
          saved_count: saved.length,
          skipped_count: skipped.length,
          ...(await perListReport(supabase, (listId) => listWorkspaces.get(listId) ?? workspaceId, {
            saved,
            skipped,
          })),
          message:
            'On the list — not in the CRM. Publish the list (publish_prospect_list) when the user is ready for these to become real companies and contacts.',
        }
      },
    }),

    publish_prospect_list: tool({
      description:
        "PUBLISH the list into the CRM — needs the user's go-ahead. The ONLY thing that writes to the CRM: every company and person saved on the list that the CRM does not hold yet becomes a real company/contact row, grouped under the list so the CRM can filter by it. Incremental — a second publish adds only what is new; nothing pending is a successful no-op. Runs no search. A person skipped as needs_review is the namesake gate — surface WHO and let the user confirm that one by name; only then call again with entry_ids holding THAT ONE id and include_unverified. Returns per-list counts in `by_list` (read those, do not tally `saved` yourself) and `sequenceable_contact_ids` for enroll_contacts_in_sequence.",
      inputSchema: z.object({
        list_id: z.string().describe('The list to publish.'),
        entry_ids: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Publish only these entries — the per-person confirm. Omit to publish everything pending on the list.',
          ),
        include_unverified: z
          .boolean()
          .optional()
          .describe(
            'Override the needs_review identity gate. NEVER for a batch — only with entry_ids holding ONE id the user explicitly confirmed by name.',
          ),
        confirmed_with_user: confirmedSchema.describe(
          'True only after the user said yes to publishing THIS list into the CRM in their last message. False, or omitted, refuses and writes nothing.',
        ),
      }),
      execute: async ({ list_id, entry_ids, include_unverified, confirmed_with_user }) => {
        const refusal = goAheadRefusal(confirmed_with_user, 'publishing the list into the CRM')
        if (refusal) return refusal
        if (include_unverified && (!entry_ids || entry_ids.length !== 1)) {
          return toolError(
            'Refused: include_unverified is a per-row override, not a bulk switch. Pass entry_ids with the ONE id the user confirmed by name.',
          )
        }

        // Route to the LIST's own workspace — before either branch spends
        // anything or writes to the CRM.
        const list = await resolveListWorkspace(supabase, userId, workspaceId, list_id, strictWorkspace)
        if (!list.ok) return list.error
        const targetWs = list.workspaceId

        const result = entry_ids
          ? await publishEntries(supabase, {
              workspaceId: targetWs,
              userId,
              entryIds: entry_ids,
              includeUnverified: include_unverified === true,
            })
          : await publishList(supabase, { workspaceId: targetWs, userId, listId: list_id })
        if (!result.ok) return toolError(result.error, { code: result.code })
        const name =
          'list_name' in result && result.list_name !== undefined
            ? result.list_name
            : await listName(supabase, targetWs, list_id)
        return {
          success: true,
          published: true,
          list_id,
          list_name: name,
          saved: result.saved,
          skipped: result.skipped,
          saved_count: result.saved.length,
          skipped_count: result.skipped.length,
          published_at: result.published_at,
          ...(await perListReport(supabase, () => targetWs, result)),
          /** The contact ids that can actually be sequenced: a person with no
           *  email cannot be enrolled, and reporting that per-row beats a
           *  toast that swallows it. */
          sequenceable_contact_ids: result.saved
            .filter((s) => s.kind === 'person' && s.contact_id && s.email)
            .map((s) => s.contact_id as string),
          url: getProspectListUrl(list_id),
          message:
            result.saved.length === 0
              ? 'Nothing new to publish — everything saved on this list is already in the CRM.'
              : `Published. These rows are in the CRM now, grouped under the list.`,
        }
      },
    }),

    dismiss_prospect_entries: tool({
      description:
        `Dismiss entries — ONLY when the user asks you to. Never dismiss on your own judgement about fit; a low score is information for the user, not a decision for you. Runs no search, and it never touches the CRM: the entry stays so it keeps suppressing future discoveries of the same company. Confirm ONCE per batch before calling, naming the count — and when the reason is competitor or already_customer, say out loud that it suppresses that company in EVERY list in this workspace, not just this one. Reasons ${PROSPECT_DISMISSED_REASONS.join(', ')}. Pass stage "discovered" to UNDO a dismissal.`,
      inputSchema: z.object({
        entry_ids: z.array(z.string()).min(1).max(100).describe('Entries to dismiss (or restore).'),
        reason: z
          .enum(PROSPECT_DISMISSED_REASONS)
          .optional()
          .describe(
            `Why. ${PROSPECT_GLOBAL_DISMISS_REASONS.join(' and ')} suppress WORKSPACE-WIDE — say so before you use them. The rest are list-relative.`,
          ),
        stage: z
          .enum(['dismissed', 'discovered', 'shortlisted'])
          .optional()
          .describe(
            'Default "dismissed". Pass "discovered" to undo a dismissal, or "shortlisted" to mark keepers.',
          ),
        confirmed_with_user: z
          .boolean()
          .describe(
            'True only when the user asked for this dismissal and you confirmed the batch with them. Set false and the call is refused.',
          ),
      }),
      execute: async ({ entry_ids, reason, stage, confirmed_with_user }) => {
        if (!confirmed_with_user) {
          return toolError(
            'Refused: dismissal happens only when the user asks. Confirm the batch with them first — say how many entries and, for competitor / already_customer, that it suppresses the company in every list in this workspace — then call again with confirmed_with_user true.',
          )
        }
        const targetStage = stage ?? 'dismissed'
        const results: Array<{ entry_id: string; ok: boolean; error?: string }> = []
        /** The lists the rows we actually updated belong to. `updateEntryStage`
         *  returns the updated row, so this is read from what was written
         *  rather than from what was asked for: an id that failed (or that
         *  belongs to another workspace) contributes nothing. */
        const touched: Array<{ list_id: string }> = []
        for (const entryId of entry_ids) {
          // No list_id to anchor on — route THIS entry to its own resolved
          // workspace before touching it, same as save_prospect_entries.
          const resolved = await resolveEntityWorkspace(
            supabase,
            userId,
            'prospect_list_entry',
            entryId,
            workspaceId,
            strictWorkspace,
          )
          if (!resolved) {
            results.push({ entry_id: entryId, ok: false, error: 'Entry not found' })
            continue
          }
          const result = await updateEntryStage(supabase, {
            workspaceId: resolved.workspaceId,
            entryId,
            userId,
            stage: targetStage,
            dismissedReason: targetStage === 'dismissed' ? reason : undefined,
          })
          if (result.ok) {
            const listId = result.entry?.list_id
            if (typeof listId === 'string' && listId) touched.push({ list_id: listId })
          }
          results.push(
            result.ok
              ? { entry_id: entryId, ok: true }
              : { entry_id: entryId, ok: false, error: result.error },
          )
        }
        const failed = results.filter((r) => !r.ok)
        const globalReason =
          targetStage === 'dismissed' &&
          reason !== undefined &&
          (PROSPECT_GLOBAL_DISMISS_REASONS as readonly ProspectDismissedReason[]).includes(reason)
        return {
          success: failed.length === 0,
          stage: targetStage,
          reason: reason ?? null,
          updated: results.length - failed.length,
          failed,
          /** Which lists changed. The list page watches these to know whether
           *  a dismissal that happened in the chat was on the list it is
           *  showing, and reload if so. */
          list_ids: distinctListIds(touched),
          suppresses_workspace_wide: globalReason,
          message: globalReason
            ? `Dismissed as ${reason} — these companies are now suppressed in every list in this workspace.`
            : `${results.length - failed.length} entries moved to ${targetStage}.`,
        }
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The distinct list ids across a set of per-entry outcomes, in first-seen
 *  order. First-seen and not sorted: the order the entries were processed is
 *  the order the user selected them in, and a caller rendering "Series A
 *  fintechs and 1 other" should name the one they were looking at. Empty ids
 *  (a `not_found` skip has no row and so no list) are dropped. */
/**
 * One save or publish, broken down PER LIST and already counted. The prompt
 * tells the model to read these numbers rather than tally `saved` itself — a
 * model counting an array of forty objects gets it wrong often enough to
 * matter, and this is the sentence the user actually hears. `list_ids` is
 * every list the call touched, in first-seen order: a selection made in chat
 * can span lists, and the list page reads these to know whether the outcome
 * it is being told about is its own.
 *
 * `resolveWs` supplies the workspace to read EACH list's name from, rather
 * than one flat workspaceId: `publish_prospect_list` is anchored on a single
 * already-resolved list, so it always returns the same workspace, but
 * `save_prospect_entries` has no list_id to anchor on and its selection can
 * legitimately span lists in DIFFERENT workspaces — reading every list's name
 * with the session's workspaceId would silently null out the name of any list
 * that was actually routed elsewhere.
 */
async function perListReport(
  supabase: SupabaseClient,
  resolveWs: (listId: string) => string,
  result: PromoteResult,
): Promise<{
  list_ids: string[]
  by_list: Array<{
    list_id: string
    list_name: string | null
    saved_companies: number
    saved_people: number
    needs_review: number
    skipped_other: number
  }>
}> {
  const listIds = distinctListIds([...result.saved, ...result.skipped])
  return {
    list_ids: listIds,
    by_list: await Promise.all(
      listIds.map(async (listId) => ({
        list_id: listId,
        list_name: await listName(supabase, resolveWs(listId), listId),
        saved_companies: result.saved.filter((e) => e.list_id === listId && e.kind === 'company')
          .length,
        saved_people: result.saved.filter((e) => e.list_id === listId && e.kind === 'person')
          .length,
        /** The namesake gate, counted apart from every other skip: it is the
         *  only one the user can act on, by confirming a person by name. */
        needs_review: result.skipped.filter(
          (e) => e.list_id === listId && e.reason === 'needs_review',
        ).length,
        skipped_other: result.skipped.filter(
          (e) => e.list_id === listId && e.reason !== 'needs_review',
        ).length,
      })),
    ),
  }
}

/**
 * Route by a LIST's own workspace — the one resolve every list-anchored tool
 * shares (`update_prospect_list`, `publish_prospect_list`, and the run-start
 * tools). The not-found shape ('List not found', NOT_FOUND) matches what
 * `createList` / `updateList` / `createRun` already return for a list_id that
 * plain does not exist, so a caller-visible refusal never changes shape
 * depending on WHY the id could not be resolved.
 */
async function resolveListWorkspace(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  listId: string,
  strictWorkspace: boolean,
): Promise<{ ok: true; workspaceId: string } | { ok: false; error: ReturnType<typeof toolError> }> {
  const resolved = await resolveEntityWorkspace(
    supabase,
    userId,
    'prospect_list',
    listId,
    workspaceId,
    strictWorkspace,
  )
  if (!resolved) return { ok: false, error: toolError('List not found', { code: 'NOT_FOUND' }) }
  return { ok: true, workspaceId: resolved.workspaceId }
}

/**
 * Group entry ids by the workspace they actually live in, for the two tools
 * that take a bare list of entry_ids with no list_id to anchor on
 * (`save_prospect_entries`, `dismiss_prospect_entries`). `saveEntriesToList`
 * and `updateEntryStage` each take exactly ONE explicit `workspaceId` for the
 * whole call, so a selection spanning two workspaces has to become two calls
 * — never one call scoped to the session's, which is exactly the bug this
 * whole protocol exists to close. An id that fails to resolve (unknown, or a
 * non-member workspace under the ordinary cross-workspace probe) is reported
 * in `notFound` rather than dropped silently.
 */
async function groupEntriesByWorkspace(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  entryIds: string[],
  strictWorkspace: boolean,
): Promise<{ groups: Map<string, string[]>; notFound: string[] }> {
  const groups = new Map<string, string[]>()
  const notFound: string[] = []
  for (const id of entryIds) {
    const resolved = await resolveEntityWorkspace(
      supabase,
      userId,
      'prospect_list_entry',
      id,
      workspaceId,
      strictWorkspace,
    )
    if (!resolved) {
      notFound.push(id)
      continue
    }
    const bucket = groups.get(resolved.workspaceId)
    if (bucket) bucket.push(id)
    else groups.set(resolved.workspaceId, [id])
  }
  return { groups, notFound }
}

function distinctListIds(entries: Array<{ list_id?: string | null }>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    const listId = entry.list_id
    if (typeof listId !== 'string' || !listId) continue
    if (seen.has(listId)) continue
    seen.add(listId)
    out.push(listId)
  }
  return out
}

/**
 * The NAME of a list, for the chat's entity chip.
 *
 * Every tool output that names a `list_id` also carries `list_name`, and this
 * is the one read that supplies it. Without it the chat rendered "Open list"
 * for a chip the user had just named themselves — the id is what the code
 * needs and the name is the only part of it a person can recognise.
 *
 * It is a deliberate second query rather than a join onto each lib call: those
 * functions serve the routes too, and widening `createRun`'s return to carry a
 * display string for one caller is a worse trade than a `select('name')` on a
 * primary key. Failure is NOT an error — a run that started is still news, so a
 * name that could not be read degrades to null and the chip falls back to
 * "Open list".
 */
async function listName(
  supabase: SupabaseClient,
  workspaceId: string,
  listId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('prospect_list')
      .select('name')
      .eq('id', listId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) {
      console.error('[prospecting-tools] list name read failed:', error.message)
      return null
    }
    const name = (data as { name?: unknown } | null)?.name
    return typeof name === 'string' && name.trim() !== '' ? name : null
  } catch (err) {
    console.error('[prospecting-tools] list name read threw:', err)
    return null
  }
}

/** The outcome of one poll loop: either the run settled, or the wait budget ran
 *  out with the run still going. Shared by `wait_for_prospecting_run` and
 *  `find_prospects`, which must agree about what "done" means — a second copy
 *  of TERMINAL_STATUSES is how a leg-2 start fires over a leg-1 that failed. */
type PollOutcome =
  | { done: true; run: ProspectingRunSnapshot }
  | { done: false; run: ProspectingRunSnapshot }
  | { error: ReturnType<typeof toolError> }

/** The run shape both the poll loop and `runSummary` read. */
type ProspectingRunSnapshot = Parameters<typeof runSummary>[0] & { status: string }

/**
 * Poll one run to a terminal status, or until `budgetMs` elapses.
 *
 * FACTORED OUT rather than duplicated because `find_prospects` waits on its
 * card leg with exactly the schedule `wait_for_prospecting_run` uses, and the
 * two must not drift: the cadence bounds how long one tool call can hold the
 * model, and the terminal set decides whether a second, paid leg is allowed to
 * start. Two copies of either is a way to bill someone twice.
 */
async function pollRun(
  supabase: SupabaseClient,
  args: { workspaceId: string; runId: string; budgetMs: number },
): Promise<PollOutcome> {
  const startedAt = Date.now()
  let attempt = 0
  let last: Awaited<ReturnType<typeof getRun>> | null = null

  for (;;) {
    last = await getRun(supabase, { workspaceId: args.workspaceId, runId: args.runId })
    if (!last.ok) return { error: toolError(last.error, { code: last.code }) }

    if (TERMINAL_STATUSES.has(last.run.status)) return { done: true, run: last.run }

    const elapsed = Date.now() - startedAt
    const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]
    if (elapsed + delay >= args.budgetMs) break
    await sleep(delay)
    attempt += 1
  }

  return { done: false, run: last.run }
}

/**
 * Kick off a run of any kind and report it. Shared by the four spending tools
 * so the error mapping — especially RUN_ALREADY_LIVE, which is a normal thing
 * that happens and not something to retry — has exactly one wording.
 *
 * `listNameHint` lets a caller that has ALREADY read the name (find_prospects,
 * which reads the list before it validates the selection) pass it in rather
 * than paying for a second identical read per leg.
 */
async function startRun(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    listId: string
    kind: 'discover' | 'account_card' | 'people'
    entryIds?: string[]
    budgetDollars?: number
    listNameHint?: string | null
  },
) {
  const result = await createRun(supabase, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    listId: args.listId,
    kind: args.kind,
    entryIds: args.entryIds,
    budgetDollars: args.budgetDollars,
  })
  if (!result.ok) {
    if (result.code === 'RUN_ALREADY_LIVE') {
      return toolError(
        'A run is already live on this list. Wait for it with wait_for_prospecting_run (or cancel it) — do not start another; only one run per list can be in flight.',
        { code: result.code },
      )
    }
    if (result.code === 'LIST_ARCHIVED') {
      return toolError('That list is archived, so it cannot be run.', { code: result.code })
    }
    return toolError(result.error, { code: result.code })
  }
  const name =
    args.listNameHint !== undefined
      ? args.listNameHint
      : await listName(supabase, args.workspaceId, args.listId)
  // Queue-on-click: a people request while a people search is already live
  // on the list JOINS that search (createRun appends to it). Say so — the
  // model must follow the run it was handed, not wonder why no new one began.
  const joined = result.joined
  const added = joined?.appended.length ?? 0
  return {
    success: true,
    ...runSummary(result.run),
    list_name: name,
    ...(joined ? { joined_live_run: true, appended: added } : {}),
    message: joined
      ? added === 0
        ? `A people search is already running on this list and every one of these companies is already on it (run_id ${result.run.id}). Poll it with wait_for_prospecting_run.`
        : `A people search was already running on this list, so ${added === 1 ? 'this company was' : `these ${added} companies were`} added to it (run_id ${result.run.id}). Poll it with wait_for_prospecting_run.`
      : `Run started. Poll it with wait_for_prospecting_run (run_id ${result.run.id}).`,
    url: getProspectListUrl(args.listId),
  }
}

/**
 * The caller's email address, for the source-company domain guess.
 *
 * Read from the session rather than taken as a parameter because `createTools`
 * is constructed with a user ID and a client, not an email — and the ONE place
 * that needs the address is a fallback guess. A service-role client has no
 * session, so this comes back null there and `research_my_company` then
 * requires an explicit `domain`, which is the honest degradation.
 */
async function callerEmail(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser()
    return data?.user?.email ?? null
  } catch {
    return null
  }
}

/** The ICP-card fields off a company row's enrichment blob, flattened to
 *  `{ key: value }` — the model does not need the confidence/source envelope
 *  to read a sentence back to the user. */
function readEnrichmentFields(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const enrichment = (metadata as Record<string, unknown>).enrichment
  if (!enrichment || typeof enrichment !== 'object' || Array.isArray(enrichment)) return {}
  const fields = (enrichment as Record<string, unknown>).fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(fields as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && 'value' in (entry as Record<string, unknown>)) {
      out[key] = (entry as Record<string, unknown>).value
    } else {
      out[key] = entry
    }
  }
  return out
}

/** Dollars, to the cent, for the numbers the model reads aloud. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}
