/**
 * Which tool calls bring UNTRUSTED OUTSIDE TEXT into a run (trust layer P2;
 * decision 16 as Liam settled it on 2026-10-20: apply with undo, never an
 * approval queue). Nothing an agent learns or writes into Native Intelligence waits on
 * this: a teammate memory entry and a canon edit apply at once and can be
 * undone. What it decides is provenance: the run's reads are recorded
 * (agent_run.outside_reads, migration 374) so what it taught or wrote carries
 * a quiet label ("learned from a web page", outside-label.ts) that lets the
 * person spot and remove it, and a document written after them stays marked
 * (outside_derived). It still gates outward actions: posts, sends and
 * connector writes after outside text (P7's egress rules) are unchanged.
 *
 * Outside text is text nobody in the workspace wrote or chose to trust:
 *   - the web: the work-agent's own web_search and web_fetch, the browser
 *     tools, and the web research tools (company research, prospect
 *     discovery and its candidates);
 *   - a connected app's tool (any mcp__ name): another service's data;
 *   - files and references pulled in: an attachment's content, a reference
 *     or source ingest;
 *   - mail from someone the person doesn't know: list_emails and read_email
 *     count only when a sender in the result is not a known sender
 *     (src/lib/agent-events/known-senders.ts) or no sender can be read off a
 *     message; get_email_summary always counts (it carries mail text with no
 *     sender to check).
 * NOT outside text: only what INTERNAL_TEXT_TOOLS lists (the person's own
 * calls and transcripts, documents, the board, the CRM, members' comments),
 * the run's own writes inside the workspace echoed back (never an external
 * write such as open_browser), and the runner's planning tools.
 *
 * FAIL CLOSED (F3 review): this is the ONE definition. Both a work run's
 * tracking (the tool route + run-work-eve.ts) and a loop run's provenance
 * (src/lib/flows/run-outside-reads.ts) call readOutsideText on each call's
 * name and result. A tool that is not on the internal allow-list counts as
 * outside text, whatever it returned. An internal tool's result still counts
 * when it carries the untrusted-content fence (a document made from a file,
 * an email body), and the search tools (find, search, deep_search) count
 * when any hit is an email, an attachment or anything sourced from one.
 *
 * Conservative by construction: a mail result the checker can't read, or a
 * known-sender lookup that fails, counts as outside text.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { knownSenders } from '@/lib/agent-events/known-senders'

export { outsideReadLabel } from './outside-label'

/**
 * What one stream `action.result` event read: a tool's result judged by this
 * module's one definition, a subagent's or a delegated teammate's as outside
 * (what it read is not on this stream), a skill load as internal. Null for
 * any other event. Loop runs (run-skill-eve.ts) and work runs
 * (run-work-eve.ts) both judge every result through it.
 */
export function toolReadOf(ev: { type: string; data?: unknown }): ToolRead | null {
  if (ev.type !== 'action.result') return null
  const result = (ev.data as { result?: { kind?: unknown; toolName?: unknown; output?: unknown; isError?: unknown } } | undefined)?.result
  if (!result || typeof result !== 'object') return null
  if (result.kind === 'subagent-result') return { tool: 'agent', outside: true }
  if (result.kind === 'load-skill-result') return { tool: 'load_skill', outside: false }
  if (result.kind !== 'tool-result' || typeof result.toolName !== 'string') return { tool: 'unknown', outside: true }
  return classifyToolRead(result.toolName, result.isError === true ? { isError: true } : result.output)
}

/** The work-agent's own web tools (eve built-ins, never registry names). */
export const EVE_WEB_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch'])

/** Registry tools whose result is outside text, whatever it says. */
export const OUTSIDE_TEXT_TOOLS: ReadonlySet<string> = new Set([
  ...EVE_WEB_TOOLS,
  'get_email_summary',
  'get_attachment_content',
  'ingest_reference',
  'ingest_source',
  'research_my_company',
  'run_prospect_discovery',
  'research_prospect_companies',
  'find_prospect_people',
  'find_prospects',
  'get_prospecting_run_candidates',
  'read_browser_page',
  'get_browser_text',
  'run_browser_task',
])

/** Mail reads that count only when a sender in the result is unknown. */
export const SENDER_CHECKED_MAIL_TOOLS: ReadonlySet<string> = new Set(['list_emails', 'read_email'])

/**
 * Read tools whose result is ONLY text people in the workspace wrote or chose
 * to keep: their calls and transcripts, the board, projects and goals,
 * documents (a file-made one is fenced, and the fence is checked), the CRM's
 * own records, members' comments, flows and skills. Everything else a run
 * can call is outside text unless listed here: calendar events (an outside
 * organizer writes them), notifications, digests and dashboards (they quote
 * mail), the knowledge graph (claims are extracted from mail too), bot
 * replies, prospecting, the browser, flow run previews (an http body).
 */
export const INTERNAL_TEXT_TOOLS: ReadonlySet<string> = new Set([
  // calls
  'list_captures', 'list_recent_captures', 'list_contact_captures', 'get_capture_content', 'get_capture_transcript', 'get_capture_extractions',
  // the board
  'list_actions', 'get_action', 'list_workflow_states', 'get_action_suggestions', 'list_labels', 'list_bot_work', 'get_bot_item',
  'list_projects', 'get_project_context', 'list_milestones', 'list_initiatives', 'get_initiative', 'list_cycles', 'get_cycle', 'list_decisions',
  // documents (fence-checked)
  'list_documents', 'get_document', 'read_canon', 'list_document_revisions', 'get_document_revision', 'list_action_documents',
  // the CRM's own records
  'list_contacts', 'get_contact', 'get_contact_details', 'get_company_overview', 'list_companies', 'list_workspace_members',
  // members' comments
  'list_comments', 'get_comment_replies',
  // the workspace's own setup
  'list_recipes', 'list_flows', 'list_skills', 'get_skill', 'list_agents', 'get_agent', 'list_connections',
  'list_sequences', 'get_sequence', 'list_campaigns', 'list_evals', 'get_eval_run', 'show', 'search_tools', 'ask_user',
  // the runner's own planning, scratch files, skills and structured result;
  // a work run's question to its person and its own finish (their words / its own)
  'update_plan', 'read_file', 'write_file', 'load_skill', 'eve__reply', 'final_output', 'submit_run_verdict',
  'request_user_input', 'finish_work',
])

/** Search tools: internal unless a hit is mail, an attachment, or sourced from one. */
export const RESULT_CHECKED_SEARCH_TOOLS: ReadonlySet<string> = new Set(['find', 'search', 'deep_search'])

const bare = (name: string) => (typeof name === 'string' ? name.replace(/^dial8_/, '') : '')

/** True when the tool's result is outside text whatever it says (no sender check). Pure. */
export function isOutsideTextTool(toolName: string): boolean {
  const name = bare(toolName)
  return name.startsWith('mcp__') || OUTSIDE_TEXT_TOOLS.has(name)
}

/**
 * True for a tool whose result is workspace text by name: on the allow-list,
 * or a write (its result echoes what the run itself wrote). Pure.
 */
export function isInternalTextTool(toolName: string): boolean {
  const name = bare(toolName)
  if (!name || isOutsideTextTool(name) || SENDER_CHECKED_MAIL_TOOLS.has(name) || RESULT_CHECKED_SEARCH_TOOLS.has(name)) return false
  return INTERNAL_TEXT_TOOLS.has(name) || workspaceWriteTools().has(name)
}

let writeTools: Set<string> | null = null
/**
 * The registry's writes inside the workspace (internal-write, automation-write,
 * delete): their result echoes what the run itself wrote. An external write
 * (open_browser, a push to Linear, a calendar event) answers with another
 * service's data, so it is not one of them.
 */
function workspaceWriteTools(): Set<string> {
  if (!writeTools) {
    writeTools = new Set(
      TOOL_CATEGORIES.flatMap((c) => c.tools)
        .filter((t) => t.sideEffect === 'internal-write' || t.sideEffect === 'automation-write' || t.sideEffect === 'delete')
        .map((t) => t.name),
    )
  }
  return writeTools
}

/** True for any tool whose call may bring outside text: everything not internal by name. Pure. */
export function mayReadOutsideText(toolName: string): boolean {
  return !isInternalTextTool(toolName)
}

/**
 * The untrusted-content fences (src/lib/email/untrusted.ts wrapUntrusted,
 * the kinds src/lib/ai/outside-text-tools.ts lists) that mark text from
 * OUTSIDE: mail, the web (enrichment too), calendar invites, files, browser
 * pages, another service's tool. A TRANSCRIPT fence is the person's own call
 * (decision 16) and WORKSPACE / CHAT / CHECKPOINT fences are members' text:
 * not outside.
 */
const OUTSIDE_FENCE_RE = /\[UNTRUSTED (EMAIL|WEB|CALENDAR|FILE|BROWSER|TOOL) CONTENT/

/** The result carries outside text in a fence anywhere in it. Pure; an unreadable result counts. */
export function carriesUntrustedFence(output: unknown): boolean {
  try {
    return OUTSIDE_FENCE_RE.test(typeof output === 'string' ? output : JSON.stringify(output ?? null))
  } catch {
    return true
  }
}

const OUTSIDE_HIT_RE = /^(email|emails|mail|email_thread|email_message|gmail|outlook|attachment|attachments|file|reference|web|message)$/i
const HIT_KIND_FIELDS = ['result_type', 'source_type', 'type', 'kind', 'entity_type'] as const

/** A search result has a hit that is (or comes from) mail, an attachment, a file or the web. Pure; at most 500 objects, 5 levels. */
export function searchHitsOutside(output: unknown): boolean {
  let seen = 0
  const walk = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 5 || seen++ > 500) return false
    if (Array.isArray(value)) return value.some((v) => walk(v, depth + 1))
    const rec = value as Record<string, unknown>
    for (const field of HIT_KIND_FIELDS) {
      const v = rec[field]
      if (typeof v === 'string' && OUTSIDE_HIT_RE.test(v.trim())) return true
    }
    return Object.values(rec).some((v) => walk(v, depth + 1))
  }
  return walk(output, 0)
}

const ADDRESS_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
const MAX_MESSAGES = 50

/**
 * The sender of every message a mail tool's result carries: each object
 * holding a `from` (or `from_email` / `sender`) field, its address
 * lower-cased, or null when that message's sender can't be read. Walks at
 * most MAX_MESSAGES messages, four levels deep. Pure.
 */
export function mailSendersIn(output: unknown): Array<string | null> {
  const out: Array<string | null> = []
  const walk = (value: unknown, depth: number) => {
    if (out.length >= MAX_MESSAGES || depth > 4 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const rec = value as Record<string, unknown>
    const field = ['from_email', 'from', 'sender'].find((key) => key in rec)
    if (field) {
      const raw = rec[field]
      const text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && typeof (raw as { email?: unknown }).email === 'string' ? (raw as { email: string }).email : ''
      const address = text.match(ADDRESS_RE)?.[0]?.toLowerCase() ?? null
      out.push(address)
      return
    }
    for (const child of Object.values(rec)) walk(child, depth + 1)
  }
  walk(output, 0)
  return out
}

/** A failed call returned nothing to read. */
function failed(output: unknown): boolean {
  return !!output && typeof output === 'object' && ((output as { success?: unknown }).success === false || (output as { isError?: unknown }).isError === true)
}

export type KnownSendersLookup = (addresses: string[]) => Promise<ReadonlySet<string>>

/**
 * Did this call bring outside text into the run? The ONE definition (see the
 * header): fail closed on any tool not internal by name; an internal tool's
 * fenced result and a search hit on mail or files count; the mail reads are
 * sender-checked. `known` answers which of some addresses the person knows
 * (knownSenders, bound to the run's workspace and user). A failed call read
 * nothing. Never throws: a lookup that fails counts every sender as unknown.
 */
export async function readOutsideText(toolName: string, output: unknown, known: KnownSendersLookup): Promise<boolean> {
  return readsOutsideText([classifyToolRead(toolName, output)], known)
}

/**
 * One call's result, judged without I/O (a run's stream tap keeps these
 * instead of whole outputs): outside, internal, or the mail senders still to
 * check against the person's known senders.
 */
export interface ToolRead {
  tool: string
  outside: boolean
  /** A mail read: the senders to check (null: one that can't be read, which counts). */
  senders?: Array<string | null>
}

/** Judge one call's result (see readOutsideText). Pure. */
export function classifyToolRead(toolName: string, output: unknown): ToolRead {
  const name = bare(toolName)
  if (failed(output)) return { tool: name, outside: false }
  if (isOutsideTextTool(name)) return { tool: name, outside: true }
  if (RESULT_CHECKED_SEARCH_TOOLS.has(name)) return { tool: name, outside: searchHitsOutside(output) || carriesUntrustedFence(output) }
  if (SENDER_CHECKED_MAIL_TOOLS.has(name)) return { tool: name, outside: false, senders: mailSendersIn(output) }
  return { tool: name, outside: !isInternalTextTool(name) || carriesUntrustedFence(output) }
}

/** Did any of these calls read outside text? Checks the mail senders, once. Never throws. */
export async function readsOutsideText(reads: readonly ToolRead[], known: KnownSendersLookup): Promise<boolean> {
  if (reads.some((r) => r.outside)) return true
  const senders = reads.flatMap((r) => r.senders ?? [])
  if (senders.length === 0) return false
  if (senders.some((s) => s === null)) return true
  try {
    const knownSet = await known([...new Set(senders as string[])])
    return senders.some((s) => !knownSet.has(s as string))
  } catch {
    return true
  }
}

/** The tool names among these reads that brought outside text by themselves (no sender check). Pure. */
export function outsideToolsIn(reads: readonly ToolRead[]): string[] {
  return [...new Set(reads.filter((r) => r.outside).map((r) => r.tool))]
}

/**
 * The addresses the run's person knows (known-senders.ts), plus their own
 * mailboxes: their own sent mail is not outside text. Throws on a failed
 * read (the caller's lookup then counts every sender as unknown).
 */
export async function knownOrOwnSenders(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; addresses: string[] },
): Promise<Set<string>> {
  const known = await knownSenders(supabase, args)
  const { data, error } = await supabase.from('connected_account').select('account_email').eq('user_id', args.userId).eq('capability', 'email')
  if (error) throw new Error(error.message)
  for (const row of (data ?? []) as Array<{ account_email?: unknown }>) {
    if (typeof row.account_email === 'string' && row.account_email.trim()) known.add(row.account_email.trim().toLowerCase())
  }
  return known
}

/**
 * Record that a run read outside text through `toolName` (agent_run.outside_reads,
 * migration 374): once per tool, atomically. Best effort, never throws: a
 * lost note only means what the run teaches or writes goes unlabelled.
 */
export async function noteOutsideRead(
  supabase: SupabaseClient,
  ref: { agentRunId: string; workspaceId: string; toolName: string },
): Promise<void> {
  try {
    const { error } = await supabase.rpc('agent_run_note_outside_read', {
      p_run_id: ref.agentRunId,
      p_workspace_id: ref.workspaceId,
      p_tool: bare(ref.toolName).slice(0, 200),
    })
    if (error) console.warn('[outside-text] could not note an outside read:', error.message)
  } catch (err) {
    console.warn('[outside-text] could not note an outside read:', err instanceof Error ? err.message : String(err))
  }
}

/** The eve web tools a stream of turn events called (actions.requested), each once. Pure. */
export function eveWebToolsIn(events: ReadonlyArray<{ type: string; data?: unknown }>): string[] {
  const out = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'actions.requested') continue
    const actions = (ev.data as { actions?: unknown } | undefined)?.actions
    if (!Array.isArray(actions)) continue
    for (const action of actions as Array<{ kind?: unknown; toolName?: unknown }>) {
      if (action?.kind === 'tool-call' && typeof action.toolName === 'string' && EVE_WEB_TOOLS.has(action.toolName)) out.add(action.toolName)
    }
  }
  return [...out]
}

/** Every outside-text tool a run's log tail names on its `[tool] …` lines (a fallback for a lost note). Pure. */
export function outsideToolsInLog(logTail: unknown): string[] {
  if (typeof logTail !== 'string' || !logTail) return []
  const out = new Set<string>()
  for (const match of logTail.matchAll(/^\[tool\]\s*(.+)$/gim)) {
    for (const name of match[1].split(/[,\s]+/).filter(Boolean)) if (isOutsideTextTool(name)) out.add(bare(name))
  }
  return [...out]
}
