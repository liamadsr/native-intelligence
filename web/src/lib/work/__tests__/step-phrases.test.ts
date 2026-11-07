import { describe, it, expect } from 'vitest'
import { phraseForTool, phraseForToolNames, phraseFromLogLine } from '../step-phrases'

describe('phraseForTool', () => {
  it('maps known tools to present-tense sentences', () => {
    expect(phraseForTool('read_email')).toBe('Reading an email thread')
    expect(phraseForTool('create_email_draft')).toBe('Drafting a reply')
  })

  it('strips MCP / dial8 prefixes before the lookup', () => {
    expect(phraseForTool('mcp__dial8__dial8_read_email')).toBe('Reading an email thread')
    expect(phraseForTool('dial8_search_contacts')).toBe('Looking up a contact')
  })

  it('degrades an unknown tool to "Running <name>"', () => {
    expect(phraseForTool('push_action_to_asana')).toBe('Running push action to asana')
    expect(phraseForTool('')).toBe('Running a tool')
  })
})

describe('phraseForToolNames', () => {
  it('describes the LAST tool of a step — what the agent is doing now', () => {
    expect(phraseForToolNames(['search_contacts', 'create_email_draft'])).toBe('Drafting a reply')
  })

  it('is null for an empty step', () => {
    expect(phraseForToolNames([])).toBeNull()
    expect(phraseForToolNames(['', '  '])).toBeNull()
  })
})

describe('phraseFromLogLine', () => {
  it('reads the [tool] lines the agent-run watchers write', () => {
    expect(phraseFromLogLine('[tool] search_contacts, create_email_draft\n')).toBe('Drafting a reply')
    expect(phraseFromLogLine('[tool] get_capture_transcript')).toBe('Reading the capture')
  })

  it('reads the failure and question markers', () => {
    expect(phraseFromLogLine('[tool failed] web_search')).toBe('Retrying after a tool failed')
    expect(phraseFromLogLine('[step failed] boom')).toBe('Recovering from a failed step')
    expect(phraseFromLogLine('❓ [asked the user a question — waiting]')).toBe('Asking you a question')
  })

  it('ignores model prose and blank lines (no step, no beat lost)', () => {
    expect(phraseFromLogLine('Here is what I found about Dana...')).toBeNull()
    expect(phraseFromLogLine('   ')).toBeNull()
  })
})
