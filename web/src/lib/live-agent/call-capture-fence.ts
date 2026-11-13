/**
 * The fence on a call's capture (one recorder per call, phase 2). Names only,
 * no heavy imports: the ceiling (./ceiling.ts), the eve spec rebuild, the
 * tool route and the cloud route all read this one module.
 *
 * Why. A call's capture is written from what anyone in the call says, a
 * meeting link's guest included: every word is untrusted input. The turn
 * that writes it runs as the capture's OWNER (the meeting's host, else the
 * call's starter), and what it writes is read by everyone in the call's
 * conversation. An agent holding the owner's read tools could be talked into
 * reading the owner's mail, calendar, documents or earlier private meetings
 * and writing them into notes the whole conversation reads; one holding
 * tools that act could be talked into acting. So on a call's capture the
 * turn holds only what writing the shared notes needs:
 *
 *   - the record's own writers: the summary (write_summary, update_summary),
 *     its title, the proposals this capture raises and their edits (new
 *     action items, decisions and milestones only: propose_change refuses
 *     any other change on a call's capture, src/lib/live-agent/tools.ts), and
 *     other people's commitments (record_commitment);
 *   - three structural reads with nothing private in them: who is in the
 *     workspace (to name an assignee), its labels and its workflow states.
 *
 * Everything else is withheld: every owner-private read (email and drafts,
 * calendar, documents and canon, attachments and chat files, packages,
 * earlier captures, search over the workspace, the knowledge graph, CRM
 * contacts and companies, campaigns, flows, sequences, comments, the
 * dashboard), the project and contact resolvers, the connected-app catalog
 * and its proposals (propose_mcp_call), the talk tools, playbooks, and the
 * web. What that costs the notes: an action item said aloud is not linked to
 * a project or a CRM contact by name, an existing task is not updated or
 * reassigned from the call (a new one is proposed instead), nothing from
 * earlier meetings or documents is woven in, and no fact is looked up on the
 * web. The summary itself, the action items, the decisions and who said
 * what are unchanged.
 *
 * What each kept tool can reach beyond the capture:
 *   - write_summary, update_summary, set_capture_title: this capture's row only.
 *   - propose_change: a proposal on this capture (read by its owner); its
 *     assignee resolves to a member only (no contact is looked up); filed on
 *     the board without a click only when its assignee said the line.
 *   - edit_proposal, dismiss_proposal: this capture's own proposals, and the
 *     items its own applied proposals created.
 *   - record_commitment: a claim. Its duplicate check matches only claims
 *     everyone can already read, or claims this capture already sources, never
 *     the owner's private ones (a hit would attach this capture and widen
 *     them); its person resolves to a member only; confirmed only when that
 *     member said the line.
 *   - list_workspace_members, list_labels, list_workflow_states: the
 *     workspace's structure, which every member can read.
 *
 * Which capture is a call's: one whose notes_channel_id is set (566-567 and
 * 588 write it, and only the server may: 566's guard), read from the row
 * itself on every turn, never from the request or the model.
 */

export function isCallCapture(row: { notes_channel_id?: string | null } | null | undefined): boolean {
  return typeof row?.notes_channel_id === 'string' && row.notes_channel_id.length > 0
}

/** The turn types the fence holds for. The end-of-call pass included (it reads the same words, as the same owner). */
export function callCaptureFenceApplies(turnType: 'copilot' | 'notes' | 'batch'): boolean {
  return turnType === 'notes' || turnType === 'copilot' || turnType === 'batch'
}

/**
 * The one question every surface asks (the ceiling, the tool map, the web, the
 * prompt's context, the spec rebuild, the cloud route): is THIS turn fenced?
 */
export function fenceCallCapture(row: { notes_channel_id?: string | null } | null | undefined, turnType: 'copilot' | 'notes' | 'batch'): boolean {
  return isCallCapture(row) && callCaptureFenceApplies(turnType)
}

/** The staging tools a turn on a call's capture keeps: the record's own writers. */
export const CALL_CAPTURE_STAGING_TOOLS: ReadonlySet<string> = new Set<string>([
  'propose_change',
  'edit_proposal',
  'dismiss_proposal',
  'record_commitment',
  'set_capture_title',
  'write_summary',
  'update_summary',
])

/** The reads a turn on a call's capture keeps: workspace structure, nothing private. */
export const CALL_CAPTURE_READ_TOOLS: ReadonlySet<string> = new Set<string>(['list_workspace_members', 'list_labels', 'list_workflow_states'])

/** What propose_change may stage on a call's capture: new action items, decisions and milestones. */
export const CALL_CAPTURE_CHANGES: ReadonlySet<string> = new Set<string>(['create:action', 'create:decision', 'create:milestone'])

/** Is this change one a call's capture may propose? */
export function callCaptureChangeAllowed(changeType: string, entityType: string): boolean {
  return CALL_CAPTURE_CHANGES.has(`${changeType}:${entityType}`)
}

/** What propose_change answers for any other change on a call's capture. */
export const CALL_CAPTURE_CHANGE_REFUSAL =
  'On a call’s shared notes only new action items, decisions and milestones are proposed. Note anything else in the summary instead.'

/**
 * What a fenced turn is told it may do on a call's shared notes, in its
 * context (the system prompt is every capture's; this narrows it), so it does
 * not spend steps on changes the fence refuses.
 */
export function callCaptureGuidance(endOfCall: boolean): string {
  return [
    "## This call's shared notes",
    "This capture is a call's: anyone in the call may have said any line, and everyone in the call's conversation reads what you write. On it you may:",
    '- write and update the summary and the title;',
    '- propose NEW action items, decisions and milestones (propose_change with change_type "create" and entity_type "action", "decision" or "milestone");',
    '- record other people\'s commitments (record_commitment), and edit or dismiss the proposals this capture already made.',
    'Do not propose updates, reassignments or deletions of existing items, email drafts or new contacts: they are refused here. Note them in the summary instead.',
    'You cannot look anything up beyond the workspace\'s members, labels and workflow states: write only from what was said in this call.',
  ].join('\n')
}
