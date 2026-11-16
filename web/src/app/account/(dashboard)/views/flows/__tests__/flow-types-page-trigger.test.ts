/**
 * The editor's "Page changes" trigger round-trips through the server's
 * validator: the page and what to tell you about save as the server stores
 * them, workspace-scoped; a bad address or a missing "what to tell you about"
 * is said in the editor first, in plain words; someone else's page watch
 * loads with its page hidden. Made-up pages only.
 */
import { describe, expect, it } from 'vitest'
import { validateTriggerConfig } from '@/lib/flows/queries'
import { triggerConfigForViewer } from '@/lib/flows/types'
import { TRIGGER_TYPE_LABELS, buildSavePayload, emptyEditor, flowToEditor, type EditorState, type Flow } from '../flow-types'

function editorWith(patch: Partial<EditorState['trigger']>): EditorState {
  const editor = emptyEditor()
  editor.name = 'Loop'
  editor.actions[0].url = 'https://example.com/hook'
  editor.trigger = { ...editor.trigger, ...patch }
  return editor
}
const reload = (p: { trigger_type: string; trigger_config: Record<string, unknown> }) =>
  flowToEditor({ id: 'f-1', name: 'Loop', description: null, team_id: null, enabled: false, actions: [], canvas_layout: {}, ...p } as unknown as Flow).trigger

describe('the page trigger in the editor', () => {
  it('labels in plain words, and starts empty', () => {
    expect(TRIGGER_TYPE_LABELS.page_changed).toBe('Page changes')
    expect(emptyEditor().trigger).toMatchObject({ page_url: '', page_look_for: '' })
  })

  it('saves as the server stores it, workspace-scoped (no team), and loads back', () => {
    const built = buildSavePayload(editorWith({ kind: 'page_changed', page_url: ' shop.example.com/kettle ', page_look_for: ' when the price drops ' }))
    if ('error' in built) throw new Error(built.error)
    const p = built.payload as { trigger_type: string; trigger_config: Record<string, unknown>; team_id?: unknown }
    expect(p.trigger_type).toBe('page_changed')
    expect(p.team_id).toBeUndefined()
    const stored = validateTriggerConfig(p.trigger_type, p.trigger_config)
    expect(stored).toEqual({ kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'when the price drops' })
    expect(reload({ trigger_type: 'page_changed', trigger_config: stored as unknown as Record<string, unknown> })).toMatchObject({
      kind: 'page_changed',
      page_url: 'https://shop.example.com/kettle',
      page_look_for: 'when the price drops',
    })
  })

  it('says a bad address or a missing “what to tell you about” before saving', () => {
    expect(buildSavePayload(editorWith({ kind: 'page_changed', page_url: '', page_look_for: 'x' }))).toEqual({ error: 'Give the address of the page to watch.' })
    expect(buildSavePayload(editorWith({ kind: 'page_changed', page_url: 'http://localhost', page_look_for: 'x' }))).toEqual({
      error: 'That address is on a private network. Only public pages can be watched.',
    })
    expect(buildSavePayload(editorWith({ kind: 'page_changed', page_url: 'example.com', page_look_for: '  ' }))).toEqual({ error: 'Say what you want to hear about on this page' })
    expect(buildSavePayload(editorWith({ kind: 'page_changed', page_url: 'example.com', page_look_for: 'a'.repeat(301) }))).toEqual({
      error: 'Keep what to tell you about to 300 characters or fewer',
    })
  })

  it("someone else's page watch loads with its page and what they asked hidden", () => {
    const seen = triggerConfigForViewer('page_changed', { kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'when the price drops' }, false)
    expect(reload({ trigger_type: 'page_changed', trigger_config: seen })).toMatchObject({ kind: 'page_changed', page_url: '', page_look_for: '', details_hidden: true })
  })
})
