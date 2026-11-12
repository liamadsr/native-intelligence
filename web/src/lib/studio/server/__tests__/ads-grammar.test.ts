/**
 * What a brand kit, a brief or a reel may put into a page or a filter graph: font names, paints (veils and shades),
 * a sound's audio filters and the copy rules' patterns are held to a grammar; a reel's length is capped. Made-up
 * values, and the worker's built-in veils (copied here) so none of them is ever refused.
 */
import { describe, expect, it } from 'vitest'
import {
  BrandKitSchema,
  FontFamilySchema,
  MotionBriefSchema,
  PaintSchema,
  REEL_MAX_SECONDS,
  ReelSpecSchema,
  SoundSchema,
  emptyKit,
  isPaint,
  parseAudioFilters,
  patternProblem,
} from '../ads-contract'
import { BeatGenerationSchema } from '../../engine/storyboard'

/** The worker's built-in veils (studio-worker/src/ads/motion-templates.ts VEILS) and the gradients its templates draw. */
const BUILT_IN = [
  'linear-gradient(180deg, rgba(247,243,239,0.6) 0%, rgba(247,243,239,0.2) 38%, rgba(247,243,239,0.12) 58%, rgba(247,243,239,0.62) 100%)',
  'linear-gradient(180deg, rgba(247,243,239,0) 44%, rgba(247,243,239,0.8) 58%, rgba(247,243,239,0.93) 100%)',
  'linear-gradient(180deg, rgba(247,243,239,0.5) 0%, rgba(247,243,239,0) 30%, rgba(247,243,239,0) 47%, rgba(247,243,239,0.6) 61%, rgba(247,243,239,0.78) 100%)',
  'linear-gradient(180deg, rgba(14,22,17,0.5) 0%, rgba(14,22,17,0.12) 30%, rgba(14,22,17,0.2) 45%, rgba(14,22,17,0.62) 75%, rgba(14,22,17,0.72) 100%)',
  'radial-gradient(ellipse 80% 50% at 50% 50%, rgba(36,30,28,0.6) 0%, rgba(36,30,28,0.35) 55%, rgba(36,30,28,0) 100%)',
  'linear-gradient(0deg, rgba(36,30,28,0) 0%, rgba(36,30,28,0.62) 38%, rgba(36,30,28,0.62) 62%, rgba(36,30,28,0) 100%)',
  'linear-gradient(160deg,#cbb59c 0%,#8d6e55 55%,#4b3a2e 100%)',
  'radial-gradient(circle at 50% 20%,#6aa37a,#2f5a3d)',
]

describe('paints (veils and shades)', () => {
  it('takes every built-in veil and gradient, preset names, colours', () => {
    for (const v of BUILT_IN) expect(isPaint(v), v).toBe(true)
    for (const v of ['sand', 'sand-low', 'photo', 'forest', 'brand-green', '#F2EBE3', '#fff', 'rgba(0,0,0,.4)', 'hsl(120, 30%, 40%)', 'transparent', 'repeating-linear-gradient(45deg, #000 0px, #111 4px)']) expect(isPaint(v), v).toBe(true)
  })

  it('refuses anything that could leave the value, load a file or run code', () => {
    for (const v of [
      'red;background-image:url(file:///etc/hosts)',
      'url(file:///etc/passwd)',
      'linear-gradient(red, blue), url(http://example.test/x.png)',
      'red" onload="alert(1)',
      "red' x='",
      'red</style><script>fetch("http://example.test")</script>',
      'var(--x)',
      'expression(alert(1))',
      'image-set("a.png" 1x)',
      'red /* note */',
      'rgb(0 0 0 / 50%)',
      'red}body{background:blue',
      '@import "x.css"',
      'red\\3b color:blue',
      'red !important',
      'linear-gradient(red, blue',
      'rgba(0,0,0,1))',
      'calc(1px + 2px)',
      'attr(data-x)',
      '',
      ' ',
      `linear-gradient(${'red, '.repeat(250)}blue)`,
    ]) expect(isPaint(v), v).toBe(false)
  })

  it('holds the kit’s veils and a brief’s veils and shade to it', () => {
    const kit = { ...emptyKit(), motion: { veils: { night: 'url(file:///etc/hosts)' } } }
    expect(BrandKitSchema.safeParse(kit).success).toBe(false)
    expect(BrandKitSchema.safeParse({ ...kit, motion: { veils: { night: BUILT_IN[3] } } }).success).toBe(true)
    const brief = (copy: Record<string, unknown>) => ({ id: 'b1', template: 'cut-on-beat', seconds: 6, background: [{ still: 'Photo' }], copy })
    const copy = { service: 'Care', ink: 'ink', beats: [{ at: 0, lines: ['Hello'], size: 120, top: 900 }], end: { at: 4, cta: 'Visit' } }
    expect(MotionBriefSchema.safeParse(brief({ ...copy, veils: [{ css: 'sand' }] })).success).toBe(true)
    expect(MotionBriefSchema.safeParse(brief({ ...copy, veils: [{ css: 'red;x:url(a)' }] })).success).toBe(false)
    expect(PaintSchema.safeParse('forest').success).toBe(true)
  })
})

describe('font names', () => {
  it('are letters (any script), digits, space, - and _', () => {
    for (const f of ['Instrument Serif', 'Inter', 'Fixture_Sans-2', 'Noto Sans JP', 'Söhne Breit', '源ノ角ゴシック']) expect(FontFamilySchema.safeParse(f).success, f).toBe(true)
    for (const f of ["X'}body{background:url(file:///etc/hosts)}", 'A";alert(1);"', 'Serif</style>', 'A\\27', ' Leading', '', 'x'.repeat(81), 'Serif;']) expect(FontFamilySchema.safeParse(f).success, f).toBe(false)
  })

  it('a kit with a hostile family, stand-in or weight name is refused', () => {
    const base = emptyKit()
    expect(BrandKitSchema.safeParse({ ...base, fonts: { ...base.fonts, serif: { ...base.fonts.serif, family: "A'}x{" } } }).success).toBe(false)
    expect(BrandKitSchema.safeParse({ ...base, fonts: { ...base.fonts, sans: { ...base.fonts.sans, standIn: 'B"</script>' } } }).success).toBe(false)
    expect(BrandKitSchema.safeParse({ ...base, fonts: { ...base.fonts, sans: { ...base.fonts.sans, weights: { 'x}y': 400 } } } }).success).toBe(false)
  })
})

describe('a kit sound’s audio filters', () => {
  it('takes plain filters with plain arguments', () => {
    expect(parseAudioFilters('highpass=f=120,lowpass=f=9000,volume=-3dB')).toEqual([{ name: 'highpass', args: 'f=120' }, { name: 'lowpass', args: 'f=9000' }, { name: 'volume', args: '-3dB' }])
    expect(parseAudioFilters('equalizer=f=1000:t=q:w=1:g=-4,aecho=0.8:0.9:40|60:0.4|0.3,afade=t=in:d=0.2')).not.toBeNull()
    expect(parseAudioFilters('')).toEqual([])
    expect(SoundSchema.safeParse({ src: 'bed.wav', kind: 'music', af: 'highpass=f=80' }).success).toBe(true)
  })

  it('refuses filters that open, write or load anything, and graph syntax', () => {
    for (const af of [
      'ladspa=file=/tmp/x.so',
      'lv2=p=urn:x',
      'sofalizer=sofa=/etc/hosts',
      'arnndn=m=/tmp/model',
      'asendcmd=f=/etc/hosts',
      'ametadata=mode=print:file=/tmp/out',
      'volume=1,amovie=/etc/hosts',
      'volume=1[x];[x]volume=2',
      "volume='1'",
      'volume=1;anullsrc',
      'highpass=f=120:file=/etc/hosts',
      'volume=1/2',
      'volume=eval(1)',
    ]) expect(parseAudioFilters(af), af).toBeNull()
    expect(SoundSchema.safeParse({ src: 'bed.wav', kind: 'music', af: 'ladspa=file=x' }).success).toBe(false)
  })
})

describe('copy rule patterns', () => {
  it('takes words and short alternations', () => {
    for (const p of ['\\bmiracle\\b', '\\b(cure|miracle)\\b', 'guarantee[sd]?', '\\bfree\\s+trial\\b', '\\d+% off', '(?:best|top)-rated']) expect(patternProblem(p), p).toBeNull()
  })

  it('refuses nested quantifiers, long patterns and broken ones', () => {
    for (const p of ['(a+)+$', '(\\w*)*x', '(a|aa)+', '((ab)*)+', '(a?){30}', '(x+x+)+y', 'a'.repeat(201), '(unclosed', '']) expect(patternProblem(p), p).not.toBeNull()
    const kit = emptyKit()
    expect(BrandKitSchema.safeParse({ ...kit, rules: { ...kit.rules, copyBans: [{ pattern: '(a+)+$', rule: 'X-1', why: 'slow' }] } }).success).toBe(false)
  })
})

describe('reels', () => {
  const reel = (shots: { src: string; in: number; out: number; slow?: number }[], end?: number) => ({ id: 'r1', shots, beats: [], ...(end ? { end: { seconds: end } } : {}) })
  it(`run at most ${REEL_MAX_SECONDS} s with their end card, slowed shots counted as they play`, () => {
    expect(ReelSpecSchema.safeParse(reel([{ src: 'Clip', in: 0, out: 80 }], 10)).success).toBe(true)
    expect(ReelSpecSchema.safeParse(reel([{ src: 'Clip', in: 0, out: 85 }], 10)).success).toBe(false)
    expect(ReelSpecSchema.safeParse(reel([{ src: 'Clip', in: 0, out: 30, slow: 4 }])).success).toBe(false)
    expect(ReelSpecSchema.safeParse({ ...reel([{ src: 'Clip', in: 0, out: 5 }]), fps: 240 }).success).toBe(false)
  })
})

describe('a beat’s generation model', () => {
  it('is a plain model name that can never read as an option', () => {
    expect(BeatGenerationSchema.safeParse({ model: 'seedance_2_5' }).success).toBe(true)
    expect(BeatGenerationSchema.safeParse({ model: 'nano_banana_2.1-lite' }).success).toBe(true)
    for (const model of ['--json', '-x', 'a', 'Model', 'a b', 'x;rm', '../x', 'a'.repeat(81)]) expect(BeatGenerationSchema.safeParse({ model }).success, model).toBe(false)
  })
})
