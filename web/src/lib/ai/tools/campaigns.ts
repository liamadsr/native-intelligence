import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCreateWorkspace, resolveEntityWorkspace, workspaceEcho, type CreateWorkspacePolicy } from './_shared'
import { getServiceClient } from '@/lib/supabase/service'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { normalizeSteps } from '@/lib/sequences/mutations'
import { DEFAULT_SEND_WINDOW } from '@/lib/sequences/schedule'
import { getSequenceUrl } from '@/lib/sequences/urls'
import { approvedOutreach, launchSummary, type LaunchCardOrigin } from '@/lib/sequences/launch-card'
import {
  AUDIENCE_RELATIONSHIP_TYPES,
  CAMPAIGN_COLUMNS,
  describeAudience,
  parseAudience,
  type CampaignAudience,
} from '@/lib/campaigns/shape'
import { campaignCounts, describeCounts } from '@/lib/campaigns/counts'
import {
  executeCampaignLaunch,
  loadCampaignForLaunch,
  prepareCampaignLaunch,
  raiseCampaignCard,
} from '@/lib/campaigns/launch'
import { CAMPAIGN_RECIPES, recipeCampaign } from '@/lib/campaigns/recipes'

/**
 * Campaigns — Marketing's anchor entity.
 *
 * "Anchors are configuration" gives a marketing workspace CAMPAIGNS the way an
 * engineering one gets projects: the thing a claim is ABOUT. These three tools
 * are what lets an agent find the campaign it should be talking about, and
 * create the one the user just described.
 *
 * Modelled on companies.ts, with two differences that follow from campaign's
 * lean shape:
 *   - no `get_campaign_overview` equivalent: `list_campaigns` returns the whole
 *     row, so a second read-one tool would add a round trip and nothing else;
 *   - everything runs on the CALLER'S RLS-scoped client, not the service client.
 *     Campaign has a single member-only policy (migration 267) with no
 *     visibility fence to work around, so there is nothing a SECURITY DEFINER
 *     RPC would buy.
 *
 * DELETE is deliberately absent, for the same reason it is on companies: a
 * campaign is an anchor that claims and entity links point at, so removing one
 * silently orphans knowledge. Retiring a campaign is `status: 'archived'`.
 *
 * SENDING (roadmap D2): a campaign can now reach people. It names an
 * audience (a CRM filter or group), the sequence it sends, and whether it
 * keeps adding new matches each week (`rolling`). `launch_campaign` never
 * sends on a call: it raises the person's card naming every recipient and
 * every email (src/lib/campaigns/launch.ts), and on their yes enrolls exactly
 * those people and launches. The opt-out list, stop-on-reply and the send
 * window are the sequence engine's, as for any sequence. `create_campaign
 * { recipe: 'win_back' }` sets up the win-back campaign and its draft emails
 * in one call (src/lib/campaigns/recipes.ts). Sent / replied / opted-out
 * counts come back on every listed campaign that sends.
 *
 * WORKSPACE ROUTING (see _shared.ts "CREATE-TIME WORKSPACE ROUTING"):
 * `create_campaign` takes an optional `workspace_id` and resolves it through
 * `resolveCreateWorkspace`; `update_campaign` resolves the campaign's OWN
 * workspace through `resolveEntityWorkspace` before writing, so a campaign_id
 * copied out of another workspace the user belongs to routes there instead of
 * being silently reported not-found (or worse, matching nothing and no-oping).
 */

export const CAMPAIGN_STATUSES = [
  'planned',
  'active',
  'paused',
  'completed',
  'archived',
] as const

/** The audience, as the model passes it (parseAudience checks it again). */
const audienceSchema = z.object({
  relationship_types: z
    .array(z.enum(AUDIENCE_RELATIONSHIP_TYPES))
    .optional()
    .describe('CRM relationship types to include. Default: customers only (unless the audience is a group of tags or contacts).'),
  last_contacted_more_than_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Only people last in touch more than this many days ago, e.g. 180 for "haven\'t seen in 6+ months".'),
  include_never_contacted: z.boolean().optional().describe('With last_contacted_more_than_days: also people never in touch. Default false.'),
  tags_any: z.array(z.string()).optional().describe('A CRM group: contacts with at least one of these tags.'),
  contact_ids: z.array(z.string()).max(500).optional().describe('A group the person named: exactly these contacts (ids from list_contacts).'),
})

/** The launch card's context (index.ts threads it from createTools' options). */
export interface CampaignToolsContext {
  conversationId?: string | null
  /** Set ONLY when replaying an accepted card (src/lib/safety/approved-call.ts). */
  approvedCall?: ApprovedCall
  approvalContext?: LaunchCardOrigin['approvalContext']
  /** Nobody at the keyboard (a work run's or loop's own turns): no card to raise. */
  unattended?: boolean
}

/** The workspace's name (the business a recipe's emails sign off as), or null. */
async function workspaceName(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data } = await supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle()
  const name = (data as { name?: string | null } | null)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/** A sequence the campaign may send: one in the same workspace. */
async function sequenceInWorkspace(supabase: SupabaseClient, sequenceId: string, workspaceId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase.from('sequence').select('id, name').eq('id', sequenceId).eq('workspace_id', workspaceId).maybeSingle()
  return (data as { id: string; name: string } | null) ?? null
}

/** ISO calendar date (what the `date` columns accept), or null to clear. */
const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use an ISO date, e.g. 2026-03-01')

/**
 * `userId` is optional and TRAILING, unlike its siblings — the lean campaign
 * table still carries no `created_by` column (ownership is `owner_member_id`,
 * which the caller sets explicitly), so it is not stamped onto any row. It
 * exists solely to run the workspace-routing membership checks in
 * `resolveCreateWorkspace` / `resolveEntityWorkspace` below. Until a caller
 * threads a real one, an explicit foreign `workspace_id` / cross-workspace
 * `campaign_id` cannot be routed (the membership probe has no user to check),
 * which is the same "inert until threaded" staging `index.ts` describes for
 * `createWorkspacePolicy` — the session-only paths (no `workspace_id`, no
 * cross-workspace `campaign_id`) are unaffected either way.
 */
export function createCampaignTools(
  supabase: SupabaseClient,
  workspaceId: string,
  userId?: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  ctx: CampaignToolsContext = {},
) {
  return {
    list_campaigns: tool({
      description:
        'List the campaigns in this workspace, most recently updated first, with objective, status, channels and date window, and for a campaign that sends: its audience in words, its sequence, whether it is rolling, and its counts (recipients, sent, replied, opted_out, active). Use this to answer "what are we running" or "how is the win-back doing", to find a campaign_id, or to check whether a campaign already exists before creating a duplicate.',
      inputSchema: z.object({
        status: z
          .enum(CAMPAIGN_STATUSES)
          .optional()
          .describe('Only campaigns in this status.'),
        search: z
          .string()
          .optional()
          .describe('Match against campaign name (case-insensitive substring).'),
        limit: z.number().int().min(1).max(200).optional().default(50).describe('Max results (default 50, max 200).'),
        offset: z.number().optional().describe('Skip this many results — for paging.'),
      }),
      execute: async ({ status, search, limit, offset }) => {
        const from = offset ?? 0
        const size = Math.min(limit ?? 50, 200)
        let query = supabase
          .from('campaign')
          .select(CAMPAIGN_COLUMNS)
          .eq('workspace_id', workspaceId)
          .order('updated_at', { ascending: false })
          .range(from, from + size - 1)

        if (status) query = query.eq('status', status)
        // Escape the LIKE metacharacters so a user searching for "50%" gets a
        // literal match instead of a wildcard.
        if (search?.trim()) {
          query = query.ilike('name', `%${search.trim().replace(/[%_]/g, '\\$&')}%`)
        }

        const { data, error } = await query
        if (error) return { success: false, error: error.message }

        const campaigns = (data ?? []) as Array<Record<string, unknown>>
        const sending = campaigns.filter((c) => typeof c.sequence_id === 'string')
        if (sending.length === 0) return { success: true, count: campaigns.length, campaigns }
        let counts: Awaited<ReturnType<typeof campaignCounts>>
        try {
          counts = await campaignCounts(supabase, {
            workspaceId,
            campaigns: sending.map((c) => ({ id: c.id as string, sequence_id: c.sequence_id as string, stats: (c.stats as Record<string, number> | null) ?? null })),
          })
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
        return {
          success: true,
          count: campaigns.length,
          campaigns: campaigns.map((c) => {
            const n = counts.get(c.id as string)
            return {
              ...c,
              ...(c.audience ? { audience_text: describeAudience(c.audience as CampaignAudience) } : {}),
              ...(n ? { counts: n, counts_text: describeCounts(n) } : {}),
            }
          }),
        }
      },
    }),

    create_campaign: tool({
      description:
        'Create a campaign — a named push with an objective, the channels it runs on, and an optional date window. A campaign that SENDS also names an audience (a CRM filter or group) and the sequence it sends (sequence_id, from create_sequence); it sends nothing until launch_campaign gets the person\'s yes. For "win back customers we haven\'t seen in N months", pass recipe "win_back" (recipe_options.months, 6 by default): it creates the campaign AND its draft emails in one call; tailor the copy to the business with update_sequence, then launch_campaign. Check list_campaigns first; a campaign already on file should be updated, not duplicated. New campaigns start as "planned" unless you say otherwise.',
      inputSchema: z.object({
        name: z.string().min(1).optional().describe('Short campaign name, e.g. "Spring product launch". Required unless a recipe names it.'),
        recipe: z.enum(CAMPAIGN_RECIPES).optional().describe('Set up a ready-made campaign: "win_back" (lapsed customers, two check-in emails, rolling weekly).'),
        recipe_options: z
          .object({ months: z.number().int().min(1).max(36).optional().describe('win_back: months since the last touch (default 6).') })
          .optional(),
        audience: audienceSchema.optional().describe('Who it sends to: a CRM filter or group. Every part given must hold.'),
        sequence_id: z.string().optional().describe('The sequence it sends (create_sequence first).'),
        rolling: z.boolean().optional().describe('Each week, people newly matching the audience get a launch card of their own. Default false.'),
        objective: z
          .string()
          .optional()
          .describe('What the campaign is for, in one line — e.g. "Drive 200 demo requests from mid-market ops teams".'),
        description: z.string().optional().describe('Longer detail, plan, or notes.'),
        status: z
          .enum(CAMPAIGN_STATUSES)
          .optional()
          .describe(`One of: ${CAMPAIGN_STATUSES.join(', ')}. Defaults to planned.`),
        channels: z
          .array(z.string())
          .optional()
          .describe("Channels it runs on, e.g. ['email', 'linkedin', 'events']."),
        starts_on: dateField.optional().describe('Start date (YYYY-MM-DD).'),
        ends_on: dateField.optional().describe('End date (YYYY-MM-DD).'),
        owner_member_id: z
          .string()
          .optional()
          .describe('UUID of the workspace MEMBER who runs it (list_workspace_members).'),
        tags: z.array(z.string()).optional(),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async (input) => {
        const ws = await resolveCreateWorkspace(supabase, userId ?? '', workspaceId, input.workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // A recipe fills what it knows: the campaign, its audience and a draft
        // sequence of its own (the person's options over the defaults).
        const recipe = input.recipe
          ? recipeCampaign(input.recipe, input.recipe_options ?? {}, ws.workspaceName ?? (await workspaceName(supabase, targetWs)) ?? 'us')
          : null
        if (recipe instanceof Error) return { success: false, error: recipe.message }
        const name = (input.name?.trim() || recipe?.name || '').trim()
        if (!name) return { success: false, error: 'name is required' }

        let audience: CampaignAudience | null = recipe?.audience ?? null
        if (input.audience) {
          const parsed = parseAudience(input.audience)
          if (!parsed.ok) return { success: false, error: parsed.error }
          audience = parsed.audience
        }

        let sequenceId: string | null = null
        let sequenceName: string | null = null
        if (input.sequence_id) {
          const seq = await sequenceInWorkspace(supabase, input.sequence_id, targetWs)
          if (!seq) return { success: false, error: 'sequence_id is not a sequence in this workspace' }
          sequenceId = seq.id
          sequenceName = seq.name
        } else if (recipe) {
          const steps = normalizeSteps(recipe.sequence.steps)
          if (!steps.ok) return { success: false, error: steps.error }
          const { data: seq, error: seqError } = await supabase
            .from('sequence')
            .insert({
              workspace_id: targetWs,
              name: recipe.sequence.name,
              description: recipe.sequence.description,
              status: 'draft',
              created_by: userId ?? null,
              timezone: 'America/Los_Angeles',
              send_window: DEFAULT_SEND_WINDOW,
              delay_unit: 'business',
            })
            .select('id, name')
            .single()
          if (seqError || !seq) return { success: false, error: seqError?.message || 'Failed to create the recipe\'s sequence' }
          const { error: stepsError } = await supabase
            .from('sequence_step')
            .insert(steps.steps.map((st) => ({ sequence_id: seq.id, ...st })))
          if (stepsError) {
            await supabase.from('sequence').delete().eq('id', seq.id).eq('workspace_id', targetWs)
            return { success: false, error: `Failed to create the recipe's emails: ${stepsError.message}` }
          }
          sequenceId = seq.id as string
          sequenceName = seq.name as string
        }

        const { data, error } = await supabase
          .from('campaign')
          .insert({
            workspace_id: targetWs,
            name,
            objective: input.objective?.trim() || recipe?.objective || null,
            description: input.description?.trim() || recipe?.description || null,
            status: input.status ?? 'planned',
            channels: input.channels ?? (sequenceId ? ['email'] : []),
            starts_on: input.starts_on ?? null,
            ends_on: input.ends_on ?? null,
            owner_member_id: input.owner_member_id || null,
            tags: input.tags ?? [],
            sequence_id: sequenceId,
            audience,
            rolling: input.rolling ?? recipe?.rolling ?? false,
            recipe: recipe?.recipe ?? null,
          })
          .select(CAMPAIGN_COLUMNS)
          .single()

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          campaign: data,
          ...(audience ? { audience_text: describeAudience(audience) } : {}),
          ...(sequenceId ? { sequence: { id: sequenceId, name: sequenceName, url: getSequenceUrl(sequenceId) } } : {}),
          ...workspaceEcho(targetWs, ws.workspaceName),
          message: recipe
            ? `Created the "${name}" campaign with a draft sequence (nothing sends yet). ${recipe.note} Next: show or tailor the emails (get_sequence, update_sequence), then launch_campaign for the person's yes.`
            : `Created campaign: "${(data as { name: string }).name}"${sequenceId && audience ? '. It sends nothing until launch_campaign gets the person\'s yes.' : ''}`,
        }
      },
    }),

    update_campaign: tool({
      description:
        'Update a campaign — name, objective, status, channels, dates, owner, tags, and for one that sends: its audience, its sequence and whether it is rolling. Only the fields you pass are touched, so a partial update never blanks anything. Use list_campaigns to find the campaign_id. Pausing a rolling campaign stops its weekly cards. To retire a campaign, set status to "archived" (there is no delete). Nothing here sends: that is launch_campaign.',
      inputSchema: z.object({
        campaign_id: z.string().describe('UUID of the campaign.'),
        name: z.string().optional(),
        objective: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(CAMPAIGN_STATUSES).optional(),
        channels: z.array(z.string()).optional(),
        starts_on: dateField.optional(),
        ends_on: dateField.optional(),
        owner_member_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
        audience: audienceSchema.optional().describe('Who it sends to (replaces the whole audience).'),
        sequence_id: z.string().optional().describe('The sequence it sends.'),
        rolling: z.boolean().optional().describe('Each week, people newly matching get a launch card of their own.'),
      }),
      execute: async ({ campaign_id, audience, sequence_id, ...input }) => {
        // Same rule as update_company: a key that was not passed is not
        // written, so a partial update never blanks a field.
        const updates: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(input)) {
          if (value === undefined) continue
          updates[key] = typeof value === 'string' ? value.trim() || null : value
        }
        if (audience !== undefined) {
          const parsed = parseAudience(audience)
          if (!parsed.ok) return { success: false, error: parsed.error }
          updates.audience = parsed.audience
        }
        if (Object.keys(updates).length === 0 && sequence_id === undefined) {
          return { success: false, error: 'Pass at least one field to change' }
        }
        updates.updated_at = new Date().toISOString()

        // Route to the campaign's OWN workspace: a campaign_id copied out of
        // another workspace the user belongs to must update THAT row, never
        // silently match nothing because the write stayed pinned to the
        // session workspace.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId ?? '',
          'campaign',
          campaign_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Campaign not found' }
        const targetWs = resolved.workspaceId

        if (sequence_id !== undefined) {
          const seq = await sequenceInWorkspace(supabase, sequence_id, targetWs)
          if (!seq) return { success: false, error: 'sequence_id is not a sequence in this campaign\'s workspace' }
          updates.sequence_id = seq.id
        }

        const { data, error } = await supabase
          .from('campaign')
          .update(updates)
          .eq('id', campaign_id)
          .eq('workspace_id', targetWs)
          .select(CAMPAIGN_COLUMNS)
          .maybeSingle()

        if (error) return { success: false, error: error.message }
        if (!data) return { success: false, error: 'Campaign not found' }
        return {
          success: true,
          campaign: data,
          updated_fields: Object.keys(updates).filter((k) => k !== 'updated_at'),
        }
      },
    }),

    launch_campaign: tool({
      description:
        "Launch a campaign: send its sequence to its audience. It never sends on the call: it finds who the audience reaches today (leaving out anyone on the opt-out list, already in the sequence, or in another sequence) and gives the person ONE approval card showing every email, when each goes, the mailbox it sends from and every recipient (up to 200; more wait for the next card). Only on their yes (the card in the app, or texting back \"yes\" with the card's code) are exactly those people enrolled and the sequence launched. Replies stop a person's emails. A rolling campaign then gets a card each week for people newly matching. Needs an audience and a sequence (create_campaign or update_campaign). Tell the person in a line or two what sends (what_sends) and that it waits for their yes; don't call it again while the card waits.",
      inputSchema: z.object({
        campaign_id: z.string().describe('UUID of the campaign.'),
      }),
      execute: async ({ campaign_id }) => {
        const launcher = userId ?? ''
        const resolved = await resolveEntityWorkspace(supabase, launcher, 'campaign', campaign_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Campaign not found' }
        const targetWs = resolved.workspaceId
        if (!launcher) return { success: false, error: 'Launching needs the person it sends as.' }

        let campaign: Awaited<ReturnType<typeof loadCampaignForLaunch>>
        try {
          campaign = await loadCampaignForLaunch(supabase, { workspaceId: targetWs, campaignId: campaign_id })
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
        if (!campaign) return { success: false, error: 'Campaign not found' }

        // The person said yes on the card: enroll and launch exactly who it named.
        const approved = approvedOutreach(ctx.approvedCall, 'launch_campaign', 'campaign', campaign.id)
        if (approved) {
          const outcome = await executeCampaignLaunch(supabase, { workspaceId: targetWs, campaign, userId: launcher, approved })
          if (!outcome.ok) return { success: false, code: outcome.code, error: outcome.error, ...(outcome.failures ? { failures: outcome.failures } : {}) }
          return {
            success: true,
            launched: true,
            campaign_id: campaign.id,
            enrolled: outcome.enrolled,
            armed_enrollments: outcome.armed,
            skipped_count: outcome.skipped.length,
            message: `Launched “${campaign.name}”: step 1 goes to ${outcome.armed} ${outcome.armed === 1 ? 'person' : 'people'} in the next send window${outcome.skipped.length ? ` (${outcome.skipped.length} skipped: opted out or already in a sequence)` : ''}. A reply stops their emails.`,
          }
        }

        if (ctx.unattended && !ctx.approvalContext) {
          return {
            success: false,
            code: 'NEEDS_PERSON',
            error: "Launching waits for the person's yes, and nobody is here to give it. Leave the launch to them.",
          }
        }
        const prep = await prepareCampaignLaunch(supabase, { workspaceId: targetWs, campaign, userId: launcher })
        if (!prep.ok) return { success: false, code: prep.code, error: prep.error, ...(prep.failures ? { failures: prep.failures } : {}) }
        if (prep.recipients.length === 0) {
          return {
            success: false,
            code: 'NO_RECIPIENTS',
            error: `Nobody in the audience (${describeAudience(prep.audience)}) can be sent to right now: ${prep.matched} matched; ${prep.skipped.opted_out} opted out, ${prep.skipped.already_in_sequence} already in this sequence, ${prep.skipped.in_another_sequence} in another one.`,
          }
        }
        const held = await raiseCampaignCard(getServiceClient(), {
          prep,
          userId: launcher,
          origin: { conversationId: ctx.conversationId ?? null, approvalContext: ctx.approvalContext },
        })
        const later = prep.eligible.length - prep.recipients.length
        return {
          success: false,
          code: 'APPROVAL_REQUIRED',
          approval_id: held.ok ? held.approval_id : null,
          what_sends: launchSummary({ plan: prep.plan, recipients: prep.recipients }),
          audience_text: describeAudience(prep.audience),
          skipped: prep.skipped,
          ...(later > 0 ? { not_on_this_card: later } : {}),
          message: held.ok
            ? `Nothing has sent yet. The person has a card to launch “${campaign.name}” to ${prep.recipients.length} ${prep.recipients.length === 1 ? 'person' : 'people'}${later > 0 ? ` (${later} more wait for the next card)` : ''}; it sends only on their yes. Tell them in a line or two what it sends (what_sends) and that it waits for their OK. By text they get a code to reply with right after your message: don't write a code yourself. Don't call launch_campaign again.`
            : `Nothing was sent, and no card could be made: ${held.error}`,
        }
      },
    }),
  }
}
