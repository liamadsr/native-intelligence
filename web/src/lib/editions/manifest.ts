/**
 * Persona editions — the ONE place an edition is defined.
 *
 * Native Intelligence runs four GTM motions (sales, meeting-notes, second-brain, and the
 * service business an agent runs by text) against one app. An "edition" is the
 * workspace-level answer to "which product is this person here for", determined
 * at signup by the landing page they came from (or by signing up by text) and
 * changeable forever after in workspace settings. It scopes SURFACES and
 * AUTOMATION — never data access — and it picks the WORDS the app and the agent
 * say (`EditionWords`): a rug cleaner's jobs and customers, not a software
 * team's actions and projects.
 *
 * Design invariants (hold across every consumer, present and future):
 *
 *   1. DEFAULT IS TODAY. A missing, unknown, or malformed edition resolves to
 *      `full`, whose manifest entry reproduces today's exact behavior. Every
 *      existing workspace is therefore unaffected by construction — there is no
 *      backfill and no migration.
 *
 *   2. SCOPE, DON'T BLOCK. An edition narrows what the app OFFERS (the pages
 *      it can show as cards, AI tool ceiling, what extraction may auto-create). It never
 *      deletes data, never blocks reading an entity that exists, and never
 *      gates a manual human action. A disallowed AUTO-creation is staged for
 *      human review, never dropped.
 *
 *   3. ONE FILE. Editions are defined HERE and nowhere else. No consumer may
 *      grow an `if (edition === 'sales')` branch — it reads the manifest field
 *      it cares about. Adding a fifth edition, or retuning a fourth, must be a
 *      single-file diff.
 *
 *   4. PRESETS, NOT PRISONS. An edition is a named set of FEATURES, and a
 *      workspace may override any of them per-feature (see `FeatureOverrides`).
 *      A feature is a coherent BUNDLE — its pages, tool categories, auto-create
 *      types — so turning one on can never produce a surface the AI cannot
 *      operate. The edition's own surface fields are composed from its feature
 *      set, never hand-authored, so the two can never disagree.
 *
 *   5. EVERY FEATURE, FOR EVERYONE (founder decision, 10-27). Every edition's
 *      preset is `'all'` and no feature is opt-in, so every workspace starts
 *      with the whole app whichever landing page or onboarding answers brought
 *      it here. An edition still picks its persona (default meeting agents,
 *      preselected role chips, the researcher's brief), never a feature. A
 *      workspace owner can still switch a feature off in Settings → Features.
 *
 * Storage lives at `workspace.settings.edition` (see ./resolve.ts), following
 * the established jsonb-policy-blob pattern of `settings.trust_policy`
 * (src/lib/proposed-changes/trust-policy.ts) — no new table, no migration,
 * member-readable through the existing workspace RLS.
 */

import type { EntityTypeSubset } from '@/lib/knowledge/entity-registry'

/**
 * The pages a workspace can have on (each shown as a card in the chat: see
 * src/lib/chat-cards, whose page kinds and `/` pages gate on these with
 * isViewAllowed).
 */
export type EditionView =
  | 'todo'
  | 'captures'
  | 'docs'
  | 'initiatives'
  | 'projects'
  | 'flows'
  | 'teams'
  | 'team-actions'
  | 'calendar'
  | 'contacts'
  | 'companies'
  | 'mail'
  | 'knowledge'
  | 'agents'
  | 'sequences'
  | 'campaigns'
  | 'prospecting'
  | 'evals'
  | 'studio'
  | 'seo'

/** The five editions. `full` is the default and reproduces today's behavior. */
export type EditionId = 'full' | 'sales' | 'notes' | 'brain' | 'service'

export const EDITION_IDS = ['full', 'sales', 'notes', 'brain', 'service'] as const

export const DEFAULT_EDITION_ID: EditionId = 'full'

/**
 * The edition a workspace takes when it sets up as a business that serves
 * customers: a text sign-up (roadmap track A) or its first business profile
 * (track B). See `adoptBusinessEdition` (./resolve.ts).
 */
export const BUSINESS_EDITION_ID: EditionId = 'service'

/**
 * Pages on in EVERY edition regardless of its features.
 *
 * These are infrastructure, not product surface: the teams settings surface.
 * Gating it would strand a user rather than focus them — invariant 2. (The
 * inbox that was here went with the notifications page:
 * docs/plans/retire-notifications-page.md.) (Every workspace is reachable in every
 * edition too, through the workspaces veil, which is not a page.)
 */
export const ALWAYS_ALLOWED_VIEWS: readonly EditionView[] = ['teams'] as const

/**
 * Entity classes an edition may allow AUTOMATED creation of (extraction, loop
 * verdicts, live-agent auto-apply). A type outside an edition's
 * `autoCreateEntities` is STAGED for human review, never dropped — invariant 2.
 * Manual accepts bypass this entirely by design (they call `applyChange`
 * directly and never reach the gate).
 */
export type EditionEntityType = EntityTypeSubset<
  'action' | 'decision' | 'contact' | 'company' | 'project' | 'milestone' | 'document' | 'claim'
>

/**
 * A FEATURE — the unit an edition is assembled from, and the unit a user
 * toggles.
 *
 * Editions are presets, not prisons: a meeting-notes workspace that discovers
 * Email should be able to turn it on and get the WHOLE coherent bundle (the
 * Mail page AND the email AI tools), never a page with a lobotomized agent
 * behind it. That coherence is what a feature is: pages, extra reachable
 * views, AI tool categories, and auto-createable entity types that only ever
 * move together.
 *
 * Consequently the manifest's surface fields are no longer authored per
 * edition — they are COMPOSED from the edition's feature set (see
 * `composeSurface`). An edition is a named set of features plus the things that
 * genuinely are edition-level: label/description, home view, seeds, and
 * onboarding roles.
 */
export type FeatureKey =
  | 'core'
  | 'docs'
  | 'boards'
  | 'knowledge'
  | 'projects'
  | 'flows'
  | 'email'
  | 'crm'
  | 'sequences'
  | 'campaigns'
  | 'prospecting'
  | 'evals'
  | 'browser'
  | 'studio'
  | 'seo'

export interface FeatureDefinition {
  id: FeatureKey
  /** Human label for the features settings card. */
  label: string
  /** One-line description of what turning it on gets you. */
  description: string
  /** The pages this feature turns on. */
  views: readonly EditionView[]
  /** Pages reachable only from within others (see EditionDefinition). */
  extraAllowedViews: readonly EditionView[]
  /** AI tool category ids (from `TOOL_CATEGORIES`) this feature unlocks. */
  toolCategories: readonly string[]
  /** Entity classes automation may create once this feature is on. */
  autoCreateEntities: readonly EditionEntityType[]
  /**
   * Features that must be on for this one to make sense. Auto-included at
   * compose time, so enabling `sequences` silently pulls in `crm` rather than
   * producing a sequences surface with no contacts to enroll.
   */
  requires: readonly FeatureKey[]
  /** `core` is locked on in every workspace and cannot be toggled off. */
  locked?: boolean
  /**
   * A hidden feature is not part of ANY edition preset, never appears in the
   * user-facing Features card, and cannot be toggled through
   * /api/account/workspace/features. It comes on for a workspace only through an
   * admin-console override ('on' in settings.feature_overrides). Staff/internal
   * surfaces live here.
   *
   * `hidden` is the STRICTER of the two off-by-default flags: it says both "not
   * in any preset" AND "not the user's to decide". No feature carries it today
   * — it is kept for the genuinely staff-only surface that will want it.
   */
  hidden?: boolean
  /**
   * An opt-in feature is not part of ANY edition preset either — it is off by
   * default in EVERY workspace, `full` included — but it IS an ordinary
   * user-toggleable feature: it appears in the Features card, and
   * /api/account/workspace/features accepts it. The difference from `hidden` is
   * purely about WHO decides; the preset semantics are the same, which is why
   * both flags feed `NON_DEFAULT_FEATURE_KEYS`.
   *
   * Use it for a feature a workspace should have to ASK for (a heavy or
   * specialist surface) rather than receive by being on the Full edition. No
   * feature carries it today: every feature is on for everyone (invariant 5).
   */
  optIn?: boolean
  /**
   * System library rows (`recipe.is_system`) OWNED by this feature — hidden
   * everywhere the library is listed or resolved when the feature is off, so a
   * gated feature cannot be reached by typing its slash command by hand.
   */
  systemRecipeIds?: readonly string[]
}

/** The feature every workspace has, always. Meetings in, work out — the
 *  irreducible Native Intelligence. Not toggleable: switching it off would leave a workspace
 *  with no way to capture or act on anything. */
export const CORE_FEATURE: FeatureKey = 'core'

/**
 * THE FEATURE TAXONOMY.
 *
 * Verified (by the golden tests in `__tests__/features.test.ts`) to reproduce
 * the four editions' hand-authored surfaces EXACTLY — this decomposition was
 * derived from them, not the other way round.
 */
export const FEATURES: Record<FeatureKey, FeatureDefinition> = {
  core: {
    id: 'core',
    label: 'Core',
    description: 'Meetings, tasks, calendar, and agents — always on.',
    // 'evals' is NOT here — it is its own opt-in feature (see `evals` below).
    views: ['todo', 'captures', 'calendar', 'agents'],
    extraAllowedViews: [],
    toolCategories: [
      'captures',
      'actions',
      'decisions',
      'calendar',
      'calendar_capture',
      'attachments',
      'comments',
      'dashboard',
      'notifications',
      'search',
      'library',
      // P8: the post checks (lint_post, review_post). Read-only, in every edition.
      'content',
    ],
    autoCreateEntities: ['action', 'decision'],
    requires: [],
    locked: true,
  },

  docs: {
    id: 'docs',
    label: 'Documents',
    description: 'Long-form docs the AI can read, draft, and edit.',
    views: ['docs'],
    extraAllowedViews: [],
    toolCategories: ['documents'],
    autoCreateEntities: [],
    requires: [],
    // The Documents playbook (migration 319): its pack's know-how, gated with the
    // feature so a workspace with it off never lists it.
    systemRecipeIds: [
      'e8d88dec-0326-41b0-971e-f974c21cdefb',
      // A1c docs-goals-tools: the write-a-document recipe (migration 327).
      'a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb',
    ],
  },

  boards: {
    id: 'boards',
    label: 'Team boards',
    description: 'A shared board of the team’s work, not just your own.',
    views: ['team-actions'],
    extraAllowedViews: [],
    // No tools of its own: the board is a VIEW over actions, which core
    // already grants the AI. Turning it on adds a surface, not a capability.
    toolCategories: [],
    autoCreateEntities: [],
    requires: [],
  },

  knowledge: {
    id: 'knowledge',
    label: 'Knowledge graph',
    description: 'Cross-linked claims, decisions, and open questions.',
    views: ['knowledge'],
    extraAllowedViews: [],
    toolCategories: ['knowledge'],
    autoCreateEntities: [],
    requires: [],
    // The Knowledge playbook (migration 319) and the Knowledge recipes (323):
    // what-do-we-know, whats-changed and everything-about. Gated with the
    // feature so a workspace with it off never lists them. find-anything
    // (326b5c1f…) is deliberately NOT here: it has no area, the general front
    // door, listed in every edition (Notes has no Knowledge).
    systemRecipeIds: [
      'e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc',
      '46d24d23-ef85-48b9-b16d-4c912899459d',
      'dc51017f-b90b-485e-a701-806f9c7b9d18',
      '29b2a03c-a998-4133-b9c5-70b969f86a41',
    ],
  },

  projects: {
    id: 'projects',
    label: 'Projects',
    description: 'Projects, initiatives, cycles, and milestones.',
    views: ['initiatives', 'projects'],
    extraAllowedViews: [],
    toolCategories: ['projects', 'initiatives', 'cycles'],
    // 'project' as well as 'milestone': this feature OWNS the project entity, so
    // it is the only place that can grant creating one. Without it no feature
    // contributes 'project' at all, which makes the union INCOMPLETE — the
    // moment any feature is switched off, `autoCreateEntities` stops being the
    // `'all'` sentinel and becomes an enumerated list that can never contain
    // 'project', so create:project would be ungrantable in every workspace
    // except a pristine `full` one. (The auto-apply gate consults this set for
    // CREATES only, so this does not affect project updates either way.)
    autoCreateEntities: ['project', 'milestone'],
    requires: [],
    // The Projects and Initiatives playbooks (migration 319) and the
    // project-status-update recipe (323): both areas live under this feature,
    // so a workspace with it off never lists them.
    systemRecipeIds: [
      'e1a419c7-8cc0-46b2-b24b-d866210d87c5',
      '1d277e63-8a44-4ca6-b743-322a812971a9',
      'ca443e96-3c3f-419a-b1f4-4f444bbe8c5c',
      // A1c docs-goals-tools: the initiative-review recipe (migration 327).
      '5472e163-15c1-4f7d-a263-55268a3825c3',
    ],
  },

  flows: {
    id: 'flows',
    label: 'Flows',
    description: 'Scheduled and event-driven automations.',
    views: ['flows'],
    extraAllowedViews: [],
    toolCategories: ['flows'],
    autoCreateEntities: [],
    requires: [],
    // The Flows playbook (migration 319, rewritten in 324) and the
    // build-a-workflow recipe (324): gated with the feature so a workspace
    // with it off never lists them.
    // F3's lens skills (migration 382): content-lens and marketing-lens, which
    // only work as the skill of a capture_processed flow.
    // P9's recipe skills, which only work as a loop's step: weekly-posts (388).
    systemRecipeIds: [
      '1ef0c12f-5d78-41ef-ab12-714512fa03cd',
      'a1c4ac7d-4b00-4af4-a97e-1c79abaed9b3',
      '8ef0cb7e-6c81-4da5-9deb-a967dc16aa30',
      'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb',
      '80d160c4-1b4a-481d-8b76-aa7fc1609326',
      // ... and shipped-note, launch-kit (389).
      '02c801d7-a5c9-4a4b-92b4-bb952ae7cd26',
      'f67944ea-eb9e-4297-abbc-4da1afc3c031',
      // ... and newsletter (390).
      'd53ec7d9-10c9-476f-ba39-06b9f261bff1',
    ],
  },

  email: {
    id: 'email',
    label: 'Email',
    description: 'Connected inbox with AI-drafted replies.',
    views: ['mail'],
    extraAllowedViews: [],
    toolCategories: ['emails'],
    autoCreateEntities: [],
    requires: [],
    // The Mail playbook (migration 316) and Mail's two skills, Write in your
    // tone and Clear an inbox (319): the Mail pack's know-how, gated with the
    // mailbox it teaches so a workspace without mail never lists it.
    systemRecipeIds: [
      '1534bd72-4cd1-4a53-b14a-a8fe8c4a0fb4',
      '0c43b03b-480d-4f59-99d3-1fd522cc34d2',
      '72cc7391-28bf-46ef-a0f2-6206bfb5de64',
    ],
  },

  crm: {
    id: 'crm',
    label: 'CRM',
    description: 'Contacts, companies, and interaction history.',
    views: ['contacts'],
    // `companies` stays reachable for account drill-in from a contact.
    extraAllowedViews: ['companies'],
    toolCategories: ['contacts'],
    autoCreateEntities: ['contact'],
    requires: [],
    // The CRM playbook (migration 319): its pack's know-how, gated with the
    // feature so a workspace with it off never lists it.
    systemRecipeIds: [
      'e05a0562-a4a2-4700-8c7b-19435fa7430b',
      // A1c crm-outreach: the stale-relationships recipe (migration 326).
      'a7337d9e-1ec0-4ed8-b6f0-0311edd54335',
    ],
  },

  sequences: {
    id: 'sequences',
    label: 'Sequences',
    description: 'Multi-step outreach with automatic follow-ups.',
    views: ['sequences'],
    extraAllowedViews: [],
    toolCategories: ['sequences'],
    autoCreateEntities: [],
    // Outreach enrolls CONTACTS. Sequences without CRM is a dead surface.
    requires: ['crm'],
    // The Sequences playbook (migration 319): its pack's know-how, gated with the
    // feature so a workspace with it off never lists it.
    systemRecipeIds: [
      '1438190a-646d-4709-ae89-22e24ddf340b',
      // A1c crm-outreach: the launch-a-sequence recipe (migration 326).
      '287cbaef-c539-42b2-84be-3cbfef7a88ec',
    ],
  },

  campaigns: {
    id: 'campaigns',
    label: 'Campaigns',
    description: 'Marketing campaigns — what a marketer\'s knowledge hangs off.',
    views: ['campaigns'],
    extraAllowedViews: [],
    toolCategories: ['campaigns'],
    // EMPTY BY DESIGN. A campaign is a deliberate act of marketing planning,
    // not something a meeting should conjure — extraction and the live agent
    // may ANCHOR claims to an existing campaign, never mint one. (Contrast
    // `crm`, where a person appearing in a meeting genuinely is a new contact.)
    // Keeping it empty is also why `campaign` is absent from
    // `EditionEntityType` altogether.
    autoCreateEntities: [],
    // Campaigns stand alone: they need no CRM rows to exist and no mailbox to
    // send from, so unlike `sequences` this requires nothing. A marketer who
    // also wants contacts turns CRM on themselves.
    requires: [],
    // The Campaigns playbook (migration 319): its pack's know-how, gated with the
    // feature so a workspace with it off never lists it.
    systemRecipeIds: ['48b8e8bd-2299-43b2-9a65-f9928a232b90'],
  },

  prospecting: {
    id: 'prospecting',
    label: 'Prospecting',
    description: 'Find accounts and people that match your ICP, then save them.',
    views: ['prospecting'],
    extraAllowedViews: [],
    // The Scout agent's tool family. Empty until the tools existed; the
    // category is now real (src/lib/ai/tool-registry.ts) and must be licensed
    // by the same feature that licenses the nav item, or an edition with
    // Prospecting enabled would show the screen and deny the agent.
    toolCategories: ['prospecting'],
    // Saving a candidate CREATES company/contact rows — the same two entity
    // classes the CRM feature already licenses automation to create.
    autoCreateEntities: ['contact'],
    // A prospect is only worth finding if it can land somewhere (CRM) and be
    // worked (sequences) — mirrors sequences' own `requires: ['crm']`
    // reasoning: without both, Prospecting is a dead surface.
    requires: ['crm', 'sequences'],
    // The Prospecting playbook (migration 319) and the build-prospect-list
    // recipe (the old `scout` skill, migration 322), gated with the feature so
    // a workspace with it off never lists them.
    systemRecipeIds: ['1b502445-3db0-4f04-bc4b-39505d2fe5ca', 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247'],
  },

  evals: {
    id: 'evals',
    label: 'Evals',
    description:
      'Grade agents and skills against synthetic mock meetings and real calls.',
    views: ['evals'],
    extraAllowedViews: [],
    toolCategories: ['evals'],
    autoCreateEntities: [],
    requires: [],
    // The `/create-eval` system skill (migration 253) and the Evals playbook
    // (319). Gated with the feature so neither is reachable in a workspace that
    // cannot run evals.
    systemRecipeIds: ['6b3f1d02-91ac-4e57-8c24-0a5f7d3e9b18', '8e08678d-1944-4a10-95ec-b9e73a7feea4'],
  },

  browser: {
    id: 'browser',
    label: 'Agent browser',
    description:
      'Your agent\'s own browser, in the cloud — one for each workspace, with its own logins — that it drives (read pages, click, type) on any site except the ones you block. Watch it or take over from the computer card. While your Mac is online, sites see your own connection.',
    // No page of its own: the side panel's computer card and its live view
    // (docs/plans/cloud-browser.md, C3) are how the person sees it.
    views: [],
    extraAllowedViews: [],
    toolCategories: ['browser'],
    autoCreateEntities: [],
    requires: [],
    // The Browser playbook (migration 319): its pack's know-how, gated with the
    // feature so a workspace with it off never lists it.
    systemRecipeIds: ['eec790ec-399f-416d-8189-c883859ba8c3'],
  },

  // Studio (migration 620): Studio projects group videos, each one edit the
  // editor and the agent write through the same checked path
  // (src/lib/studio/). On by default, like Documents: every edition gets it.
  studio: {
    id: 'studio',
    label: 'Studio',
    description: 'Make videos and ads: record, script, storyboard, edit and export.',
    views: ['studio'],
    extraAllowedViews: [],
    toolCategories: ['studio'],
    // A video is made on purpose, never conjured by a meeting.
    autoCreateEntities: [],
    requires: [],
    // The Studio skills (migration 621, refreshed and extended by 626): the playbook, then its task skills.
    systemRecipeIds: [
      '954c76ec-ab39-4066-af50-7bdfb4a15a82', // studio-playbook
      '586ac29a-3ea9-44ed-a21c-03f1d5850570', // studio-editing-layers
      '09a42a42-bcc7-4e1e-8aea-cde5f7410df6', // studio-picture-and-shots
      '748fabfb-99c8-40f6-a43c-6bf74921fb75', // studio-motion-design
      '99e78d7c-4e13-4cff-8fba-75aea2cd7060', // studio-motion-particles
      'f4b1b4cc-ab0b-4e91-b49b-d3111e0b02ff', // studio-motion-recipes
      'ddd132e7-05d6-490b-a1b8-6fda277f6287', // studio-type-and-graphics
      '6890489d-e8a8-4712-9d5d-35e9633b323a', // studio-brand
      'edbcbdcc-5101-4c9a-b89f-7f9d51fea9d6', // studio-script-writing
      'dc4e61f5-a966-4120-9a63-e770725696c5', // studio-storyboard
      '470a6a9c-ef31-4d9f-a43c-b64d30717e8e', // studio-style-packs
      '651c4102-eaef-4a56-ae51-bbb4afb995d3', // studio-style-pack-editorial-archival
      '8cf5a3ee-ab8b-4dcb-ac70-5ca6e9da1ad8', // studio-style-pack-paper-collage
      '4390a45d-766e-4487-af0a-808223245a91', // studio-style-pack-orbital
      '9499a35b-bacb-462d-aad9-7168668fa405', // studio-style-pack-warm-loft
      '73c5576d-701d-49d4-bdd8-4fb40df9a7c4', // studio-reference-to-style-pack
      '399c0258-a53f-4ac5-b4b4-97ebbcaa5e4c', // studio-review
      'd7dd9d4f-f7af-4722-9e8c-e7daf930d159', // studio-match-a-reference
      '630f44d7-164d-46bc-a5d4-723558173211', // studio-motion-ads
      'ecb5d367-acbe-4fcf-a863-30b3332eb2ca', // studio-generated-shots
      'cd6753b1-db8f-42cb-aab1-21620b411f24', // studio-sound
      'b310d743-be33-49dd-85ef-1655cd5b7f14', // studio-scene-design
      '6ed3b2eb-8d15-46b7-9717-23f36d698f85', // studio-product-ui
      'f78898eb-1f33-4cc2-974a-6f7986e5070e', // studio-product-onboarding
      // Migration 626: the task skills for what the Studio gained since.
      'ff3c1bc7-de70-4e91-9201-37b79d1d0c03', // studio-static-ads
      '808be34a-c35f-4976-abf7-8f19066e30d9', // studio-reels
      'd1c1868a-529c-420c-9e65-86ce43b64050', // studio-narration
      'eca4a2dd-7410-43c5-bddc-477d2f1d7da1', // studio-measured-checks
      'c1ae523f-83c4-4a7e-9dff-3286f38cd4d4', // studio-director-and-cut-outs
    ],
  },
  seo: {
    id: 'seo',
    label: 'SEO',
    description: 'Audit your website, find keywords, track rankings and see how you show up in search, on Google Maps and in AI answers.',
    // One view for every SEO page (the audit today; keywords, rankings and the
    // rest as they land), the way Files shares `docs` and Availability shares
    // `calendar`: the area turns on and off as one.
    views: ['seo'],
    extraAllowedViews: [],
    toolCategories: ['seo'],
    autoCreateEntities: [],
    // Works on any public website, so it needs nothing else. The workspace's
    // own site is only its default (src/lib/seo/site.ts).
    requires: [],
    // The ten SEO skills (migration 598: the overview, site audit, keywords,
    // competitors, rank tracking, search performance, backlinks, AI
    // visibility, local, the report). They sit in the Marketing area, whose
    // pack lists them; gated here so a workspace with SEO off never does.
    systemRecipeIds: [
      '72285100-16f5-43ac-abc8-599ad8e96e8a',
      '7185990b-056e-42f8-be10-4fb998268646',
      '48632b85-370a-41d2-90ec-134c70720de6',
      'f39d4983-a50f-4b8c-9628-e36e61bc389e',
      '6972ef33-62e5-4f75-bc0d-ca12fe66059b',
      '7effa973-4c67-4c25-8d1d-8458d15750a3',
      '59791459-238d-40ad-8bc4-39d87497c76f',
      '87aac0de-9c0c-40b7-a5c2-d8ed2099f38b',
      '52d2241c-1a7d-482f-8645-d4e706472a9a',
      '0b2fb881-429c-485d-9119-1a6ad914680c',
    ],
  },
}

export const FEATURE_KEYS = [
  'core',
  'docs',
  'boards',
  'knowledge',
  'projects',
  'flows',
  'email',
  'crm',
  'sequences',
  'campaigns',
  'prospecting',
  'evals',
  'browser',
  'studio',
  'seo',
] as const satisfies readonly FeatureKey[]

/**
 * TWO AXES, deliberately separate.
 *
 *   PRESET axis    — is this feature part of an edition's default set?
 *                    Answered by `NON_DEFAULT_FEATURE_KEYS` (hidden OR optIn):
 *                    a key in there is off in every edition, `full` included,
 *                    and reaches a workspace only through an explicit `'on'`
 *                    override. Everything the `'all'` sentinel touches keys on
 *                    THIS set.
 *
 *   VISIBILITY axis — is this feature the USER's to see and toggle?
 *                    Answered by `hidden` alone. An opt-in feature is fully
 *                    user-facing (Features card, user PATCH); only a hidden one
 *                    is admin-console-only.
 *
 * Conflating the two is what would make an opt-in feature either invisible (if
 * visibility keyed on the preset axis) or on-by-default on Full (if the preset
 * axis keyed on `hidden`).
 */

/**
 * The features an edition preset may contain — every DEFAULT-ON one.
 *
 * `features: 'all'` expands to THIS, not to `FEATURE_KEYS`: a hidden or opt-in
 * feature is off in every edition by construction and reaches a workspace only
 * through an explicit `'on'` override.
 */
export const STANDARD_FEATURE_KEYS: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (k) => !FEATURES[k].hidden && !FEATURES[k].optIn,
)

/**
 * The complement of STANDARD_FEATURE_KEYS — every feature no preset grants,
 * whether because it is staff-only (`hidden`) or because a workspace has to ask
 * for it (`optIn`).
 */
export const NON_DEFAULT_FEATURE_KEYS: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (k) => FEATURES[k].hidden || FEATURES[k].optIn,
)

/** Staff/internal surfaces only — the VISIBILITY axis. */
export const HIDDEN_FEATURE_KEYS: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (k) => FEATURES[k].hidden,
)

/**
 * Every tool category contributed ONLY by non-default features.
 *
 * A category a non-default feature shares with a standard one is not here —
 * denying it would take the standard feature's tools with it. Consumed by
 * `computeEditionToolCeiling` to keep the `'all'` sentinel from handing a full
 * workspace a feature's tools when it does not have that feature.
 */
export const NON_DEFAULT_FEATURE_TOOL_CATEGORIES: readonly string[] = (() => {
  const standard = new Set(STANDARD_FEATURE_KEYS.flatMap((k) => FEATURES[k].toolCategories))
  return [
    ...new Set(
      NON_DEFAULT_FEATURE_KEYS.flatMap((k) => FEATURES[k].toolCategories).filter(
        (id) => !standard.has(id),
      ),
    ),
  ]
})()

/**
 * Ordered list for the USER-facing settings card — hidden features excluded,
 * OPT-IN features INCLUDED (they are ordinary user-toggleable features that
 * merely start off).
 */
export const FEATURE_LIST: readonly FeatureDefinition[] = FEATURE_KEYS.filter(
  (k) => !FEATURES[k].hidden,
).map((k) => FEATURES[k])

/** Ordered list for the ADMIN console — every feature, hidden ones included. */
export const ADMIN_FEATURE_LIST: readonly FeatureDefinition[] = FEATURE_KEYS.map((k) => FEATURES[k])

/** Every non-core, non-hidden feature — what a workspace OWNER may toggle. */
export const TOGGLEABLE_FEATURE_KEYS: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (k) => !FEATURES[k].locked && !FEATURES[k].hidden,
)

/** Every non-core feature — what an ADMIN may toggle, hidden ones included. */
export const ADMIN_TOGGLEABLE_FEATURE_KEYS: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (k) => !FEATURES[k].locked,
)

/** True when `raw` is exactly a known feature key. */
export function isFeatureKey(raw: unknown): raw is FeatureKey {
  return typeof raw === 'string' && (FEATURE_KEYS as readonly string[]).includes(raw)
}

/**
 * Close a feature set under `requires`, with `core` always in.
 *
 * Idempotent and order-insensitive: the result is a Set, and every consumer of
 * it iterates in FEATURE_KEYS order. `'all'` expands to every DEFAULT-ON feature —
 * an explicit key list may name a non-default one (hidden or opt-in), which is
 * how an override reaches the surface.
 */
export function resolveFeatureClosure(keys: 'all' | readonly FeatureKey[]): Set<FeatureKey> {
  const out = new Set<FeatureKey>([CORE_FEATURE])
  const stack: FeatureKey[] = keys === 'all' ? [...STANDARD_FEATURE_KEYS] : [...keys]
  while (stack.length > 0) {
    const key = stack.pop()!
    if (out.has(key)) continue
    // Defensive: a garbage key from a settings blob is dropped, not thrown on.
    if (!isFeatureKey(key)) continue
    out.add(key)
    stack.push(...FEATURES[key].requires)
  }
  return out
}

/** The surface a feature set produces — exactly the fields an edition exposes. */
export interface ComposedSurface {
  views: readonly EditionView[]
  extraAllowedViews: readonly EditionView[]
  toolCategories: readonly string[] | 'all'
  autoCreateEntities: 'all' | readonly EditionEntityType[]
}

/**
 * Compose a feature set into a surface. PURE — no I/O, no edition, no policy.
 *
 * The `'all'` passthrough is load-bearing, not cosmetic: `toolCategories: 'all'`
 * is the inherit-all sentinel `computeEditionToolCeiling` returns `null` for,
 * and `autoCreateEntities: 'all'` is the identity the auto-apply gate treats as
 * "this workspace imposes nothing". An enumerated list that happens to be
 * exhaustive today would NOT be the same thing — it would freeze a snapshot of
 * the tool registry into every full workspace's ceiling, so a tool category
 * added later would silently be denied. Hence: pass `'all'` in, get `'all'`
 * out. The moment ANY feature is off — or a NON-DEFAULT one is on — the caller
 * passes an explicit key list and gets explicit unions, which is precisely the
 * ceiling they asked for.
 *
 * `'all'` composes the DEFAULT-ON features only, so `composeSurface('all')`
 * carries no opt-in or hidden feature's nav item. The `'all'` tool-category
 * sentinel is still returned as-is; `computeEditionToolCeiling` is what
 * subtracts the non-default categories from it.
 */
export function composeSurface(keys: 'all' | readonly FeatureKey[]): ComposedSurface {
  const enabled = resolveFeatureClosure(keys)
  const defs = FEATURE_KEYS.filter((k) => enabled.has(k)).map((k) => FEATURES[k])

  const views = dedupe(defs.flatMap((f) => f.views))

  const extraAllowedViews = dedupe(defs.flatMap((f) => f.extraAllowedViews))
  const toolCategories = dedupe(defs.flatMap((f) => f.toolCategories))
  const autoCreateEntities = dedupe(defs.flatMap((f) => f.autoCreateEntities))

  return {
    views,
    extraAllowedViews,
    toolCategories: keys === 'all' ? 'all' : toolCategories,
    autoCreateEntities: keys === 'all' ? 'all' : autoCreateEntities,
  }
}

function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)]
}

/**
 * A workspace's per-feature overrides — the tri-state that makes editions
 * presets rather than prisons.
 *
 *   absent  → follow the edition's default for that feature
 *   'on'    → force-enable regardless of edition
 *   'off'   → force-disable regardless of edition
 *
 * Tri-state (rather than storing a flat resolved feature list) is what lets
 * preset IMPROVEMENTS propagate: retuning `notes` to include Documents reaches
 * every notes workspace that never touched the Documents toggle, while a
 * workspace that explicitly turned something on keeps it across an edition
 * switch. Stored at `workspace.settings.feature_overrides`.
 */
export type FeatureState = 'on' | 'off'
export type FeatureOverrides = Partial<Record<FeatureKey, FeatureState>>

/**
 * Coerce an unknown jsonb blob into valid overrides.
 *
 * Same defensive contract as `normalizeEditionId`: any shape of garbage
 * degrades to "no overrides" (or drops the offending key) rather than throwing
 * — invariant 1. `core` is dropped outright: it is locked on, and honoring an
 * `off` for it would strand a workspace with an empty app. NON-DEFAULT keys
 * (hidden or opt-in) are KEPT: an `evals: 'on'` is the only way that feature is
 * ever on, so dropping it here would make the switch inert.
 */
export function normalizeFeatureOverrides(raw: unknown): FeatureOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: FeatureOverrides = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFeatureKey(key)) continue
    if (FEATURES[key].locked) continue
    if (value === 'on' || value === 'off') out[key] = value
  }
  return out
}

/**
 * The features actually in effect: the edition's set, plus every `on`, minus
 * every `off`, CLOSED UNDER `requires` with `core` forced in.
 *
 * The closure is applied HERE, not left to `composeSurface`, so this list is
 * the truth about which features are live rather than a raw merge that happens
 * to compose into the right surface. Without it, `sequences: 'on'` on a preset
 * without CRM returns a list omitting `crm` while the composed surface carries
 * CRM's nav and tools — and any consumer rendering switches off the list (the
 * features settings card, the features API) would show Sequences on and CRM
 * off in an app where both are live. Closing at the source means every future
 * consumer of the key list gets the truth for free.
 *
 * Order is FEATURE_KEYS order, so the result is stable, deterministic, and
 * comparable regardless of override insertion order or closure traversal.
 *
 * OFF WINS over `requires`. An explicit `off` is a user decision about THIS
 * workspace and outranks a preset's transitive wants, so a feature switched off
 * stays off — and every feature that requires it goes off WITH it (dependents
 * die with their dependency), rather than the dependency being resurrected to
 * keep the dependent alive. The alternative — resurrecting `crm` because
 * `sequences` is still on — strands the user's stored `crm: 'off'` key: the
 * effective set contains crm, the card shows no Custom badge and offers no
 * Reset, and the dead key sits in the blob forever. On a `full` workspace that
 * stranded key is worse than cosmetic: any effective `off` collapses the `'all'`
 * sentinel into an enumerated list, silently freezing the tool ceiling against
 * every category added later. Cascading off keeps the surface coherent (no
 * outreach surface without contacts) with no resurrection.
 *
 * Returns the literal `'all'` — not an enumerated list — when the edition is
 * `'all'`, nothing is EFFECTIVELY switched off, and no NON-DEFAULT feature is
 * switched on, so `composeSurface` can preserve the null-ceiling passthrough.
 * An `on` override on a STANDARD feature against an `'all'` edition is a no-op
 * by construction (every default-on feature is already on); an `on` for a
 * non-default feature (hidden or opt-in) is not — `'all'` excludes those, so it
 * must collapse to an explicit list that names the one being turned on.
 */
export function effectiveFeatureKeys(
  edition: EditionDefinition,
  overrides?: FeatureOverrides | null,
): 'all' | FeatureKey[] {
  const off = new Set<FeatureKey>()
  const on = new Set<FeatureKey>()
  for (const [key, state] of Object.entries(overrides ?? {})) {
    if (!isFeatureKey(key) || FEATURES[key].locked) continue
    // An `off` on a NON-DEFAULT feature is INERT and must not be collected.
    // Such a feature is off in every preset already, so the override changes
    // nothing — but a key in `off` defeats the `'all'` early return below and
    // collapses the sentinel into an enumerated list. `pruneNoOpOverrides`
    // would then see the two results differ (`'all'` deliberately never equals
    // an exhaustive list) and keep the key forever, silently freezing the
    // workspace's tool ceiling against every category added later. Any owner
    // who ticks an opt-in feature on and back off again would hit exactly that,
    // so the inertness is recognized HERE, at the single source of truth, and
    // every consumer — the prune, the card, the ceiling — gets it for free.
    if (state === 'off') {
      if (!FEATURES[key].hidden && !FEATURES[key].optIn) off.add(key)
    } else if (state === 'on') on.add(key)
  }

  // A non-default feature switched on cannot ride the `'all'` sentinel —
  // `'all'` means "every default-on feature" — so it collapses to an explicit
  // list that names it. (The `off` direction needs no such check: an `off` on
  // one of those is inert and was dropped above.)
  const nonDefaultOn = [...on].some((k) => FEATURES[k].hidden || FEATURES[k].optIn)
  if (edition.features === 'all' && off.size === 0 && !nonDefaultOn) return 'all'

  // The `off` set closed under DEPENDENTS: switching CRM off also takes
  // Sequences, and anything that required Sequences, and so on. This is the
  // "off wins" half of the invariant — computed before the merge so nothing the
  // requires-closure adds below can bring a killed feature back.
  const dead = closeOverDependents(off)

  // Non-default features are never in a preset's base — they enter ONLY via an
  // `on` override.
  const base: readonly FeatureKey[] =
    edition.features === 'all'
      ? STANDARD_FEATURE_KEYS
      : edition.features.filter((k) => !FEATURES[k].hidden && !FEATURES[k].optIn)
  const keys = new Set<FeatureKey>(base)
  for (const key of on) keys.add(key)
  for (const key of dead) keys.delete(key)

  // `resolveFeatureClosure` pulls in requirements and forces `core` in — the
  // same function `composeSurface` uses, so the list and the surface it
  // composes to can never disagree.
  //
  // Because `dead` already removed every dependent of an `off` feature, the
  // closure has nothing left that could ask for one: it can only re-add a
  // requirement of a feature that survived, and a survivor's requirements are
  // by construction not in `dead`. (An `on` override on a feature whose
  // requirement is `off` is the one contradiction left, and it resolves the
  // same way — `on` is expanded first, `dead` removes it, and neither it nor
  // its requirement comes back.) Belt and braces: filter `dead` out of the
  // closed result too, so the invariant holds no matter how `requires` grows.
  const closed = resolveFeatureClosure([...keys])
  return FEATURE_KEYS.filter((k) => closed.has(k) && !dead.has(k))
}

/**
 * Expand a set of switched-off features to include everything that REQUIRES one
 * of them, transitively. `core` can never enter (it is locked on and dropped
 * from overrides upstream, and nothing may require it — asserted by the
 * taxonomy tests), so a cascade can never empty the workspace.
 */
function closeOverDependents(off: ReadonlySet<FeatureKey>): Set<FeatureKey> {
  const dead = new Set<FeatureKey>(off)
  dead.delete(CORE_FEATURE)
  let grew = true
  while (grew) {
    grew = false
    for (const key of FEATURE_KEYS) {
      if (dead.has(key) || FEATURES[key].locked) continue
      if (FEATURES[key].requires.some((r) => dead.has(r))) {
        dead.add(key)
        grew = true
      }
    }
  }
  return dead
}

/** The surface for an edition under a set of overrides. */
export interface EffectiveSurface extends ComposedSurface {
  features: 'all' | FeatureKey[]
}

export function composeEffectiveSurface(
  edition: EditionDefinition,
  overrides?: FeatureOverrides | null,
): EffectiveSurface {
  const features = effectiveFeatureKeys(edition, overrides)
  return { ...composeSurface(features), features }
}

/**
 * Project an effective surface back onto an `EditionDefinition`.
 *
 * The composed surface has to be WRITTEN BACK over the manifest entry's own
 * fields, because `EditionDefinition` is what every consumer reads — resolve.ts
 * (server) and `useWorkspaceEdition` (client) both need the same projection, and
 * a hand-rolled spread in each is a place for the two to silently disagree.
 *
 * Spread order is load-bearing: the composed fields must WIN over the base
 * entry's derived ones. `id`, `label`, `description`, `features`,
 * `onboardingDefaultRoles`, `defaultAgents` and `words` are edition-level and
 * pass straight through.
 *
 * PURE — no I/O, no storage, no policy.
 */
export function withEffectiveSurface(
  base: EditionDefinition,
  overrides?: FeatureOverrides | null,
): EditionDefinition {
  const surface = composeEffectiveSurface(base, overrides)
  return {
    ...base,
    views: surface.views,
    extraAllowedViews: surface.extraAllowedViews,
    toolCategories: surface.toolCategories,
    autoCreateEntities: surface.autoCreateEntities,
  }
}

export interface EditionDefinition {
  id: EditionId
  /** Human label for the settings switcher. */
  label: string
  /** One-line description of who the edition is for (settings switcher copy). */
  description: string
  /**
   * The features this edition turns on — the AUTHORED field. `'all'` means
   * every feature (and, critically, the inherit-all sentinels downstream; see
   * `composeSurface`). The surface fields below are DERIVED from this at module
   * load and must never be hand-authored.
   */
  features: 'all' | readonly FeatureKey[]
  /** DERIVED from `features` — the pages this edition has on. */
  views: readonly EditionView[]
  /**
   * DERIVED from `features` — pages reachable only from within others: e.g.
   * the `crm` feature keeps `companies` reachable so account drill-in from a
   * contact lands somewhere.
   */
  extraAllowedViews: readonly EditionView[]
  /**
   * DERIVED from `features` — AI tool categories (ids from `TOOL_CATEGORIES`),
   * or `'all'` for no ceiling. `'all'` is distinct from listing every id: it
   * means "inherit-all", which is what `computeToolCeiling` returns `null` for.
   */
  toolCategories: readonly string[] | 'all'
  /**
   * DERIVED from `features` — entity classes automation may create without
   * human review, or `'all'` for no restriction. `'all'` mirrors
   * `toolCategories: 'all'`: the identity element the gate treats as "this
   * edition imposes nothing", distinct from an enumerated list that happens to
   * be exhaustive today.
   */
  autoCreateEntities: 'all' | readonly EditionEntityType[]
  /**
   * Role chips pre-selected in onboarding. Empty = no preselection (the user
   * answers from a blank slate, today's behavior).
   */
  onboardingDefaultRoles: readonly string[]
  /**
   * AUTHORED (not derived) — the meeting agent this edition drives a capture
   * with when the user has not picked one, per mode.
   *
   * SLUGS, never ids. A system recipe's id is per-environment (dev and prod
   * seed their own rows); its slug is the stable cross-environment handle, and
   * it is what the client already matches on (INTERACTIVE_ASSISTANT_SLUG in
   * capture-detail-panel.tsx). Putting ids here would make the manifest
   * environment-specific — the one thing invariant 3 exists to prevent.
   *
   * `null` means "today's behavior" and is the identity element, exactly like
   * the `'all'` sentinels above: live falls back to the seeded Interactive
   * Assistant (client-side) and batch to the built-in ASSISTANT_PERSONA
   * (server-side). It is NOT the same as naming a slug that happens to resolve
   * to the Assistant — a null skips resolution entirely, so an edition that
   * wants no opinion costs no query.
   *
   * Resolution is FAIL-OPEN at every step (see
   * `src/lib/live-agent/default-agent.ts`): a missing row, an unseeded
   * environment, or an unreadable workspace all degrade to today's behavior
   * rather than blocking extraction. A default agent is a preference, never a
   * gate — invariant 2.
   */
  defaultAgents: EditionDefaultAgents
  /**
   * AUTHORED (not derived) — the words the app and the agent say in this
   * edition. `APP_WORDS` (every field empty) is today's app, word for word, so
   * an edition that says nothing changes no label and adds nothing to a
   * prompt. Read through ./words.ts, never field by field.
   */
  words: EditionWords
}

/**
 * The app's nouns an edition may say in its own words. Each is something the
 * person meets by name: in a card's pill ("12 actions"), a page's name, the
 * agent's replies. `quote` and `booking` have no rows on main yet (they arrive
 * with the customer front door, roadmap track B); naming them here keeps their
 * words in this one table, so the agent and B's surfaces say them the same way.
 */
export type EditionTerm =
  | 'action'
  | 'capture'
  | 'contact'
  | 'company'
  | 'deal'
  | 'project'
  | 'initiative'
  | 'document'
  | 'quote'
  | 'booking'

/** A term's word, both ways, and (for the agent) when it says something else. */
export interface TermWords {
  one: string
  many: string
  /** For the agent only: the case the word doesn't cover ("a to-do, when it isn't work for a customer"). */
  note?: string
}

/** The app's own word for every term: what an edition that says nothing shows. */
export const APP_TERMS: Readonly<Record<EditionTerm, TermWords>> = {
  action: { one: 'action', many: 'actions' },
  capture: { one: 'capture', many: 'captures' },
  contact: { one: 'contact', many: 'contacts' },
  company: { one: 'company', many: 'companies' },
  deal: { one: 'deal', many: 'deals' },
  project: { one: 'project', many: 'projects' },
  initiative: { one: 'initiative', many: 'initiatives' },
  document: { one: 'doc', many: 'docs' },
  quote: { one: 'quote', many: 'quotes' },
  booking: { one: 'booking', many: 'bookings' },
}

/** A page's name in an edition's words, where the `/` menu and its card name it. */
export interface PageWords {
  label: string
  /** One line on what it opens on (the `/` menu). Absent: the app's own line. */
  description?: string
  /**
   * What the person types after `/` for it ("jobs"). Absent: the app's own
   * slug. The app's slug stays the page's id (its icon, how the agent hears a
   * card was opened) and still finds it.
   */
  slug?: string
}

/** An empty chat's two starter prompts for one area, named by the area's page. */
export interface StarterWords {
  view: EditionView
  prompts: readonly string[]
}

/**
 * The words an edition says. Everything is optional in effect: an empty field
 * is the app's own words, and `APP_WORDS` is every field empty.
 *
 * Words only, by design (invariants 2 and 5): renaming a page never turns it
 * off, and the agent's tool names, tool results and prompts keep the app's own
 * words. The agent is told to translate when it speaks, so one set of tools and
 * one prompt serve every edition.
 */
export interface EditionWords {
  /**
   * Who the workspace is, in a sentence, to lead the agent's words section
   * (./words.ts renderEditionWordsSection). `null`, with no terms: no section,
   * the prompt as it is today.
   */
  agentLead: string | null
  /** The terms this edition says differently. Absent: `APP_TERMS`. */
  terms: Partial<Record<EditionTerm, TermWords>>
  /** App words the agent keeps out of its replies unless the person uses them first. */
  avoid: readonly string[]
  /** Pages this edition names differently, by the page's view. */
  pages: Partial<Record<EditionView, PageWords>>
  /**
   * The empty chat's starters, in order, by area (src/lib/chat/starters.ts).
   * `null`: the app's own areas and prompts. A view with no starter area there
   * is dropped, and every area keeps its own gates.
   */
  starters: readonly StarterWords[] | null
}

/** The app's own words: no section, no renames, today's starters. */
export const APP_WORDS: EditionWords = {
  agentLead: null,
  terms: {},
  avoid: [],
  pages: {},
  starters: null,
}

/**
 * Per-mode default agent slugs for an edition.
 *
 * The two modes are genuinely different personas, not one persona used twice:
 * `live` runs every few seconds mid-meeting and leans forward (it speaks to the
 * user), while `batch` sees the finished transcript once and writes the record.
 * A single field would force one of them to wear the other's prompt.
 */
export interface EditionDefaultAgents {
  /** Mid-meeting live agent (mode 'live'). */
  live: string | null
  /** End-of-meeting batch extraction (mode 'batch'). */
  batch: string | null
}

/** The mode a default agent is being resolved for. */
export type EditionAgentMode = 'live' | 'batch'

/**
 * The default agent SLUG for an edition in one mode, or `null` for "no opinion
 * — today's behavior". PURE: no I/O, no workspace, no recipe lookup.
 *
 * Accepts anything `getEdition` accepts (an id, a definition, garbage), so a
 * caller holding only a raw `settings.edition` value needs no coercion dance
 * and garbage degrades to `full` ⇒ `null` rather than throwing — invariant 1.
 */
export function editionDefaultAgentSlug(
  edition: EditionDefinition | EditionId | unknown,
  mode: EditionAgentMode,
): string | null {
  const def =
    edition && typeof edition === 'object' && 'defaultAgents' in edition
      ? (edition as EditionDefinition)
      : getEdition(edition)
  return def.defaultAgents?.[mode] ?? null
}

/**
 * The AUTHORED half of an edition — everything that is genuinely edition-level.
 * The surface (pages, extras, tool categories, auto-create) is composed from
 * `features` by `buildEdition` below and must not appear here.
 */
type EditionSpec = Omit<
  EditionDefinition,
  'views' | 'extraAllowedViews' | 'toolCategories' | 'autoCreateEntities'
>

/**
 * THE MANIFEST.
 *
 * Tunable forever in this table alone. An edition is now a NAMED FEATURE SET
 * plus the handful of things that do not decompose into features:
 * label/description (settings switcher copy), onboardingDefaultRoles (the
 * onboarding prime step), defaultAgents (the capture agents), words (what the
 * app and the agent call things). Every edition
 * starts with the same seeded loop, Triage (seed-default-loops.ts), so seeding
 * is not an edition choice. Everything else — the
 * pages, the pages reachable only from within others, the
 * chat tool ceiling, the auto-apply gate's entity set — is COMPOSED from
 * `features` at module load, so retuning an edition means editing one array.
 */
const EDITION_SPECS: Record<EditionId, EditionSpec> = {
  full: {
    id: 'full',
    label: 'Full',
    description:
      'Everything Native Intelligence does — meetings, projects, knowledge, CRM, and outreach in one workspace.',
    // `'all'`, not an enumerated feature list: this is what preserves the
    // inherit-all sentinels (null tool ceiling, unrestricted auto-create) that
    // make a full workspace byte-identical to the pre-editions app.
    features: 'all',
    onboardingDefaultRoles: [],
    // No opinion: full is the generalist edition, and today's behavior (live =
    // the seeded Interactive Assistant, batch = the built-in Assistant persona)
    // is exactly right for a workspace that has not declared a motion.
    defaultAgents: { live: null, batch: null },
    words: APP_WORDS,
  },

  sales: {
    id: 'sales',
    label: 'Sales',
    description:
      'Pipeline-first: calls coached and written up by the sales agents, with the whole app on.',
    // Every feature (invariant 5): the edition is the persona, not the surface.
    features: 'all',
    onboardingDefaultRoles: ['Sales'],
    // The two seeded sales system recipes. A sales workspace's calls ARE the
    // pipeline, so the generalist note-taker is the wrong default here: live
    // coaches the rep in the moment, batch writes the call record afterwards.
    defaultAgents: { live: 'sales-live', batch: 'sales-post-call' },
    words: APP_WORDS,
  },

  notes: {
    id: 'notes',
    label: 'Meeting notes',
    description:
      'Capture-first: meetings, notes, and the follow-ups they produce, with the whole app on.',
    features: 'all',
    onboardingDefaultRoles: [],
    defaultAgents: { live: null, batch: null },
    words: APP_WORDS,
  },

  brain: {
    id: 'brain',
    label: 'Company brain',
    description:
      'Knowledge-first: everything the org knows, cross-linked, with the whole app on.',
    features: 'all',
    onboardingDefaultRoles: [],
    defaultAgents: { live: null, batch: null },
    words: APP_WORDS,
  },

  // A business that serves customers, run by an agent the owner mostly texts
  // (roadmap F1, "speaks the owner's language"). Every text sign-up is one
  // (roadmap track A), and so is any workspace that sets up a business profile
  // (track B). The owner may not be computer literate: the words are theirs
  // (jobs, customers, quotes, bookings), never a software team's.
  service: {
    id: 'service',
    label: 'Service business',
    description:
      'A business that serves customers, like a rug cleaner, a plumber or a dog walker: jobs, customers, quotes and bookings in the owner’s words, with the whole app on.',
    features: 'all',
    onboardingDefaultRoles: [],
    // No opinion yet: the call agents for a business's phone line are their own work (roadmap B3/D4).
    defaultAgents: { live: null, batch: null },
    words: {
      agentLead:
        'This workspace is a service business (a rug cleaner, a plumber, a dog walker…): the owner does work for customers, mostly by phone and text, and may not use computers much.',
      terms: {
        // "Job" is also track D's complete_job (a customer's finished work,
        // which may ask them for a review): the note sends a done job there.
        action: {
          one: 'job',
          many: 'jobs',
          note: 'or a to-do, when it isn’t work for a customer; when they say a customer’s job is done, that’s complete_job',
        },
        capture: { one: 'call', many: 'calls', note: 'or a voice note' },
        contact: { one: 'customer', many: 'customers', note: 'or a supplier, a worker or someone they know, when that’s who it is' },
        initiative: { one: 'goal', many: 'goals' },
        // Track B's quotes (customer_quote, list_quotes / get_quote).
        quote: { one: 'quote', many: 'quotes', note: 'what a customer asked a price for' },
        // The business's own word for it, once it has one (a pickup, a visit,
        // a walk: track B's business_profile.booking_kind) wins: ./words.ts.
        booking: { one: 'booking', many: 'bookings' },
      },
      // Software-team words with no plain replacement. "Project" and
      // "milestone" stay: they're ordinary English, and the agent may make
      // one when the owner plans something big.
      avoid: ['cycle', 'sprint', 'backlog', 'pipeline', 'action item'],
      pages: {
        todo: { label: 'My jobs', description: 'Jobs and to-dos still open', slug: 'jobs' },
        captures: { label: 'Calls & notes', description: 'Your calls and voice notes', slug: 'calls' },
        contacts: { label: 'Customers', description: 'Everyone you’ve worked for', slug: 'customers' },
        initiatives: { label: 'Goals', description: 'Every goal', slug: 'goals' },
      },
      starters: [
        { view: 'todo', prompts: ['What jobs do I have today?', 'What’s still open this week?'] },
        { view: 'calendar', prompts: ['What’s on for tomorrow?', 'Who am I seeing this week?'] },
        { view: 'contacts', prompts: ['Which customers haven’t been back in a while?', 'Show my newest customers'] },
        { view: 'captures', prompts: ['What did my last caller want?', 'Sum up today’s calls'] },
        { view: 'mail', prompts: ['Which emails need a reply?', 'Did a customer email me today?'] },
      ],
    },
  },
}

/** Spec + composed surface = the definition every consumer already reads. */
function buildEdition(spec: EditionSpec): EditionDefinition {
  const { views, extraAllowedViews, toolCategories, autoCreateEntities } = composeSurface(
    spec.features,
  )
  return { ...spec, views, extraAllowedViews, toolCategories, autoCreateEntities }
}

/**
 * The manifest as consumers see it: same shape as before the feature
 * decomposition, composed once at module load. Frozen in practice by being
 * built from pure functions over immutable tables.
 */
export const EDITIONS: Record<EditionId, EditionDefinition> = {
  full: buildEdition(EDITION_SPECS.full),
  sales: buildEdition(EDITION_SPECS.sales),
  notes: buildEdition(EDITION_SPECS.notes),
  brain: buildEdition(EDITION_SPECS.brain),
  service: buildEdition(EDITION_SPECS.service),
}

/** Ordered list for settings UIs — `full` first, then the personas. */
export const EDITION_LIST: readonly EditionDefinition[] = EDITION_IDS.map((id) => EDITIONS[id])

/**
 * Coerce an unknown value into a valid EditionId.
 *
 * Defensive by the same rule as `normalizeTrustPolicy`: any shape of garbage in
 * `settings.edition` (null, a number, a stale id from a removed edition)
 * degrades to `full` rather than throwing — invariant 1.
 */
export function normalizeEditionId(raw: unknown): EditionId {
  if (typeof raw !== 'string') return DEFAULT_EDITION_ID
  return (EDITION_IDS as readonly string[]).includes(raw)
    ? (raw as EditionId)
    : DEFAULT_EDITION_ID
}

/** True when `raw` is EXACTLY a known edition id (no coercion). Use this at
 *  attribution boundaries — a `?edition=` query param, an API body — where the
 *  difference between "the caller said sales" and "the caller said nonsense"
 *  matters and must NOT be silently recorded as `full`. */
export function isEditionId(raw: unknown): raw is EditionId {
  return typeof raw === 'string' && (EDITION_IDS as readonly string[]).includes(raw)
}

/** The definition for any input, normalized. Never throws, never returns null. */
export function getEdition(raw: unknown): EditionDefinition {
  return EDITIONS[normalizeEditionId(raw)]
}

/**
 * Is the page `view` on in this edition? Allowed = always-allowed ∪ views ∪
 * extraAllowedViews.
 */
export function isViewAllowed(edition: EditionDefinition, view: EditionView): boolean {
  return ALWAYS_ALLOWED_VIEWS.includes(view) || edition.views.includes(view) || edition.extraAllowedViews.includes(view)
}

/** Every view reachable in an edition, deduped. Convenience for consumers that
 *  want the set rather than a predicate. */
export function allowedViews(edition: EditionDefinition): Set<EditionView> {
  return new Set<EditionView>([
    ...ALWAYS_ALLOWED_VIEWS,
    ...edition.views,
    ...edition.extraAllowedViews,
  ])
}

/** May automation create this entity type unattended in this edition? A `false`
 *  means STAGE for human review — never drop (invariant 2). */
export function isAutoCreateAllowed(
  edition: EditionDefinition,
  entityType: EditionEntityType | string,
): boolean {
  if (edition.autoCreateEntities === 'all') return true
  return (edition.autoCreateEntities as readonly string[]).includes(entityType)
}

/**
 * Is one feature effectively on for a resolved workspace?
 *
 * The `'all'` sentinel means "every DEFAULT-ON feature", so a hidden or opt-in
 * key is off under it — a full workspace does not get Evals for free. Any other
 * result is an explicit list and answers for itself.
 */
export function isFeatureEnabled(
  resolved: { edition: EditionDefinition; overrides: FeatureOverrides },
  key: FeatureKey,
): boolean {
  const keys = effectiveFeatureKeys(resolved.edition, resolved.overrides)
  if (keys === 'all') return !FEATURES[key].hidden && !FEATURES[key].optIn
  return keys.includes(key)
}

/**
 * System `recipe` ids that must be hidden from this workspace — every
 * `systemRecipeIds` entry belonging to a feature that is NOT effectively on.
 *
 * Empty for a workspace where every recipe-owning feature is live, and every
 * query helper must treat empty as "change nothing", so the gated path is
 * byte-identical to the ungated one when nothing is gated.
 */
export function featureGatedRecipeExclusions(resolved: {
  edition: EditionDefinition
  overrides: FeatureOverrides
}): string[] {
  const out: string[] = []
  for (const key of FEATURE_KEYS) {
    const ids = FEATURES[key].systemRecipeIds
    if (!ids || ids.length === 0) continue
    if (!isFeatureEnabled(resolved, key)) out.push(...ids)
  }
  return out
}

/** Every feature-gated system recipe id, regardless of any workspace. Used
 *  where there is no workspace to resolve (the public marketplace listing). */
export const ALL_FEATURE_GATED_RECIPE_IDS: readonly string[] = FEATURE_KEYS.flatMap(
  (k) => FEATURES[k].systemRecipeIds ?? [],
)
