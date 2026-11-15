/**
 * The editor's "New row in a table" and "New quote" triggers round-trip
 * through the server's validators, and someone else's row loop loads without
 * its table.
 */
import { describe, expect, it } from 'vitest'
import { validateTriggerConfig } from '@/lib/flows/queries'
import { triggerConfigForViewer } from '@/lib/flows/types'
import { HIDDEN_TABLE, TRIGGER_TYPE_LABELS, buildSavePayload, emptyEditor, flowToEditor, type EditorState, type Flow } from '../flow-types'

const TABLE = '33333333-3333-4333-8333-333333333333'

function editorWith(patch: Partial<EditorState['trigger']>): EditorState {
  const editor = emptyEditor()
  editor.name = 'Loop'
  editor.actions[0].url = 'https://example.com/hook'
  editor.trigger = { ...editor.trigger, ...patch }
  return editor
}
const reload = (p: { trigger_type: string; trigger_config: Record<string, unknown> }) =>
  flowToEditor({ id: 'f-1', name: 'Loop', description: null, team_id: null, enabled: false, actions: [], canvas_layout: {}, ...p } as unknown as Flow).trigger

describe('the row and quote triggers in the editor', () => {
  it('labels in plain words', () => {
    expect(TRIGGER_TYPE_LABELS.record_created).toBe('New row in a table')
    expect(TRIGGER_TYPE_LABELS.quote_received).toBe('New quote')
  })

  it('New row: the table picked, workspace-scoped (no team)', () => {
    const built = buildSavePayload(editorWith({ kind: 'record_created', record_table_id: TABLE }))
    if ('error' in built) throw new Error(built.error)
    const p = built.payload as { trigger_type: string; trigger_config: Record<string, unknown>; team_id?: unknown }
    expect(p.trigger_type).toBe('record_created')
    expect(p.team_id).toBeUndefined()
    expect(validateTriggerConfig(p.trigger_type, p.trigger_config)).toEqual({ kind: 'record_created', table_id: TABLE })
    expect(reload({ trigger_type: 'record_created', trigger_config: { kind: 'record_created', table_id: TABLE } }).record_table_id).toBe(TABLE)
  })

  it('New row: asks for a table before it saves', () => {
    expect(buildSavePayload(editorWith({ kind: 'record_created', record_table_id: '' }))).toEqual({ error: 'Pick a table' })
    expect(buildSavePayload(editorWith({ kind: 'record_created', record_table_id: HIDDEN_TABLE }))).toEqual({ error: 'Pick a table' })
  })

  it("someone else's row loop loads as \"a table\", never its id", () => {
    const shown = triggerConfigForViewer('record_created', { kind: 'record_created', table_id: TABLE }, false)
    const t = reload({ trigger_type: 'record_created', trigger_config: shown })
    expect(t).toMatchObject({ kind: 'record_created', record_table_id: HIDDEN_TABLE, details_hidden: true })
  })

  it('New quote: no fields', () => {
    const built = buildSavePayload(editorWith({ kind: 'quote_received' }))
    if ('error' in built) throw new Error(built.error)
    const p = built.payload as { trigger_type: string; trigger_config: Record<string, unknown> }
    expect(validateTriggerConfig(p.trigger_type, p.trigger_config)).toEqual({ kind: 'quote_received' })
    expect(reload({ trigger_type: 'quote_received', trigger_config: { kind: 'quote_received' } }).kind).toBe('quote_received')
  })
})
