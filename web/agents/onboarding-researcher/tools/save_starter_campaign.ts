/**
 * save_starter_campaign — seed ONE starter campaign for a Marketing-role
 * workspace, so a marketer's first screen already names the thing their
 * meetings and notes will hang off.
 *
 * WHY only marketing: "anchors are configuration" gives each workspace the
 * entity type its knowledge attaches to — projects for engineering, companies
 * for sales, CAMPAIGNS for marketing. `save_starter_content` seeds the project
 * side; this is its campaign counterpart, and the instructions gate it on the
 * brief's `roles` containing Marketing. (The agent is told when to call it; the
 * tool itself does not read the brief, so it stays a plain write.)
 *
 * Owner-derivation: workspace_id comes ONLY from the verified session principal
 * (requireOwner). The schema carries no tenant field — the model describes WHAT
 * to seed, never WHERE. Same invariant as save_starter_content.
 *
 * IDEMPOTENT under replay AND re-run: the campaign id is a pure function of the
 * workspace (lib/seed-id.ts) and the write is an upsert with ignoreDuplicates,
 * so a second call lands on the same row and no-ops. The first run's content
 * wins.
 *
 * Status is always 'planned'. A campaign the agent invented has not started;
 * marking it active would put a fiction on the user's board.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { requireOwner, serviceClient, NoOwnerError } from '../lib/tool-context.js'
import { deriveStarterCampaignId } from '../lib/seed-id.js'

const NAME_CAP = 120
const OBJECTIVE_CAP = 500
const DESCRIPTION_CAP = 2000
/** Keep the channel list short and real; extras past this are dropped. */
const MAX_CHANNELS = 6
const CHANNEL_CAP = 40

export default defineTool({
  description:
    'Seed the brand-new workspace with ONE starter marketing campaign. Call ' +
    'this at most once, and ONLY when the brief\'s roles include Marketing — ' +
    'it is the marketing counterpart to save_starter_content\'s starter ' +
    'project. Name it for what the user said they are working on (their ' +
    'focus), not for the company. Skip it entirely when you have no real ' +
    'focus to name — an invented campaign is worse than an empty list. Safe ' +
    'to call again: a repeat call upserts into the same deterministic row.',
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .describe('Short campaign name (2-5 words), derived from the user\'s focus.'),
    objective: z
      .string()
      .optional()
      .describe('One line on what the campaign is for, in the user\'s own terms.'),
    description: z
      .string()
      .optional()
      .describe('Optional longer detail — the fuller flavor of their focus.'),
    channels: z
      .array(z.string())
      .optional()
      .describe("Channels it runs on, e.g. ['email', 'linkedin']. Omit if unsure."),
  }),
  async execute(input, ctx) {
    let owner
    try {
      owner = requireOwner(ctx)
    } catch (err) {
      if (err instanceof NoOwnerError) return { success: false, error: err.message }
      throw err
    }
    const { workspaceId } = owner
    const supabase = serviceClient()

    // Clamp server-side: the schema's caps are advisory, these are law.
    const name = input.name.trim().slice(0, NAME_CAP)
    if (!name) return { success: false, error: 'name is empty after trimming.' }
    const objective = input.objective?.trim().slice(0, OBJECTIVE_CAP) || null
    const description = input.description?.trim().slice(0, DESCRIPTION_CAP) || null
    const channels = (input.channels ?? [])
      .map((c) => c.trim().slice(0, CHANNEL_CAP))
      .filter(Boolean)
      .slice(0, MAX_CHANNELS)

    const campaignId = deriveStarterCampaignId(workspaceId)

    const { error } = await supabase.from('campaign').upsert(
      {
        id: campaignId,
        workspace_id: workspaceId,
        name,
        objective,
        description,
        // Never 'active': this campaign is a suggestion the agent wrote, not
        // work the user has started.
        status: 'planned',
        channels,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    )
    if (error) return { success: false, error: `campaign insert failed: ${error.message}` }

    // Report the CANONICAL name: on a re-run, ignoreDuplicates means the first
    // call's name stands even if this one sent a different one, and the summary
    // must reflect what the user will actually see.
    const { data: saved } = await supabase
      .from('campaign')
      .select('name')
      .eq('id', campaignId)
      .maybeSingle<{ name: string }>()
    const canonicalName = saved?.name ?? name

    return {
      success: true,
      campaignId,
      campaignName: canonicalName,
      message: `Seeded campaign "${canonicalName}".`,
    }
  },
})
