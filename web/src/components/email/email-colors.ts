/**
 * Making an arbitrary HTML email readable on the app's theme.
 *
 * An email is written for a white page. On the dark theme that goes wrong in
 * one of two ways: its dark text lands on our dark background, or its white
 * panels sit as islands in it. Two answers, chosen per email (`emailCanvasMode`):
 *
 *  - "canvas": a designed email (a layout table, its own stylesheet, painted
 *    backgrounds) keeps the page it was designed for. It is drawn on its own
 *    canvas, in the background and text colour its <body> asked for (white and
 *    near-black when it asked for none), exactly as authored.
 *  - "adapt": a plain email (someone typing in a mail client) takes the theme's
 *    colours. Whatever colours it does set are then checked against the
 *    theme's background once it is on the page (`adaptEmailColors`): a light
 *    background nothing sits behind is dropped, and text too close to the
 *    background is moved to the other end of the lightness scale, hue kept.
 *
 * Written for this app. The idea of choosing between "leave a designed email
 * on its light canvas" and "re-colour a plain one" is how mail clients
 * generally handle dark mode; no code here comes from another project.
 */

export interface Rgb {
  r: number
  g: number
  b: number
  /** 0-1. */
  a: number
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', navy: '#000080', maroon: '#800000', purple: '#800080', teal: '#008080', olive: '#808000',
  yellow: '#ffff00', orange: '#ffa500', lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', dimgray: '#696969', dimgrey: '#696969',
  whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', ivory: '#fffff0', snow: '#fffafa', ghostwhite: '#f8f8ff', aliceblue: '#f0f8ff',
}

/** A CSS colour as RGBA, or null for one we don't read (a gradient, `inherit`, a variable). */
export function parseCssColor(value: string | null | undefined): Rgb | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = (NAMED[v] ?? v).match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16))
      return { r, g, b, a: a === undefined ? 1 : a / 255 }
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
    }
    return null
  }
  const fn = v.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/)
  if (fn) {
    const channel = (s: string) => Math.max(0, Math.min(255, s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s)))
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4])
    return { r: channel(fn[1]), g: channel(fn[2]), b: channel(fn[3]), a: Math.max(0, Math.min(1, alpha)) }
  }
  return null
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance({ r, g, b }: Pick<Rgb, 'r' | 'g' | 'b'>): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Pick<Rgb, 'r' | 'g' | 'b'>, b: Pick<Rgb, 'r' | 'g' | 'b'>): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function rgbToHsl({ r, g, b }: Pick<Rgb, 'r' | 'g' | 'b'>): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return [h * 60, s, l]
}

function hslToRgb(h: number, s: number, l: number): Pick<Rgb, 'r' | 'g' | 'b'> {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }
}

/** The contrast body text must reach against the page (WCAG AA). */
export const MIN_TEXT_CONTRAST = 4.5
/** A background lighter than this is "the white page", dropped on the dark theme. */
export const LIGHT_BACKGROUND_LUMINANCE = 0.7
/** A background darker than this is "a dark page", dropped on the light theme. */
export const DARK_BACKGROUND_LUMINANCE = 0.08

/**
 * A text colour that reads on `background`: the colour itself when it already
 * does, else the same hue moved along the lightness scale, away from the
 * background, until it does. Returns null when nothing needs to change.
 */
export function readableTextColor(text: Rgb, background: Pick<Rgb, 'r' | 'g' | 'b'>): string | null {
  if (contrastRatio(text, background) >= MIN_TEXT_CONTRAST) return null
  const darkPage = luminance(background) < 0.5
  const [h, s, l] = rgbToHsl(text)
  // Start from the mirrored lightness (a dark grey becomes a light grey), then step until it reads.
  let next = darkPage ? Math.max(1 - l, 0.6) : Math.min(1 - l, 0.4)
  // Strong colours glare on a dark page: ease them a little.
  const sat = darkPage ? Math.min(s, 0.85) : s
  for (let i = 0; i < 20; i++) {
    const candidate = hslToRgb(h, sat, next)
    if (contrastRatio(candidate, background) >= MIN_TEXT_CONTRAST) return `rgb(${candidate.r}, ${candidate.g}, ${candidate.b})`
    next = darkPage ? Math.min(1, next + 0.04) : Math.max(0, next - 0.04)
  }
  return darkPage ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'
}

export type EmailCanvasMode = 'canvas' | 'adapt'

const SIGNATURE_SELECTOR = '.gmail_signature, [data-smartmail="gmail_signature"], #Signature, .moz-signature'

/**
 * Which way an email is drawn. "canvas" for a designed email: a table outside
 * a signature, a stylesheet that paints backgrounds, or a painted background
 * (an image, a gradient, or a colour that is not near-white). Everything else adapts.
 */
export function emailCanvasMode(doc: Document): EmailCanvasMode {
  // A stylesheet of its own that paints a background: a design. (One that only
  // sets fonts and margins, as Outlook adds to every message, is not.)
  for (const style of doc.querySelectorAll('style')) {
    if (/background(-color|-image)?\s*:/i.test(style.textContent || '')) return 'canvas'
  }
  for (const table of doc.querySelectorAll('table')) {
    if (!table.closest(SIGNATURE_SELECTOR)) return 'canvas'
  }
  for (const el of doc.querySelectorAll<HTMLElement>('[bgcolor], [background], [style]')) {
    if (el.closest(SIGNATURE_SELECTOR)) continue
    if (el.hasAttribute('background')) return 'canvas'
    const style = (el.getAttribute('style') || '').toLowerCase()
    if (/background(-image)?\s*:[^;]*(url\(|gradient\()/.test(style)) return 'canvas'
    const declared = el.getAttribute('bgcolor') || style.match(/background(?:-color)?\s*:\s*([^;!]+)/)?.[1]
    const color = parseCssColor(declared)
    // Any colour that is not the white page: a banner, a button, a dark panel.
    if (color && color.a > 0.5 && luminance(color) <= LIGHT_BACKGROUND_LUMINANCE) return 'canvas'
  }
  return 'adapt'
}

export interface BodyPaint {
  background?: string
  color?: string
}

/** Only a plain colour gets through: nothing that could carry a url() or a second declaration. */
function safeColor(value: string | null | undefined): string | undefined {
  const color = parseCssColor(value)
  if (!color) return undefined
  return color.a < 1 ? `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${color.a})` : `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`
}

/**
 * The page colours the email's own <body> asked for (`bgcolor`, `text`, or its
 * style): what sanitizing drops, since only what is inside the body is kept.
 * Without them a dark-designed email is light text on our white, and a
 * newsletter's grey page is lost.
 */
export function readBodyPaint(rawHtml: string): BodyPaint {
  if (typeof DOMParser === 'undefined' || !/<body[\s>]/i.test(rawHtml)) return {}
  // An inert document: nothing in it loads or runs.
  const body = new DOMParser().parseFromString(rawHtml, 'text/html').body
  const style = (body.getAttribute('style') || '').toLowerCase()
  const background = safeColor(body.getAttribute('bgcolor')) ?? safeColor(style.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/)?.[1])
  const color = safeColor(body.getAttribute('text')) ?? safeColor(style.match(/(?:^|;)\s*color\s*:\s*([^;!]+)/)?.[1])
  return { ...(background ? { background } : {}), ...(color ? { color } : {}) }
}

/**
 * Re-colour a plain email in place, once it is on the page (it reads computed
 * styles): against `pageBackground`, the theme's.
 *
 *  1. A background that is the wrong page (near-white on the dark theme,
 *     near-black on the light one) is dropped, unless something painted sits
 *     behind it. Any other background is kept, and the text on it left alone:
 *     its author chose that pair.
 *  2. Text that doesn't reach `MIN_TEXT_CONTRAST` against the page is moved
 *     until it does (`readableTextColor`).
 *
 * Returns how many elements it changed.
 */
export function adaptEmailColors(root: ParentNode, pageBackground: string): number {
  const page = parseCssColor(pageBackground)
  if (!page) return 0
  const darkPage = luminance(page) < 0.5
  const view = (root as Node).ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null)
  if (!view) return 0

  let changed = 0
  /** Elements that keep a background of their own: the text in them is left as authored. */
  const painted = new Set<Element>()
  const isUnderPaint = (el: Element) => {
    for (let p: Element | null = el; p; p = p.parentElement) if (painted.has(p)) return true
    return false
  }

  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.tagName === 'STYLE' || el.closest('details.quoted-toggle > summary')) continue
    const computed = view.getComputedStyle(el)

    const hasImage = !!computed.backgroundImage && computed.backgroundImage !== 'none'
    const bg = parseCssColor(computed.backgroundColor)
    if (hasImage) {
      painted.add(el)
    } else if (bg && bg.a > 0.5) {
      const lum = luminance(bg)
      const wrongPage = darkPage ? lum > LIGHT_BACKGROUND_LUMINANCE : lum < DARK_BACKGROUND_LUMINANCE
      if (wrongPage && !isUnderPaint(el)) {
        el.style.setProperty('background-color', 'transparent', 'important')
        el.removeAttribute('bgcolor')
        changed++
      } else {
        painted.add(el)
      }
    }

    // Only elements that hold text of their own: the rest inherit.
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim() !== '')
    if (!ownText || isUnderPaint(el)) continue
    const color = parseCssColor(computed.color)
    if (!color) continue
    const readable = readableTextColor(color, page)
    if (readable) {
      el.style.setProperty('color', readable, 'important')
      changed++
    }
  }
  return changed
}
