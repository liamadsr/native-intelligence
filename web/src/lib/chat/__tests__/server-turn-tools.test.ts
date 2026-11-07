/**
 * isServerTurnTool (A4 slice 5): a server-started home turn holds registry
 * reads only — never a write, the relay or delegation, an attended-only
 * tool, a tool that needs the person's JWT, the desktop browser, read_card,
 * or anything without a registry entry (external MCP).
 */
import { describe, it, expect } from 'vitest'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, getToolSideEffect } from '@/lib/ai/tool-registry'
import {
  CHECK_IN_REFUSED_READS,
  CHECK_IN_WRITE_TOOLS,
  HOME_TURN_ACTING_REASONS,
  HOME_TURN_LOCAL_AGENT_TOOLS,
  HOME_TURN_SETTLE_TOOLS,
  SERVER_TURN_EXCLUDED_TOOLS,
  checkInMayCall,
  isServerTurnTool,
  serverTurnMayCall,
} from '../chat-ceiling'
import { isInternalTextTool } from '@/lib/safety/outside-text'

describe('isServerTurnTool', () => {
  it('every allowed registry tool is a read, and outside the exclusions', () => {
    const allowed = ALL_TOOL_NAMES.filter(isServerTurnTool)
    expect(allowed.length).toBeGreaterThan(10)
    for (const name of allowed) {
      expect([name, getToolSideEffect(name)]).toEqual([name, 'read'])
      expect(SERVER_TURN_EXCLUDED_TOOLS.has(name)).toBe(false)
    }
  })

  it('no write of any class gets in', () => {
    for (const name of ALL_TOOL_NAMES) {
      if (getToolSideEffect(name) !== 'read') expect([name, isServerTurnTool(name)]).toEqual([name, false])
    }
  })

  it('refuses the chat-native, attended-only, JWT, card and browser tools', () => {
    for (const name of [...CHAT_NATIVE_TOOL_NAMES, ...ATTENDED_ONLY_TOOL_NAMES]) expect([name, isServerTurnTool(name)]).toEqual([name, false])
    for (const name of ['generate_email_drafts', 'draft_followup_email', 'read_card', 'mcp_confirm_call', 'run_browser_task', 'read_browser_page', 'helpers', 'start_helper', 'stop_helper']) {
      expect([name, isServerTurnTool(name)]).toEqual([name, false])
    }
  })

  it('allows plain reads and search_tools; refuses unknown and external names', () => {
    for (const name of ['list_actions', 'get_contact', 'search_tools', 'show']) expect([name, isServerTurnTool(name)]).toEqual([name, true])
    for (const name of ['mcp_github_create_issue', '__proto__', 'constructor', '']) expect([name, isServerTurnTool(name)]).toEqual([name, false])
  })
})

describe('serverTurnMayCall (away helpers, Liam 2026-10-15; acting on its own, 2026-10-26)', () => {
  it('a home turn for an acting reason may start a background helper and act on its own; never the excluded or settle set, and no other server principal', () => {
    expect(serverTurnMayCall('start_helper', 'home_turn', 'event')).toBe(true)
    expect(serverTurnMayCall('start_helper', 'idle_compaction')).toBe(false)
    for (const reason of ['helper_report', 'event', 'agent_answer', 'approval'] as const) {
      // Its writes reach the tool (the gate holds what leaves Dial8 as the person's card).
      for (const name of ['create_action', 'update_action', 'delete_action', 'create_email_draft', 'create_calendar_event']) {
        if (ALL_TOOL_NAMES.includes(name)) expect([reason, name, serverTurnMayCall(name, 'home_turn', reason)]).toEqual([reason, name, true])
      }
      expect(serverTurnMayCall('mcp__jira__create_issue', 'home_turn', reason)).toBe(true)
      // Never the quick helpers, the relay to the bots, the JWT tools, the attended-only tools or the browser.
      for (const name of ['helpers', 'stop_helper', 'send_bot_message', 'generate_email_drafts', 'settle_card', 'mcp_confirm_call', 'read_card']) {
        expect([reason, name, serverTurnMayCall(name, 'home_turn', reason)]).toEqual([reason, name, false])
      }
      // Never the person's review items: confirming or dismissing is their call.
      for (const name of HOME_TURN_SETTLE_TOOLS) expect([reason, name, serverTurnMayCall(name, 'home_turn', reason)]).toEqual([reason, name, false])
      // Every other registry tool: allowed unless the excluded or settle set holds it (the named exceptions aside).
      for (const name of ALL_TOOL_NAMES) {
        if (name !== 'start_helper' && name !== 'answer_guest' && name !== 'ask_agent' && !HOME_TURN_LOCAL_AGENT_TOOLS.has(name)) {
          expect([reason, name, serverTurnMayCall(name, 'home_turn', reason)]).toEqual([reason, name, !SERVER_TURN_EXCLUDED_TOOLS.has(name) && !HOME_TURN_SETTLE_TOOLS.has(name)])
        }
      }
    }
    // Idle compaction stays held to the read-only set.
    for (const name of ALL_TOOL_NAMES) expect([name, serverTurnMayCall(name, 'idle_compaction')]).toEqual([name, isServerTurnTool(name)])
  })

  it('a guest’s ask, the digest and a home token with no reason stay read-only: a guest’s words never drive a write, and nothing deletes', () => {
    for (const reason of ['guest_ask', 'digest', undefined] as const) {
      for (const name of ['create_action', 'delete_action', 'update_action', 'create_calendar_event', 'mcp__jira__create_issue', ...HOME_TURN_SETTLE_TOOLS]) {
        expect([reason, name, serverTurnMayCall(name, 'home_turn', reason)]).toEqual([reason, name, false])
      }
      // The reads, and what each reason's own guidance names, still reach the tool.
      expect(serverTurnMayCall('list_actions', 'home_turn', reason)).toBe(true)
      expect(serverTurnMayCall('answer_guest', 'home_turn', reason)).toBe(true)
      expect(serverTurnMayCall('ask_agent', 'home_turn', reason)).toBe(true)
      expect(serverTurnMayCall('start_helper', 'home_turn', reason)).toBe(true)
    }
    expect([...HOME_TURN_ACTING_REASONS].sort()).toEqual(['agent_answer', 'approval', 'event', 'helper_report'])
  })

  it('a helper’s report never starts another helper (no report-helper chains); other home turns may', () => {
    expect(serverTurnMayCall('start_helper', 'home_turn', 'helper_report')).toBe(false)
    expect(serverTurnMayCall('start_helper', 'home_turn', 'event')).toBe(true)
    expect(serverTurnMayCall('start_helper', 'home_turn', 'agent_answer')).toBe(true)
    expect(serverTurnMayCall('start_helper', 'home_turn', 'approval')).toBe(true)
  })

  it('an approval turn (445) reads how the call ended, and never raises a confirm card itself', () => {
    expect(serverTurnMayCall('get_tool_approval_result', 'home_turn', 'approval')).toBe(true)
    expect(serverTurnMayCall('mcp_confirm_call', 'home_turn', 'approval')).toBe(false)
    // A connected app's call reaches the tool route, whose gate holds it as the person's card.
    expect(serverTurnMayCall('mcp__supabase__execute_sql', 'home_turn', 'approval')).toBe(true)
  })
})

describe('serverTurnMayCall: the check-in (docs/plans/now-file.md "Who may write the note")', () => {
  const may = (name: string) => serverTurnMayCall(name, 'home_turn', 'check_in')

  it('admits update_now and start_helper, and only the internal-text reads (minus get_document and its kin)', () => {
    expect([...CHECK_IN_WRITE_TOOLS].sort()).toEqual(['start_helper', 'update_now'])
    for (const name of CHECK_IN_WRITE_TOOLS) expect([name, may(name)]).toEqual([name, true])
    const allowed = ALL_TOOL_NAMES.filter(may)
    expect(allowed.length).toBeGreaterThan(10)
    for (const name of allowed) {
      if (CHECK_IN_WRITE_TOOLS.has(name)) continue
      // Every other one is a plain server-turn read whose result is workspace text by name.
      expect([name, getToolSideEffect(name), isServerTurnTool(name), isInternalTextTool(name)]).toEqual([name, 'read', true, true])
    }
    for (const name of ['list_actions', 'get_action', 'list_projects', 'get_capture_transcript', 'list_documents', 'search_tools']) expect([name, may(name)]).toEqual([name, true])
  })

  it('refuses get_document (a file-made document reads as outside), its revisions, canon, and show', () => {
    for (const name of CHECK_IN_REFUSED_READS) expect([name, may(name)]).toEqual([name, false])
    expect([...CHECK_IN_REFUSED_READS].sort()).toEqual(['get_document', 'get_document_revision', 'read_canon', 'show'])
  })

  it('refuses outside text (mail, the web, find and search, connected apps) and every other write', () => {
    for (const name of ['read_email', 'list_emails', 'get_email_summary', 'get_attachment_content', 'find', 'search', 'deep_search', 'search_claims', 'get_calendar_events', 'web_search', 'web_fetch', 'mcp__jira__get_issue', 'mcp__jira__create_issue']) {
      expect([name, may(name)]).toEqual([name, false])
    }
    for (const name of ALL_TOOL_NAMES) {
      if (getToolSideEffect(name) !== 'read' && !CHECK_IN_WRITE_TOOLS.has(name)) expect([name, may(name)]).toEqual([name, false])
    }
  })

  it('shuts out what every other home turn holds: the local agents, answer_guest, ask_agent, stop_helper, remember', () => {
    for (const name of [...HOME_TURN_LOCAL_AGENT_TOOLS, 'answer_guest', 'ask_agent', 'stop_helper', 'helpers', 'remember', 'start_local_agent', 'start_cloud_coding_run', 'send_bot_message']) {
      expect([name, may(name)]).toEqual([name, false])
      // The same names stay open to the turns that held them.
      if (name === 'answer_guest' || name === 'ask_agent' || HOME_TURN_LOCAL_AGENT_TOOLS.has(name)) expect(serverTurnMayCall(name, 'home_turn', 'event')).toBe(true)
    }
  })

  it('is not an acting reason, and its branch is the check-in’s alone: no other home turn may write the note', () => {
    expect(HOME_TURN_ACTING_REASONS.has('check_in')).toBe(false)
    for (const reason of ['helper_report', 'event', 'digest', 'guest_ask', 'agent_answer', undefined] as const) {
      expect([reason, serverTurnMayCall('update_now', 'home_turn', reason)]).toEqual([reason, false])
    }
    expect(serverTurnMayCall('update_now', 'idle_compaction')).toBe(false)
    expect(checkInMayCall('update_now')).toBe(true)
  })
})

describe('serverTurnMayCall: a guest_ask update answers guests (guest access, migration 429)', () => {
  it('a home turn may answer one (the route answers only the owner\'s own pending asks); no other server principal', () => {
    expect(serverTurnMayCall('answer_guest', 'home_turn')).toBe(true)
    expect(isServerTurnTool('answer_guest')).toBe(false)
    expect(serverTurnMayCall('answer_guest', 'idle_compaction')).toBe(false)
  })
})

describe('serverTurnMayCall: the local agents (docs/plans/local-agents.md, decisions 6 and 8)', () => {
  it('a home turn may read them, stop one and message one (its handler admits only an answer to an open question); never start one', () => {
    expect([...HOME_TURN_LOCAL_AGENT_TOOLS]).toEqual(['local_agents', 'read_local_agent', 'stop_local_agent', 'message_local_agent'])
    for (const name of HOME_TURN_LOCAL_AGENT_TOOLS) {
      expect([name, serverTurnMayCall(name, 'home_turn')]).toEqual([name, true])
      // Chat-native: never the plain read-only set, and never another server principal's.
      expect([name, isServerTurnTool(name)]).toEqual([name, false])
      expect([name, serverTurnMayCall(name, 'idle_compaction')]).toEqual([name, false])
    }
    expect(serverTurnMayCall('start_local_agent', 'home_turn')).toBe(false)
    expect(serverTurnMayCall('start_local_agent', 'idle_compaction')).toBe(false)
    expect(serverTurnMayCall('start_local_agent', undefined)).toBe(false)
  })
})
