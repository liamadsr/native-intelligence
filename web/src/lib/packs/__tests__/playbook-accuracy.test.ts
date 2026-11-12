/**
 * Every playbook and area skill teaches the agent with names, so a name that
 * doesn't exist teaches it to call nothing. This holds each seeded text (316
 * and 319, as 322, 323 and 324 rewrote them, and the skills 322, 323 and 324 add) to
 * the code:
 *   - tools: a backticked bare identifier is a TOOL_CATEGORIES tool (any
 *     area's: real requests cross areas) or a core tool the chat always has
 *     (`search_tools`), a known system skill, or a word
 *     that text lists on purpose as not a tool (a field, a value). The list
 *     is per text, so a typo can't hide behind a word another text uses;
 *   - skills: every skill a text names (`find-email`, `build-prospect-list`) is seeded or
 *     tagged as a system skill;
 *   - cards: the fields a `show` sentence filters on are real
 *     FILTERABLE_FIELDS of the entity it shows;
 *   - chat-only tools: which ones each text names is pinned, so a new one is
 *     a decision (a playbook also runs in background runs, where the
 *     background note has to cover it);
 *   - size, by the packs' own estimate: a core (`<area>-playbook`) at most
 *     2,000 tokens, since every touched area's core is paid again at each
 *     compaction; a 323/324 recipe 150 to 900; any other area skill at most 1,200.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ATTENDED_ONLY_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { CORE_TOOL_NAMES } from '@/lib/ai/tool-ceiling-core'
import { FILTERABLE_FIELDS } from '@/lib/views/types'
import { CARD_LIST_ENTITIES, type CardListEntity } from '@/lib/chat-cards/kinds'
import { estimateTokens } from '../memory'
import { BACKGROUND_PERSON_STEPS_NOTE } from '../render'
import { allShippedSkills, readMigration, seededSkills } from './playbook-seeds'

/** The registry's tools, plus the core ones the chat always has that live outside it (`search_tools`, `ask_user`). */
const TOOL_NAMES: ReadonlySet<string> = new Set([...TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name)), ...CORE_TOOL_NAMES])

/**
 * The chat-agent's own eve tools a text may name (not registry tools, so never
 * on MCP or in a skill run's registry): the quick `helpers` (main chat only)
 * and `update_plan` (main chat, skill and work runs). 338's helper lines name
 * them, always conditionally ("if you have `helpers`"). Each is a file in
 * agents/chat-agent/tools/.
 */
const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['helpers', 'update_plan'])

const seeded = allShippedSkills()

/** System skill slugs 316 tagged that a later migration renamed: no text may name them. */
const RENAMED_AWAY: ReadonlySet<string> = new Set(['scout']) // 322: now `build-prospect-list`

/**
 * The system skills a text may name: those 316 tags with an area (each
 * checked present on DEV when 316 landed), less the ones renamed since, and
 * the ones 316, 319 and 322 seed.
 */
const SYSTEM_SKILLS: ReadonlySet<string> = new Set([
  ...[...readMigration('316_skill_area_and_playbooks.sql').matchAll(/AND slug IN \(([^)]*)\)/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((s) => s[1]))
    .filter((slug) => !RENAMED_AWAY.has(slug)),
  ...seeded.map((s) => s.slug),
  // 382's lens skills: the content and marketing playbooks name them for the call-watching recipes.
  ...seededSkills('382_lens_skills.sql').map((s) => s.slug),
])

/**
 * Per text, the backticked words that are deliberately not tools: parameters,
 * result fields, enum values. Keep each to what its text uses (a test fails on
 * a stale entry), and never put a tool name here.
 */
const NOT_TOOLS: Record<string, readonly string[]> = {
  // A1c meetings-mail: rewritten in 325.
  'mail-playbook': [
    'account', 'all_time', 'archive', 'body_text', 'confirmed_with_user', 'email', 'folder', 'from_account', 'in_reply_to',
    'last_message_id', 'mail', 'max_drafts', 'max_results', 'needs_reply', 'previous_draft_id', 'query', 'read', 'thread_id',
    'thread_ids', 'types', 'undo', 'unread',
  ],
  // A1c meetings-mail: rewritten in 325; find_times' answer (suggested, free, unknown) in 551; its teammates (people, coverage)
  // and the working hours' availability_sharing in 553; offer_times' send_by (link, email, text) in 580; its recipients (a poll) in 584.
  'calendar-playbook': [
    'account_email', 'attendees', 'availability_sharing', 'calendar', 'capture_status', 'coverage', 'description', 'email', 'end', 'end_date',
    'event_id', 'free', 'from', 'hours_ahead', 'link', 'local_exchange', 'location', 'max_results', 'participant_email', 'people', 'recipients', 'send_by',
    'since', 'start', 'start_date', 'suggested', 'text', 'title', 'truncated', 'unknown', 'view',
  ],
  'actions-playbook': [
    'assignee', 'assignee_id', 'assignee_name', 'confirmation', 'due_at', 'filter', 'has_more', 'id', 'identifier', 'is_relative',
    'label_ids', 'limit', 'offset', 'project_id', 'project_name', 'since', 'status', 'status_name', 'status_type', 'summary', 'team_id',
    'team_name', 'time_field', 'title_match', 'total', 'until', 'user_id', 'verbose', 'why',
  ],
  // A1c meetings-mail: rewritten in 325.
  'captures-playbook': [
    'additional_context', 'ai_processed', 'all_time', 'capture_id', 'confirmation', 'has_more', 'has_transcript', 'include_transcript',
    'is_relative', 'limit', 'next_offset', 'offset', 'possibly_you', 'project_id', 'proposal_id', 'proposal_ids', 'reason', 'since',
    'started_at', 'status', 'time_field', 'title', 'transcript_has_more', 'transcript_next_offset', 'until', 'verbose',
  ],
  // A1c docs-goals-tools: rewritten in 327; documents phase 1 tools in 368.
  'documents-playbook': [
    'base_revision', 'change_summary', 'content', 'created_by', 'id', 'include_preps', 'include_reports', 'is_pinned', 'kind', 'limit', 'lines',
    'match', 'old_text', 'overwrite', 'project_id', 'revision', 'section', 'since', 'status', 'team_id', 'time_field', 'title', 'types', 'until',
  ],
  'knowledge-playbook': [
    'all_time', 'cites', 'claim_status', 'company_id', 'confirmation', 'cross_workspace', 'direction', 'domain', 'group_by_change',
    'include_provenance', 'relation', 'rules', 'since', 'source_id', 'source_text', 'status', 'subject_member_id', 'team_id', 'time_field',
    'type', 'types', 'until',
  ],
  // A1c docs-goals-tools: rewritten in 327.
  'initiatives-playbook': [
    'filter', 'health', 'include_archived', 'initiative_id', 'is_overdue', 'label_ids', 'labels', 'name', 'name_match', 'owner_id',
    'progress_pct', 'project_id', 'since', 'status', 'target_date', 'time_field', 'until',
  ],
  'projects-playbook': [
    'end_date', 'filter', 'has_more', 'include_archived', 'initiative_id', 'is_archived', 'label_ids', 'lead_id', 'milestone_id', 'name',
    'name_match', 'offset', 'open_actions_total', 'project_id', 'project_name', 'roll_to_next', 'since', 'start_date', 'status', 'status_type',
    'target_date', 'team_id', 'time_field',
  ],
  'flows-playbook': [
    'action_results', 'actions', 'bearer_token', 'body_template', 'bot_character', 'cadence', 'condition', 'confirmed_with_user',
    'enabled', 'event_title', 'field', 'fire_on_agent_changes', 'flow_id', 'headers', 'id', 'method', 'mode', 'offset_minutes', 'parent_id',
    'skill', 'status', 'summary', 'time', 'timezone', 'to_status_id', 'trigger', 'type', 'url', 'weekday',
  ],
  // A1c crm-outreach: crm, prospecting, sequences and campaigns rewritten in 326.
  'crm-playbook': [
    'company', 'company_id', 'contact_count', 'contact_id', 'domain', 'employee_count_range', 'enrichment_status', 'full_name',
    'industry', 'interaction_count', 'last_interaction_at', 'name', 'next_followup_at', 'offset', 'people_on_record', 'prospect_list_ids',
    'relationship_strength', 'relationship_type', 'send_email', 'source', 'speaker_label', 'tags', 'voice_match_confidence',
  ],
  'prospecting-playbook': [
    'already_customer', 'budget_exhausted', 'by_list', 'competitor', 'confirmed_with_user', 'follow_up_run', 'include_archived',
    'include_unverified', 'kind', 'list_id', 'matched', 'min_fit_score', 'needs_review', 'prospect_list_ids', 'reason',
    'sequenceable_contact_ids', 'stage', 'still_running', 'target', 'whole_list_entry_counts',
  ],
  'sequences-playbook': [
    'already_active', 'body', 'contact_id', 'days', 'delay_days', 'delay_unit', 'end_hour', 'enrollment_id', 'enrollment_limit', 'id',
    'no_email', 'not_found', 'send_window', 'sequence_id', 'sequenceable_contact_ids', 'start_hour', 'status', 'step_order', 'subject',
    'suppressed', 'target', 'timezone',
  ],
  // 461: a campaign that sends (its audience's fields, its sequence, rolling, the win_back recipe).
  'campaigns-playbook': ['audience', 'channels', 'contact_ids', 'ends_on', 'id', 'offset', 'owner_member_id', 'recipe', 'rolling', 'sequence_id', 'starts_on', 'status', 'tags', 'tags_any'],
  // A1c docs-goals-tools: evals, browser and library rewritten in 327.
  'evals-playbook': [
    'adopted', 'case_id', 'case_ids', 'chunk_count', 'error_code', 'expected', 'forbidden_proposals', 'include_trace', 'is_self', 'key',
    'local_1', 'mode', 'must_have', 'name', 'no_nudge_windows', 'nudges', 'participants', 'polarity', 'proposals', 'remote_1', 'remote_2',
    'rubric', 'run_id', 'script', 'speaker_label', 'suite_id', 'suite_kind', 'summary', 't_ms', 'target', 'target_kind', 'target_recipe_id',
    'tools', 'trials_per_case',
  ],
  'browser-playbook': ['completion', 'goal', 'max_chars', 'max_wait_seconds', 'pending', 'run_id', 'success', 'tab_id'],
  'library-playbook': ['description', 'id', 'mine', 'mine_only', 'name', 'system_prompt', 'target', 'visibility'],
  'write-in-your-tone': ['account', 'body_text', 'draft_id', 'from_account', 'in_reply_to', 'previous_draft_id', 'thread_id', 'tone'],
  'clear-inbox': [
    'account', 'archive', 'confirmed_with_user', 'draft_id', 'from_account', 'in_reply_to', 'last_message_id', 'max_drafts', 'max_results',
    'previous_draft_id', 'thread_id', 'thread_ids', 'tone',
  ],
  'build-prospect-list': [
    'by_list', 'confirmed_with_user', 'domain', 'entry_ids', 'fit_rationale', 'follow_up_run', 'joined_live_run', 'needs_domain',
    'needs_go_ahead', 'needs_review', 'sequenceable_contact_ids',
  ],
  // 323's recipes.
  'my-todo-list': [
    'assignee', 'assignee_id', 'confirmation', 'due_at', 'filter', 'has_more', 'id', 'is_overdue', 'limit', 'offset', 'project_name',
    'status_type', 'total',
  ],
  'overdue-work': [
    'assignee', 'assignee_id', 'confirmation', 'due_at', 'filter', 'has_more', 'id', 'limit', 'offset', 'project_id', 'status_type',
    'team_id', 'team_name', 'why',
  ],
  'project-status-update': [
    'assignee_id', 'due_at', 'filter', 'group_by_change', 'has_more', 'limit', 'offset', 'open_actions_total', 'progress_pct',
    'project_id', 'since', 'time_field',
  ],
  'what-do-we-know': ['all_time', 'include_provenance', 'limit', 'type'],
  'whats-changed': ['filter', 'group_by_change', 'include_provenance', 'project_id', 'since', 'time_field'],
  'everything-about': ['assignee', 'company_id', 'contact_id', 'limit', 'open_actions_total', 'project_id', 'subject_member_id'],
  'find-anything': ['all_time', 'project_id', 'query', 'since', 'status', 'types'],
  // 324's recipe.
  'build-a-workflow': [
    'actions', 'bearer_token', 'body_template', 'cadence', 'confirmed_with_user', 'enabled', 'event_title', 'field', 'flow_id', 'id',
    'instructions', 'mode', 'name', 'offset_minutes', 'skill', 'summary', 'time', 'timezone', 'to_status_id', 'trigger', 'url', 'weekday',
  ],
  // A1c docs-goals-tools: 327's recipes; write-a-document's documents phase 1 tools in 370.
  'write-a-document': ['base_revision', 'capture_id', 'content', 'id', 'project_id', 'revision', 'title'],
  'initiative-review': ['filter', 'group_by_change', 'initiative_id', 'is_overdue', 'name', 'progress_pct', 'project_id', 'since', 'time_field'],
  // A1c crm-outreach: 326's recipes (build-prospect-list, rewritten in 326, is above).
  'stale-relationships': [
    'company_id', 'interaction_count', 'last_interaction_at', 'limit', 'next_followup_at', 'offset', 'relationship_type', 'send_email', 'why',
  ],
  'launch-a-sequence': [
    'already_active', 'company_id', 'contact_ids', 'id', 'no_email', 'not_found', 'relationship_type',
    'sequence_id', 'sequenceable_contact_ids', 'status', 'suppressed', 'target',
    // 461: launch_sequence's summary of what sends (in place of reading the schedule fields).
    'what_sends',
  ],
  // A1c meetings-mail: 325's recipes (write-in-your-tone and clear-inbox, rewritten in 325, are above; meeting-prep is the 159 row).
  'meeting-prep': ['all_time', 'attendees', 'domain', 'email', 'event_id', 'max_results', 'participant_email'],
  // 551: find_times' inputs and answer in place of reading the events; 553: its teammates (people); 584: a poll's offer_times (recipients, co_hosts).
  'find-a-time': [
    'attendees', 'buffer_minutes', 'co_hosts', 'duration_minutes', 'end', 'free', 'from', 'location', 'people', 'recipients', 'start', 'suggested', 'time_zone', 'title',
    'to', 'unknown', 'working_hours_are_default',
  ],
  'meeting-recap': ['capture_id', 'has_more', 'next_offset', 'project_id', 'since'],
  // P8: content (384) and marketing (385).
  // P9 (391): the recipes by name, built with create_flow's `recipe`.
  // P12: a recipe the person asks for is built with `enabled` true (on).
  'content-playbook': ['call_moments', 'enabled', 'idea', 'recipe', 'recipe_options', 'since', 'status', 'time_field', 'weekly_newsletter', 'weekly_posts'],
  'x-post': ['parts', 'sources'],
  'linkedin-post': ['sources'],
  'marketing-playbook': ['enabled', 'launch_kit', 'product_doc_from_calls', 'recipe', 'recipe_options', 'you_asked_we_shipped'],
  'brand-context': [],
  'marketing-positioning': [],
  'marketing-messaging': [],
  'customer-language': [],
  'battle-card': [],
  'content-planning': [],
  // The SEO skills: `confirmed_with_user` is the argument a paid, repeating or costly call takes after the person's yes.
  'seo-guide': ['confirmed_with_user'],
  'seo-site-audit': [],
  'seo-keywords': ['confirmed_with_user'],
  'seo-competitors': [],
  'seo-rank-tracking': ['confirmed_with_user'],
  'seo-performance': [],
  'seo-backlinks': [],
  'seo-ai-visibility': ['confirmed_with_user'],
  'seo-local': ['confirmed_with_user'],
  'seo-report': ['enabled'],
  'meeting-follow-up': [
    'account', 'additional_context', 'body', 'capture_id', 'from_account', 'in_reply_to', 'proposal_id', 'proposal_ids', 'reason', 'recipients', 'since', 'status',
    'subject', 'thread_id', 'to', 'tone', 'why',
  ],
}

/**
 * The chat-only tools (ATTENDED_ONLY_TOOL_NAMES) each text names. A playbook
 * is also read by background runs, which don't hold these; the background
 * note (render.ts) tells them to leave such steps for the person. Changing
 * this map is a decision: check the sentence still reads as a step for the
 * person, not one a run can do.
 */
const CHAT_ONLY_NAMED: Record<string, readonly string[]> = {
  'actions-playbook': ['read_card'],
  'find-anything': ['read_card'],
  // GEN-1166: tidying and unsubscribing are the person's asks, in the main chat.
  'mail-playbook': ['revise_email_draft', 'unsubscribe_thread', 'update_email_thread'],
  'captures-playbook': ['undo_extraction_pass'],
  'write-in-your-tone': ['remember', 'revise_email_draft'],
  'clear-inbox': ['revise_email_draft', 'update_email_thread'],
  // The loop builders (A1b): building or switching on a loop is the person's step.
  'flows-playbook': ['create_flow', 'delete_flow', 'update_flow'],
  'build-a-workflow': ['create_flow', 'update_flow'],
  // The skill writers: saving or rewriting a skill is the person's step, said in chat.
  'library-playbook': ['create_skill', 'update_skill'],
  'evals-playbook': ['update_skill'],
  // Rolling a page back is the person's step, asked for in the chat (368).
  'documents-playbook': ['restore_document_revision'],
  // P8: a post's fresh-eyes review needs the chat (the writer's model rides its envelope); a loop is built in chat.
  // P9: posting through Typefully is the person's approval card, raised only in their chat.
  // P12: a recipe they ask for is created on, so update_flow is no longer taught here.
  'content-playbook': ['create_flow', 'publish_post', 'review_post', 'schedule_post'],
  'x-post': ['review_post'],
  'linkedin-post': ['review_post'],
  'marketing-playbook': ['create_flow'],
  // The weekly SEO report is a loop the person asks for in chat, built on (and switched on after their yes if it saved off).
  'seo-report': ['create_flow', 'update_flow'],
  // 551: changing the working hours is the person's step, on what they said in the chat.
  // The working hours (551), and making a booking link (582): the person's own steps, in their chat.
  'calendar-playbook': ['create_booking_link', 'set_working_hours'],
  'find-a-time': ['set_working_hours'],
}

/** The operators a `show` filter takes (show.ts filterSchema). */
const SHOW_OPERATORS: ReadonlySet<string> = new Set([
  'is', 'is_not', 'is_any_of', 'is_none_of', 'contains', 'does_not_contain', 'gt', 'gte', 'lt', 'lte', 'between',
  'is_relative', 'includes', 'excludes', 'is_empty', 'is_not_empty',
])

/** The token bounds per kind of text (estimated): a core, a 323/324 recipe, any other area skill. */
const CORE_MAX_TOKENS = 2000
const RECIPE_MIN_TOKENS = 150
// 900, not 800: 338 adds a helper passage (at most about 120 tokens) to the batch recipes.
const RECIPE_MAX_TOKENS = 900
const SKILL_MAX_TOKENS = 1200

/** The recipes 323 and 324 add (their rows that aren't a core). */
const RECIPES: ReadonlySet<string> = new Set(
  [
    '323_feature_skills_v2.sql',
    '324_workflows_skill.sql',
    // A1c docs-goals-tools
    '327_docs_goals_tools_skills.sql',
    // A1c crm-outreach (its build-prospect-list, now under 800, is held to the recipe bounds too)
    '326_crm_outreach_skills.sql',
    // A1c meetings-mail (its write-in-your-tone and clear-inbox are held to the recipe bounds too)
    '325_meetings_mail_skills.sql',
  ]
    .flatMap((file) => seededSkills(file))
    .map((s) => s.slug)
    .filter((slug) => !slug.endsWith('-playbook')),
)

/** [min exclusive, max inclusive] estimated tokens for one text. */
function tokenBounds(slug: string): [number, number] {
  if (slug.endsWith('-playbook')) return [400, CORE_MAX_TOKENS]
  if (RECIPES.has(slug)) return [RECIPE_MIN_TOKENS - 1, RECIPE_MAX_TOKENS]
  return [400, SKILL_MAX_TOKENS]
}

/** Backticked bare identifiers: `list_emails`, `find`, `max_drafts`. Not `from:sarah` or `max_drafts: 10`. */
function backtickedIdentifiers(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])
}

/** Backticked skill-shaped names with a hyphen: `find-email`, `write-in-your-tone`. */
function backtickedHyphenated(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((m) => m[1])
}

/** The words a text names that are none of: a tool, a system skill, its own non-tool words. */
function unknownWords(slug: string, text: string): string[] {
  const allowed = new Set(NOT_TOOLS[slug] ?? [])
  return backtickedIdentifiers(text).filter((w) => !TOOL_NAMES.has(w) && !AGENT_TOOL_NAMES.has(w) && !SYSTEM_SKILLS.has(w) && !allowed.has(w))
}

/**
 * The card fields a text filters on, with the entities they must belong to:
 * in each line that shows `entity_type: X`, the sentences that name the
 * entity or say "filter".
 */
function showFilterFields(text: string): Array<{ entities: CardListEntity[]; field: string; line: string }> {
  const out: Array<{ entities: CardListEntity[]; field: string; line: string }> = []
  for (const line of text.split('\n')) {
    const named = [...line.matchAll(/`entity_type: ([a-z_]+)`/g)].map((m) => m[1])
    if (named.length === 0) continue
    const alsoNamed = backtickedIdentifiers(line).filter((w) => (CARD_LIST_ENTITIES as readonly string[]).includes(w))
    const entities = [...new Set([...named, ...alsoNamed])] as CardListEntity[]
    for (const sentence of line.split(/(?<=\.)\s+/)) {
      if (!/entity_type:|\bfilter\b/i.test(sentence)) continue
      for (const w of backtickedIdentifiers(sentence)) {
        if (TOOL_NAMES.has(w) || SHOW_OPERATORS.has(w) || (CARD_LIST_ENTITIES as readonly string[]).includes(w)) continue
        out.push({ entities, field: w, line })
      }
    }
  }
  return out
}

describe('playbook accuracy', () => {
  it('reads all eighteen playbooks (the sixteen pages, content and marketing) and the area skills, and has a non-tool list for each', () => {
    expect(seeded.filter((s) => s.slug.endsWith('-playbook'))).toHaveLength(18)
    // Data-derived (A1c: three groups add recipes at once): at least A1's and
    // A1b's eight, every one of them a shipped skill.
    expect(RECIPES.size).toBeGreaterThanOrEqual(8)
    for (const slug of RECIPES) expect(seeded.some((s) => s.slug === slug), slug).toBe(true)
    expect(seeded.map((s) => s.slug).sort()).toEqual(Object.keys(NOT_TOOLS).sort())
  })

  for (const skill of seeded) {
    it(`${skill.slug} names only tools and skills that exist`, () => {
      expect(unknownWords(skill.slug, skill.prompt), `${skill.slug}: not a tool or system skill (fix the name, or add a non-tool word to its NOT_TOOLS)`).toEqual([])
      const skills = backtickedHyphenated(skill.prompt).filter((s) => !SYSTEM_SKILLS.has(s))
      expect(skills, `${skill.slug}: names a skill that isn't a system skill`).toEqual([])
    })

    it(`${skill.slug} filters cards only on real fields`, () => {
      for (const { entities, field, line } of showFilterFields(skill.prompt)) {
        const real = entities.some((e) => FILTERABLE_FIELDS[e].some((d) => d.field === field))
        expect(real, `${skill.slug}: \`${field}\` is not a field of ${entities.join(' or ')} in "${line.slice(0, 80)}…"`).toBe(true)
      }
    })

    it(`${skill.slug} names exactly the chat-only tools it is expected to`, () => {
      const named = [...new Set(backtickedIdentifiers(skill.prompt).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w)))].sort()
      expect(named).toEqual([...(CHAT_ONLY_NAMED[skill.slug] ?? [])].sort())
    })

    it(`${skill.slug} is within its kind's size (${tokenBounds(skill.slug).join('–')} tokens)`, () => {
      const [min, max] = tokenBounds(skill.slug)
      expect(estimateTokens(skill.prompt), skill.slug).toBeLessThanOrEqual(max)
      // And says something: not a stub.
      expect(estimateTokens(skill.prompt), skill.slug).toBeGreaterThan(min)
    })
  }

  it('names only agent tools that exist as chat-agent tool files', () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(existsSync(join(process.cwd(), 'agents/chat-agent/tools', `${name}.ts`)), name).toBe(true)
      expect(TOOL_NAMES.has(name), `${name} is a registry tool now: take it out of AGENT_TOOL_NAMES`).toBe(false)
    }
  })

  it('the background note covers the chat-only tools a playbook names', () => {
    // A background run reads playbooks verbatim; the note is what tells it a
    // chat-only step is the person's.
    expect(BACKGROUND_PERSON_STEPS_NOTE).toContain('tools only a chat with the person holds')
  })

  it('catches a tool that does not exist, a typo included, and a skill that does not exist', () => {
    expect(unknownWords('mail-playbook', 'Read with `read_email`, then call `send_email_now`.')).toEqual(['send_email_now'])
    // A non-tool word of another text doesn't excuse it here.
    expect(unknownWords('mail-playbook', 'Then `include_unverified`.')).toEqual(['include_unverified'])
    expect(backtickedHyphenated('Use the `find-emails` skill.').filter((s) => !SYSTEM_SKILLS.has(s))).toEqual(['find-emails'])
  })

  it('catches a card filter on a field the entity does not have', () => {
    const bad = showFilterFields('- `show` with `entity_type: project`: filter `owner_id` and `status`.')
    const wrong = bad.filter(({ entities, field }) => !entities.some((e) => FILTERABLE_FIELDS[e].some((d) => d.field === field)))
    expect(wrong.map((w) => w.field)).toEqual(['owner_id'])
  })

  it('lists no tool, no skill and nothing unused as a non-tool word', () => {
    for (const skill of seeded) {
      const used = new Set(backtickedIdentifiers(skill.prompt))
      for (const word of NOT_TOOLS[skill.slug] ?? []) {
        expect(TOOL_NAMES.has(word), `${word} is a tool: take it out of ${skill.slug}'s NOT_TOOLS`).toBe(false)
        expect(SYSTEM_SKILLS.has(word), `${word} is a skill: take it out of ${skill.slug}'s NOT_TOOLS`).toBe(false)
        expect(used.has(word), `${word} is no longer used: take it out of ${skill.slug}'s NOT_TOOLS`).toBe(true)
      }
    }
  })
})
