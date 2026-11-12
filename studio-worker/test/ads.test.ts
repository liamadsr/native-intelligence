/**
 * The ads' pure parts: the motion helpers and checks (loops, the light
 * transition, punch-ins, the 4:5 crop, the type checks), the templates' markup,
 * the static templates agreeing with the app's catalogue, the report text, and
 * the kit's colour roles. Made-up copy only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MotionRules } from '../../web/src/lib/studio/server/ads-contract.ts'
import { copyFindings, crop45, lightMask, loopCount, punchZoom, typeFindings } from '../src/ads/motion.ts'
import { cutOnBeat, pulloutKeyframes, pullOut } from '../src/ads/motion-templates.ts'
import { tokenFor, type AdsKit } from '../src/ads/kit.ts'
import { TEMPLATE_IDS } from '../src/ads/templates.ts'
import { keepClear, reportText } from '../src/ads/render.ts'
import { contract } from './ads-fixtures.ts'

const rules: MotionRules = {
  service: { minPx: 40, by: 1, minSeconds: 2 }, minPx: 26, safe: { top: 384, bottom: 1498, side: 48 }, maxHold: 2.5,
  loudness: { lufs: -17, tolerance: 1.5, peak: -1 }, banned: [{ pattern: '\\bmiracle\\b', rule: 'VOICE-3', why: 'a promise' }],
}
const el = (o: Partial<{ role: string; text: string; x: number; y: number; w: number; h: number; size: number; opacity: number; clipped: boolean; zoom: boolean }>) =>
  ({ role: 'service', text: 'Plant care', x: 72, y: 404, w: 400, h: 48, size: 40, opacity: 1, clipped: false, zoom: false, ...o })
const frames = (secs: number, fps: number, els: (t: number) => ReturnType<typeof el>[]) => Array.from({ length: secs * fps }, (_, i) => ({ t: i / fps, els: els(i / fps) }))
const kit = { tok: (n: string) => n, fonts: { serif: { family: 'Fixture Serif' }, sans: { family: 'Fixture Sans' } }, kit: { motion: {} } } as unknown as AdsKit

test('loops cover the piece: use plus crossfaded loops reach the full length', () => {
  assert.equal(loopCount(8, [0, 5.02], [0.08, 5.02], 0.12), 1)
  assert.equal(loopCount(8, [0, 4.5], [1, 4.4], 0.5), 2)
  assert.equal(loopCount(7, [1, 8], null, 0.5), 0)
})

test('the light transition opens brightest first and is fully open at the end', () => {
  const m = lightMask(1.45, 0.9, 199, 218)
  const at = (lum: number, T: number) => Function('lum', 'T', 'X', 'Y', 'clip', `return ${m.replace(/lum\(X,Y\)/g, 'lum')}`)(lum, T, 0, 0, (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)))
  assert.equal(at(218, 1.45), 0)
  assert.ok(at(218, 1.8) > at(205, 1.8))
  assert.ok(at(199, 2.4) > 254.9)
})

test('punch-ins switch on the frame of the cut; the 4:5 crop keeps the safe band', () => {
  assert.equal(punchZoom([[1.7, 1.15]], 0, 24), 'if(gte(on,41),1.15,1)')
  assert.equal(punchZoom(undefined, 0, 24), '1')
  const c = crop45(rules.safe)
  assert.deepEqual([c.w, c.h], [1080, 1350])
  assert.ok(c.y <= 384 && c.y + c.h >= 1498)
  assert.match(pulloutKeyframes(72), /^0\.00% \{ transform:scale\(72\.0000\) \}/)
})

test('the type checks: the service early, last and long enough; clipped, small, out of band, slow, banned', () => {
  const ok = frames(8, 10, (t) => (t >= 0.3 ? [el({})] : []))
  assert.deepEqual(typeFindings(ok, [], [0, 1.7, 3.4], 8, rules).filter((f) => f.level === 'error'), [])
  assert.ok(typeFindings(frames(8, 10, (t) => (t >= 1.5 ? [el({})] : [])), [], [0, 1.7, 3.4], 8, rules).some((f) => /first 1s/.test(f.message)))
  const f = typeFindings(frames(8, 10, () => [el({}), el({ role: 'headline', text: 'Golden hour.', clipped: true, y: 1450, h: 160, size: 168 }), el({ role: 'aside', text: 'NOW', size: 20 })]), [2], [0, 4.5], 8, rules)
  for (const rule of ['MOTION-2', 'MOTION-3', 'MOTION-4', 'MOTION-5']) assert.ok(f.some((x) => x.rule === rule), rule)
  assert.deepEqual(copyFindings('A miracle of calm', rules).map((x) => x.rule), ['VOICE-3'])
})

test('cut-on-beat marks the service and cuts each beat on the next; pull-out leaves its move to the background', () => {
  const b = cutOnBeat({ service: 'Plant care', aside: '45 min', ink: 'pine', beats: [{ at: 0.05, lines: ['Busy', 'week?'], size: 196, top: 600 }, { at: 1.7, lines: ['We water.'], size: 258, top: 560 }], end: { at: 3.4, cta: 'Book a visit' } }, { secs: 7, fps: 24, kit })
  assert.match(b.html, /data-role="service">Plant care</)
  assert.match(b.html, /gone \.01s linear 1\.7s forwards/)
  assert.deepEqual(b.events, [0, 0.05, 1.7, 3.4])
  assert.equal(b.scene, undefined)
  const p = pullOut({ service: 'Plant care', panel: 'oat', ink: 'pine', hookInk: 'oat', hook: { lines: ['Every plant'], at: [0.2] }, line: 'Grow', word: 'slow.', end: { at: 4, cta: 'Book' } }, { secs: 6, fps: 24, kit })
  assert.equal(p.scene, 'svg.panel')
  assert.ok(p.editable.some((e) => e.kind === 'scene'))
})

test('the static templates are the ones the app lists, and faces grow by a margin', () => {
  assert.deepEqual([...TEMPLATE_IDS].sort(), [...contract.STATIC_TEMPLATE_IDS].sort())
  assert.deepEqual(keepClear({ faces: [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], heads: [] }, 0.5), [{ x: 0.45, y: 0.45, w: 0.2, h: 0.2 }])
})

test('roles resolve to palette tokens, or say what is missing', () => {
  const k = { palette: { oat: '#F2EBE3', white: '#FFFFFF' }, roles: { ground: 'oat' } }
  assert.equal(tokenFor(k as never, 'ground'), 'oat')
  assert.equal(tokenFor(k as never, 'oat'), 'oat')
  assert.throws(() => tokenFor(k as never, 'deep'), /roles\.deep/)
})

test('the report lists errors, warnings, flags and the face pass skipped', () => {
  const md = reportText({ id: 'b', title: 'Batch' }, { fonts: { serif: { family: 'S', faces: [], weights: {} }, sans: { family: 'X', faces: [], weights: {} } } } as never, [
    { id: 'A1', pattern: 'AD-1', template: 'statement', files: { square: '/x.png' }, findings: { square: [{ level: 'error', rule: 'COLOR-2', message: 'low' }] }, photo: [], flags: ['price'], people: false },
  ])
  assert.match(md, /✗ COLOR-2: low/)
  assert.match(md, /⚑ price/)
  assert.match(md, /face-avoid/)
})
