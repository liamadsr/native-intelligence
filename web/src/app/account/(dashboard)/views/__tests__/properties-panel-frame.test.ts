/**
 * Every detail page's properties panel is built on the one frame
 * (docs/plans/properties-panels.md, components/views/property-layout.tsx):
 * core rows, set rows, the add strip; verbs with More last, holding Delete.
 *
 * The panels are too heavy to mount here (the capture panel's own tests read
 * its source for the same reason), so this reads their source. It pins the
 * frame, and that the reorganisation LOST NOTHING: each control the panels
 * had before it is still named in the panel it was in.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const VIEWS = join(__dirname, '..')
const read = (file: string) => readFileSync(join(VIEWS, file), 'utf8')

/** panel file → what must still be reachable in it (labels, components, handlers). */
const PANELS: Record<string, { kind: string; keeps: string[] }> = {
  'action-detail-panel.tsx': {
    kind: 'action',
    keeps: [
      'StatusPanelField', 'PriorityPanelField', 'assignee_ids', 'assignee_ai_member_id', 'placeholder="Due date"',
      "'Estimate'", "'Add to cycle'", 'Add label', 'AttachmentsCarousel', 'placeholder="Set project"', "'Set milestone'",
      "'Add link'", 'Paste URL...', 'DocumentSearchPicker', "'Link pull request'", 'Paste PR URL...', 'projectRepo.github_repo',
      'PropertyLensSwitcher', 'TaskLens', 'data-compose-sidebar-host', 'CustomFieldsGroup', 'ReferencedIn', 'RecordHistory',
      'ReminderPickerPopover', 'StartAgentWhere', 'StartAgentWith', 'StartFolderChoice', 'PushToTrackerMenu', 'ListenBrief',
      "label: 'Copy as prompt'", 'handleCopyAsPrompt', "label: 'Relations'", 'moveToWorkspace.item', "label: 'Delete action'",
    ],
  },
  'capture-detail-panel.tsx': {
    kind: 'capture',
    keeps: [
      'formatDate(dateStr)', 'formatDuration(capture.duration_seconds)', 'CallRecordingRow', 'CallAudioRow', 'placeholder="Set project"',
      'Link event', 'handleUnlinkEvent', 'data-capture-agent-row', 'data-capture-packages-row', 'participantsExpanded',
      'Add participant', 'Add label', 'AttachmentsCarousel', 'ActivityRow', 'Transcription disconnected', 'ReferencedIn', 'RecordHistory',
      'CaptureVisibilityControl', 'Capture history', 'label="Resume recording"', 'data-call-notes-finishing', 'label="Reprocess capture"',
      'DraftFollowUpDialog', 'CopyTranscriptButton', 'ShareDialog', "label: 'Move to workspace…'", 'setMoveOpen(true)', "label: 'Delete capture'",
    ],
  },
  'project-detail-panel.tsx': {
    kind: 'project',
    keeps: [
      'placeholder="Set status"', 'placeholder="Lead"', 'placeholder="Start date"', 'placeholder="Target date"', 'placeholder="Set initiative"',
      'Link remote repository', 'github_repo: null', 'ProjectEnvironmentField', 'CustomFieldsGroup', 'ReferencedIn', 'RecordHistory',
      'ReminderPickerPopover', 'moveToWorkspace.item', "label: 'Delete project'",
    ],
  },
  'initiative-detail-panel.tsx': {
    kind: 'initiative',
    keeps: [
      'placeholder="Set status"', 'placeholder="Set owner"', 'placeholder="Target date"', "'Set color'", 'color: null', 'Add label',
      'title="Projects"', 'Link project', 'handleUnlinkProject', 'CustomFieldsGroup', 'ReferencedIn', 'RecordHistory',
      'ReminderPickerPopover', 'moveToWorkspace.item', "label: 'Delete initiative'",
    ],
  },
  'document-detail-panel.tsx': {
    kind: 'document',
    keeps: [
      'placeholder="Set project"', 'doc.created_by_name', 'handleUnlinkAction', 'ActionSearchPicker', 'ActivityRow',
      'CustomFieldsGroup', 'ReferencedIn', 'RecordHistory', 'VisibilityControl', 'ListenTarget', 'CopyDocumentButton', 'ShareDialog',
      'moveToWorkspace.item', "label: 'Delete document'", 'SYSTEM_DOCUMENT_REFUSAL',
    ],
  },
  'contact-detail-panel.tsx': {
    kind: 'contact',
    keeps: [
      'placeholder="Set type"', 'placeholder="Set strength"', 'placeholder="Job title"', 'placeholder="Department"', 'placeholder="Email"',
      'FindEmailButton', 'secondary_emails', 'placeholder="Add email..."', 'placeholder="Phone"', 'placeholder="LinkedIn URL"',
      'placeholder="Set company"', "'Set follow-up date'", 'Remove date', 'EnrichmentSection', 'CustomFieldsGroup', 'ReferencedIn', 'RecordHistory',
      'Add to sequence', 'EnrichButton', 'label="Find duplicates"', 'ContactShareDialog', "label: 'Delete contact'",
    ],
  },
  'company-detail-panel.tsx': {
    kind: 'company',
    keeps: [
      'placeholder="Domain"', 'placeholder="Website"', 'placeholder="Contact email"', 'placeholder="Phone"', 'placeholder="Industry"',
      'EMPLOYEE_COUNT_OPTIONS', 'label="Employee count"', 'placeholder="Address"', 'placeholder="City"', 'placeholder="State"', 'placeholder="Country"',
      'EnrichmentSection', 'CustomFieldsGroup', 'ReferencedIn', 'RecordHistory', 'EnrichButton', 'ShareDialog', "label: 'Delete company'",
    ],
  },
}

describe.each(Object.entries(PANELS))('%s', (file, { kind, keeps }) => {
  const src = read(file)
  /** The column itself: from its opening tag to its closing one. */
  const column = src.slice(src.indexOf('<WindowProperties '), src.indexOf('</WindowProperties>'))
  const verbs = src.slice(src.indexOf('<WindowActions'), src.indexOf('</WindowActions>'))

  it('builds its column on the shared frame', () => {
    expect(column).toContain('<PropertyRows')
    expect(column).toContain('<PropertyRow')
    expect(column).toContain('<OptionalProperty')
    // No "Properties" heading over the main group (property-group.tsx).
    expect(column).not.toContain('title="Properties"')
    expect(column).not.toContain('data-properties-heading')
  })

  it('ends its verbs with More, which holds Delete', () => {
    const menu = verbs.lastIndexOf('<EntityActionsMenu')
    expect(menu).toBeGreaterThan(-1)
    // One menu, and nothing after it but its own props.
    expect(verbs.indexOf('<EntityActionsMenu')).toBe(menu)
    const after = verbs.slice(menu)
    expect(after).toContain(`type: '${kind}'`)
    expect(after).toContain('omit={PANEL_OMIT}')
    expect(after).toContain("id: 'delete'")
    expect(after).toContain('danger')
    expect(after.slice(after.indexOf('/>') + 2).trim().replace(/^\)\}/, '').trim()).toBe('')
    // Delete is not also a button of its own.
    expect(verbs).not.toMatch(/label="Delete /)
  })

  it('keeps every control it had', () => {
    const missing = keeps.filter((k) => !src.includes(k))
    expect(missing).toEqual([])
  })
})
