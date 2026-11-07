import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTools } from '../tools'
import {
  ALL_TOOL_NAMES,
  REPORT_MODE_WRITE_ALLOWLIST,
  getMutatingToolNames,
  isReadShapedToolName,
} from '../tool-registry'

/**
 * Report mode (run_skill flow actions with mode 'report' — the trust
 * gradient's safe end) is enforced by denying every MUTATING tool name via
 * getMutatingToolNames(). That classification is prefix-based, so a future
 * tool whose name is neither read-shaped nor write-verb-shaped would silently
 * escape the denylist and let a "report" run mutate the workspace.
 *
 * This is the guard: every REAL tool (the actual createTools output, not just
 * the registry) must be classified read-or-mutate by the helper's logic.
 * Adding an unclassifiable tool fails here, forcing an explicit decision
 * (rename it, or list it in NON_PREFIX_MUTATING_TOOLS).
 *
 * The builders capture `supabase` in their `execute` closures but never touch
 * it at construction time, so a stub client is enough to enumerate the keys.
 */
const stubSupabase = {} as unknown as SupabaseClient
const realToolNames = [
  // The discovery meta-tool is assembled at the route level, alongside
  // createTools output — it's part of every live tool set.
  'search_tools',
  ...Object.keys(createTools('test-user', stubSupabase, 'test-workspace')),
]

describe('getMutatingToolNames — report-mode classification', () => {
  const mutating = getMutatingToolNames()

  it('classifies every real tool as read or mutate (no escapes)', () => {
    const unclassified = realToolNames.filter(
      (name) =>
        !mutating.has(name) &&
        !isReadShapedToolName(name) &&
        !(REPORT_MODE_WRITE_ALLOWLIST as readonly string[]).includes(name),
    )
    expect(unclassified).toEqual([])
  })

  it('classifies every registry tool as read or mutate', () => {
    const unclassified = ALL_TOOL_NAMES.filter(
      (name) =>
        !mutating.has(name) &&
        !isReadShapedToolName(name) &&
        !(REPORT_MODE_WRITE_ALLOWLIST as readonly string[]).includes(name),
    )
    expect(unclassified).toEqual([])
  })

  it('no tool is classified BOTH read and mutate', () => {
    const both = realToolNames.filter((name) => mutating.has(name) && isReadShapedToolName(name))
    expect(both).toEqual([])
  })

  it("allowlists report mode's own output surface (create_document, add_comment)", () => {
    expect(mutating.has('create_document')).toBe(false)
    expect(mutating.has('add_comment')).toBe(false)
  })

  it('classifies obviously-mutating tools as mutating', () => {
    const obviouslyMutating = [
      'start_helper',
      'stop_helper',
      // Local agents on the person's Mac: a start, a message (a turn there) and a stop.
      'start_local_agent',
      'message_local_agent',
      'stop_local_agent',
      'create_action',
      'update_action',
      'complete_action',
      'delete_action',
      'create_actions_batch',
      'accept_proposal',
      'update_document',
      'edit_document_content',
      'propose_document_edit',
      'publish_draft',
      'create_email_draft',
      'generate_email_drafts',
      'draft_followup_email',
      'sync_calendar',
      'create_calendar_event',
      'delete_calendar_event',
      'archive_capture',
      'edit_capture_content',
      'start_cycle',
      'complete_cycle',
      'supersede_claim',
      'ingest_source',
      'link_entities',
      'unlink_entities',
      'attach_chat_file',
      'add_to_package',
      'remove_from_package',
      'create_flow',
      'update_flow',
      'delete_flow',
      'confirm_decision',
      'dismiss_proposal',
    ]
    const missing = obviouslyMutating.filter((name) => !mutating.has(name))
    expect(missing).toEqual([])
  })

  it('classifies any send_* tool as mutating (future guard — none exist today)', () => {
    const unclassifiedSends = realToolNames.filter(
      (name) => name.startsWith('send_') && !mutating.has(name),
    )
    expect(unclassifiedSends).toEqual([])
  })

  it('classifies pure reads as non-mutating', () => {
    const reads = [
      'list_actions',
      'get_action',
      'get_action_suggestions',
      'search',
      'deep_search',
      'read_email',
      'get_meeting_prep',
      'get_dashboard_summary',
      'traverse',
      'list_flow_runs',
    ]
    const misclassified = reads.filter((name) => mutating.has(name))
    expect(misclassified).toEqual([])
  })
})
