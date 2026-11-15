/**
 * The editor's "New contact" trigger round-trips through the server's
 * validator: any contact by default, or the source picked, workspace-scoped,
 * and a stored loop with a source the editor does not know loads as any.
 */
import { describe, expect, it } from 'vitest'
import { validateTriggerConfig } from '@/lib/flows/queries'
import { CONTACT_SOURCE_LABELS, TRIGGER_TYPE_LABELS, buildSavePayload, emptyEditor, flowToEditor, type ContactCreatedSource, type EditorState, type Flow } from '../flow-types'

function editorWith(patch: Partial<EditorState['trigger']>): EditorState {
  const editor = emptyEditor()
  editor.name = 'Loop'
  editor.actions[0].url = 'https://example.com/hook'
  editor.trigger = { ...editor.trigger, ...patch }
  return editor
}
const reload = (p: { trigger_type: string; trigger_config: Record<string, unknown> }) =>
  flowToEditor({ id: 'f-1', name: 'Loop', description: null, team_id: null, enabled: false, actions: [], canvas_layout: {}, ...p } as unknown as Flow).trigger

describe('the contact trigger in the editor', () => {
  it('labels in plain words', () => {
    expect(TRIGGER_TYPE_LABELS.contact_created).toBe('New contact')
    expect(CONTACT_SOURCE_LABELS).toEqual({ any: 'Any', form: 'From a form or a customer’s text', manual: 'Added by hand' })
    expect(emptyEditor().trigger.contact_source).toBe('any')
  })

  it('New contact: each source saves as the server stores it, workspace-scoped (no team), and loads back', () => {
    for (const source of ['any', 'form', 'manual'] as ContactCreatedSource[]) {
      const built = buildSavePayload(editorWith({ kind: 'contact_created', contact_source: source }))
      if ('error' in built) throw new Error(built.error)
      const p = built.payload as { trigger_type: string; trigger_config: Record<string, unknown>; team_id?: unknown }
      expect(p.trigger_type).toBe('contact_created')
      expect(p.team_id).toBeUndefined()
      expect(validateTriggerConfig(p.trigger_type, p.trigger_config)).toEqual({ kind: 'contact_created', source })
      expect(reload({ trigger_type: 'contact_created', trigger_config: { kind: 'contact_created', source } })).toMatchObject({ kind: 'contact_created', contact_source: source })
    }
  })

  it('a stored loop with no source, or one the editor does not know, loads as any', () => {
    expect(reload({ trigger_type: 'contact_created', trigger_config: {} }).contact_source).toBe('any')
    expect(reload({ trigger_type: 'contact_created', trigger_config: { source: 'csv_import' } }).contact_source).toBe('any')
  })
})
