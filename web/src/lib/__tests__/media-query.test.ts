// @vitest-environment jsdom
/**
 * Media queries, read safely (../media-query.ts).
 *
 * The owner's crash (Sentry JAVASCRIPT-NEXTJS-CR, 11-24, the desktop app's
 * WKWebView): `TypeError: null is not an object (evaluating
 * 'matchMedia("(prefers-reduced-motion: reduce)").matches')`, thrown while the
 * side panel's agent face rendered (bot-avatars' BotAvatar, read in render),
 * which took the dashboard down to Home. WebKit's matchMedia can answer null;
 * Chromium's never does. Here: the helpers read a null, a missing matchMedia,
 * a throw and an old list as "can't tell"; the page's shim turns a null into a
 * list; no bare `matchMedia(` is left in the app's code; and the two packages
 * that read it in render stay patched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MATCH_MEDIA_SHIM_SCRIPT, mediaMatches, mediaQueryList, prefersReducedMotion, subscribeMedia } from '../media-query'

const realMatchMedia = window.matchMedia

afterEach(() => {
  window.matchMedia = realMatchMedia
  vi.restoreAllMocks()
})

function list(matches: boolean, extra: Partial<MediaQueryList> = {}): MediaQueryList {
  return {
    matches,
    media: 'q',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
    ...extra,
  } as unknown as MediaQueryList
}

describe('mediaMatches', () => {
  it('reads the answer when there is one', () => {
    window.matchMedia = vi.fn(() => list(true)) as typeof window.matchMedia
    expect(mediaMatches('(hover: hover)')).toBe(true)
    expect(prefersReducedMotion()).toBe(true)
  })

  it('a null answer (WebKit) is the fallback, not a throw', () => {
    window.matchMedia = vi.fn(() => null) as unknown as typeof window.matchMedia
    expect(mediaMatches('(prefers-reduced-motion: reduce)')).toBe(false)
    expect(mediaMatches('(min-width: 48rem)', true)).toBe(true)
    expect(prefersReducedMotion()).toBe(false)
    expect(mediaQueryList('(hover: hover)')).toBeNull()
  })

  it('no matchMedia, or one that throws, is the fallback too', () => {
    ;(window as { matchMedia?: unknown }).matchMedia = undefined
    expect(mediaMatches('(hover: hover)', true)).toBe(true)
    window.matchMedia = vi.fn(() => {
      throw new Error('detached')
    }) as typeof window.matchMedia
    expect(mediaMatches('(hover: hover)')).toBe(false)
  })
})

describe('subscribeMedia', () => {
  it('listens with addEventListener and stops', () => {
    const l = list(false)
    window.matchMedia = vi.fn(() => l) as typeof window.matchMedia
    const off = subscribeMedia('q', () => {})
    expect(l.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    off()
    expect(l.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('falls back to addListener on an old list', () => {
    const l = list(false, { addEventListener: undefined, removeEventListener: undefined } as unknown as Partial<MediaQueryList>)
    window.matchMedia = vi.fn(() => l) as typeof window.matchMedia
    const off = subscribeMedia('q', () => {})
    expect(l.addListener).toHaveBeenCalled()
    off()
    expect(l.removeListener).toHaveBeenCalled()
  })

  it('a null answer, or no way to listen, is a no-op unsubscribe', () => {
    window.matchMedia = vi.fn(() => null) as unknown as typeof window.matchMedia
    expect(() => subscribeMedia('q', () => {})()).not.toThrow()
    const bare = list(false, { addEventListener: undefined, addListener: undefined } as unknown as Partial<MediaQueryList>)
    window.matchMedia = vi.fn(() => bare) as typeof window.matchMedia
    expect(() => subscribeMedia('q', () => {})()).not.toThrow()
  })
})

describe('the page shim (MATCH_MEDIA_SHIM_SCRIPT)', () => {
  it('turns a null answer into a list that matches nothing and hears nothing, once', () => {
    const raw = vi.fn((q: string) => (q === '(hover: hover)' ? list(true) : null))
    window.matchMedia = raw as unknown as typeof window.matchMedia
    new Function(MATCH_MEDIA_SHIM_SCRIPT)()
    const installed = window.matchMedia
    new Function(MATCH_MEDIA_SHIM_SCRIPT)() // a second run leaves the first in place
    expect(window.matchMedia).toBe(installed)
    const missing = window.matchMedia('(prefers-reduced-motion: reduce)')
    expect(missing).not.toBeNull()
    expect(missing.matches).toBe(false)
    expect(() => missing.addEventListener('change', () => {})).not.toThrow()
    expect(window.matchMedia('(hover: hover)').matches).toBe(true)
    expect((window.matchMedia as unknown as { __niSafe?: boolean }).__niSafe).toBe(true)
    // One call of the original per question asked.
    expect(raw).toHaveBeenCalledTimes(2)
  })

  it('leaves a missing matchMedia missing', () => {
    ;(window as { matchMedia?: unknown }).matchMedia = undefined
    new Function(MATCH_MEDIA_SHIM_SCRIPT)()
    expect(window.matchMedia).toBeUndefined()
  })

  it('is the first thing the page’s theme script runs', async () => {
    const src = readFileSync(join(process.cwd(), 'src/components/theme-script.tsx'), 'utf8')
    expect(src).toMatch(/const script = `\$\{MATCH_MEDIA_SHIM_SCRIPT\}/)
  })
})

/** Every .ts/.tsx file under `dir`, tests left out. */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...sources(path))
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

describe('no bare matchMedia', () => {
  // Where a call stays, and why: the helper itself; inline scripts in a string (they run before any
  // module, so they can't import it; each guards a null itself); and the sky's check, which takes the
  // window as an argument and guards a null and a throw.
  const ALLOWED: Record<string, RegExp> = {
    'src/lib/media-query.ts': /./,
    'src/components/theme-script.tsx': /window\.matchMedia && window\.matchMedia\('\(prefers-color-scheme: dark\)'\) \|\| \{\}\)\.matches/,
    'src/app/hud/meeting-detected/route.ts': /window\.matchMedia && window\.matchMedia\('\(prefers-color-scheme: dark\)'\) \|\| \{\}\)\.matches/,
    'src/lib/sky/marketing-sky.ts': /win\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\?\.matches/,
  }

  it('every matchMedia call outside the helper goes through it', () => {
    const root = process.cwd()
    const offenders: string[] = []
    for (const dir of ['src', 'packages']) {
      for (const file of sources(join(root, dir))) {
        const rel = relative(root, file)
        const text = readFileSync(file, 'utf8')
        text.split('\n').forEach((line, i) => {
          // A call: `matchMedia(`, `.matchMedia(` or `matchMedia?.(`, not a word in a comment.
          if (!/matchMedia\??\.?\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) return
          const allowed = ALLOWED[rel]
          if (allowed && allowed.test(line)) return
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('packages that read matchMedia in render stay patched (patches/*.patch)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), 'node_modules', p), 'utf8')

  it('bot-avatars (the side panel’s agent face: the crash)', () => {
    const src = read('bot-avatars/dist/index.es.js')
    expect(src).toContain('matchMedia("(prefers-reduced-motion: reduce)")?.matches')
    expect(src).toContain('matchMedia("(prefers-color-scheme: light)")?.matches')
    expect(src).not.toMatch(/matchMedia\("[^"]*"\)\.matches/)
  })

  it('metal-fx (the read-aloud toggle’s metal)', () => {
    const src = read('metal-fx/dist/index.es.js')
    expect(src).toContain('window.matchMedia(t)?.matches')
    expect(src).toContain('window.matchMedia("(prefers-color-scheme: dark)")?.matches ?? !0')
    expect(src).not.toMatch(/matchMedia\([^)]*\)\.matches/)
  })
})
