// @vitest-environment jsdom
/**
 * Liam, 11-11: "you can still see the main chat input even when you have a
 * panel open". Beside the rail, with a card in front (<html> data-card-front,
 * front-card.ts), the chat stops painting but its composer dock: the rules in
 * tailwind.css, read from the file and applied to the shell's DOM as
 * dashboard-shell.tsx and chat-panel.tsx draw it. What paints: no element on
 * its path carries `opacity: 0`, and its nearest `visibility` rule (self or
 * ancestor, inherited) is `visible`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Rule {
  selectors: string[]
  visibility: 'hidden' | 'visible' | null
  opacityZero: boolean
}

let rules: Rule[] = []

beforeAll(() => {
  const css = readFileSync(resolve(__dirname, '../../../../../styles/tailwind.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectorText = m[1].trim()
    if (!selectorText.includes('[data-card-front]')) continue
    const body = m[2]
    const vis = body.match(/visibility:\s*(hidden|visible)/)
    rules.push({
      selectors: selectorText.split(',').map((s) => s.trim()).filter(Boolean),
      visibility: vis ? (vis[1] as 'hidden' | 'visible') : null,
      opacityZero: /opacity:\s*0\s*;/.test(body),
    })
  }
})

afterEach(() => {
  document.documentElement.removeAttribute('data-app-rail')
  document.documentElement.removeAttribute('data-card-front')
  document.body.innerHTML = ''
})

function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const attrs = (selector.match(/\[[^\]]+\]|:(?!not\b|is\b)[\w-]+|\.[\w-]+/g) ?? []).length
  const types = (selector.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length
  return [ids, attrs, types]
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The `visibility` set on this element itself by the rules (the most specific, last wins), or null. */
function ownVisibility(el: Element): 'hidden' | 'visible' | null {
  let best: { spec: [number, number, number]; value: 'hidden' | 'visible' } | null = null
  for (const rule of rules) {
    if (!rule.visibility) continue
    for (const sel of rule.selectors) {
      if (!el.matches(sel)) continue
      const spec = specificity(sel)
      if (!best || cmp(spec, best.spec) >= 0) best = { spec, value: rule.visibility }
    }
  }
  return best?.value ?? null
}

function paints(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (rules.some((r) => r.opacityZero && r.selectors.some((s) => node!.matches(s)))) return false
  }
  for (let node: Element | null = el; node; node = node.parentElement) {
    const v = ownVisibility(node)
    if (v) return v === 'visible'
  }
  return true
}

/** The row as dashboard-shell.tsx draws it, the main chat as chat-panel.tsx and live-capture-dock.tsx do. */
function shell(): Record<string, Element> {
  document.body.innerHTML = `
    <div data-shell-top-bar=""></div>
    <div data-windows-row="">
      <div id="ni-chat-strip-slot">
        <div><div>
          <div data-live-capture-dock-row="off">
            <div data-live-capture-chat-area="">
              <div>
                <div class="panel">
                  <div data-chat-thread-stage="">
                    <div data-main-chat-thread=""><p class="message">Hi</p></div>
                  </div>
                  <div data-chat-composer-dock="">
                    <div data-fading-blur="up"></div>
                    <div data-chat-composer=""><div class="chat-reading-col"><textarea></textarea></div></div>
                  </div>
                </div>
              </div>
            </div>
            <aside data-live-capture-dock="cap-1" class="visible"></aside>
          </div>
        </div></div>
      </div>
      <div data-fading-blur="down"></div>
      <aside data-page-panel=""><p class="recent">Recent</p></aside>
      <aside id="ni-side-panel"></aside>
    </div>`
  const q = (s: string) => document.querySelector(s)!
  return {
    topBar: q('[data-shell-top-bar]'),
    message: q('.message'),
    stage: q('[data-chat-thread-stage]'),
    dock: q('[data-chat-composer-dock]'),
    textarea: q('textarea'),
    dockBlur: q('[data-chat-composer-dock] > [data-fading-blur]'),
    captureDock: q('[data-live-capture-dock]'),
    rowBlur: q('[data-windows-row] > [data-fading-blur]'),
    recent: q('.recent'),
    sidePanel: q('#ni-side-panel'),
  }
}

describe('the composer under a front card (tailwind.css)', () => {
  it('reads the rules', () => {
    expect(rules.some((r) => r.selectors.includes('html[data-app-rail][data-card-front] #ni-chat-strip-slot [data-chat-composer-dock]') && r.visibility === 'visible')).toBe(true)
  })

  it('with a card in front beside the rail: the composer paints, the thread, the top bar and the right panel do not, the Recent panel does', () => {
    const el = shell()
    document.documentElement.setAttribute('data-app-rail', '')
    document.documentElement.setAttribute('data-card-front', '')
    expect(paints(el.textarea)).toBe(true)
    expect(paints(el.dock)).toBe(true)
    expect(paints(el.recent)).toBe(true)
    expect(paints(el.message)).toBe(false)
    expect(paints(el.stage)).toBe(false)
    expect(paints(el.topBar)).toBe(false)
    expect(paints(el.sidePanel)).toBe(false)
    // Both frosted strips stay, so the blur never goes and comes back (Liam, 11-11).
    expect(paints(el.rowBlur)).toBe(true)
    expect(paints(el.dockBlur)).toBe(true)
    // The live capture's notepad, though it says `visible` of itself.
    expect(paints(el.captureDock)).toBe(false)
  })

  it('with no card in front, everything paints', () => {
    const el = shell()
    document.documentElement.setAttribute('data-app-rail', '')
    for (const key of Object.keys(el)) expect(paints(el[key]), key).toBe(true)
  })
})
