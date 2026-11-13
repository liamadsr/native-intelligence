/**
 * What a run of a loop on its owner's mail, chat or documents leaves behind
 * stays the owner's: the report document it writes is private to them
 * (reportIsPrivate, read by the skill run's spec), and its trigger's own
 * details (a chat loop's channel, a mail loop's sender filter) are shown to
 * no one else (triggerConfigForViewer).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reportIsPrivate } from '../run-skill'
import { flowRowForViewer, triggerConfigForViewer } from '../types'

describe('reportIsPrivate', () => {
  it("is private for every owner event trigger, and for P9's material", () => {
    for (const type of ['email_received', 'chat_message', 'document_created']) expect(reportIsPrivate(null, { type })).toBe(true)
    expect(reportIsPrivate({ privateReport: true }, { type: 'schedule' })).toBe(true)
  })

  it('stays workspace-visible for every other trigger', () => {
    for (const type of ['schedule', 'capture_processed', 'entity_status_change', 'quote_received', 'calendar_event', 'pr_status_changed']) {
      expect(reportIsPrivate(null, { type })).toBe(false)
    }
    expect(reportIsPrivate(undefined, undefined)).toBe(false)
  })

  it('the spec reads it from the fire, and delivery makes the document private', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/flows/run-skill.ts'), 'utf8')
    expect(src).toContain('...(reportIsPrivate(material, ctx.trigger) ? { privateReport: true } : {}),')
    expect(src).toContain("if (spec.privateReport && member?.id) insert.visibility = 'private'")
  })
})

describe('triggerConfigForViewer', () => {
  it('the owner sees the config as stored', () => {
    const cfg = { kind: 'chat_message', channel_id: 'ch-1', mentions_only: false }
    expect(triggerConfigForViewer('chat_message', cfg, true)).toEqual(cfg)
  })

  it('anyone else: "a channel" (or "any channel"), and no sender filter', () => {
    expect(triggerConfigForViewer('chat_message', { kind: 'chat_message', channel_id: 'ch-1', mentions_only: false }, false)).toEqual({
      kind: 'chat_message',
      mentions_only: false,
      channel: 'a channel',
      owner_only: true,
    })
    expect(triggerConfigForViewer('chat_message', { kind: 'chat_message', channel_id: null, mentions_only: true }, false)).toEqual({
      kind: 'chat_message',
      mentions_only: true,
      channel: 'any channel',
      owner_only: true,
    })
    expect(triggerConfigForViewer('email_received', { kind: 'email_received', from: 'billing@vendor.example' }, false)).toEqual({ kind: 'email_received', owner_only: true })
  })

  it("leaves every other loop's config alone", () => {
    const cfg = { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' }
    expect(triggerConfigForViewer('schedule', cfg, false)).toEqual(cfg)
  })
})

describe('flowRowForViewer (the REST reads and the views query)', () => {
  const mail = { id: 'f-1', trigger_type: 'email_received', created_by: 'u-ana', trigger_config: { kind: 'email_received', from: 'billing@vendor.example' }, name: 'Mail' }
  it("redacts another member's event loop, and only its trigger config", () => {
    expect(flowRowForViewer(mail, 'u-bo')).toEqual({ ...mail, trigger_config: { kind: 'email_received', owner_only: true } })
    expect(flowRowForViewer(mail, null).trigger_config).toEqual({ kind: 'email_received', owner_only: true })
  })
  it('the owner, and every other loop, as stored', () => {
    expect(flowRowForViewer(mail, 'u-ana')).toBe(mail)
    const daily = { ...mail, trigger_type: 'schedule', trigger_config: { kind: 'schedule', cadence: 'daily' } }
    expect(flowRowForViewer(daily, 'u-bo')).toBe(daily)
  })
})

describe('the views read flows through flowRowForViewer', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
  it('the saved-view results (executeView) and the ad hoc views query both redact a flow row for its viewer', () => {
    expect(read('src/lib/views/query-engine.ts')).toContain("if (view.entity_type === 'flow') items = items.map((row) => flowRowForViewer(row, userId))")
    expect(read('src/app/api/account/views/query/route.ts')).toContain("if (entity_type === 'flow') items = items.map((row) => flowRowForViewer(row, user.id))")
  })
})
