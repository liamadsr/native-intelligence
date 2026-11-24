import { describe, expect, it } from 'vitest'
import { addDays, format, parseISO } from 'date-fns'
import {
  PX_PER_DAY, DEFAULT_SPAN_DAYS, ROADMAP_ZOOMS,
  axisTicks, dateToX, dayIndex, dragPatch, flattenRoadmapRows, itemSpan, parseDay,
  previewSpan, pxToDays, schedulePatch, spanBox, supportsRoadmap, timelineRange, undoPatch, xToDate,
} from '../roadmap'
import type { GroupedResults } from '../types'

const day = (s: string) => parseISO(s) // local midnight
const ymd = (d: Date | null) => (d ? format(d, 'yyyy-MM-dd') : null)

describe('which kinds get a roadmap', () => {
  it('actions, projects and initiatives — the view kinds with dates', () => {
    expect(supportsRoadmap('action')).toBe(true)
    expect(supportsRoadmap('project')).toBe(true)
    expect(supportsRoadmap('initiative')).toBe(true)
  })
  it('not kinds without dates to draw', () => {
    expect(supportsRoadmap('contact')).toBe(false)
    expect(supportsRoadmap('document')).toBe(false)
    expect(supportsRoadmap('claim')).toBe(false)
  })
})

describe('date ↔ pixel math', () => {
  const origin = day('2026-10-01')

  it('a day sits pxPerDay × days from the origin, at every zoom', () => {
    expect(dateToX(day('2026-10-01'), origin, 'month')).toBe(0)
    expect(dateToX(day('2026-10-11'), origin, 'month')).toBe(10 * PX_PER_DAY.month)
    expect(dateToX(day('2026-10-11'), origin, 'week')).toBe(10 * PX_PER_DAY.week)
    expect(dateToX(day('2026-10-11'), origin, 'quarter')).toBe(10 * PX_PER_DAY.quarter)
  })

  it('xToDate inverts dateToX, and any x inside a day is that day', () => {
    for (const zoom of ['day', 'week', 'month', 'quarter'] as const) {
      const d = day('2026-12-24')
      const x = dateToX(d, origin, zoom)
      expect(ymd(xToDate(x, origin, zoom))).toBe('2026-12-24')
      expect(ymd(xToDate(x + PX_PER_DAY[zoom] - 0.5, origin, zoom))).toBe('2026-12-24')
    }
  })

  it('counts calendar days across a daylight-saving change', () => {
    // A 23- or 25-hour day is still one day.
    expect(dayIndex(day('2026-11-02'), day('2026-10-31'))).toBe(2)
    expect(dayIndex(day('2026-03-30'), day('2026-03-28'))).toBe(2)
  })

  it('rounds a drag to the nearest whole day, never -0', () => {
    expect(pxToDays(PX_PER_DAY.month * 2.4, 'month')).toBe(2)
    expect(pxToDays(PX_PER_DAY.month * 2.6, 'month')).toBe(3)
    expect(pxToDays(-PX_PER_DAY.week * 1.6, 'week')).toBe(-2)
    expect(Object.is(pxToDays(-1, 'month'), 0)).toBe(true)
  })

  it('a span box runs from its first day’s left edge to its last day’s right edge', () => {
    const span = itemSpan('project', { start_date: '2026-10-03', target_date: '2026-10-05' })
    expect(spanBox(span, origin, 'month')).toEqual({ left: 2 * PX_PER_DAY.month, width: 3 * PX_PER_DAY.month })
  })

  it('parses date columns and timestamps as their local day', () => {
    expect(ymd(parseDay('2026-10-09'))).toBe('2026-10-09')
    const ts = new Date(2026, 9, 9, 17, 30).toISOString()
    expect(ymd(parseDay(ts))).toBe('2026-10-09')
    expect(parseDay(null)).toBeNull()
    expect(parseDay('')).toBeNull()
    expect(parseDay('not a date')).toBeNull()
  })
})

describe('a row’s span', () => {
  it('a project with both dates is a bar, in order even when stored backwards', () => {
    expect(itemSpan('project', { start_date: '2026-10-01', target_date: '2026-10-20' }).kind).toBe('bar')
    const back = itemSpan('project', { start_date: '2026-10-20', target_date: '2026-10-01' })
    expect([ymd(back.start), ymd(back.end)]).toEqual(['2026-10-01', '2026-10-20'])
  })

  it('a project with one date gets a default length toward the missing one', () => {
    const s = itemSpan('project', { start_date: '2026-10-01', target_date: null })
    expect(s.kind).toBe('open-end')
    expect(ymd(s.end)).toBe(ymd(addDays(day('2026-10-01'), DEFAULT_SPAN_DAYS - 1)))
    const t = itemSpan('project', { start_date: null, target_date: '2026-10-30' })
    expect(t.kind).toBe('open-start')
    expect(ymd(t.end)).toBe('2026-10-30')
  })

  it('an action is a marker on its due day; an initiative on its target', () => {
    const due = new Date(2026, 10, 24, 9, 0).toISOString()
    const a = itemSpan('action', { due_at: due })
    expect(a.kind).toBe('marker')
    expect(ymd(a.start)).toBe('2026-11-24')
    expect(itemSpan('initiative', { target_date: '2027-01-15' }).kind).toBe('marker')
  })

  it('no dates draws nothing', () => {
    expect(itemSpan('action', { due_at: null }).kind).toBe('none')
    expect(itemSpan('project', {}).kind).toBe('none')
    expect(itemSpan('contact', { due_at: '2026-10-01' }).kind).toBe('none')
  })
})

describe('drag to reschedule', () => {
  const project = { id: 'p1', start_date: '2026-10-05', target_date: '2026-10-16' }

  it('moving a bar shifts both dates by the same days', () => {
    expect(dragPatch('project', project, 'move', 3)).toEqual({ start_date: '2026-10-08', target_date: '2026-10-19' })
    expect(dragPatch('project', project, 'move', -5)).toEqual({ start_date: '2026-09-30', target_date: '2026-10-11' })
  })

  it('dragging an end changes only that date', () => {
    expect(dragPatch('project', project, 'start', 2)).toEqual({ start_date: '2026-10-07' })
    expect(dragPatch('project', project, 'end', 7)).toEqual({ target_date: '2026-10-23' })
  })

  it('a resize never crosses the other end', () => {
    expect(dragPatch('project', project, 'start', 30)).toEqual({ start_date: '2026-10-16' })
    expect(dragPatch('project', project, 'end', -30)).toEqual({ target_date: '2026-10-05' })
    const p = previewSpan(itemSpan('project', project), 'end', -30)
    expect(ymd(p.end)).toBe(ymd(p.start))
  })

  it('no movement writes nothing', () => {
    expect(dragPatch('project', project, 'move', 0)).toBeNull()
    // Already at the limit: pushing further is no change.
    expect(dragPatch('project', { start_date: '2026-10-05', target_date: '2026-10-05' }, 'end', -3)).toBeNull()
  })

  it('an open-ended project: moving writes only the date it has; dragging the faded end sets the missing one', () => {
    const open = { id: 'p2', start_date: '2026-10-05', target_date: null }
    expect(dragPatch('project', open, 'move', 1)).toEqual({ start_date: '2026-10-06' })
    expect(dragPatch('project', open, 'end', 2)).toEqual({
      target_date: format(addDays(day('2026-10-05'), DEFAULT_SPAN_DAYS - 1 + 2), 'yyyy-MM-dd'),
    })
  })

  it('an action’s marker moves its due date and keeps its time of day', () => {
    const due = new Date(2026, 10, 24, 15, 45)
    const patch = dragPatch('action', { id: 'a1', due_at: due.toISOString() }, 'move', 4)!
    const moved = new Date(patch.due_at as string)
    expect(format(moved, 'yyyy-MM-dd HH:mm')).toBe('2026-11-28 15:45')
    // A handle drag on a marker is a move: there is no start to stretch.
    expect(dragPatch('action', { id: 'a1', due_at: due.toISOString() }, 'start', 1)).toEqual(
      dragPatch('action', { id: 'a1', due_at: due.toISOString() }, 'move', 1),
    )
  })

  it('a dateless row cannot be dragged', () => {
    expect(dragPatch('action', { id: 'a2', due_at: null }, 'move', 2)).toBeNull()
  })

  it('schedules a dateless row on a day', () => {
    const d = day('2026-12-01')
    const a = schedulePatch('action', d)!
    const at = new Date(a.due_at)
    expect(format(at, 'yyyy-MM-dd HH:mm')).toBe('2026-12-01 12:00')
    expect(schedulePatch('project', d)).toEqual({
      start_date: '2026-12-01',
      target_date: format(addDays(d, DEFAULT_SPAN_DAYS - 1), 'yyyy-MM-dd'),
    })
    expect(schedulePatch('initiative', d)).toEqual({ target_date: '2026-12-01' })
    expect(schedulePatch('contact', d)).toBeNull()
  })

  it('undo restores exactly the fields the patch replaced, null where they were empty', () => {
    expect(undoPatch({ start_date: '2026-10-05' }, { start_date: 'x', target_date: 'y' }))
      .toEqual({ start_date: '2026-10-05', target_date: null })
  })
})

describe('the range and the axis', () => {
  const today = day('2026-11-22')

  it('spans whole months from before today to well after it, widening to the rows', () => {
    const r = timelineRange([], today)
    expect(ymd(r.start)).toBe('2026-07-01')
    expect(ymd(r.end)).toBe('2027-09-30') // nine months on, plus a month, to a month's end
    const wide = timelineRange([itemSpan('project', { start_date: '2025-01-10', target_date: '2028-03-02' })], today)
    expect(ymd(wide.start)).toBe('2024-12-01')
    expect(wide.end > day('2028-03-02')).toBe(true)
  })

  it('month zoom: a label per month (year on the first and on January), a tick per Monday', () => {
    const { major, minor } = axisTicks(day('2026-10-01'), day('2027-01-31'), 'month')
    expect(major.map(t => t.label)).toEqual(['October 2026', 'November', 'December', 'January 2027'])
    expect(minor.every(t => t.date.getDay() === 1)).toBe(true)
    expect(minor[0].label).toBe('5') // Monday 5 October 2026
    expect(minor[1].x - minor[0].x).toBe(7 * PX_PER_DAY.month)
  })

  it('day zoom (Liam, 11-23: "lets add a day view"): the closest, a tick per day with its weekday, the month named on its 1st', () => {
    expect(ROADMAP_ZOOMS[0]).toBe('day')
    expect(PX_PER_DAY.day).toBeGreaterThan(PX_PER_DAY.week)
    const { major, minor } = axisTicks(day('2026-11-29'), day('2026-12-02'), 'day')
    expect(major.map(t => t.label)).toEqual(['November 2026', 'December'])
    expect(minor.map(t => t.label)).toEqual(['Sun 29', 'Mon 30', 'Tue Dec 1', 'Wed 2'])
    expect(minor[1].x).toBe(PX_PER_DAY.day)
  })

  it('week zoom: a tick per day', () => {
    const { minor } = axisTicks(day('2026-10-01'), day('2026-10-31'), 'week')
    expect(minor).toHaveLength(31)
    expect(minor[1].x).toBe(PX_PER_DAY.week)
  })

  it('quarter zoom: quarters on top, months below', () => {
    const { major, minor } = axisTicks(day('2026-10-01'), day('2027-06-30'), 'quarter')
    expect(major.map(t => t.label)).toEqual(['Q4 2026', 'Q1 2027', 'Q2 2027'])
    expect(minor.map(t => t.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'])
  })
})

describe('rows and grouping', () => {
  const a = { id: 'a', title: 'Draft the brief' }
  const b = { id: 'b', title: 'Book the venue' }
  const c = { id: 'c', title: 'Send invites' }

  it('an ungrouped result is one row per item', () => {
    const rows = flattenRoadmapRows([a, b], new Set())
    expect(rows.map(r => r.type)).toEqual(['item', 'item'])
  })

  it('a grouped result is a header per group followed by its items', () => {
    const groups: GroupedResults[] = [
      { key: 'high', label: 'High', items: [a, b] },
      { key: 'low', label: 'Low', items: [c] },
    ]
    const rows = flattenRoadmapRows(groups, new Set())
    expect(rows.map(r => (r.type === 'group' ? `#${r.label}:${r.count}` : String((r as { item?: Record<string, unknown> }).item?.id))))
      .toEqual(['#High:2', 'a', 'b', '#Low:1', 'c'])
  })

  it('a collapsed group keeps its header and hides its items', () => {
    const groups: GroupedResults[] = [
      { key: 'high', label: 'High', items: [a, b] },
      { key: 'low', label: 'Low', items: [c] },
    ]
    const rows = flattenRoadmapRows(groups, new Set(['high']))
    expect(rows.map(r => r.type)).toEqual(['group', 'group', 'item'])
    expect(rows[0].type === 'group' && rows[0].collapsed).toBe(true)
  })

  it('sub-groups nest under their group, with keys unique per path', () => {
    const groups: GroupedResults[] = [
      { key: 'p1', label: 'Launch', items: [], subGroups: [{ key: 'high', label: 'High', items: [a] }] },
      { key: 'p2', label: 'Website', items: [], subGroups: [{ key: 'high', label: 'High', items: [b] }] },
    ]
    const rows = flattenRoadmapRows(groups, new Set())
    expect(rows.map(r => `${r.type}:${r.depth}`)).toEqual(['group:0', 'group:1', 'item:1', 'group:0', 'group:1', 'item:1'])
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
    // Collapsing one sub-group leaves its namesake in the other group open.
    const one = flattenRoadmapRows(groups, new Set(['p1/high']))
    expect(one.filter(r => r.type === 'item').map(r => String((r as { item?: Record<string, unknown> }).item?.id))).toEqual(['b'])
  })

  it('a lazy finished group starts collapsed, and opening it shows a loading row until its page arrives', () => {
    const groups: GroupedResults[] = [
      { key: 'done', label: 'Done', items: [], metadata: { lazy: true, count: 12 } },
    ]
    const closed = flattenRoadmapRows(groups, new Set())
    expect(closed).toHaveLength(1)
    expect(closed[0].type === 'group' && closed[0].collapsed && closed[0].count).toBe(12)
    const open = flattenRoadmapRows(groups, new Set(['done']))
    expect(open.map(r => r.type)).toEqual(['group', 'empty'])
  })
})
