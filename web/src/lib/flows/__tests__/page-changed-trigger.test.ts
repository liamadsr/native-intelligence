/**
 * The page_changed trigger: its config (a public page, tidied, and what the
 * person wants to hear about), that it is the owner's own event (runs private
 * to them, its page hidden from other members), what a run and a test fire
 * get (ids and the owner's own address, never the page's text), and its clock
 * (due now while on, none while off; the schedule tick's own types untouched).
 * Made-up pages only.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventTriggerTargetProblem } from '../event-triggers'
import { nextRunAtOnDisable, nextRunAtOnEnable, nextRunAtOnWrite } from '../next-run'
import { PAGE_WATCH_LOOK_FOR_MAX } from '../page-watch/url'
import { validatePageChangedConfig, validateTriggerConfig } from '../queries'
import { TEMPLATE_TOKENS, buildTemplateContext } from '../template'
import { entitylessTestTrigger } from '../test-fire'
import { OWNER_ONLY_RUNS_NOTE, flowRowForViewer, flowRunPrivateTo, flowRunsAreSomeoneElses, isOwnerEventTrigger, triggerConfigForViewer, type FlowTriggerConfig } from '../types'

const WS = 'ws-fernhill'
const CHANGE = '77777777-7777-4777-8777-777777777777'
const NOW = new Date('2026-11-16T15:00:00Z')

describe('the config', () => {
  it('keeps the page tidied and what to look for trimmed; nothing else', () => {
    expect(validatePageChangedConfig({ url: 'Example.com/pricing#plans', look_for: '  when the price drops ', extra: 'x' })).toEqual({
      kind: 'page_changed',
      url: 'https://example.com/pricing',
      look_for: 'when the price drops',
    })
    expect(validateTriggerConfig('page_changed', { url: 'https://shop.example.com/kettle', look_for: 'back in stock' })).toEqual({
      kind: 'page_changed',
      url: 'https://shop.example.com/kettle',
      look_for: 'back in stock',
    })
  })

  it.each([
    [{ url: 'http://localhost/admin', look_for: 'x' }, /trigger_config\.url: .*private network/],
    [{ url: 'http://192.168.1.10/', look_for: 'x' }, /trigger_config\.url: .*private network/],
    [{ url: 'ftp://example.com/file', look_for: 'x' }, /trigger_config\.url: Only web pages/],
    [{ url: '', look_for: 'x' }, /trigger_config\.url: Give the address/],
    [{ look_for: 'x' }, /trigger_config\.url/],
    [{ url: 'example.com', look_for: '   ' }, /trigger_config\.look_for: say what you want to hear about/],
    [{ url: 'example.com' }, /trigger_config\.look_for/],
    [{ url: 'example.com', look_for: 'a'.repeat(PAGE_WATCH_LOOK_FOR_MAX + 1) }, /trigger_config\.look_for: keep it to 300 characters/],
    [null, /must be an object/],
    [[], /must be an object/],
  ])('refuses %j in plain words', (raw, message) => {
    const out = validatePageChangedConfig(raw)
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toMatch(message)
  })

  it('takes exactly the longest look_for allowed', () => {
    expect(validatePageChangedConfig({ url: 'example.com', look_for: 'a'.repeat(PAGE_WATCH_LOOK_FOR_MAX) })).not.toBeInstanceOf(Error)
  })

  it('has no channel or table to check at save', async () => {
    const supabase = {} as SupabaseClient
    expect(await eventTriggerTargetProblem(supabase, { workspaceId: WS, ownerUserId: 'u-ana', triggerType: 'page_changed', config: { url: 'https://example.com', look_for: 'x' } })).toBeNull()
  })
})

describe("an owner's own event", () => {
  const config = { kind: 'page_changed', url: 'https://example.com/pricing', look_for: 'when the price drops' }

  it('its runs are private to the owner, and its history says so to anyone else', () => {
    expect(isOwnerEventTrigger('page_changed')).toBe(true)
    expect(flowRunPrivateTo('page_changed', 'u-ana')).toBe('u-ana')
    expect(flowRunsAreSomeoneElses({ trigger_type: 'page_changed', created_by: 'u-ana' }, 'u-cy')).toBe(true)
    expect(flowRunsAreSomeoneElses({ trigger_type: 'page_changed', created_by: 'u-ana' }, 'u-ana')).toBe(false)
    expect(OWNER_ONLY_RUNS_NOTE).toMatch(/pages they watch/)
  })

  it('another member reads it without the page or what the owner asked about; the owner as stored', () => {
    expect(triggerConfigForViewer('page_changed', config, false)).toEqual({ kind: 'page_changed', page: 'a page', owner_only: true })
    expect(triggerConfigForViewer('page_changed', config, true)).toEqual(config)
    const row = { id: 'f-1', trigger_type: 'page_changed', trigger_config: config, created_by: 'u-ana' }
    expect(JSON.stringify(flowRowForViewer(row, 'u-cy'))).not.toMatch(/example\.com|price/)
    expect(flowRowForViewer(row, 'u-ana')).toBe(row)
  })
})

describe('what a run gets', () => {
  it('the change by its id and the owner’s own address, as template tokens', () => {
    expect(TEMPLATE_TOKENS).toContain('{{trigger.page_change_id}}')
    expect(TEMPLATE_TOKENS).toContain('{{trigger.page_url}}')
    const ctx = buildTemplateContext(
      null,
      { type: 'page_changed', entity_type: null, from_status_id: null, to_status_id: null, fired_at: 'now', page_change_id: CHANGE, page_url: 'https://example.com/pricing' },
      'https://app.example',
      { workspaceId: WS },
    )
    expect(ctx.trigger.page_change_id).toBe(CHANGE)
    expect(ctx.trigger.page_url).toBe('https://example.com/pricing')
    // Every other fire has neither.
    const other = buildTemplateContext(null, { type: 'schedule', entity_type: null, from_status_id: null, to_status_id: null, fired_at: 'now' }, 'https://app.example', { workspaceId: WS })
    expect(other.trigger.page_change_id).toBeNull()
    expect(other.trigger.page_url).toBeNull()
  })

  it('a test fire names a change that is not there, and the page only when the config names it', () => {
    const t = entitylessTestTrigger('page_changed', { url: 'https://example.com/pricing', look_for: 'x' }, '2026-11-16T15:00:00Z')
    expect(t).toMatchObject({ type: 'page_changed', entity_type: null, page_url: 'https://example.com/pricing' })
    expect(t.page_change_id).toMatch(/^[0-9a-f-]{36}$/)
    // Someone else's loop is tested with its config as they see it: no page.
    const hidden = entitylessTestTrigger('page_changed', triggerConfigForViewer('page_changed', { url: 'https://example.com', look_for: 'x' }, false), 'now')
    expect(hidden.page_url).toBeNull()
  })
})

describe('the clock (next_run_at)', () => {
  const cfg = { kind: 'page_changed', url: 'https://example.com', look_for: 'x' } as FlowTriggerConfig

  it('a page watch saved on is due now, saved off holds no slot', () => {
    expect(nextRunAtOnWrite('page_changed', cfg, NOW)).toBe(NOW.toISOString())
    expect(nextRunAtOnWrite('page_changed', cfg, NOW, true)).toBe(NOW.toISOString())
    expect(nextRunAtOnWrite('page_changed', cfg, NOW, false)).toBeNull()
  })

  it('switched on it is due now; switched off it holds none', () => {
    expect(nextRunAtOnEnable('page_changed', cfg, NOW)).toBe(NOW.toISOString())
    expect(nextRunAtOnDisable('page_changed')).toBeNull()
  })

  it('every other trigger keeps its own rule: the switch never touches a schedule or an event loop', () => {
    const daily = { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'America/New_York' } as FlowTriggerConfig
    expect(nextRunAtOnWrite('schedule', daily, NOW, false)).toBe(nextRunAtOnWrite('schedule', daily, NOW))
    expect(nextRunAtOnWrite('contact_created', { kind: 'contact_created', source: 'any' } as FlowTriggerConfig, NOW, true)).toBeNull()
    for (const type of ['schedule', 'calendar_event', 'contact_created', 'email_received']) expect(nextRunAtOnDisable(type), type).toBeUndefined()
    expect(nextRunAtOnEnable('contact_created', {}, NOW)).toBeUndefined()
  })
})
