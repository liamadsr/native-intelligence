// @vitest-environment jsdom
/**
 * How an email is made readable on the theme: which emails keep their own
 * page ("canvas"), which take the theme's ("adapt"), and what re-colouring
 * does to a plain one. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import {
  adaptEmailColors,
  contrastRatio,
  emailCanvasMode,
  luminance,
  MIN_TEXT_CONTRAST,
  parseCssColor,
  readableTextColor,
  readBodyPaint,
} from '../email-colors'
import { prepareEmailForDisplay, sanitizeEmailCss, sanitizeEmailHtml } from '../email-sanitize'

const DARK = '#1a1a1a'
const LIGHT = '#ffffff'
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const rgb = (value: string) => parseCssColor(value)!

describe('parseCssColor', () => {
  it('reads hex, rgb(), rgba() and names', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseCssColor('#1A2b3C')).toEqual({ r: 26, g: 43, b: 60, a: 1 })
    expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseCssColor('rgba(10,20,30,0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseCssColor('White')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseCssColor('transparent')?.a).toBe(0)
  })

  it('returns null for what is not a plain colour', () => {
    for (const v of ['', 'inherit', 'url(https://example.com/x.png)', 'linear-gradient(red, blue)', 'var(--x)', 'red; background: url(x)']) {
      expect(parseCssColor(v)).toBeNull()
    }
  })
})

describe('readableTextColor', () => {
  it('leaves a colour that already reads', () => {
    expect(readableTextColor(rgb('#e5e5e5'), rgb(DARK))).toBeNull()
    expect(readableTextColor(rgb('#222222'), rgb(LIGHT))).toBeNull()
  })

  it('moves dark grey text to a light grey on a dark page', () => {
    const out = readableTextColor(rgb('#555555'), rgb(DARK))!
    expect(contrastRatio(rgb(out), rgb(DARK))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    expect(luminance(rgb(out))).toBeGreaterThan(0.3)
  })

  it('keeps the hue of a coloured text it lightens', () => {
    const out = rgb(readableTextColor(rgb('#00338d'), rgb(DARK))!)
    expect(out.b).toBeGreaterThan(out.r)
    expect(contrastRatio(out, rgb(DARK))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })

  it('darkens white text on a white page', () => {
    const out = readableTextColor(rgb('#ffffff'), rgb(LIGHT))!
    expect(contrastRatio(rgb(out), rgb(LIGHT))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })

  it('always ends up readable, whatever the colour', () => {
    for (const hex of ['#000000', '#7f7f7f', '#ff0000', '#00ff00', '#0000ff', '#3a2f1b', '#101010', '#fafafa']) {
      for (const page of [DARK, LIGHT]) {
        const out = readableTextColor(rgb(hex), rgb(page))
        if (out) expect(contrastRatio(rgb(out), rgb(page))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
      }
    }
  })
})

describe('emailCanvasMode', () => {
  it('adapts a plain typed email', () => {
    expect(emailCanvasMode(doc('<div dir="ltr">Hi Sam,<br><br>Can we move Thursday?</div>'))).toBe('adapt')
  })

  it('adapts a plain email that only sets a text colour or a white background', () => {
    expect(emailCanvasMode(doc('<div style="color:#333;background-color:#ffffff"><p>Thanks!</p></div>'))).toBe('adapt')
  })

  it('adapts an email whose stylesheet only sets fonts (what Outlook adds to every message)', () => {
    expect(emailCanvasMode(doc('<style>p.MsoNormal{margin:0;font-family:Calibri}</style><p class="MsoNormal">Hello</p>'))).toBe('adapt')
  })

  it('keeps a table-built newsletter on its own canvas', () => {
    expect(emailCanvasMode(doc('<table width="600"><tr><td>The Weekly Digest</td></tr></table>'))).toBe('canvas')
  })

  it('does not count a table inside a signature', () => {
    expect(emailCanvasMode(doc('<p>Thanks</p><div class="gmail_signature"><table><tr><td>Sam Rivera</td></tr></table></div>'))).toBe('adapt')
  })

  it('keeps an email with a painted background on its canvas', () => {
    expect(emailCanvasMode(doc('<div style="background-color:#0b3d91;color:#fff">Sale</div>'))).toBe('canvas')
    expect(emailCanvasMode(doc('<div style="background:url(https://example.com/hero.png)">Hi</div>'))).toBe('canvas')
    expect(emailCanvasMode(doc('<div bgcolor="#222222">Hi</div>'))).toBe('canvas')
    expect(emailCanvasMode(doc('<style>.card{background:#f4f4f4}</style><div class="card">Hi</div>'))).toBe('canvas')
  })
})

describe('readBodyPaint', () => {
  it('reads the body colours sanitizing drops', () => {
    expect(readBodyPaint('<html><body bgcolor="#111111" text="#eeeeee"><p>Hi</p></body></html>')).toEqual({
      background: 'rgb(17, 17, 17)',
      color: 'rgb(238, 238, 238)',
    })
    expect(readBodyPaint('<body style="margin:0;background-color:#f6f6f6;color:#444"><p>Hi</p></body>')).toEqual({
      background: 'rgb(246, 246, 246)',
      color: 'rgb(68, 68, 68)',
    })
  })

  it('gives nothing for a fragment, or for a value that is not a plain colour', () => {
    expect(readBodyPaint('<p>Hi</p>')).toEqual({})
    expect(readBodyPaint('<body style="background:url(https://example.com/t.gif)">x</body>')).toEqual({})
    expect(readBodyPaint('<body bgcolor="red;background:url(https://example.com/t.gif)">x</body>')).toEqual({})
  })
})

describe('adaptEmailColors', () => {
  function mount(html: string) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host
  }

  it('lightens dark text on the dark theme and leaves readable text alone', () => {
    const host = mount('<p id="a" style="color:#333333">Dark grey</p><p id="b" style="color:#eeeeee">Light</p>')
    adaptEmailColors(host, DARK)
    const a = host.querySelector<HTMLElement>('#a')!
    expect(contrastRatio(rgb(a.style.color), rgb(DARK))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    expect(a.style.getPropertyPriority('color')).toBe('important')
    expect(host.querySelector<HTMLElement>('#b')!.style.color).toBe('rgb(238, 238, 238)')
    host.remove()
  })

  it('drops a white background on the dark theme', () => {
    const host = mount('<div id="w" style="background-color:#ffffff;color:#222222">On white</div>')
    adaptEmailColors(host, DARK)
    const w = host.querySelector<HTMLElement>('#w')!
    expect(w.style.backgroundColor).toBe('transparent')
    expect(contrastRatio(rgb(w.style.color), rgb(DARK))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    host.remove()
  })

  it('keeps a coloured background and the text its author put on it', () => {
    const host = mount('<span id="btn" style="background-color:#0b57d0;color:#111111">Open</span>')
    adaptEmailColors(host, DARK)
    const btn = host.querySelector<HTMLElement>('#btn')!
    expect(btn.style.backgroundColor).toBe('rgb(11, 87, 208)')
    expect(btn.style.color).toBe('rgb(17, 17, 17)')
    host.remove()
  })

  it('keeps a white chip that sits on a coloured panel', () => {
    const host = mount('<div style="background-color:#0b57d0"><span id="chip" style="background-color:#ffffff;color:#111111">New</span></div>')
    adaptEmailColors(host, DARK)
    expect(host.querySelector<HTMLElement>('#chip')!.style.backgroundColor).toBe('rgb(255, 255, 255)')
    host.remove()
  })

  it('changes nothing in an email that already reads', () => {
    const host = mount('<p>No colours of its own</p><p style="color:#1a1a1a">Near black</p>')
    expect(adaptEmailColors(host, LIGHT)).toBe(0)
    host.remove()
  })
})

describe('prepareEmailForDisplay', () => {
  it('draws a newsletter with its own page colour as authored, on that page', () => {
    const out = prepareEmailForDisplay(
      '<html><body style="background-color:#f4f4f4;color:#555555"><table><tr><td style="color:#666666">Digest</td></tr></table></body></html>',
      true,
    )
    expect(out.mode).toBe('canvas')
    expect(out.pageBackground).toBe('rgb(244, 244, 244)')
    expect(out.html).toContain('background-color: rgb(244, 244, 244)')
    expect(out.html).toContain('color-scheme: light')
    // As authored: its grey is left alone.
    expect(out.html).toContain('color:#666666')
  })

  it('draws a table-built email with no page colour on white, in dark mode', () => {
    const out = prepareEmailForDisplay('<table><tr><td style="color:#333">Receipt</td></tr></table>', true)
    expect(out.mode).toBe('canvas')
    expect(out.pageBackground).toBe('#ffffff')
  })

  it('puts a plain email on the theme', () => {
    expect(prepareEmailForDisplay('<div>Hi Sam</div>', true)).toMatchObject({ mode: 'adapt', pageBackground: '#1a1a1a' })
    expect(prepareEmailForDisplay('<div>Hi Sam</div>', false)).toMatchObject({ mode: 'adapt', pageBackground: '#ffffff' })
  })

  it('keeps a dark-designed email dark on the light theme', () => {
    const out = prepareEmailForDisplay('<body bgcolor="#101010" text="#f0f0f0"><p>Night edition</p></body>', false)
    expect(out.mode).toBe('canvas')
    expect(out.html).toContain('color-scheme: dark')
    expect(out.html).toContain('color: rgb(240, 240, 240)')
  })
})

describe('sanitizeEmailCss', () => {
  it('drops @import', () => {
    expect(sanitizeEmailCss('@import url("https://example.com/t.css");p{color:red}')).toBe('p{color:red}')
    expect(sanitizeEmailCss("@import 'https://example.com/t.css' screen;\np{}")).not.toContain('@import')
  })

  it('drops rules aimed at the shadow host', () => {
    const out = sanitizeEmailCss('p{color:red}:host{display:none}a{color:blue}:host(.x) b{color:red}')
    expect(out).not.toContain(':host')
    expect(out).toContain('p{color:red}')
    expect(out).toContain('a{color:blue}')
  })

  it('unpins fixed and sticky positioning', () => {
    expect(sanitizeEmailCss('div{position:fixed;top:0}')).toBe('div{position: static;top:0}')
    expect(sanitizeEmailCss('position: STICKY')).toBe('position: static')
  })

  it('drops the old script hooks', () => {
    expect(sanitizeEmailCss('a{behavior:url(x.htc);color:red}')).toBe('a{;color:red}')
    expect(sanitizeEmailCss('a{width:expression(alert(1))}')).not.toContain('expression')
  })

  it('leaves ordinary CSS as written', () => {
    const css = '.x{color:red;background:url(https://example.com/a.png)}@media (max-width:600px){.x{width:100%}}'
    expect(sanitizeEmailCss(css)).toBe(css)
  })
})

describe('sanitizeEmailHtml', () => {
  it('applies the CSS rules to style blocks and to style attributes', () => {
    const out = sanitizeEmailHtml(
      '<style>@import url(https://example.com/t.css);.a{position:fixed}</style><div class="a" style="position:fixed;inset:0;color:red">x</div>',
    )
    expect(out).not.toContain('@import')
    expect(out).not.toMatch(/position:\s*fixed/)
    expect(out).toContain('color:red')
  })

  it('still removes scripts, handlers, forms, iframes and javascript: links', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="x()">a</p><script>alert(1)</script><iframe src="https://example.com"></iframe><form action="https://example.com"><input name="q"></form><a href="javascript:alert(1)">l</a><img src="x" onerror="alert(1)">',
    )
    for (const bad of ['<script', 'onclick', 'onerror', '<iframe', '<form', '<input', 'javascript:']) expect(out).not.toContain(bad)
  })
})
