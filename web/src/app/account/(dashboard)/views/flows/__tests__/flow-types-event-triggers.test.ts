/**
 * The editor's new triggers round-trip through the server's validators: New
 * email (a From filter), Chat message (a channel, or Any channel only with
 * "Only when I'm @mentioned"), New document (no fields), and the schedule's
 * Monthly, Custom (cron) and Once cadences. A stored flow loads back into the
 * editor as it was saved.
 */
import { describe, expect, it } from 'vitest'
import { validateTriggerConfig } from '@/lib/flows/queries'
import { ANY_CHANNEL, TRIGGER_TYPE_LABELS, buildSavePayload, describeSchedule, emptyEditor, flowToEditor, type EditorState, type Flow } from '../flow-types'

const CH = '55555555-5555-4555-8555-555555555555'

function editorWith(patch: Partial<EditorState['trigger']>): EditorState {
  const editor = emptyEditor()
  editor.name = 'Loop'
  editor.actions[0].url = 'https://example.com/hook'
  editor.trigger = { ...editor.trigger, timezone: 'America/New_York', ...patch }
  return editor
}

function saved(editor: EditorState): { trigger_type: string; trigger_config: Record<string, unknown> } {
  const built = buildSavePayload(editor)
  if ('error' in built) throw new Error(built.error)
  return built.payload as { trigger_type: string; trigger_config: Record<string, unknown> }
}

const reload = (p: { trigger_type: string; trigger_config: Record<string, unknown> }) =>
  flowToEditor({ id: 'f-1', name: 'Loop', description: null, team_id: null, enabled: false, actions: [], canvas_layout: {}, ...p } as unknown as Flow).trigger

describe('the new triggers in the editor', () => {
  it('labels in plain words', () => {
    expect(TRIGGER_TYPE_LABELS.email_received).toBe('New email')
    expect(TRIGGER_TYPE_LABELS.chat_message).toBe('Chat message')
    expect(TRIGGER_TYPE_LABELS.document_created).toBe('New document')
  })

  it('New email: the From filter, or none', () => {
    const p = saved(editorWith({ kind: 'email_received', email_from: ' @acme.example ' }))
    expect(p.trigger_config).toEqual({ kind: 'email_received', from: '@acme.example' })
    expect(validateTriggerConfig(p.trigger_type, p.trigger_config)).toEqual({ kind: 'email_received', from: 'acme.example' })
    expect(reload({ trigger_type: 'email_received', trigger_config: { kind: 'email_received', from: 'acme.example' } }).email_from).toBe('acme.example')
    expect(saved(editorWith({ kind: 'email_received', email_from: '' })).trigger_config).toEqual({ kind: 'email_received' })
  })

  it('Chat message: a channel; Any channel only with mentions-only', () => {
    const p = saved(editorWith({ kind: 'chat_message', chat_channel_id: CH }))
    expect(validateTriggerConfig(p.trigger_type, p.trigger_config)).toEqual({ kind: 'chat_message', channel_id: CH, mentions_only: false })
    const any = saved(editorWith({ kind: 'chat_message', chat_channel_id: ANY_CHANNEL, mentions_only: true }))
    expect(any.trigger_config).toEqual({ kind: 'chat_message', channel_id: null, mentions_only: true })
    expect(validateTriggerConfig(any.trigger_type, any.trigger_config)).not.toBeInstanceOf(Error)
    expect(reload(any)).toMatchObject({ kind: 'chat_message', chat_channel_id: ANY_CHANNEL, mentions_only: true })

    expect(buildSavePayload(editorWith({ kind: 'chat_message', chat_channel_id: '' }))).toEqual({ error: 'Pick a channel' })
    expect(buildSavePayload(editorWith({ kind: 'chat_message', chat_channel_id: ANY_CHANNEL, mentions_only: false }))).toMatchObject({ error: expect.stringMatching(/@mentioned/) })
  })

  it('New document: no fields', () => {
    const p = saved(editorWith({ kind: 'document_created' }))
    expect(p.trigger_config).toEqual({ kind: 'document_created' })
    expect(reload(p).kind).toBe('document_created')
  })

  it('Monthly: a day and a time', () => {
    const p = saved(editorWith({ kind: 'schedule', cadence: 'monthly', day_of_month: 15, time: '08:00' }))
    expect(p.trigger_config).toEqual({ kind: 'schedule', cadence: 'monthly', time: '08:00', day_of_month: 15, timezone: 'America/New_York' })
    expect(validateTriggerConfig(p.trigger_type, p.trigger_config)).not.toBeInstanceOf(Error)
    expect(reload(p)).toMatchObject({ cadence: 'monthly', day_of_month: 15, time: '08:00' })
    expect(describeSchedule(reload(p))).toBe('Monthly on day 15 at 08:00')
  })

  it('Custom: the expression is checked before saving', () => {
    const p = saved(editorWith({ kind: 'schedule', cadence: 'cron', cron: '0 9 * * 1-5' }))
    expect(p.trigger_config).toEqual({ kind: 'schedule', cadence: 'cron', cron: '0 9 * * 1-5', timezone: 'America/New_York' })
    expect(validateTriggerConfig(p.trigger_type, p.trigger_config)).not.toBeInstanceOf(Error)
    expect(buildSavePayload(editorWith({ kind: 'schedule', cadence: 'cron', cron: '*/5 * * * *' }))).toMatchObject({ error: expect.stringMatching(/^Custom schedule: .*15 minutes/) })
    expect(buildSavePayload(editorWith({ kind: 'schedule', cadence: 'cron', cron: '0 9 * *' }))).toMatchObject({ error: expect.stringMatching(/^Custom schedule: /) })
  })

  it('Once: a date and time (the picker’s own format)', () => {
    const p = saved(editorWith({ kind: 'schedule', cadence: 'once', run_at: '2099-12-01T15:00' }))
    expect(p.trigger_config).toEqual({ kind: 'schedule', cadence: 'once', run_at: '2099-12-01T15:00', timezone: 'America/New_York' })
    expect(validateTriggerConfig(p.trigger_type, p.trigger_config, { now: new Date() })).not.toBeInstanceOf(Error)
    expect(reload(p).run_at).toBe('2099-12-01T15:00')
    expect(buildSavePayload(editorWith({ kind: 'schedule', cadence: 'once', run_at: '' }))).toEqual({ error: 'Pick the date and time it runs' })
  })
})
