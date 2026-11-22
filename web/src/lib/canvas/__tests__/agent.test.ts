import { describe, expect, it } from 'vitest'
import type { CanvasItem, ConnectorItem, RectangleItem, TextItem } from '../types'
import { AGENT_ARTIFACTS_OFF, AGENT_LIMITS, agentArtifactsEnabled, describeThreads, agentColor, applyAgentOps, describeCanvas, estimateText, type AgentOp } from '../agent'
import { ordered } from '../engine/scene'

const run = (items: readonly CanvasItem[], ops: AgentOp[]) => applyAgentOps(items, ops)
const list = (r: ReturnType<typeof run>) => ordered(r.scene) as CanvasItem[]

describe('an agent edits a canvas', () => {
  it('draws a small flow in one batch, tying arrows to what it just made', () => {
    const r = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0, text: 'Research', fill: 'soft-blue' },
      { op: 'create_shape', key: 'b', shape: 'ellipse', x: 480, y: 0, w: 200, h: 100, text: 'Launch' },
      { op: 'connect', from: 'a', to: 'b', label: 'then', route: 'elbow' },
      { op: 'create_text', x: 0, y: 200, text: 'Ship by Friday', font_size: 24 },
    ])
    expect(r.errors).toEqual([])
    expect(r.done).toBe(4)
    const [a, b, k, t] = list(r)
    expect(a).toMatchObject({ kind: 'rectangle', x: 0, y: 0, w: 320, h: 80, label: { plain: 'Research' }, style: { fill: 'theme:blue-soft' } })
    expect(r.created.a).toBe(a.id)
    const c = k as ConnectorItem
    expect(c.start.bind).toEqual({ id: a.id, anchor: 'center' })
    expect(c.end.bind).toEqual({ id: b.id, anchor: 'center' })
    expect(c).toMatchObject({ route: 'elbow', endHead: 'arrow', label: { plain: 'then' } })
    // Settled: the arrow starts on the rectangle's edge, not its middle.
    expect(c.start.x).toBe(320)
    expect((t as TextItem).text.fontSize).toBe(24)
    expect(t.w).toBeGreaterThan(100)
    // Everything is a change to save.
    expect(r.step).toHaveLength(4)
    expect(r.step.every((ch) => ch.before === null && ch.after)).toBe(true)
  })

  it('grows a box to hold its words', () => {
    const long = 'A sentence long enough that it cannot sit on one line of a narrow box and has to wrap several times over.'
    const r = run([], [{ op: 'create_shape', shape: 'rectangle', x: 0, y: 0, w: 160, h: 40, text: long }])
    expect(list(r)[0].w).toBe(160)
    expect(list(r)[0].h).toBeGreaterThan(100)
    expect(estimateText('ab\ncd', 20)).toEqual({ w: 23, h: 56 })
  })

  it('moves, resizes, styles, retitles, groups, restacks and deletes what is there', () => {
    const first = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0, w: 100, h: 50 },
      { op: 'create_shape', key: 'b', shape: 'rectangle', x: 200, y: 0, w: 100, h: 50 },
      { op: 'connect', key: 'k', from: 'a', to: 'b' },
    ])
    const [a, b, k] = list(first)
    const r = run(list(first), [
      { op: 'move', ids: [b.id], dx: 0, dy: 100 },
      { op: 'move', ids: [a.id], x: 10, y: 10 },
      { op: 'resize', id: a.id, w: 200 },
      { op: 'style', ids: [a.id, b.id], fill: '#FF0000', stroke_style: 'dashed', stroke_width: 4, opacity: 0.5 },
      { op: 'set_text', id: a.id, text: 'Start' },
      { op: 'group', key: 'g', ids: [a.id, b.id] },
      { op: 'order', ids: [k.id], to: 'back' },
    ])
    expect(r.errors).toEqual([])
    const items = r.scene.items
    expect(items[b.id]).toMatchObject({ x: 200, y: 100 })
    expect(items[a.id]).toMatchObject({ x: 10, y: 10, w: 200, h: 50, label: { plain: 'Start' } })
    expect((items[a.id] as RectangleItem).style).toMatchObject({ fill: '#ff0000', strokeStyle: 'dashed', strokeWidth: 4, opacity: 0.5 })
    expect(items[a.id].parentId).toBe(r.created.g)
    // The arrow followed both moves, and went to the back.
    const c = items[k.id] as ConnectorItem
    expect(c.end.y).toBeGreaterThan(90)
    expect(ordered(r.scene)[0].id).toBe(k.id)
    const del = run(Object.values(items), [{ op: 'delete', ids: [r.created.g] }])
    expect(Object.values(del.scene.items).map((i) => i.kind)).toEqual(['connector'])
    expect(del.step.filter((ch) => ch.after === null)).toHaveLength(3)
  })

  it('refuses a bad operation with a reason and still applies the rest', () => {
    const r = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0 },
      { op: 'connect', from: 'a', to: 'nowhere' },
      { op: 'style', ids: ['a'], fill: 'chartreuse-ish' },
      { op: 'connect', from: 'a', to: 'a' },
      { op: 'move', ids: ['a'] },
      { op: 'resize', id: 'ghost', w: 10 },
      { op: 'group', ids: ['a'] },
      { op: 'explode' } as unknown as AgentOp,
      { op: 'create_text', x: 0, y: 300, text: '   ' },
      { op: 'create_shape', shape: 'rectangle', x: Number.NaN, y: 0 },
      { op: 'create_text', x: 0, y: 300, text: 'Still here' },
    ])
    expect(r.done).toBe(2)
    expect(r.errors.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(r.errors[0].error).toContain('no item "nowhere"')
    expect(r.errors[1].error).toContain('a color is one of')
    expect(r.errors[2].error).toBe('from and to are the same item')
    expect(list(r).map((i) => i.kind)).toEqual(['rectangle', 'text'])
  })

  it('stops at a hundred operations and says so', () => {
    const ops: AgentOp[] = Array.from({ length: 130 }, (_, i) => ({ op: 'create_shape', shape: 'rectangle', x: i * 10, y: 0, w: 8, h: 8 }))
    const r = run([], ops)
    expect(r.done).toBe(100)
    expect(r.errors).toEqual([{ index: 100, op: 'batch', error: 'only the first 100 operations were applied' }])
  })

  it('names colors the way the palette does', () => {
    expect(agentColor('Blue')).toBe('theme:blue')
    expect(agentColor('Soft blue')).toBe('theme:blue-soft')
    expect(agentColor('blue-soft')).toBe('theme:blue-soft')
    expect(agentColor('theme:ink')).toBe('theme:ink')
    expect(agentColor('none')).toBe('transparent')
    expect(agentColor('#abc')).toBe('#aabbcc')
    expect(agentColor('not a color')).toBeNull()
    expect(agentColor(undefined)).toBeUndefined()
  })
})

describe('an agent reads a canvas', () => {
  it('lists items back to front with their words, ties and groups', () => {
    const made = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0, w: 100, h: 50, text: 'Start', fill: 'green' },
      { op: 'create_shape', key: 'b', shape: 'ellipse', x: 300, y: 0, w: 100, h: 50 },
      { op: 'connect', key: 'k', from: 'a', to: { x: 500, y: 500 } },
      { op: 'group', key: 'g', ids: ['a', 'b'] },
    ])
    const read = describeCanvas(list(made))
    expect(read.total).toBe(4)
    expect(read.omitted).toBe(0)
    expect(read.kinds).toEqual({ rectangle: 1, ellipse: 1, connector: 1, group: 1 })
    expect(read.bounds).toMatchObject({ x: 0, y: 0 })
    const a = read.items.find((i) => i.id === made.created.a)!
    expect(a).toMatchObject({ kind: 'rectangle', x: 0, y: 0, w: 100, h: 50, text: 'Start', fill: 'green', group: made.created.g })
    expect(a.stroke).toBeUndefined()
    const k = read.items.find((i) => i.kind === 'connector')!
    expect(k.from).toBe(made.created.a)
    expect(k.to).toEqual({ x: 500, y: 500 })
    expect(k.heads).toBe('none>arrow')
    // A group reports the box around what is in it.
    expect(read.items.find((i) => i.kind === 'group')).toMatchObject({ x: 0, y: 0, w: 400, h: 50 })
  })

  it('caps a big canvas and counts what it left out', () => {
    const ops: AgentOp[] = Array.from({ length: 100 }, (_, i) => ({ op: 'create_shape', shape: 'rectangle', x: i * 10, y: 0, w: 8, h: 8 }))
    let items: CanvasItem[] = []
    for (let i = 0; i < 4; i++) items = list(run(items, ops))
    const read = describeCanvas(items)
    expect(read.total).toBe(400)
    expect(read.items).toHaveLength(300)
    expect(read.omitted).toBe(100)
  })
})

const ON = { artifacts: true }

describe('an agent makes and changes artifacts', () => {
  it('creates one at a default size, with a tidy title, and reads it back by title and length', () => {
    const r = applyAgentOps([], [{ op: 'create_artifact', key: 'chart', x: 40, y: 60, html: '<h1>Q4</h1><script>document.title = 1</script>', title: '  Q4\n numbers ' }], ON)
    expect(r.errors).toEqual([])
    const item = r.scene.items[r.created.chart]
    expect(item).toMatchObject({ kind: 'artifact', x: 40, y: 60, w: 480, h: 320, title: 'Q4 numbers' })
    const read = describeCanvas(Object.values(r.scene.items))
    expect(read.items[0]).toMatchObject({ kind: 'artifact', text: 'Q4 numbers', html_chars: 46 })
    expect(JSON.stringify(read)).not.toContain('<h1>')
  })

  it('changes the page or the title, and takes an emptied title off', () => {
    const made = applyAgentOps([], [{ op: 'create_artifact', x: 0, y: 0, html: '<p>one</p>', title: 'First' }], ON)
    const id = Object.keys(made.scene.items)[0]
    const r = applyAgentOps(Object.values(made.scene.items), [
      { op: 'set_artifact', id, html: '<p>two</p>' },
      { op: 'set_artifact', id, title: ' ' },
    ], ON)
    expect(r.errors).toEqual([])
    expect(r.scene.items[id]).toMatchObject({ html: '<p>two</p>' })
    expect('title' in r.scene.items[id]).toBe(false)
  })

  it('refuses a page with nothing in it, one that is too long, and a change to something that is not an artifact', () => {
    const box = applyAgentOps([], [{ op: 'create_shape', key: 'b', shape: 'rectangle', x: 0, y: 0 }], ON)
    const boxId = box.created.b
    const r = applyAgentOps(Object.values(box.scene.items), [
      { op: 'create_artifact', x: 0, y: 0, html: '   ' },
      { op: 'create_artifact', x: 0, y: 0, html: 'x'.repeat(200_001) },
      { op: 'create_artifact', x: Number.NaN, y: 0, html: '<p>ok</p>' },
      { op: 'set_artifact', id: boxId, html: '<p>ok</p>' },
      { op: 'set_artifact', id: 'nope', title: 'T' },
    ], ON)
    expect(r.done).toBe(0)
    expect(r.errors.map((e) => e.index)).toEqual([0, 1, 2, 3, 4])
    expect(Object.keys(r.scene.items)).toEqual([boxId])
  })

  it('clamps a size to something that can be seen', () => {
    const r = applyAgentOps([], [{ op: 'create_artifact', key: 'a', x: 0, y: 0, w: 1, h: 1, html: '<p>ok</p>' }], ON)
    expect(r.scene.items[r.created.a]).toMatchObject({ w: 120, h: 80 })
  })
})

describe('artifacts are off for agents unless the server says otherwise', () => {
  it('refuses both operations with the reason, and applies the rest of the batch', () => {
    const made = applyAgentOps([], [{ op: 'create_artifact', key: 'a', x: 0, y: 0, html: '<p>one</p>' }], ON)
    const id = made.created.a
    for (const opts of [undefined, {}, { artifacts: false }]) {
      const r = applyAgentOps(Object.values(made.scene.items), [
        { op: 'create_artifact', x: 0, y: 0, html: '<p>planted</p>' },
        { op: 'set_artifact', id, html: '<p>changed</p>' },
        { op: 'create_shape', shape: 'rectangle', x: 0, y: 0 },
        { op: 'move', ids: [id], dx: 10 },
      ], opts)
      expect(r.errors.map((e) => [e.index, e.error])).toEqual([
        [0, AGENT_ARTIFACTS_OFF],
        [1, AGENT_ARTIFACTS_OFF],
      ])
      expect(r.done).toBe(2)
      expect(r.scene.items[id]).toMatchObject({ html: '<p>one</p>', x: 10 })
      expect(Object.values(r.scene.items).filter((it) => it.kind === 'artifact')).toHaveLength(1)
    }
  })

  it('is on only when CANVAS_AGENT_ARTIFACTS is exactly 1', () => {
    expect(agentArtifactsEnabled({})).toBe(false)
    for (const v of ['', '0', 'true', 'yes', ' 1', 'on']) expect(agentArtifactsEnabled({ CANVAS_AGENT_ARTIFACTS: v }), v).toBe(false)
    expect(agentArtifactsEnabled({ CANVAS_AGENT_ARTIFACTS: '1' })).toBe(true)
  })
})

describe('an agent reads what people said about a canvas', () => {
  const t = (id: string, extra: Record<string, unknown> = {}, replies: Array<{ author_name: string | null; body: string }> = []) => ({ root: { id, item_id: null, author_name: 'Ada Example', body: `About ${id}`, resolved_at: null, ...extra }, replies })

  it('lists open threads with who said what and the item, and leaves resolved ones out', () => {
    const read = describeThreads([t('a', { item_id: 'shape-1' }, [{ author_name: 'Ben Example', body: 'Agreed' }, { author_name: null, body: 'x'.repeat(500) }]), t('b', { resolved_at: '2026-11-21T09:00:00Z' }), t('c', { author_name: null })])
    expect(read.open).toBe(2)
    expect(read.threads.map((x) => x.id)).toEqual(['a', 'c'])
    expect(read.threads[0]).toMatchObject({ item: 'shape-1', by: 'Ada Example', text: 'About a' })
    expect(read.threads[0].replies?.[0]).toEqual({ by: 'Ben Example', text: 'Agreed' })
    expect(read.threads[0].replies?.[1].text).toHaveLength(401)
    expect(read.threads[1]).toEqual({ id: 'c', by: 'Someone', text: 'About c' })
  })

  it('keeps the newest when there are too many, and says how many it left out', () => {
    const many = Array.from({ length: AGENT_LIMITS.threads + 7 }, (_, i) => t(`t${i}`))
    const read = describeThreads(many)
    expect(read.threads).toHaveLength(AGENT_LIMITS.threads)
    expect(read.omitted).toBe(7)
    expect(read.threads.at(-1)?.id).toBe(`t${AGENT_LIMITS.threads + 6}`)
  })
})
