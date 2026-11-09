'use client'

import { Button } from '@/components/ui/button'
import { ShimmerText } from '@/components/ui/shimmer-text'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { CheckCircle, ChevronDown, CircleAlert, CircleDashed, CirclePause, Clock3, ExternalLink, Settings, ShieldAlert, XCircle } from 'lucide-react'
import { memo, useState } from 'react'
import { browserTaskOutcome } from './browser-task-outcome'
import { describeSearchScope, readSearchScope } from '@/lib/ai/tools/search-scope'

export type ToolState =
  | 'partial-call'
  | 'call'
  | 'result'
  | 'error'

/** Describes a clickable entity link shown inline on a completed tool call. */
export type EntityLink = {
  id: string
  label: string
  /** Each opens as a card the person opened (chat-message.tsx chipOpenTarget):
   *  a record as its record card, a prospect list on the Prospecting card. */
  type:
    | 'action'
    | 'capture'
    | 'document'
    | 'contact'
    | 'company'
    | 'project'
    | 'initiative'
    | 'calendar-event'
    | 'prospect_list'
}

export type ToolProps = {
  name: string
  state: ToolState
  args?: Record<string, unknown>
  result?: unknown
  className?: string
  /** Clickable entity links extracted from the tool result */
  entityLinks?: EntityLink[]
  /** Callback when an entity link is clicked */
  onEntityClick?: (link: EntityLink) => void
}

const TOOL_LABELS: Record<string, string> = {
  // Search
  find: 'Search workspace',
  search: 'Search',
  deep_search: 'Deep search',
  search_tools: 'Discover tools',
  load_skill: 'Load skill',
  // Provider-executed internet access (eve built-ins). The chat renders
  // web_search through its own WebSearchCard; this label is the fallback for
  // any other surface that falls back to the generic chip.
  web_search: 'Search the web',
  web_fetch: 'Fetch web page',
  // Pages in the chat (a show card renders itself; this is the fallback chip).
  show: 'Show',
  read_card: 'Read a card',
  // Actions
  create_action: 'Create action',
  update_action: 'Update action',
  list_actions: 'List actions',
  complete_action: 'Complete action',
  suggest_changes: 'Suggest changes',
  settle_card: 'Settle card',
  list_bot_work: 'Read agent work',
  get_bot_item: 'Read an agent item',
  settle_work_item: 'Settle agent work',
  send_work_answer: 'Answer an agent',
  rename_bot: 'Rename an agent',
  delete_bot: 'Delete an agent',
  merge_bots: 'Merge agents',
  send_bot_message: 'Message an agent',
  wait_for_bot_reply: 'Wait for an agent',
  start_helper: 'Start a helper',
  stop_helper: 'Stop a helper',
  // Local agents on the person's Mac (docs/plans/local-agents.md).
  local_agents: 'Check local agents',
  start_local_agent: 'Start a local agent',
  message_local_agent: 'Message a local agent',
  read_local_agent: 'Read a local agent',
  stop_local_agent: 'Stop a local agent',
  // …and its cloud counterpart (docs/plans/environments.md E2).
  start_cloud_coding_run: 'Start a cloud coding run',
  // Guest access: the main agent's answer to a guest's ask.
  answer_guest: 'Answer a guest',
  ask_agent: 'Ask their agent',
  remember: 'Remember',
  // The person's Now file (docs/plans/now-file.md): the main agent's running notes.
  update_now: 'Update the Now file',
  // Getting started (docs/plans/getting-started-skill.md): the walk-through ends.
  finish_getting_started: 'Finish getting started',
  // Setup by text (src/lib/onboarding/text-setup.ts).
  connect_link: 'Make a connect link',
  save_business_profile: 'Save the business profile',
  // Bringing existing customers in (src/lib/ai/tools/contact-import.ts).
  read_contact_file: 'Read the contacts file',
  import_contact_file: 'Import contacts',
  list_contact_imports: 'Check imports',
  undo_contact_import: 'Undo the import',
  // The agent's checklist for a long job (agents' native update_plan; the chat
  // draws its own plan card, this is the fallback chip for a refused call).
  update_plan: 'Update plan',
  delete_action: 'Delete action',
  list_action_lists: 'List action lists',
  move_action: 'Move action',
  confirm_action: 'Confirm action',
  dismiss_action: 'Dismiss action',
  get_action_suggestions: 'Get suggestions',
  reorder_actions: 'Reorder actions',
  create_actions_batch: 'Create actions',
  // Flows (loops)
  list_flows: 'List loops',
  create_flow: 'Create loop',
  update_flow: 'Update loop',
  delete_flow: 'Delete loop',
  list_flow_runs: 'Read loop runs',
  get_flow_run: 'Read loop run',
  test_flow: 'Test loop',
  transfer_flow_owner: 'Hand over loop',
  request_flow_takeover: 'Ask for loop',
  // Skills
  list_skills: 'List skills',
  get_skill: 'Read skill',
  create_skill: 'Create skill',
  update_skill: 'Update skill',
  // Document part edits and history
  edit_document_lines: 'Edit document lines',
  replace_section: 'Replace document section',
  append_to_section: 'Add to document section',
  remove_section: 'Remove document section',
  insert_section_after: 'Add document section',
  list_document_revisions: 'Read document history',
  get_document_revision: 'Read document version',
  restore_document_revision: 'Restore document version',
  archive_document: 'Archive document',
  restore_document: 'Restore document',
  archive_reports: 'Archive reports',
  delete_document: 'Delete document',
  // Canon documents (D1/D2)
  read_canon: 'Read canon document',
  // Connections (F2)
  list_connections: 'Check connections',
  connect: 'Connect an app',
  disconnect: 'Disconnect',
  set_tool_access: 'Change tool access',
  get_tool_approval_result: 'Check approved call',
  read_guest_conversation: 'Read guest conversation',
  // Posts (content C0)
  lint_post: 'Check post',
  review_post: 'Review post',
  publish_post: 'Post via Typefully',
  send_payment_link: 'Send payment link',
  schedule_post: 'Queue in Typefully',
  create_canon_document: 'Create canon document',
  propose_section_edit: 'Edit canon section',
  revert_section_edit: 'Revert document edit',
  // Notes
  list_notes: 'List notes',
  create_note: 'Create note',
  update_note: 'Update note',
  archive_note: 'Archive note',
  get_note_content: 'Get note content',
  text_search_notes: 'Search notes',
  semantic_search_notes: 'Search notes',
  // Contacts
  search_contacts: 'Search contacts',
  list_contacts: 'List contacts',
  list_companies: 'List companies',
  create_company: 'Create company',
  update_company: 'Update company',
  get_contact: 'Get contact',
  create_contact: 'Create contact',
  update_contact: 'Update contact',
  enrich_contact: 'Enrich contact',
  toggle_favorite_contact: 'Toggle favorite',
  list_contact_groups: 'List contact groups',
  // Goals
  create_goal: 'Create goal',
  list_goals: 'List goals',
  get_goal: 'Get goal',
  update_goal: 'Update goal',
  delete_goal: 'Delete goal',
  create_milestone: 'Create milestone',
  update_milestone: 'Update milestone',
  delete_milestone: 'Delete milestone',
  // Projects
  list_projects: 'List projects',
  create_project: 'Create project',
  get_project_context: 'Get project context',
  // Calendar
  get_calendar_events: 'Get calendar events',
  create_calendar_event: 'Create calendar event',
  update_calendar_event: 'Update calendar event',
  delete_calendar_event: 'Delete calendar event',
  // Email
  list_emails: 'List emails',
  get_email: 'Get email',
  search_emails: 'Search emails',
  create_email_draft: 'Create email draft',
  revise_email_draft: 'Revise email draft',
  update_email_thread: 'Update email threads',
  unsubscribe_thread: 'Unsubscribe',
  discard_email_draft: 'Discard email drafts',
  // Customers & bookings (roadmap B)
  list_quotes: 'List quotes',
  get_quote: 'Read quote',
  update_quote: 'Update quote',
  get_business_profile: 'Read business profile',
  update_business_profile: 'Update business profile',
  create_quote_form_link: 'Make quote form link',
  find_booking_slots: 'Find booking slots',
  list_bookings: 'List bookings',
  move_booking: 'Move booking',
  cancel_booking: 'Cancel booking',
  send_quote: 'Send quote',
  book_quote: 'Book quote',
  // Attachments
  list_attachments: 'List attachments',
  get_attachment_content: 'View attachment',
  attach_chat_file: 'Attach file',
  semantic_search_attachments: 'Search attachments',
  // Captures
  list_captures: 'List captures',
  get_capture_content: 'Read capture',
  get_capture_transcript: 'Read transcript',
  create_capture: 'Create capture',
  undo_extraction_pass: 'Undo extraction',
  // Knowledge
  get_claim: 'Get claim',
  list_claims: 'List claims',
  get_context_bundle: 'Gather context',
  get_dashboard_summary: 'Get dashboard summary',
  get_notifications: 'Get notifications',
  // Prospecting (Scout). The run tools render as a ProspectingRunCard in chat
  // rather than this chip, but the labels are still load-bearing: any surface
  // without the card falls back here, and a raw `find_prospect_people` is the
  // one place a user meets a tool name they never chose.
  research_my_company: 'Research my company',
  list_prospect_lists: 'List prospect lists',
  create_prospect_list: 'Create prospect list',
  update_prospect_list: 'Update prospect list',
  list_prospect_entries: 'List prospect entries',
  run_prospect_discovery: 'Run discovery',
  research_prospect_companies: 'Research accounts',
  find_prospect_people: 'Find people',
  find_prospects: 'Find prospects',
  wait_for_prospecting_run: 'Wait for run',
  get_prospecting_run_candidates: 'Run candidates',
  cancel_prospecting_run: 'Cancel run',
  save_prospect_entries: 'Save to list',
  publish_prospect_list: 'Publish to CRM',
  dismiss_prospect_entries: 'Dismiss entries',
}

function getToolLabel(name: string): string {
  return TOOL_LABELS[name] || name.replace(/_/g, ' ')
}

/** The workspace searches whose result says what they covered (`scope`). */
const SCOPED_SEARCH_TOOLS = new Set(['find', 'deep_search'])

/**
 * A finished search's scope as a short line ("Past 4 weeks", "All time ·
 * transcripts"), so the person sees when the agent widened its search. Null
 * for any other tool, or a result without a scope.
 */
function searchScopeLine(name: string, state: ToolState, result: unknown): string | null {
  if (state !== 'result' || !SCOPED_SEARCH_TOOLS.has(name)) return null
  const scope = readSearchScope(result)
  return scope ? describeSearchScope(scope) : null
}

/**
 * A tool call as ONE line in the thread: an icon, the tool's label and its
 * status, collapsed by default. While it runs the label shimmers (ShimmerText,
 * which stops the moment the call settles); once done it is static, with a
 * search's scope after it. The input and output (or a failure's message) are
 * behind the chevron, so raw results never fill the thread. Tools whose
 * rendering IS the answer (a page card, a draft, a question) have their own
 * renderers instead (chat/tool-renderers.tsx).
 */
function ToolImpl({ name, state, args, result, className, entityLinks, onEntityClick }: ToolProps) {
  const [isOpen, setIsOpen] = useState(false)
  const browserOutcome = state === 'result' ? browserTaskOutcome(name, result) : null
  const scopeLine = searchScopeLine(name, state, result)
  const running = state === 'partial-call' || state === 'call'

  const stateIcon = (() => {
    if (browserOutcome) {
      const Icon = browserOutcome.label === 'Site blocked' ? ShieldAlert
        : browserOutcome.label === 'Waiting for result' ? Clock3
        : browserOutcome.label === 'Stopped' ? CirclePause : CircleAlert
      return <Icon className="h-4 w-4 text-muted-foreground" />
    }
    switch (state) {
      // In flight (args still streaming in, then running): a still icon, the
      // label's shimmer is the motion.
      case 'partial-call':
      case 'call':
        return <CircleDashed className="h-4 w-4 text-muted-foreground" />
      case 'result':
        return <CheckCircle className="h-4 w-4 text-muted-foreground" />
      // Quiet: the agent usually routes around a failed call; the message is
      // one click away (the row expands to it).
      case 'error':
        return <XCircle className="h-4 w-4 text-muted-foreground" />
      default:
        return <Settings className="h-4 w-4 text-muted-foreground" />
    }
  })()

  const stateLabel = (() => {
    if (browserOutcome) return browserOutcome.label
    switch (state) {
      case 'partial-call':
        return 'Calling…'
      case 'call':
        return 'Running…'
      case 'result':
        return 'Done'
      case 'error':
        return 'Error'
      default:
        return 'Pending'
    }
  })()

  const hasDetails =
    (args && Object.keys(args).length > 0) || result !== undefined

  const hasEntityLinks = entityLinks && entityLinks.length > 0

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg',
        className,
      )}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="group/tool h-auto w-auto cursor-pointer justify-start gap-2 rounded-b-none px-0 py-1 font-normal hover:bg-transparent"
              disabled={!hasDetails}
            >
              {stateIcon}
              {running ? (
                <ShimmerText active className="text-sm font-medium">
                  {getToolLabel(name)}
                </ShimmerText>
              ) : (
                <span className="text-sm font-medium transition-colors group-hover/tool:text-foreground">
                  {getToolLabel(name)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {stateLabel}
              </span>
              {scopeLine && (
                <span data-search-scope className="truncate text-xs text-muted-foreground/70">
                  · {scopeLine}
                </span>
              )}
              {hasDetails && (
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform',
                    isOpen && 'rotate-180',
                  )}
                />
              )}
            </Button>
          </CollapsibleTrigger>
          {hasEntityLinks && entityLinks.length === 1 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/10"
              onClick={() => onEntityClick?.(entityLinks[0])}
            >
              {entityLinks[0].label}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </button>
          )}
        </div>
        {browserOutcome?.message && (
          <p className="max-w-xl break-words pb-2 pl-6 text-xs leading-relaxed text-muted-foreground">
            {browserOutcome.message}
          </p>
        )}
        {hasEntityLinks && entityLinks.length > 1 && (
          <div className="flex flex-wrap gap-1.5 pb-1 pl-6">
            {entityLinks.map((link) => (
              <button
                key={link.id}
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                onClick={() => onEntityClick?.(link)}
              >
                {link.label}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </button>
            ))}
          </div>
        )}
        {hasDetails && (
          <CollapsibleContent>
            {/* `ph-no-capture`: session replay blocks the raw tool input and
                output (a mail tool's carries subjects, bodies and drafts, and
                Dial8 never stores mail text). */}
            <div className="ph-no-capture space-y-3 p-3">
              {args && Object.keys(args).length > 0 && (
                <div>
                  <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Input
                  </h4>
                  <div className="rounded p-2 font-mono text-xs">
                    {Object.entries(args).map(([key, value]) => (
                      <div key={key} className="mb-0.5">
                        <span className="text-muted-foreground">{key}:</span>{' '}
                        <span>
                          {typeof value === 'string'
                            ? value
                            : JSON.stringify(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {result !== undefined && (
                <div>
                  <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Output
                  </h4>
                  <div className="max-h-60 overflow-auto rounded p-2 font-mono text-xs">
                    <pre className="whitespace-pre-wrap">
                      {typeof result === 'string'
                        ? result
                        : JSON.stringify(result, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  )
}

// Memoized: while a message streams, the parent re-walks and re-renders every
// tool part on each token. A completed tool's props (name/state/args/result) are
// referentially stable across those re-renders — the AI SDK only mutates the
// actively-streaming part — and onEntityClick is a stable useCallback, so default
// shallow comparison bails for every already-finished tool call. (entityLinks is
// undefined for all but the rare terminal create_* tools, so it doesn't defeat it.)
const Tool = memo(ToolImpl)

export { Tool, getToolLabel }
