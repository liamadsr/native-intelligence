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
import { triggerConfigForViewer } from '../types'

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
    })
    expect(triggerConfigForViewer('chat_message', { kind: 'chat_message', channel_id: null, mentions_only: true }, false)).toEqual({
      kind: 'chat_message',
      mentions_only: true,
      channel: 'any channel',
    })
    expect(triggerConfigForViewer('email_received', { kind: 'email_received', from: 'billing@vendor.example' }, false)).toEqual({ kind: 'email_received' })
  })

  it("leaves every other loop's config alone", () => {
    const cfg = { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' }
    expect(triggerConfigForViewer('schedule', cfg, false)).toEqual(cfg)
  })
})
