/**
 * ::before and ::after only where a rule gives them something to draw.
 *
 * Four rules in the app's CSS match every element's ::before and ::after:
 * Tailwind's preflight (`*, ::after, ::before, … { box-sizing: border-box;
 * border: 0 solid; margin: 0; padding: 0 }`), the v3 border-colour block and
 * our `border-color: hsl(var(--border))` in src/styles/tailwind.css, and the
 * kept-page pause (`[data-card-parked] *::before`). One such rule is enough
 * for WebKit to resolve a ::before and an ::after style for every element on
 * every style pass, although nearly none has `content` and so none draws
 * (desktop app, 10-19: 37% of style time in
 * Style::TreeResolver::resolvePseudoElement). WebKit stops doing that upstream
 * (bug 323564, 2026-10-02), but the system WKWebView doesn't have it yet.
 *
 * So, after Tailwind, each universal ::before / ::after in such a selector list
 * becomes one selector per element that some rule gives that pseudo-element:
 *
 *   ::before  →  :where(.before\:absolute)::before, :where(q)::before, …
 *
 * Same rule, same declarations, same layer, same place in the sheet, and the
 * same specificity (`:where()` adds none). So every ::before / ::after that a
 * rule styles (the only ones that can have content and draw) computes exactly
 * as before. The rest have no content: no box, nothing drawn. Measured in
 * WKWebView with the app's CSS: computed styles and pixels identical; a
 * whole-window restyle with 3 kept pages 60 → 44 ms, and a 100-reply thread
 * (with the not-prose class selector) 45 → 37 ms.
 *
 * Where the hosts come from:
 * - every other selector in this stylesheet that ends in ::before / ::after,
 *   with CSS nesting resolved (Tailwind keeps it in dev) and @media / @supports
 *   conditions ignored: matching more than needed is harmless;
 * - RUNTIME_HOSTS below: the browser's own sheet, and sheets that libraries
 *   inject at runtime, which never pass through PostCSS.
 *
 * A universal ::before / ::after rule that could give content itself (content,
 * animation, transition) could make any pseudo-element draw, and a ::before /
 * ::after this can't read could hide a host: either way, nothing is changed.
 */

/**
 * Elements whose ::before / ::after are styled by sheets this plugin never
 * sees. They keep the universal defaults too, so their computed style doesn't
 * change either. (Their rules don't depend on them today: no border widths, and
 * no padding with an explicit size.) Matching more than needed is harmless.
 */
const RUNTIME_HOSTS = [
  'q', // the browser's sheet: q::before { content: open-quote }
  '[data-sonner-toast]', // sonner's injected <style>
  '.ProseMirror-gapcursor', // tiptap's injected base styles
  '.metal-fx-root', // metal-fx
  '[data-beam]', // border-beam
  '[data-voice-beam]', // voice-glow
]

/** Declarations through which a ::before / ::after rule can generate a box. */
const MAY_GENERATE = /^(content|animation|animation-name|transition|transition-behavior)$/i

/**
 * Reads one complex selector (no top-level commas): where its subject compound
 * starts, and the ::before / ::after it ends with, if any. `buried` is set when
 * a ::before / ::after sits anywhere but the end (nothing here handles that).
 */
function read(selector) {
  let depth = 0
  let quote = ''
  let subject = 0
  let colon = -1 // start of the last top-level `:` / `::`
  let last = -2 // the last top-level `:` itself
  let buried = false
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === '\\') {
      i++
      continue
    }
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth > 0) continue
    else if (c === ' ' || c === '>' || c === '+' || c === '~' || c === '\n' || c === '\t') subject = i + 1
    else if (c === ':') {
      if (last !== i - 1) {
        if (colon >= 0 && /^::?(before|after)\b/i.test(selector.slice(colon))) buried = true
        colon = i
      }
      last = i
    }
  }
  const tail = colon >= 0 ? /^::?(before|after)$/i.exec(selector.slice(colon)) : null
  if (colon >= 0 && !tail && /^::?(before|after)\b/i.test(selector.slice(colon))) buried = true
  const compound = tail ? selector.slice(subject, colon) : null
  return {
    pseudo: tail ? tail[1].toLowerCase() : null,
    host: tail ? selector.slice(0, colon) : null,
    prefix: selector.slice(0, subject),
    universal: compound === '' || compound === '*',
    buried,
  }
}

/** Replaces every unescaped `&` outside strings. */
function replaceNesting(selector, parent) {
  let out = ''
  let quote = ''
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === '\\') {
      out += c + (selector[i + 1] ?? '')
      i++
    } else if (quote) {
      if (c === quote) quote = ''
      out += c
    } else if (c === '"' || c === "'") {
      quote = c
      out += c
    } else out += c === '&' ? parent : c
  }
  return out
}

/** The closest rule this one is nested in, through any at-rules. */
function parentRule(rule) {
  let parent = rule.parent
  while (parent && parent.type !== 'rule') parent = parent.parent
  return parent
}

/** The rule's selectors with any CSS nesting resolved. */
function resolvedSelectors(rule) {
  const parent = parentRule(rule)
  if (!parent) return rule.selectors
  const outer = resolvedSelectors(parent)
  // A lone compound without a type selector can be written in place of `&`
  // anywhere; anything else goes in as :is(), which is what `&` means.
  const lone = outer.length === 1 && /^[.#[:]/.test(outer[0]) && read(outer[0]).prefix === ''
  const whole = lone ? outer[0] : `:is(${outer.join(', ')})`
  return rule.selectors.map((s) => (/(^|[^\\])&/.test(s) ? replaceNesting(s, whole) : `${whole} ${s}`))
}

/** @type {import('postcss').PluginCreator<void>} */
function beforeAfterHosts() {
  return {
    postcssPlugin: 'ni-before-after-hosts',
    OnceExit(root, { result }) {
      const hosts = { before: new Set(RUNTIME_HOSTS), after: new Set(RUNTIME_HOSTS) }
      /** @type {import('postcss').Rule[]} */
      const universal = []
      let unsafe = ''

      root.walkRules((rule) => {
        if (unsafe || !/:(before|after)/i.test(rule.selector)) return
        let hasUniversal = false
        for (const selector of resolvedSelectors(rule)) {
          const r = read(selector)
          if (r.buried) unsafe = `can't read "${selector}"`
          if (!r.pseudo) continue
          if (!r.universal) {
            hosts[r.pseudo].add(r.host)
            continue
          }
          hasUniversal = true
          rule.walkDecls((d) => {
            if (MAY_GENERATE.test(d.prop)) unsafe = `"${selector}" sets ${d.prop}`
          })
        }
        // A nested one stays as it is (there are none): only its subtree pays.
        if (hasUniversal && !parentRule(rule)) universal.push(rule)
      })
      if (unsafe) {
        result.warn(`${unsafe}: universal ::before/::after rules left as they are`)
        return
      }

      for (const rule of universal) {
        rule.selectors = rule.selectors.flatMap((selector) => {
          const r = read(selector)
          if (!r.pseudo || !r.universal) return [selector]
          return [...hosts[r.pseudo]].map((host) => `${r.prefix}:where(${host})::${r.pseudo}`)
        })
      }
    },
  }
}
beforeAfterHosts.postcss = true

module.exports = beforeAfterHosts
