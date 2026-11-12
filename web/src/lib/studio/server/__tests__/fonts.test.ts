import { beforeEach, describe, expect, it, vi } from 'vitest'

// Storage and records in memory: the font code only reads and writes blobs and records through these.
const blobs = new Map<string, { bytes: number; contentType: string }>()
const records = new Map<string, unknown>()
vi.mock('../blobs', () => ({
  getBlob: vi.fn(async (_ctx: unknown, key: string) => (blobs.has(key) ? { key, ...blobs.get(key)! } : null)),
  putBlobBytes: vi.fn(async (_ctx: unknown, key: string, bytes: Uint8Array, contentType: string) => {
    blobs.set(key, { bytes: bytes.byteLength, contentType })
    return { key, bytes: bytes.byteLength, parts: 1, partBytes: bytes.byteLength, contentType, sha256: null }
  }),
}))
vi.mock('../records', () => ({
  getRecord: vi.fn(async (_ctx: unknown, collection: string, key: string) => records.get(`${collection}/${key}`) ?? null),
  listRecords: vi.fn(async (_ctx: unknown, collection: string) =>
    [...records].filter(([k]) => k.startsWith(`${collection}/`)).map(([k, value]) => ({ key: k.slice(collection.length + 1), value, updatedAt: '' }))),
  putRecord: vi.fn(async (_ctx: unknown, collection: string, key: string, value: unknown) => {
    records.set(`${collection}/${key}`, value)
  }),
}))

import {
  allowedFontUrl, ensureFonts, facesOf, familiesToEnsure, FONT_FILE_MAX_BYTES, fontshareCssUrl, fontshareFiles, fontshareRecord, fontsourceAxes,
  fontsourceStaticFiles, fontsourceVariableCandidates, installFont, installedFonts, isFontFile, parseFamilies, parseFontshare, parseFontsource, projectFamilies,
  resetFontListings, searchFonts, servedFaces, type InstalledFont,
} from '../fonts'
import type { StudioContext } from '../context'

const ctx = { workspaceId: '11111111-2222-4333-8444-555555555555', userId: null, supabase: {} } as unknown as StudioContext
/** A made-up font file: a WOFF2 header, then nothing. */
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, ...new Array<number>(60).fill(0)])

// ---- recorded fixtures, written by hand in the shapes the two sources answer -----------------------------------

const SHARE_LIST = {
  count: 2,
  fonts: [
    {
      name: 'Satoshi', slug: 'satoshi', category: 'Sans', license_type: 'itf_ffl',
      axes: [{ name: 'wght', property: 'wght', range_left: 300, range_right: 900, range_default: 600 }],
      styles: [
        { is_variable: false, is_italic: false, weight: { number: 300, label: 'Light' } },
        { is_variable: false, is_italic: true, weight: { number: 301, label: 'Light Italic' } },
        { is_variable: true, is_italic: false, weight: { number: 1, label: 'Variable' } },
        { is_variable: true, is_italic: true, weight: { number: 2, label: 'Variable Italic' } },
      ],
    },
    { name: 'Tanker', slug: 'tanker', category: 'Display', styles: [{ is_variable: false, is_italic: false, weight: { number: 400 } }] },
  ],
}
const SATOSHI_CSS = `/* Satoshi */
@font-face {
  font-family: 'Satoshi';
  src: url('//cdn.fontshare.com/wf/AAAA/BBBB/CCCC.woff2') format('woff2'),
       url('//cdn.fontshare.com/wf/AAAA/BBBB/CCCC.woff') format('woff');
  font-weight: 300 900;
  font-display: swap;
  font-style: normal;
}
@font-face {
  font-family: 'Satoshi';
  src: url('//cdn.fontshare.com/wf/DDDD/EEEE/FFFF.woff2') format('woff2');
  font-weight: 300 900;
  font-display: swap;
  font-style: italic;
}`
const SOURCE_LIST = [
  { id: 'inter', family: 'Inter', subsets: ['latin', 'greek'], weights: [100, 400, 900], styles: ['italic', 'normal'], variable: true, category: 'sans-serif', type: 'google' },
  { id: 'anton', family: 'Anton', subsets: ['latin'], weights: [400], styles: ['normal'], variable: false, category: 'sans-serif', type: 'google' },
  { id: 'noto-only', family: 'Noto Only Arabic', subsets: ['arabic'], weights: [400], styles: ['normal'], variable: false, category: 'sans-serif', type: 'google' },
]
const INTER_AXES = { family: 'Inter', axes: { ital: { default: '0', min: '0', max: '1' }, opsz: { default: '14', min: '14', max: '32' }, wght: { default: '400', min: '100', max: '900' } } }

/** A fake of the font hosts: answers by URL, counts requests, refuses anything else. */
function fakeHosts(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = String(input)
    calls.push(url)
    if (overrides[url]) return overrides[url]()
    if (url === 'https://api.fontshare.com/v2/fonts') return Response.json(SHARE_LIST)
    if (url === 'https://api.fontsource.org/v1/fonts') return Response.json(SOURCE_LIST)
    if (url === 'https://api.fontsource.org/v1/variable/inter') return Response.json(INTER_AXES)
    if (url.startsWith('https://api.fontshare.com/v2/css?')) return new Response(SATOSHI_CSS)
    if (url.endsWith('.woff2')) return new Response(WOFF2)
    return new Response('missing', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

beforeEach(() => {
  blobs.clear()
  records.clear()
  resetFontListings()
  vi.unstubAllGlobals()
})

describe('parsing the sources', () => {
  it('keeps the fields used, and only Latin Fontsource families', () => {
    const share = parseFontshare(SHARE_LIST)
    expect(share.map((f) => f.slug)).toEqual(['satoshi', 'tanker'])
    expect(share[0]!.axes?.[0]).toEqual({ property: 'wght', range_left: 300, range_right: 900, range_default: 600 })
    expect(parseFontsource(SOURCE_LIST).map((f) => f.id)).toEqual(['inter', 'anton'])
    expect(parseFontshare({ nope: 1 })).toEqual([])
    expect(parseFontsource({})).toEqual([])
  })
})

describe('which files a family is made of', () => {
  it('asks Fontshare for the variable styles when there are any, and takes its woff2 files', () => {
    const satoshi = parseFontshare(SHARE_LIST)[0]!
    expect(fontshareCssUrl(satoshi)).toBe('https://api.fontshare.com/v2/css?f[]=satoshi@1&f[]=satoshi@2&display=swap')
    const files = fontshareFiles(satoshi, SATOSHI_CSS)
    expect(files).toEqual([
      { url: 'https://cdn.fontshare.com/wf/AAAA/BBBB/CCCC.woff2', file: 'fonts/satoshi/satoshi-300-900-normal.woff2', weight: '300 900', style: 'normal' },
      { url: 'https://cdn.fontshare.com/wf/DDDD/EEEE/FFFF.woff2', file: 'fonts/satoshi/satoshi-300-900-italic.woff2', weight: '300 900', style: 'italic' },
    ])
    const record = fontshareRecord(satoshi, files)
    expect(record).toMatchObject({ family: 'Satoshi', variable: true, italic: true, weights: [300, 900], category: 'sans' })
  })

  it('asks Fontshare for every weight of a static family', () => {
    const tanker = parseFontshare(SHARE_LIST)[1]!
    expect(fontshareCssUrl(tanker)).toBe('https://api.fontshare.com/v2/css?f[]=tanker@400&display=swap')
  })

  it('refuses a stylesheet that points outside the font hosts', () => {
    const satoshi = parseFontshare(SHARE_LIST)[0]!
    expect(() => fontshareFiles(satoshi, `@font-face { src: url('https://evil.example/x.woff2'); font-weight: 400; font-style: normal; }`)).toThrow(/outside the font hosts/)
  })

  it('tries the full variable file first when a Fontsource family has more axes than weight', () => {
    const inter = parseFontsource(SOURCE_LIST)[0]!
    const axes = fontsourceAxes(INTER_AXES)
    expect(Object.keys(axes!)).toEqual(['opsz', 'wght'])
    expect(fontsourceVariableCandidates(inter, axes, 'normal').map((c) => c.url)).toEqual([
      'https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-full-normal.woff2',
      'https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-wght-normal.woff2',
    ])
    expect(fontsourceVariableCandidates(inter, axes, 'italic')[0]).toMatchObject({ file: 'fonts/inter/inter-full-italic.woff2', weight: '100 900', style: 'italic' })
  })

  it('lists every weight and style of a static Fontsource family', () => {
    const anton = parseFontsource(SOURCE_LIST)[1]!
    expect(fontsourceStaticFiles(anton)).toEqual([
      { url: 'https://cdn.jsdelivr.net/fontsource/fonts/anton@latest/latin-400-normal.woff2', file: 'fonts/anton/anton-400-normal.woff2', weight: '400', style: 'normal' },
    ])
  })
})

describe('the allowlist', () => {
  it('lets only https on the four font hosts through', () => {
    expect(allowedFontUrl('//cdn.fontshare.com/wf/a.woff2').hostname).toBe('cdn.fontshare.com')
    expect(allowedFontUrl('https://cdn.jsdelivr.net/fontsource/fonts/x.woff2').hostname).toBe('cdn.jsdelivr.net')
    for (const bad of ['http://cdn.fontshare.com/a.woff2', 'https://fontshare.com.evil.example/a', 'https://evil.example/a', 'https://user:pw@cdn.jsdelivr.net/a', 'https://cdn.jsdelivr.net:8443/a', 'file:///etc/passwd', 'not a url'])
      expect(() => allowedFontUrl(bad)).toThrow()
  })
})

describe('searching', () => {
  it('lists the shelf first, then each source, no family twice', async () => {
    fakeHosts()
    const all = await searchFonts('')
    expect(all[0]).toMatchObject({ family: 'Inter', source: 'fontsource', category: 'sans' })
    expect(all.filter((f) => f.family === 'Satoshi')).toHaveLength(1)
    const found = await searchFonts('tank')
    expect(found.map((f) => f.family)).toEqual(['Tanker'])
    expect(found[0]!.mood).toBe('big, loud, condensed or heavy')
  })

  it('still answers the shelf when the sources are down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    expect((await searchFonts('serif')).map((f) => f.family)).toContain('Instrument Serif')
  })
})

describe('installing', () => {
  it('downloads a family once per workspace and records it', async () => {
    const calls = fakeHosts()
    const font = await installFont(ctx, 'satoshi')
    expect(font.files.map((f) => f.file)).toEqual(['fonts/satoshi/satoshi-300-900-normal.woff2', 'fonts/satoshi/satoshi-300-900-italic.woff2'])
    expect(blobs.get('fonts/satoshi/satoshi-300-900-normal.woff2')).toEqual({ bytes: 64, contentType: 'font/woff2' })
    const downloads = calls.filter((u) => u.endsWith('.woff2')).length
    expect(downloads).toBe(2)
    await installFont(ctx, 'Satoshi')
    expect(calls.filter((u) => u.endsWith('.woff2')).length).toBe(downloads)
    expect((await installedFonts(ctx)).map((f) => f.family)).toEqual(['Satoshi'])
  })

  it('takes a shelf family from its own source and skips files already stored', async () => {
    const gone = () => new Response('nope', { status: 404 })
    const calls = fakeHosts({ 'https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-full-normal.woff2': gone, 'https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-full-italic.woff2': gone })
    blobs.set('fonts/inter/inter-wght-italic.woff2', { bytes: 10, contentType: 'font/woff2' })
    const font = await installFont(ctx, 'Inter')
    expect(font.source).toBe('fontsource')
    expect(font.files).toEqual([
      { file: 'fonts/inter/inter-wght-normal.woff2', weight: '100 900', style: 'normal' },
      { file: 'fonts/inter/inter-wght-italic.woff2', weight: '100 900', style: 'italic' },
    ])
    expect(calls).not.toContain('https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-wght-italic.woff2')
    expect(font.variable).toBe(true)
  })

  it('refuses a file over the size cap', async () => {
    fakeHosts({ 'https://cdn.jsdelivr.net/fontsource/fonts/anton@latest/latin-400-normal.woff2': () => new Response(new Uint8Array(FONT_FILE_MAX_BYTES + 1)) })
    await expect(installFont(ctx, 'Anton')).rejects.toThrow(/no files/)
    expect(blobs.size).toBe(0)
  })

  it('refuses a file that is not a font (a page or a script on a font host)', async () => {
    fakeHosts({ 'https://cdn.jsdelivr.net/fontsource/fonts/anton@latest/latin-400-normal.woff2': () => new Response('<!doctype html><script>alert(1)</script>') })
    await expect(installFont(ctx, 'Anton')).rejects.toThrow(/no files/)
    expect(blobs.size).toBe(0)
    expect(isFontFile(WOFF2)).toBe(true)
    expect(isFontFile(new Uint8Array(64))).toBe(false)
  })

  it('does not follow a redirect off the font hosts', async () => {
    fakeHosts({ 'https://cdn.jsdelivr.net/fontsource/fonts/anton@latest/latin-400-normal.woff2': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.woff2' } }) })
    await expect(installFont(ctx, 'Anton')).rejects.toThrow()
  })

  it('refuses a name no source lists, and nonsense', async () => {
    fakeHosts()
    await expect(installFont(ctx, 'Made Up Grotesk')).rejects.toThrow(/No font called/)
    await expect(installFont(ctx, '')).rejects.toThrow(/Name a font family/)
    await expect(installFont(ctx, { family: 'x' })).rejects.toThrow(/Name a font family/)
  })

  it('ensures the families a video names and the defaults, reporting failures', async () => {
    fakeHosts()
    const result = await ensureFonts(ctx, ['Anton', 'Made Up Grotesk'], { withDefaults: false })
    expect(result).toEqual({ installed: ['Anton'], failed: ['Made Up Grotesk'] })
  })
})

describe('faces', () => {
  const fonts: InstalledFont[] = [
    { family: 'Inter', slug: 'inter', source: 'fontsource', category: 'sans-serif', variable: true, weights: [100, 900], italic: false, files: [{ file: 'fonts/inter/inter-wght-normal.woff2', weight: '100 900', style: 'normal' }], license: '' },
    { family: 'Anton', slug: 'anton', source: 'fontsource', category: 'sans-serif', variable: false, weights: [400, 400], italic: false, files: [{ file: 'fonts/anton/anton-400-normal.woff2', weight: '400', style: 'normal' }], license: '' },
  ]

  it('lists the faces of the families asked for, generic names resolved', () => {
    expect(facesOf(fonts).map((f) => f.family)).toEqual(['Inter', 'Anton'])
    expect(facesOf(fonts, ['sans'])).toEqual([{ family: 'Inter', file: 'fonts/inter/inter-wght-normal.woff2', weight: '100 900', style: 'normal' }])
  })

  it('serves a face from the workspace file route, same origin', () => {
    expect(servedFaces(ctx.workspaceId, facesOf(fonts, ['Anton']))[0]!.src).toBe(`/api/account/studio/file/${ctx.workspaceId}/fonts/anton/anton-400-normal.woff2`)
  })

  it('resolves the five built-in names as before', () => {
    expect(familiesToEnsure(['sans', 'display', 'heavy', 'serif', 'mono'], false)).toEqual(['Inter', 'Satoshi', 'Clash Display', 'Instrument Serif', 'JetBrains Mono'])
    expect(familiesToEnsure(['Anton'])).toEqual(['Inter', 'Satoshi', 'Clash Display', 'Instrument Serif', 'JetBrains Mono', 'Anton'])
  })

  it('reads the families a video uses from its text', () => {
    const project = { layers: [{ kind: 'text', style: { font: 'heavy' } }, { kind: 'shape', style: {} }, { kind: 'card', style: { font: 'Anton', scene: { fonts: ['serif'] } } }] }
    expect(projectFamilies(project as never)).toEqual(['Clash Display', 'Anton', 'Instrument Serif'])
  })

  it('takes at most a dozen plausible names from a query', () => {
    expect(parseFamilies('Inter|Clash Display|<script>|Inter')).toEqual(['Inter', 'Clash Display'])
    expect(parseFamilies(Array.from({ length: 20 }, (_, i) => `Font ${i}`).join('|'))).toHaveLength(12)
    expect(parseFamilies(null)).toEqual([])
  })
})
