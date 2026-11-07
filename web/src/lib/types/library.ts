/**
 * Library types — the unified vocabulary for Skills and Agents.
 *
 * These are persisted in the `public.recipe` table (the table name is
 * internal-only; user-facing surfaces never use the word "recipe").
 *
 *   - `skill` (was 'agent') — Chat-invoked context+tools presets.
 *     Invoked via slash-command in the chat panel. Examples:
 *     "Weekly Planner", "Email Assistant".
 *
 *   - `agent` (was 'live_agent') — Autonomous agents that process a capture,
 *     either live (during recording) or as a post-capture batch pass. They
 *     listen, propose changes, and can act. The built-in "Assistant" is the
 *     default persona when no agent is selected. Examples: "Project Manager".
 *
 * (The former `meeting_type` category was removed — captures no longer carry a
 * per-capture template; a single agent concept drives all processing.)
 */

export type LibraryCategory = 'skill' | 'agent'

export type LibraryVisibility = 'personal' | 'workspace' | 'public'

/**
 * How an agent behaves when it drives a capture. See `AgentConfig.capture_mode`.
 */
export type CaptureAgentMode = 'full' | 'assist_only'

/**
 * Agent/skill behavior configuration stored in the JSONB `agent_config`
 * column. Applies to both skills and agents.
 */
export interface AgentConfig {
  enabled_tools?: string[]
  disabled_tools?: string[]
  /** 'agent' on a skill the agent wrote (src/lib/flows/skill-tool-profile.ts). */
  authored_by?: 'agent'
  /** Listed by the live copilot as a call playbook (any member may set it). */
  live_playbook?: boolean
  /**
   * How this agent behaves when it drives a CAPTURE.
   *
   *   - absent / 'full' — today's behavior: the agent takes notes, writes the
   *     summary, and stages proposals.
   *   - 'assist_only' — the agent is a real-time HELPER and nothing else. It
   *     talks to the user (say_to_user / ask_user) grounded in read tools, and
   *     writes NO notes and stages NO proposals; a post-call batch pass does all
   *     of that afterwards. Honored in LIVE mode only — a batch run is the pass
   *     that writes the record, so it ignores the flag entirely (and the batch
   *     resolver never picks an assist-only persona in the first place).
   */
  capture_mode?: CaptureAgentMode
  response_style?: {
    format?: string
    tone?: string
    always_cite_sources?: boolean
  }
  context_rules?: string[]
}

/**
 * Unified row shape for any library item — meeting type, skill, or agent.
 *
 * This is the broad shape used by list views and the marketplace surface.
 * For type-narrowed handling per category, see the discriminated union
 * aliases (Skill, Agent) below.
 */
export interface LibraryItem {
  id: string
  name: string
  icon: string | null
  color: string | null
  description: string | null
  category: LibraryCategory
  slug: string | null
  system_prompt: string | null
  is_system: boolean
  is_default: boolean
  sort_order: number
  created_at: string
  visibility: LibraryVisibility
  created_by: string | null

  /** Skill/agent behavior config. */
  agent_config: AgentConfig | null

  /** Optional model override (currently used for agents). */
  model: string | null

  /**
   * A skill's area (migration 316, src/lib/packs/registry.ts): its pack
   * loads it whenever the agent works there. Null for none, and for agents.
   */
  area?: string | null

  /** Marketplace metadata (migration 079). */
  fork_count: number
  forked_from: string | null
  author_name: string | null
  author_avatar_url: string | null
  marketplace_category: string | null
  featured: boolean
}

// ─── Discriminated unions for type-narrowing ─────────────────────────

export type Skill = LibraryItem & { category: 'skill' }
export type Agent = LibraryItem & { category: 'agent' }

// ─── Display labels (single source of truth for the UI) ──────────────

export const LIBRARY_CATEGORY_LABELS: Record<LibraryCategory, string> = {
  skill: 'Skill',
  agent: 'Agent',
}

/**
 * The single user-facing name for the whole library surface (nav item, tab
 * title, page header, command palette). It holds the personas teammates are
 * built from and the skills they run. It was "Agents & Skills" until a page of
 * what the teammates were doing took the name "Agents" (since gone: each bot
 * has its own page); the view id stays `agents`, so saved tabs and links still
 * land here.
 *
 * Keep every entry-point label reading from this constant so the name can never
 * drift between the nav, the tab, and the page header again.
 */
export const LIBRARY_SURFACE_LABEL = 'Personas'
