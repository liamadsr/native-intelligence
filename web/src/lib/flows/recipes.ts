/**
 * The opt-in loop recipes (P9; eve-alignment.md §5b "Recipes the agent can
 * set up on request", flows-connectors.md §3). Capabilities, not defaults:
 * nothing here is seeded or switched on for anyone. The person asks in their
 * own words; the agent builds the recipe with `create_flow { recipe,
 * enabled: true }`, which saves it ON because they asked (the one exception,
 * a webhook step, is no recipe's), and says the loop in one line.
 *
 * A recipe is the canonical shape of one loop: its trigger and steps, in the
 * same flat form create_flow takes, so it goes through exactly the same
 * validators, skill checks, lens guard and switch-on rules as a loop built
 * field by field. The defaults are decision 3's and the plans' (3 posts a
 * week, Monday morning; the newsletter on Friday), each changeable by asking.
 *
 *   weekly_posts            "Draft X posts every week": a weekly schedule →
 *                           the weekly-posts skill → post_drafts. The server
 *                           reads the week's material (content/post-week.ts);
 *                           a slow week brings ideas. The first setup also
 *                           makes the person's content-brief:<surface> canon
 *                           document, empty, for the agent to fill by
 *                           inference.
 *   call_moments            "…from my calls": the content lens on
 *                           capture_processed. It rides the ONE Triage read of
 *                           each call and keeps the person's own moments for
 *                           weekly_posts. Build it beside weekly_posts when
 *                           they want their calls in it.
 *   product_doc_from_calls  "Keep our product doc current from customer
 *                           calls": the marketing lens (external calls only,
 *                           owners and admins only), at most one batch of
 *                           product-doc edits a day, one digest line.
 *   you_asked_we_shipped    "When we ship something customers asked for, tell
 *                           them": a project or milestone completed, an
 *                           action reaching a done state, or a pull request
 *                           merged → the shipped-note skill → email_drafts to
 *                           exactly the people who asked (never sent). With
 *                           `launch_kit`, a second step writes the public
 *                           side as a document: a post draft and a changelog
 *                           line, from the shipped work only.
 *   weekly_newsletter       "Write my newsletter every Friday": a weekly
 *                           schedule → the content-newsletter skill → a document the
 *                           person shapes in the chat and copies into their
 *                           own tool. Native Intelligence never sends it (decision 9).
 *   ci_fix_loop             "Fix failing CI on the PRs Native Intelligence opens" (P10
 *                           F7): a pr_status_changed loop on one repo whose
 *                           run_agent step is marked fix_ci. The step runs
 *                           nothing; the loop switched on is its owner's
 *                           opt-in: a failing check on a PR their own coding
 *                           run opened there gets a fix run, at most 2 per PR,
 *                           then a "CI still red" card (src/lib/coding/
 *                           ci-fix.ts). Without it, nothing happens. Not held
 *                           to the run_agent dispatch switch (it starts
 *                           coding runs of the person's own PRs, like Start).
 *   small_bug_draft_prs     "Open draft PRs for small bugs from my calls"
 *                           (P10 F4, decision 12): a capture_processed step
 *                           marked attempt_small_bugs that rides Triage's one
 *                           read. A developer work_proposal the pre-check
 *                           finds small and clear becomes an action and a
 *                           coding run; only the reviewer's approve opens a
 *                           PR, always a draft (src/lib/coding/proactive.ts).
 *                           At most 2 a day. It is a run_agent step, so
 *                           create_flow refuses it while this server doesn't
 *                           dispatch coding agents (RUN_AGENT_DISPATCH_ENABLED,
 *                           off on PROD): that is the real switch.
 *
 * Pure: no I/O.
 */
import { POST_SURFACE_NAME, POST_SURFACES, type PostSurface } from '@/lib/content/post-draft'
import { DEFAULT_POST_SLOTS, MAX_POST_SLOTS } from '@/lib/content/post-week'

/**
 * The system skills the recipes run, by their FIXED ids (migrations 382,
 * 388-390), never by slug (P9 review S3): a workspace or personal skill with
 * the same slug outranks a system one in the skill lookup, and would quietly
 * take the recipe over (one already exists on PROD for \`newsletter\`), and with
 * it the server's guards (\`material\`, the askers-only filter).
 */
export const RECIPE_SKILL_IDS = {
  'content-lens': '8ef0cb7e-6c81-4da5-9deb-a967dc16aa30',
  'marketing-lens': 'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb',
  'weekly-posts': '80d160c4-1b4a-481d-8b76-aa7fc1609326',
  'shipped-note': '02c801d7-a5c9-4a4b-92b4-bb952ae7cd26',
  'launch-kit': 'f67944ea-eb9e-4297-abbc-4da1afc3c031',
  'content-newsletter': 'd53ec7d9-10c9-476f-ba39-06b9f261bff1',
} as const

export const FLOW_RECIPES = ['weekly_posts', 'call_moments', 'product_doc_from_calls', 'you_asked_we_shipped', 'weekly_newsletter', 'small_bug_draft_prs', 'ci_fix_loop'] as const
export type FlowRecipe = (typeof FLOW_RECIPES)[number]

export function isFlowRecipe(value: unknown): value is FlowRecipe {
  return typeof value === 'string' && (FLOW_RECIPES as readonly string[]).includes(value)
}

/** What a person can change about a recipe by asking. */
export interface RecipeOptions {
  /** weekly_posts: the platform (x by default). */
  surface?: PostSurface
  /** weekly_posts: posts a week, 1-5 (3 by default). */
  slots?: number
  /** Schedules: 0 Sunday … 6 Saturday. */
  weekday?: number
  /** Schedules: "HH:mm" in the zone. */
  time?: string
  /** Schedules: an IANA zone (else the person's). */
  timezone?: string
  /** you_asked_we_shipped: what shipping means: a project or milestone completed (default project), or an action reaching `to_status_id`. */
  entity_type?: 'project' | 'milestone' | 'action'
  /** you_asked_we_shipped on actions: the done state's id (list_workflow_states). */
  to_status_id?: string
  /** you_asked_we_shipped on pull requests: the repo, "owner/repo"; a merge ships. */
  repo_full_name?: string
  /** you_asked_we_shipped: also write the launch kit (a post draft and a changelog line) as a document. */
  launch_kit?: boolean
  /** small_bug_draft_prs: the project whose repo the bugs go to (else the only project with a repo). */
  project_id?: string
}

/** One step, in create_flow's flat action form. */
export type RecipeAction =
  | {
      id: string
      type: 'run_skill'
      /** The system skill's fixed id (RECIPE_SKILL_IDS). */
      skill: string
      parent_id?: string
      deliver_to?: 'document' | 'post_drafts' | 'email_drafts'
      post_surface?: PostSurface
      post_slots?: number
      document_title?: string
    }
  | {
      id: string
      type: 'run_agent'
      /** No agent or repo of its own: both are resolved per bug (proactive.ts). */
      use_triggering_action_context: true
      attempt_small_bugs: true
      project_id?: string
    }
  | {
      id: string
      type: 'run_agent'
      /** No agent or repo of its own: a fix run takes the PR run's (ci-fix.ts). */
      use_triggering_action_context: true
      fix_ci: true
    }

/** The trigger, in create_flow's form. */
export type RecipeTrigger =
  | { type: 'schedule'; cadence: 'weekly'; weekday: number; time: string; timezone?: string }
  | { type: 'capture_processed' }
  | { type: 'entity_status_change'; entity_type: 'project' | 'milestone' | 'action'; to_status_id: string }
  | { type: 'pr_status_changed'; repo_full_name: string; pr_state: 'merged' | 'open' }

export interface RecipeFlow {
  recipe: FlowRecipe
  name: string
  description: string
  trigger: RecipeTrigger
  actions: RecipeAction[]
  /** A personal canon document the first setup makes, empty, for the agent to fill by inference. */
  brief?: string
  /** What the agent tells the person in its one line (the loop's summary carries the rest). */
  note: string
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function weekday(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6 ? value : fallback
}

function time(value: unknown, fallback: string): string {
  return typeof value === 'string' && TIME_RE.test(value.trim()) ? value.trim() : fallback
}

function zone(value: unknown): { timezone?: string } {
  return typeof value === 'string' && value.trim() ? { timezone: value.trim() } : {}
}

/** A recipe's loop, with the person's options over the defaults, or an Error naming the field to fix. Pure. */
export function recipeFlow(recipe: FlowRecipe, options: RecipeOptions = {}): RecipeFlow | Error {
  switch (recipe) {
    case 'weekly_posts': {
      const surface: PostSurface = options.surface && (POST_SURFACES as readonly string[]).includes(options.surface) ? options.surface : 'x'
      if (options.slots !== undefined && (!Number.isInteger(options.slots) || options.slots < 1 || options.slots > MAX_POST_SLOTS)) {
        return new Error(`recipe_options.slots must be a whole number from 1 to ${MAX_POST_SLOTS}`)
      }
      const slots = options.slots ?? DEFAULT_POST_SLOTS
      const where = POST_SURFACE_NAME[surface]
      return {
        recipe,
        name: `Weekly ${where} posts`,
        description: `${slots} ${where} post${slots === 1 ? '' : 's'} a week as For you cards, from what you ship, publish and say on your calls; a slow week brings ideas. You post each one.`,
        trigger: { type: 'schedule', cadence: 'weekly', weekday: weekday(options.weekday, 1), time: time(options.time, '09:00'), ...zone(options.timezone) },
        actions: [{ id: 'posts', type: 'run_skill', skill: RECIPE_SKILL_IDS['weekly-posts'], deliver_to: 'post_drafts', post_surface: surface, post_slots: slots }],
        brief: `content-brief:${surface}`,
        note: `Each week up to ${slots} ${where} post cards; at most ${slots} wait at once and an untouched one goes after 7 days. Nothing is posted for you.`,
      }
    }
    case 'call_moments':
      return {
        recipe,
        name: 'Post moments from my calls',
        description: 'Keeps the post-worthy moments you say on your calls (your own words, never a name or a number) for your weekly posts.',
        trigger: { type: 'capture_processed' },
        actions: [{ id: 'moments', type: 'run_skill', skill: RECIPE_SKILL_IDS['content-lens'] }],
        note: 'It rides the one read of each call; nothing is drafted or posted from it on its own.',
      }
    case 'product_doc_from_calls':
      return {
        recipe,
        name: 'Product doc from customer calls',
        description: 'Adds what customers say on external calls (objections, competitors, their words) to the product doc, at most once a day, graded by the evidence.',
        trigger: { type: 'capture_processed' },
        actions: [{ id: 'market', type: 'run_skill', skill: RECIPE_SKILL_IDS['marketing-lens'] }],
        note: 'External calls only, one batch of product-doc edits a day with one digest line; testimonials stay internal.',
      }
    case 'you_asked_we_shipped': {
      let trigger: RecipeTrigger
      if (typeof options.repo_full_name === 'string' && options.repo_full_name.trim()) {
        trigger = { type: 'pr_status_changed', repo_full_name: options.repo_full_name.trim(), pr_state: 'merged' }
      } else if (options.entity_type === 'action') {
        if (!options.to_status_id) return new Error('recipe_options.to_status_id is required for actions: the done state\'s id from list_workflow_states')
        trigger = { type: 'entity_status_change', entity_type: 'action', to_status_id: options.to_status_id }
      } else {
        trigger = { type: 'entity_status_change', entity_type: options.entity_type === 'milestone' ? 'milestone' : 'project', to_status_id: 'completed' }
      }
      const actions: RecipeAction[] = [{ id: 'notes', type: 'run_skill', skill: RECIPE_SKILL_IDS['shipped-note'], deliver_to: 'email_drafts' }]
      if (options.launch_kit) {
        actions.push({ id: 'kit', type: 'run_skill', skill: RECIPE_SKILL_IDS['launch-kit'], deliver_to: 'document', document_title: 'Launch kit — {{entity.name}}' })
      }
      return {
        recipe,
        name: 'You asked, we shipped',
        description: 'When something customers asked for ships, drafts a short note to each person who asked. The drafts wait in your mail; nothing is sent.',
        trigger,
        actions,
        note: `Drafts go only to the people who asked (on a call, in a claim or linked to the work) whom you're already in touch with${options.launch_kit ? ', plus a launch kit document with a post and a changelog line' : ''}. You send each one.`,
      }
    }
    case 'weekly_newsletter':
      return {
        recipe,
        name: 'Weekly newsletter',
        description: 'A newsletter draft from your week as a document you shape in the chat and copy into your own newsletter tool. Native Intelligence never sends it.',
        trigger: { type: 'schedule', cadence: 'weekly', weekday: weekday(options.weekday, 5), time: time(options.time, '15:00'), ...zone(options.timezone) },
        actions: [{ id: 'newsletter', type: 'run_skill', skill: RECIPE_SKILL_IDS['content-newsletter'], deliver_to: 'document', document_title: 'Newsletter — {date}' }],
        note: 'A document each week; ask here to change it, then copy it into Substack, HubSpot or wherever you send from. Nothing is sent.',
      }
    case 'ci_fix_loop': {
      const repo = typeof options.repo_full_name === 'string' ? options.repo_full_name.trim() : ''
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        return new Error('recipe_options.repo_full_name is required: the repo ("owner/repo") whose pull requests it fixes, from list_projects')
      }
      return {
        recipe,
        name: `Fix failing CI on Native Intelligence's PRs in ${repo}`,
        description: `When a check fails on a pull request one of your coding runs opened in ${repo}, a coding agent fixes it on a side branch; only a fix the reviewer approves moves the pull request. At most 2 fix runs per pull request, then a "CI still red" card.`,
        trigger: { type: 'pr_status_changed', repo_full_name: repo, pr_state: 'open' },
        actions: [{ id: 'ci', type: 'run_agent', use_triggering_action_context: true, fix_ci: true }],
        note: 'Only pull requests your own coding runs opened; never anyone else\'s branch. It fixes the code, never the check.',
      }
    }
    case 'small_bug_draft_prs': {
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (options.project_id !== undefined && !(typeof options.project_id === 'string' && UUID.test(options.project_id))) {
        return new Error('recipe_options.project_id must be a project id from list_projects')
      }
      return {
        recipe,
        name: 'Draft PRs for small bugs from my calls',
        description: 'When a small, clear bug comes up on a call, a coding agent fixes it and a reviewer on another model checks the diff. Only an approved fix becomes a draft pull request in For you; you mark it ready.',
        trigger: { type: 'capture_processed' },
        actions: [
          {
            id: 'bugs',
            type: 'run_agent',
            use_triggering_action_context: true,
            attempt_small_bugs: true,
            ...(options.project_id ? { project_id: options.project_id } : {}),
          },
        ],
        note: 'At most 2 a day, small and clear bugs only, each one a draft you review; anything unclear stays a card.',
      }
    }
  }
}
