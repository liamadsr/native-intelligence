/**
 * The typography plugin's escape hatch, as a class selector.
 *
 * fumadocs-ui's typography plugin (@fumadocs/tailwind, loaded by its preset in
 * src/styles/tailwind.css) wraps every `.prose` rule as
 *
 *   .prose :where(p):not(:where([class~="not-prose"],[class~="not-prose"] *))
 *
 * so styling any p, li, a, strong, code… under `.prose` (every chat reply,
 * every notes editor) checks each of the element's ancestors for the word
 * `not-prose`. WebKit matches `[class~=…]` as an attribute: a substring search
 * through each ancestor's whole Tailwind class string, all the way up a
 * ~60-deep tree. In the desktop app that search was a third of every style
 * pass after a long session (10-19 samples: WTF::findCommon).
 *
 * `.not-prose` matches exactly the same elements (an HTML class is the
 * `class` attribute's whitespace-separated words) and, inside :where(), with
 * the same zero specificity, but WebKit checks it against each element's
 * parsed class list instead of the raw string. Measured in WKWebView with the
 * app's CSS: restyling a thread of 100 replies 78.6 → 39.8 ms.
 */
const NOT_PROSE = /\[class~=(["']?)not-prose\1\]/g

/** @type {import('postcss').PluginCreator<void>} */
function notProseClass() {
  return {
    postcssPlugin: 'ni-not-prose-class',
    Rule(rule) {
      if (rule.selector.includes('not-prose')) rule.selector = rule.selector.replace(NOT_PROSE, '.not-prose')
    },
  }
}
notProseClass.postcss = true

module.exports = notProseClass
