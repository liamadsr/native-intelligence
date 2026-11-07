/**
 * Which of the attended-only tools (ATTENDED_ONLY_TOOL_NAMES, bots v3 Phase 5)
 * an MCP connection offers. The bridge exposes every createTools() tool by
 * default (src/lib/mcp/tools/index.ts), so this is the one place that says no.
 *
 *   A person's own connector (Claude Desktop, Cursor, ...): settle_card,
 *   revise_email_draft and discard_email_draft, as the person's own tools.
 *   Each acts only on the caller's own card or Dial8's own drafts, and the
 *   person is the one asking (a big discard still asks them first: its
 *   `confirmed`).
 *   undo_extraction_pass stays out: it deletes what a pass filed in bulk, and
 *   is said to the Captures bot (or the main chat) about the pass in view.
 *   list_bot_work and get_bot_item (bots-v4 Phase A1: what the person's bots
 *   have waiting on them) are in: they only read the caller's own rows and
 *   cards (dial8_list_bot_work, dial8_get_bot_item). So are settle_work_item
 *   and send_work_answer (Phase A2: Reviewed or Dismiss on one of the caller's
 *   reviews, the caller's answer to a question their own run waits on), as the
 *   person's own clicks (dial8_settle_work_item, dial8_send_work_answer).
 *   And rename_bot, delete_bot and merge_bots (GEN-1168): the person
 *   managing their own agents from their own client, under the agent
 *   editor's rules; a delete or merge lands as their card in the app, exactly
 *   as from chat, and an MCP client can't accept one.
 *   And remember (one-agent plan Part 3): the person saying what Dial8
 *   should remember, from their own client, lands in the same note (or, with
 *   scope 'profile', in the facts about them); they see and undo it in What
 *   Dial8 has learned (dial8_remember).
 *   And the loop builders (create_flow, update_flow, delete_flow): the
 *   person's own client building or switching on their loops is the person
 *   acting, as it was before they became attended-only. The tools' own
 *   asks-first gate (confirmed_with_user) still holds, and the F1 cards
 *   (a risky switch-on, a delete, transfer_flow_owner) land in the person's
 *   queue exactly as from chat: an MCP client can't accept one either.
 *   And test_flow: the person dry-running their loop from their own client
 *   (its skills run as them; nothing is sent or delivered).
 *   And the skill writers (create_skill, update_skill): the person authoring
 *   their own skills from their own client. Over MCP these are the
 *   hand-registered dial8_create_skill / dial8_update_skill (plus
 *   dial8_delete_skill, which chat doesn't have, and the agent writers).
 *   And restore_document_revision: the person rolling one of the documents
 *   they may edit back to an earlier version, from their own client; the
 *   restore is a new revision, so it can be undone the same way. So is
 *   revert_section_edit (canon D2): undoing one edit, one section.
 *   And delete_document (GEN-1169): like delete_flow, it only raises the
 *   person's card, which waits for them in the app.
 *   And list_connections (F2): the person reading their own connections.
 *   connect, disconnect and set_tool_access stay out: the Connect card is a
 *   chat card no MCP client draws, and the other two widen or remove access,
 *   which the person does in the app.
 *   review_post (content C0) stays out: its reviewer must be another vendor
 *   than the writer, and an MCP client's model is unknown to us, so it could
 *   only ever answer "not reviewed". lint_post (no model call) is there for
 *   every caller.
 *   publish_post and schedule_post (content C2a) stay out: a post goes out
 *   only on the person's approval card in the app, or their post card's
 *   own button, and no MCP client draws either.
 *   update_now stays out: the person's Now file (docs/plans/now-file.md) is
 *   the main agent's own sketchpad, written only from the person's chat in
 *   the app (and Slice 2's check-in), never from another client.
 *   finish_getting_started stays out too: getting started
 *   (docs/plans/getting-started-skill.md) is the app's chat walking someone
 *   new through Dial8, so only that chat ends it.
 *   And update_email_thread (GEN-1166): the person sorting their own inbox
 *   from their own client (dial8_update_email_thread); every change comes
 *   back with its undo, and over ten threads still waits for their yes
 *   (confirmed_with_user). unsubscribe_thread stays out: it runs only on the
 *   person's approval card in the app.
 *   And update_business_profile and create_quote_form_link (roadmap B): the
 *   owner changing what their customers are told, or their website form's
 *   link, from their own client. Only an unattended run is kept from them.
 */
import { ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'

/** The attended-only tools a person's own MCP connector offers. */
export const MCP_ATTENDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'settle_card',
  'revise_email_draft',
  'discard_email_draft',
  'list_bot_work',
  'get_bot_item',
  'settle_work_item',
  'send_work_answer',
  'rename_bot',
  'delete_bot',
  'merge_bots',
  'remember',
  'create_flow',
  'update_flow',
  'delete_flow',
  'transfer_flow_owner',
  'request_flow_takeover',
  'test_flow',
  'create_skill',
  'update_skill',
  'restore_document_revision',
  'revert_section_edit',
  'delete_document',
  'list_connections',
  'update_email_thread',
  'update_business_profile',
  'create_quote_form_link',
])

/** The attended-only tool names a person's MCP connection must NOT offer. Pure. */
export function mcpWithheldAttendedTools(): string[] {
  return [...ATTENDED_ONLY_TOOL_NAMES].filter((name) => !MCP_ATTENDED_TOOL_NAMES.has(name))
}
