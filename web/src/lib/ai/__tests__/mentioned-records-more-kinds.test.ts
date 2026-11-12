/**
 * §6h for the kinds the one `@` picker added: deals, flows, files and calendar
 * events, each a line naming the tool that reads it, each read fenced: a deal
 * or flow to the workspace, a file by the attachments rule, an event to its
 * owner (and none on a run that can't read private data). The system
 * context's keys map onto the gatherer's. Fixtures are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { gatherMentionedRecords, hasMentionedRecordIds, mentionedRecordIdsOf } from '../mentioned-records'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const DEAL = 'de000000-0000-4000-8000-000000000001'
const FOREIGN_DEAL = 'de000000-0000-4000-8000-000000000002'
const FLOW = 'f1000000-0000-4000-8000-000000000001'
const OPEN_FILE = 'f0000000-0000-4000-8000-000000000001'
const PRIVATE_FILE = 'f0000000-0000-4000-8000-000000000002'
const BEN_CALL = 'c0000000-0000-4000-8000-000000000001'
const ANA_EVENT = 'e0000000-0000-4000-8000-000000000001'
const BEN_EVENT = 'e0000000-0000-4000-8000-000000000002'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [{ id: 'm-ana', user_id: ANA, workspace_id: WS }],
    deal: [
      { id: DEAL, workspace_id: WS, name: 'Harbor Coffee renewal', stage: { name: 'Proposal sent' } },
      { id: FOREIGN_DEAL, workspace_id: 'another', name: 'Not here', stage: null },
    ],
    flow: [{ id: FLOW, workspace_id: WS, name: 'Weekly digest', enabled: true }],
    captures: [{ id: BEN_CALL, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false }],
    attachments: [
      { id: OPEN_FILE, workspace_id: WS, user_id: BEN, note_id: null, file_name: 'menu.pdf' },
      { id: PRIVATE_FILE, workspace_id: WS, user_id: BEN, note_id: BEN_CALL, file_name: 'salary.xlsx' },
    ],
    local_calendar_event: [
      { id: ANA_EVENT, workspace_id: WS, user_id: ANA, title: 'Harbor call', start_at: '2026-11-12T10:00:00.000Z', is_all_day: false },
      { id: BEN_EVENT, workspace_id: WS, user_id: BEN, title: 'Dentist', start_at: '2026-11-12T09:00:00.000Z', is_all_day: false },
    ],
  }
})

const ids = {
  dealIds: [DEAL, FOREIGN_DEAL],
  flowIds: [FLOW],
  fileIds: [OPEN_FILE, PRIVATE_FILE],
  calendarEventIds: [ANA_EVENT, BEN_EVENT],
}

describe('gatherMentionedRecords: deals, flows, files, events', () => {
  it('lists each readable one with the tool that reads it', async () => {
    const lines = await gatherMentionedRecords(memoryDb(tables), { workspaceId: WS, userId: ANA, ...ids })
    expect(lines.map((l) => l.line)).toEqual([
      `Deal "Harbor Coffee renewal" (Proposal sent): get_deal(deal_id: ${DEAL})`,
      `Flow "Weekly digest" (on), id ${FLOW}: list_flows shows it in full`,
      `File "menu.pdf": get_attachment_content(attachment_id: ${OPEN_FILE})`,
      `Calendar event "Harbor call" (starts 2026-11-12T10:00:00.000Z): get_calendar_events(start_date: 2026-11-12)`,
    ])
  })

  it('a run that can’t read private data gets no event and only the files every member reads', async () => {
    const lines = await gatherMentionedRecords(memoryDb(tables), { workspaceId: WS, userId: ANA, privateDocs: false, ...ids })
    expect(lines.map((l) => l.kind)).toEqual(['deal', 'flow', 'attachment'])
    expect(lines.find((l) => l.kind === 'attachment')?.id).toBe(OPEN_FILE)
  })
})

describe('mentionedRecordIdsOf', () => {
  it('reads the system context’s keys under the gatherer’s names', () => {
    const named = mentionedRecordIdsOf({ attachedDealIds: [DEAL], attachedFileIds: [OPEN_FILE], attachedProjectIds: ['p'], other: [1] })
    expect(named).toEqual({ dealIds: [DEAL], fileIds: [OPEN_FILE], projectIds: ['p'] })
    expect(hasMentionedRecordIds(named)).toBe(true)
    expect(hasMentionedRecordIds(mentionedRecordIdsOf(undefined))).toBe(false)
  })
})
