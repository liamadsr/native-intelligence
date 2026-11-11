import type { SupabaseClient } from '@supabase/supabase-js'
import type { StatusChangeOrigin } from '@/lib/flows/types'
import type { CreateWorkspacePolicy } from './_shared'
import type { BrowserCommandAttribution } from '@/lib/browser-agent/attribution'
import { createActionTools, type ActionToolRules } from './actions'
import { createCaptureTools } from './captures'
import { createNoteTakerTools } from './note-taker'
import { createMeetingGoalTools } from './meeting-goal'
import { createVocabularyTools } from './vocabulary'
import { createDocumentTools } from './documents'
import { createCanonTools, type CanonToolContext } from './canon'
import { createContentTools } from './content'
import { createPaymentTools } from './payments'
import { createDecisionTools } from './decisions'
import { createContactTools } from './contacts'
import { createBusinessTools } from './business'
import { createInitiativeTools } from './initiatives'
import { createProjectTools } from './projects'
import { createCycleTools } from './cycles'
import { createAvailabilityTools } from './availability'
import { createCalendarTools } from './calendar'
import { createEmailTools } from './email'
import { createCommentTools } from './comments'
import { createDashboardTools } from './dashboard'
import { createSearchTools } from './search'
import { createNotificationTools } from './notifications'
import { createBrowserTools } from './browser'
import { createCalendarCaptureTools } from './calendar-capture'
import { createCrmTools } from './crm'
import { createEnrichContactTools } from './enrich-contact'
import { createEmailManagementTools } from './email-management'
import { createAttachmentTools } from './attachments'
import { createFlowTools } from './flows'
import { createConnectionTools } from './connections'
import { createApprovalResultTools } from './approval-results'
import { createGuestConversationTools } from './guest-conversation'
import { createClaimTools } from './claims'
import { createEntityLinkTools } from './entity-links'
import { createPackageTools } from './packages'
import { createAsanaTools } from './asana'
import { createJiraTools } from './jira'
import { createLinearTools } from './linear'
import { createLibraryTools } from './library'
import { createSequenceTools } from './sequences'
import { createProspectingTools } from './prospecting'
import { createCompanyTools } from './companies'
import { createDealTools } from './deals'
import { createCampaignTools } from './campaigns'
import { createReviewTools } from './reviews'
import { createChatHelperTools } from './chat-helpers'
import { createLocalAgentTools } from './local-agent'
import { createCloudCodingTools } from './cloud-coding'
import { createGuestAnswerTools } from './guest-answer'
import { createAgentLinkAskTools } from './agent-link-ask'
import { createBotRelayTools } from './bot-relay'
import { createAskUserTools } from './ask-user'
import { createEvalTools } from './evals'
import { createFollowThroughTools } from './follow-through'
import { createSuggestionTools, type SuggestionToolContext } from './suggestions'
import { createBotWorkTools } from './bot-work'
import { createBotManageTools } from './bot-manage'
import type { BotWorkVoice } from '@/lib/bots/bot-work-server'
import { createMemoryTools } from './memory'
import { createNowTools, type NowToolContext } from './now'
import { createGettingStartedTools } from './getting-started'
import { createTextSetupTools } from './text-setup'
import { createWebsiteTools } from './website'
import { createContactImportTools } from './contact-import'
import { createShowTools, type PersonalCardKind } from './show'
import type { CardContextEntry } from '@/lib/chat-cards/context'
import type { SearchDefaultWindow } from './search-scope'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import type { ApprovalContext } from '@/lib/safety/approvals'

/**
 * Options for {@link createTools}. All optional — absent = today's behavior.
 */
export interface CreateToolsOptions {
  /**
   * Who reads list_bot_work and get_bot_item (one face, always-on-agent §2c):
   * the chat agent itself (`agent`, the default: its own face's lines in the
   * first person) or a client acting for the person over MCP (`person`: "Your
   * agent…"). src/lib/mcp/tools/index.ts passes `person`.
   */
  botWorkVoice?: BotWorkVoice
  /**
   * The evidence rule (always-on plan decision 3): the chat agent checked a
   * `remember` of a profile fact's `quote` against the person's latest
   * messages and found it. Only then does the fact save active; without it a
   * profile fact is a proposal. Set by the chat's internal tool route only.
   */
  rememberQuoteVerified?: boolean
  /** Correlation injected by authenticated runtime dispatch, never model input. */
  browserAttribution?: BrowserCommandAttribution
  browserSourceRequest?: string
  /**
   * HARD-FENCE every ID-based tool to `workspaceId`: the cross-workspace resolve
   * (resolveEntityWorkspace's slow path) is disabled, so a model-authored entity id
   * that lives in ANOTHER workspace the user belongs to resolves as not-found.
   *
   * Default false — cloud chat / MCP behavior is byte-identical. Unattended runs
   * (work-run, skill-run) built with a service-role client MUST pass true: the run
   * is scoped to one workspace and must never mutate a foreign one. See
   * resolveEntityWorkspace in ./_shared.ts.
   */
  strictWorkspace?: boolean
  /**
   * EXCLUDE private captures (and content derived solely from them) entirely,
   * even when the run is "as" the capture's creator.
   *
   * Set by unattended runs (skill-run, work-run, flows/run-skill): their outputs
   * land in workspace-readable tables (report documents, proposals), so a private
   * capture paraphrased into a brief would leak. Capture filters become
   * `visibility = 'workspace'` only and the search RPCs get
   * `p_requesting_user_id: null` (fail closed). Interactive paths (chat, live
   * agent, MCP) leave this false — the user sees their own private captures.
   * See docs/design-capture-visibility.md. Private DOCUMENTS (migration 369)
   * follow the same flag: an unattended run reads none, not even its person's,
   * unless it writes for that one person (defaultDocumentVisibility below).
   */
  omitPrivateCaptures?: boolean
  /**
   * Who a document `create_document` writes can be seen by when the call
   * names nothing (migration 369). 'private' for a run that writes for one
   * person (a server-started helper: a meeting prep, a home-turn helper);
   * default 'workspace' (what people create themselves). Such a run also
   * reads its person's own private documents, as it reads their mail.
   */
  defaultDocumentVisibility?: 'workspace' | 'private'
  /**
   * What `find` / `deep_search` cover when the model names no window
   * (search-scope.ts). Default `'all_time'`, as every surface always had. The
   * main chat's tool route passes `'past_4_weeks'`: its prompt tells the model
   * to start there and widen. Claims are never windowed by default either way.
   */
  searchDefaultWindow?: SearchDefaultWindow
  /**
   * What a CREATE tool does when the caller passes no `workspace_id`.
   *
   * `strictWorkspace` above fences writes to EXISTING entities; this is the
   * other half, for writes that have no entity to route by. Creates land
   * wherever the session points unless something says otherwise, and for a
   * connector whose "active workspace" is a months-old OAuth artifact nobody
   * looked at this turn, that default is how a follow-up read out of
   * Engineering gets filed in Marketing.
   *
   * Default 'session' — chat / live agent / device / work-run / skill-run
   * behavior is byte-identical (no `workspace_id` → the session workspace).
   * The MCP bridge (src/lib/mcp/tools/index.ts) passes 'explicit': it defaults
   * only when the user has exactly ONE workspace and otherwise returns a
   * structured `needs_workspace` refusal listing the candidates. See
   * {@link CreateWorkspacePolicy} and `resolveCreateWorkspace` in ./_shared.ts.
   *
   * THREADING (wave 2): each factory that owns a create tool takes this as a
   * trailing positional, exactly as `strict` is threaded today —
   * `createActionTools(userId, supabase, workspaceId, strict, omitPrivate, createPolicy)`
   * — and hands it to `resolveCreateWorkspace` as `policy`. Declared here now so
   * the bridge can pass 'explicit' in the same commit that lands the resolver;
   * until a factory takes the argument the value is inert FOR THAT FAMILY, which
   * is the whole of the staging. (Contrast `includeEvalCaptures` below, which is
   * absent because it would be inert FOREVER.)
   */
  createWorkspacePolicy?: CreateWorkspacePolicy
  /**
   * The turn is someone else's conversation with the person's agent: a
   * guest's, or a linked agent's (src/lib/guests/guest-tools.ts). Such a
   * turn runs the person's tools, but a per-item grant (492) shared a record
   * with the PERSON, not with whoever they let talk to their agent: with
   * this set, no read tool lets a grant through (the documents, captures,
   * comments, decisions, attachments, project notes and claim labels the
   * grant would open, the contacts and companies and their names on deals,
   * sequences, meetings and the graph (migration 519), and find / search
   * drop what only a grant found).
   * Everything else reads as before. Absent: the person's own turn.
   */
  omitGrants?: boolean
  /**
   * Who the tools' status writes are, for the flow dispatcher's LOOP GUARD
   * (flows/types.ts StatusChangeOrigin). Unattended runs (work-run, skill-run)
   * pass `{ actor: 'agent', depth, run_id }`; absent = a person at depth 0
   * (chat on the user's instruction, MCP, the live agent). Threaded only to
   * the families that emit status changes (actions).
   */
  origin?: StatusChangeOrigin
  /**
   * The run has no person at the keyboard (work-run, skill-run). Sequence
   * step 2 (plan A.1): `create_contact` stays an internal write on the board's
   * own CRM, but its fire-and-forget HubSpot writeback is an EXTERNAL side
   * effect — a contact an unattended run invents must not be pushed to a
   * customer's HubSpot before anyone has looked at it. Unattended runs pass
   * true: the row is created with a push HOLD (metadata.hubspot_push_hold,
   * src/lib/crm/hubspot-push-hold.ts) and no push event; the push function
   * and the 15-minute sweep skip held rows, and a person's edit through
   * PATCH /api/account/contacts/[id] lifts the hold and pushes. Interactive
   * paths leave it false and behave as before. Threaded only to the contacts
   * family.
   */
  unattended?: boolean
  /**
   * The person's own text to the Native Intelligence number (a channel turn, surface sms,
   * no guest, relay or teammate: isPersonTextTurn in
   * src/lib/onboarding/text-setup.ts). Only then does connect_link make a
   * link, and it texts it to their verified number itself: a link handed to
   * the model, a web chat or an MCP client could be forwarded to someone
   * else (./text-setup.ts).
   */
  textTurn?: boolean
  /**
   * The person's own text OR call to the Native Intelligence number (both from a caller ID
   * that can be spoofed). The website tools (src/lib/ai/tools/website.ts)
   * keep what such a turn alone may change narrow: which repo is the site,
   * its address, and how long an edit request may be.
   */
  remoteTurn?: boolean
  /**
   * Nobody asked for this draft in a chat: a work run's own turns, an
   * unattended loop (A6 review). create_email_draft then refuses a reply on a
   * thread that already has a draft waiting for review, and refuses once the
   * person's shared daily cap of automatic drafts is reached (the cap the
   * arrival path and the 05:00 safety net share), so a helper can't draft
   * past the cap or twice over. Absent on attended surfaces.
   */
  automaticDrafts?: boolean
  /**
   * Unattended-run rules for the action tools ({@link ActionToolRules}),
   * derived by the tool routes from the run's verified token:
   *   - `fileActionsAsSuggested`: the promotion guard. A run with nobody
   *     watching (a work run's own turns, an unattended skill run) files
   *     create_action / create_actions_batch as 'suggested', whatever the
   *     model passed.
   *   - `reviewActionIds`: the run's own action (agent_run.action_id). The
   *     agent finishing it moves it to review, never Done (decision 9).
   *   - `unattended` + `filedByRun`: nothing the run does promotes a
   *     suggestion. confirm_action is refused; accept_proposal,
   *     confirm_decision and confirm_all_decisions refuse what the run filed
   *     itself (its ledger's created / proposed touches); create_decision
   *     files suggested.
   * Absent on attended surfaces (chat, MCP, the live agent, a run's follow-up
   * chat turn), which behave as before.
   */
  actionRules?: ActionToolRules
  /**
   * Where suggest_changes stages its suggestions and who staged them
   * (docs/plans/suggestions-everywhere.md): the chat conversation, or the run's
   * work-ledger row (its suggestions are re-homed onto the document the run
   * delivers). Absent (MCP): the tool asks for a document_id.
   */
  suggestionContext?: SuggestionToolContext
  /**
   * The cards on the person's screen this turn (the main chat's tool route,
   * from what the chat-agent forwards): what read_card reads. Absent
   * everywhere else, where read_card answers that no card is open.
   */
  cards?: CardContextEntry[]
  /**
   * The per-person cards `show` may put up here: calendar and mail, each only
   * where its own tool (get_calendar_events, list_emails) is in the caller's
   * ceiling. Only the main chat's tool route passes them; absent (MCP,
   * unattended runs, a teammate's chat) they are refused, so a card never
   * reads more than the existing tools may.
   */
  personalCardKinds?: readonly PersonalCardKind[]
  /**
   * The browser's IANA zone this turn (the main chat's tool route, from what
   * the chat-agent forwards): the zone a calendar card's local days are in,
   * and the zone create_flow / update_flow give a schedule that names none.
   */
  timeZone?: string
  /**
   * Set ONLY by executeStoredCall (src/lib/safety/approvals.ts): this call is
   * the stored call of an approval the person just accepted on its card. The
   * flow tools' F1 cards (switch-on, delete, change owner) run it instead of
   * raising another card. Never derived from a request or a model.
   */
  approvedCall?: ApprovedCall
  /**
   * The chat door's approval context (its agent persona, surface, teammate
   * fence: the chat tool route's chatApprovalContext), stored on a card a
   * tool raises itself (the F2 connection cards), so Accept re-checks that
   * persona's ceiling. Never from a model.
   */
  approvalContext?: Omit<ApprovalContext, 'flow' | 'connection' | 'bots' | 'document'>
  /**
   * Who is asking, for a canon section edit's provenance label (canon D2,
   * decision 16; src/lib/documents/canon-sources.ts): whether a person is in the
   * conversation (default: not `unattended`), and the run whose outside reads
   * count: a work run's (agent_run.outside_reads; the work-run tool route
   * sets it: a follow-up chat turn is attended, the run's own turns are not),
   * or a loop run's own record (`readOutside`, the skill-run tool route).
   */
  canonContext?: CanonToolContext
  /**
   * The loop tools' turn context (#835 S1): the tools that brought untrusted
   * outside text into the person's chat turn so far, from the chat tool
   * route (src/lib/chat/turn-outside-reads.ts). create_flow asked to save a
   * loop on in such a turn saves it off and asks in the chat, and
   * update_email_thread refuses a claimed yes to a bulk change (GEN-1166).
   * Absent: none read (a surface with no turn to mark).
   */
  flowContext?: { turnReadOutside?: () => readonly string[] }
  /**
   * The content tools' context (content C0, src/lib/ai/tools/content.ts): the
   * model that wrote the post the person is reviewing, from the chat tool
   * route's authenticated envelope (the chat agent's turn model). review_post
   * picks its reviewer from another vendor (decision 13); absent, it reviews
   * nothing and says so. Never from a model.
   */
  contentContext?: { writerModel?: string | null }
  /**
   * The person's Now file (docs/plans/now-file.md): who may write it here
   * (update_now's `writer`) and whether get_document, find and the history
   * tools may show it (`readable`). Only the main chat's tool route sets it,
   * for the person's own turn in the app (caller class `person`, no server
   * turn, not a quick helper's call): writer 'chat', readable. Absent
   * everywhere else (MCP, runs, the live agent, a teammate chat, a home or
   * channel turn): update_now refuses and the reads leave the note out.
   * Slice 2's check-in passes writer 'check_in' and no `readable`.
   */
  nowContext?: NowToolContext
  // NO `includeEvalCaptures` HERE, deliberately.
  //
  // Eval captures (`captures.is_eval`, migration 252) are synthetic mock
  // meetings, fenced out of every chat capture read by the default-EXCLUDE in
  // `applyCaptureVisibility` and friends (./_shared.ts, docs/plans/evals.md
  // §5.2). Those helpers DO take an `includeEvalCaptures` scope, but no factory
  // in this file forwards one, so an option declared here could not take effect
  // — and an option that silently ignores itself is worse than an absent one: a
  // caller wiring the Evals surface would pass it, see an empty result, and have
  // no way to tell "not threaded" from "no eval captures exist".
  //
  // The fence stays absolute until something needs otherwise. When the Evals
  // surface does want mock meetings in a chat tool, add the field back TOGETHER
  // with a trailing `includeEvalCaptures` positional on each capture-reading
  // factory (createActionTools, createCaptureTools, createProjectTools,
  // createCommentTools, createDashboardTools, createCalendarCaptureTools,
  // createCrmTools, createClaimTools, createDecisionTools, createAttachmentTools)
  // forwarded to the ./_shared.ts helpers.
}

/**
 * Creates the complete tool set for AI chat, scoped to a specific user.
 * The client is whatever the caller passes, and on the eve tool proxies
 * (/api/internal/<agent>/tool) and the MCP bridge that is a SERVICE-ROLE client:
 * RLS does not apply, so every tool fences its own reads and writes (the
 * workspace via ./_shared.ts resolveEntityWorkspace, and who may change a
 * document via src/lib/documents/access.ts). Never assume RLS here.
 * Calendar/email tools use server-side OAuth tokens (Google/Microsoft).
 */
export function createTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  accessToken?: string,
  options?: CreateToolsOptions,
) {
  const strict = options?.strictWorkspace ?? false
  const omitPrivate = options?.omitPrivateCaptures ?? false
  // Create-time routing policy (see CreateToolsOptions.createWorkspacePolicy).
  // Threaded as a trailing positional into every factory that owns a ROOT
  // create; families whose creates are all parent-anchored (cycles, decisions,
  // comments) take it too, for uniform signatures, and ignore it. `strict` now
  // also reaches every family that resolves a target entity — before this, the
  // unattended work-run / skill-run paths could not fence the newly-routed
  // cycle/decision/comment/link/attachment/integration writes.
  const createPolicy = options?.createWorkspacePolicy ?? 'session'
  // A guest's or a linked agent's turn reads no grant (CreateToolsOptions.omitGrants).
  const omitGrants = options?.omitGrants ?? false
  // An edit grant (512) lets a write through only on the person's own,
  // attended turn: never a guest's or a linked agent's, never an unattended
  // one (a home turn reading inbound mail, a skill or work run). One flag,
  // passed to every factory that writes a grantable record.
  const editGrants = !omitGrants && options?.unattended !== true
  // Every capture read below is fenced against eval captures by the
  // default-EXCLUDE in ./_shared.ts — no opt-in exists here on purpose (see
  // CreateToolsOptions).
  return {
    ...createActionTools(userId, supabase, workspaceId, strict, omitPrivate, createPolicy, options?.origin, options?.actionRules),
    ...createCaptureTools(userId, supabase, workspaceId, accessToken, strict, omitPrivate, createPolicy, omitGrants, editGrants),
    ...createNoteTakerTools(userId, supabase, workspaceId, options?.unattended ?? false),
    // A run that writes for one person (defaultDocumentVisibility 'private')
    // reads that person's own private documents too, as it reads their mail:
    // otherwise a meeting prep could not read or edit the prep it just wrote.
    ...createDocumentTools(
      userId,
      supabase,
      workspaceId,
      strict,
      createPolicy,
      options?.defaultDocumentVisibility === 'private' ? false : omitPrivate,
      options?.defaultDocumentVisibility,
      // delete_document's card renders in this chat; a replayed approval deletes (GEN-1169).
      {
        conversationId: options?.suggestionContext?.origin === 'chat' ? (options.suggestionContext.conversationId ?? null) : null,
        approvedCall: options?.approvedCall,
        approvalContext: options?.approvalContext,
        nowReadable: options?.nowContext?.readable === true,
        omitGrants,
        editGrants,
      },
    ),
    // Canon documents (D1/D2): read and edited by key, in the session workspace only.
    ...createCanonTools(userId, supabase, workspaceId, {
      attended: options?.canonContext?.attended ?? !(options?.unattended ?? false),
      outsideReadsRunId: options?.canonContext?.outsideReadsRunId ?? null,
      ...(options?.canonContext?.readOutside ? { readOutside: options.canonContext.readOutside } : {}),
    }),
    // Posts (content C0): the deterministic check and the fresh-eyes review. Nothing posts.
    ...createContentTools(userId, supabase, workspaceId, { writerModel: options?.contentContext?.writerModel ?? null, approvedCall: options?.approvedCall, unattended: options?.unattended === true }),
    ...createDecisionTools(userId, supabase, workspaceId, strict, createPolicy, omitPrivate, options?.actionRules, omitGrants, editGrants),
    ...createContactTools(userId, supabase, workspaceId, strict, createPolicy, options?.unattended ?? false, editGrants, omitGrants),
    // The business's front door (roadmap B): customers' quotes, its profile, booking slots and bookings. See ./business.ts.
    // send_quote / book_quote run only as the owner's approved call (roadmap F3).
    // move_booking / cancel_booking text the customer: never an unattended run's.
    ...createBusinessTools(userId, supabase, workspaceId, { approvedCall: options?.approvedCall, unattended: options?.unattended === true }),
    // The one money tool (roadmap C2): a customer payment link, only ever the owner's approved call.
    ...createPaymentTools(userId, supabase, workspaceId, { approvedCall: options?.approvedCall }),
    // Companies — the CRM's other half. `get_company_overview` (crm.ts) reads
    // ONE account you can already name; these are the index and the writes.
    ...createCompanyTools(userId, supabase, workspaceId, strict, createPolicy, editGrants, omitGrants),
    // Deals and custom fields (roadmap #8): apply with undo, every change logged. See ./deals.ts.
    ...createDealTools(userId, supabase, workspaceId, strict, createPolicy, editGrants, omitGrants),
    // Campaigns — Marketing's anchor entity. Read + create + update; no delete
    // (a campaign is something claims point at).
    // launch_campaign raises the person's card and sends on their yes (roadmap D2).
    ...createCampaignTools(supabase, workspaceId, userId, strict, createPolicy, {
      conversationId: options?.suggestionContext?.origin === 'chat' ? (options.suggestionContext.conversationId ?? null) : null,
      approvedCall: options?.approvedCall,
      approvalContext: options?.approvalContext,
      unattended: options?.unattended === true,
      omitGrants,
    }),
    ...createInitiativeTools(userId, supabase, workspaceId, strict, createPolicy),
    ...createProjectTools(userId, supabase, workspaceId, strict, omitPrivate, createPolicy, omitGrants),
    ...createCycleTools(userId, supabase, workspaceId, strict, createPolicy),
    // get_calendar_events reads and writes times in the person's zone: this turn's browser zone, else their saved one.
    ...createCalendarTools(userId, workspaceId, { supabase, timeZone: options?.timeZone }),
    // When the person can meet, alone or with teammates, and their working hours (src/lib/availability).
    // A guest's or a linked agent's turn reads only the person's own time, never a teammate's.
    ...createAvailabilityTools(userId, workspaceId, { timeZone: options?.timeZone, omitGrants }),
    ...createEmailTools(userId, workspaceId, strict, createPolicy, options?.automaticDrafts ?? false, {
      approvedCall: options?.approvedCall,
      ...(options?.flowContext?.turnReadOutside ? { turnReadOutside: options.flowContext.turnReadOutside } : {}),
    }),
    ...createCommentTools(userId, supabase, workspaceId, omitPrivate, strict, createPolicy, omitGrants, editGrants),
    ...createDashboardTools(userId, supabase, workspaceId, omitPrivate),
    ...createSearchTools(userId, supabase, workspaceId, omitPrivate, options?.searchDefaultWindow ?? 'all_time', strict, options?.nowContext?.readable === true, omitGrants),
    ...createNotificationTools(userId, supabase, workspaceId),
    ...createBrowserTools(userId, supabase, workspaceId, options?.browserAttribution, options?.browserSourceRequest, options?.approvedCall),
    ...createCalendarCaptureTools(userId, supabase, workspaceId, accessToken, omitPrivate, omitGrants),
    // The person's goal for one of their meetings (the prep card's composer writes the same store).
    ...createMeetingGoalTools(userId, supabase, workspaceId, options?.unattended ?? false),
    ...createVocabularyTools(userId, supabase, workspaceId, { omitPrivate, unattended: options?.unattended ?? false }),
    ...createCrmTools(userId, supabase, workspaceId, omitPrivate, strict, editGrants, omitGrants),
    // enrich_contact: one paid web search for one contact, only on the person's
    // yes (confirmed_with_user), the same run as the contact page's Enrich
    // button. Nothing enriches on its own. See ./enrich-contact.ts.
    ...createEnrichContactTools(userId, supabase, workspaceId, strict, editGrants),
    // Review requests (roadmap D3): the owner's Google review link, and the
    // jobs they say are done, each sending that customer the link once.
    ...createReviewTools(userId, supabase, workspaceId, strict, { unattended: options?.unattended === true, omitGrants }),
    ...createEmailManagementTools(userId, supabase, workspaceId, accessToken),
    ...createAttachmentTools(userId, supabase, workspaceId, strict, omitPrivate, omitGrants),
    // The browser zone: a schedule loop with no timezone takes the person's.
    // The chat's conversation counts the flow cards it raises (approval caps);
    // a replayed approval runs the stored change (F1, ../flows/flow-approvals.ts).
    ...createFlowTools(userId, supabase, workspaceId, strict, createPolicy, options?.timeZone, {
      conversationId: options?.suggestionContext?.origin === 'chat' ? (options.suggestionContext.conversationId ?? null) : null,
      approvedCall: options?.approvedCall,
      ...(options?.flowContext?.turnReadOutside ? { turnReadOutside: options.flowContext.turnReadOutside } : {}),
    }),
    // The person's connections (F2): list them, connect from a card, disconnect
    // and loosen tool access only from their card. Attended only.
    ...createConnectionTools(userId, supabase, workspaceId, {
      conversationId: options?.suggestionContext?.origin === 'chat' ? (options.suggestionContext.conversationId ?? null) : null,
      approvedCall: options?.approvedCall,
      approvalContext: options?.approvalContext,
    }),
    // How a call held for the person's approval ended (GEN-1172): read by its approval_id.
    ...createApprovalResultTools(userId, supabase, workspaceId),
    // One guest's conversation with the agent the person made for them (guest access): a read of their own guests.
    ...createGuestConversationTools(userId, supabase, workspaceId),
    ...createClaimTools(userId, supabase, workspaceId, strict, omitPrivate, createPolicy, omitGrants),
    ...createEntityLinkTools(userId, supabase, workspaceId, strict, omitPrivate, omitGrants),
    ...createPackageTools(userId, supabase, workspaceId, strict, createPolicy),
    ...createAsanaTools(userId, supabase, workspaceId, strict),
    ...createJiraTools(userId, supabase, workspaceId, strict),
    ...createLinearTools(userId, supabase, workspaceId, strict),
    // Skill authoring — the tools behind the /create-skill system skill, which
    // replaced the hardcoded "Save as skill" button.
    ...createLibraryTools(userId, supabase, workspaceId, strict, createPolicy),
    // Sequences (CRM outreach): create, configure, stage, and launch_sequence,
    // which only raises the person's launch card (every email, every
    // recipient); it sends on their yes, replayed here with approvedCall
    // (roadmap D1). Nothing sets auto_send on a model's word. See ./sequences.ts.
    ...createSequenceTools(userId, supabase, workspaceId, strict, createPolicy, {
      conversationId: options?.suggestionContext?.origin === 'chat' ? (options.suggestionContext.conversationId ?? null) : null,
      approvedCall: options?.approvedCall,
      approvalContext: options?.approvalContext,
      unattended: options?.unattended === true,
      omitGrants,
    }),
    // Prospecting — the tools behind the `build-prospect-list` skill. Every
    // search, and publish, takes `confirmed_with_user` and refuses, running
    // nothing, unless it is true: the model sets it only after the user said
    // yes to that call. Prices and ceilings stay in the backend; the chat never
    // talks about money. See ./prospecting.ts.
    ...createProspectingTools(userId, supabase, workspaceId, strict, createPolicy),
    // Clarifying-question tool (no execute — resolved client-side via the
    // QuestionPicker + addToolResult). Skipped by the MCP registrar since it has
    // no execute, so it's chat-only.
    ...createAskUserTools(),
    // Background helpers (always-on-agent §4): start_helper, stop_helper.
    // Schema twins: no execute, run only by the main chat's tool route
    // (CHAT_NATIVE_TOOL_NAMES). See ./chat-helpers.ts.
    ...createChatHelperTools(),
    // Local agents on the person's Mac (docs/plans/local-agents.md): local_agents,
    // start_local_agent, message_local_agent, read_local_agent, stop_local_agent.
    // Schema twins like start_helper's: no execute, run only by the main chat's
    // tool route (CHAT_NATIVE_TOOL_NAMES). See ./local-agent.ts.
    ...createLocalAgentTools(),
    // The chat's cloud counterpart (docs/plans/environments.md E2):
    // start_cloud_coding_run. A schema twin too, run only by the main chat's
    // tool route (CHAT_NATIVE_TOOL_NAMES). See ./cloud-coding.ts.
    ...createCloudCodingTools(),
    // Guest access (429): answer_guest, the main agent's answer to a guest's
    // ask. A schema twin too, run only by the main chat's tool route
    // (CHAT_NATIVE_TOOL_NAMES). See ./guest-answer.ts.
    ...createGuestAnswerTools(),
    // Agent links (435): ask_agent, the main agent asks a linked person's
    // agent. A schema twin too, run only by the main chat's tool route
    // (CHAT_NATIVE_TOOL_NAMES). See ./agent-link-ask.ts.
    ...createAgentLinkAskTools(),
    // The main agent talks to the bots (bots-v4 Phase A3): send_bot_message,
    // wait_for_bot_reply. Schema twins like start_helper's: no execute, run
    // only by the main chat's tool route (CHAT_NATIVE_TOOL_NAMES). See ./bot-relay.ts.
    ...createBotRelayTools(),
    // Evals — authoring synthetic-meeting cases and running suites from chat,
    // the tools behind the /create-eval system skill. See ./evals.ts.
    ...createEvalTools(userId, supabase, workspaceId, strict, createPolicy),
    // A bot's follow-through (bots v3 Phase 5): settle_card, revise_email_draft,
    // undo_extraction_pass. Attended only (ATTENDED_ONLY_TOOL_NAMES): every
    // unattended surface's ceiling leaves them out, and each re-checks that
    // what it touches is the caller's own, in this workspace. See ./follow-through.ts.
    ...createFollowThroughTools(userId, supabase, workspaceId),
    // Stage suggestions the person settles with one click, where the agent
    // wrote about them. See ./suggestions.ts.
    ...createSuggestionTools(userId, supabase, workspaceId, options?.suggestionContext, omitGrants),
    // The main agent reads the bots' work (bots-v4 Phase A1): list_bot_work,
    // get_bot_item; and acts on it (Phase A2): settle_work_item,
    // send_work_answer. Attended only, like the follow-through above: only the
    // main chat and a person's own MCP connector hold them. See ./bot-work.ts.
    ...createBotWorkTools(userId, supabase, { voice: options?.botWorkVoice ?? 'agent' }),
    // And manages them (GEN-1168): rename_bot at once; delete_bot and
    // merge_bots only from the person's card, replayed on their Accept.
    // Attended only, like the bot-work tools. See ./bot-manage.ts.
    ...createBotManageTools(userId, supabase, workspaceId, strict, {
      conversationId: options?.suggestionContext?.origin === 'chat' ? (options.suggestionContext.conversationId ?? null) : null,
      approvedCall: options?.approvedCall,
      approvalContext: options?.approvalContext,
    }),
    // What the person tells the main agent to remember, per area (one-agent
    // plan Part 3, "Memory"): remember. Attended only, like the bot-work tools:
    // the main chat and a person's own MCP connector hold it, never a bot or a
    // run's token. See ./memory.ts.
    ...createMemoryTools(userId, supabase, workspaceId, { quoteVerified: options?.rememberQuoteVerified === true }),
    // The person's Now file, the main agent's sketchpad (docs/plans/now-file.md):
    // update_now. Attended only, like remember, and written only where the
    // route says who writes (nowContext.writer). See ./now.ts.
    ...createNowTools(userId, supabase, workspaceId, options?.nowContext),
    // The person's getting started (docs/plans/getting-started-skill.md):
    // finish_getting_started. Attended only. See ./getting-started.ts.
    ...createGettingStartedTools(userId, supabase, workspaceId),
    // Setup by text (src/lib/onboarding/text-setup.ts): connect_link and
    // save_business_profile, each refusing an unattended turn. See ./text-setup.ts.
    ...createTextSetupTools(userId, supabase, workspaceId, { unattended: options?.unattended === true, textTurn: options?.textTurn === true }),
    ...createWebsiteTools(userId, supabase, workspaceId, { unattended: options?.unattended === true, remoteTurn: options?.remoteTurn === true }),
    // Bringing existing customers in (roadmap track G, docs/plans/customer-import.md): read_contact_file,
    // import_contact_file, import_stripe_customers, list_contact_imports, undo_contact_import. Each write refuses an unattended turn.
    ...createContactImportTools(userId, supabase, workspaceId, { unattended: options?.unattended === true }),
    // Pages in the chat: show puts a filtered page or a record in the chat;
    // read_card reads what a card shows the person now. See ./show.ts.
    ...createShowTools(userId, supabase, workspaceId, options?.cards, options?.personalCardKinds, options?.timeZone),
  }
}
