/**
 * Writing a kit's or a brief's values into the ads' pages, each escaped for where it goes: HTML text, an attribute,
 * a CSS string or url(), a JavaScript string inside a <script>. The contract already holds every such value to a
 * grammar (ads-contract.ts); these are checked again here (a job's input is not only ever the app's), and escaped
 * all the same.
 */
import { FONT_FAMILY, isPaint } from '../engine.ts'

/** Text or an attribute's value in HTML: & < > " ' as entities. Pure. */
export const html = (s: string) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
export const attr = html

/**
 * A CSS string literal in single quotes: everything but letters (any script), digits, space, - and _ written as a CSS
 * hex escape, so no quote, backslash, newline or `<` survives (safe in a <style> element and, through attr(), in a
 * style attribute). Pure.
 */
export function cssString(s: string): string {
  return `'${Array.from(String(s), (c) => (/[\p{L}\p{N} _-]/u.test(c) ? c : `\\${c.codePointAt(0)!.toString(16)} `)).join('')}'`
}

/** A url() for CSS, its address as an escaped CSS string. Pure. */
export const cssUrl = (url: string) => `url(${cssString(url)})`

/** A JavaScript string literal for inside a <script>: JSON, with < > & and the line separators escaped. Pure. */
export function jsString(s: string): string {
  return JSON.stringify(String(s)).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** A font family, refused unless it is letters, digits, space, - and _ (the contract's grammar). */
export function family(name: string): string {
  if (typeof name !== 'string' || !FONT_FAMILY.test(name)) throw new Error(`"${String(name).slice(0, 40)}" is not a font family name the ads can use (letters, numbers, spaces, - and _)`)
  return name
}

/** A veil or a shade, refused unless it is a preset name or a plain CSS colour or gradient (the contract's grammar). */
export function paint(value: string): string {
  if (!isPaint(value)) throw new Error(`"${String(value).slice(0, 60)}" is not a veil the ads can draw (a preset name, or a CSS colour or gradient)`)
  return value
}
