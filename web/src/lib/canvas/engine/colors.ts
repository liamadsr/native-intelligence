/**
 * Canvas colors. A color is a CSS color or a theme reference ("theme:blue")
 * that has a light and a dark value, so a board drawn in one theme reads in
 * the other. The editor resolves references through CSS variables it sets on
 * its root; exports and agents resolve them to hex here.
 */
import type { CanvasColor } from '../types'

export interface ThemeColor {
  id: string
  label: string
  light: string
  dark: string
}

/** The app palette offered in every color field: ink and paper, then the hues. */
export const THEME_COLORS: readonly ThemeColor[] = [
  { id: 'ink', label: 'Ink', light: '#18181b', dark: '#f4f4f5' },
  { id: 'gray', label: 'Gray', light: '#71717a', dark: '#a1a1aa' },
  { id: 'paper', label: 'Paper', light: '#ffffff', dark: '#27272a' },
  { id: 'red', label: 'Red', light: '#dc2626', dark: '#f87171' },
  { id: 'orange', label: 'Orange', light: '#ea580c', dark: '#fb923c' },
  { id: 'yellow', label: 'Yellow', light: '#ca8a04', dark: '#facc15' },
  { id: 'green', label: 'Green', light: '#16a34a', dark: '#4ade80' },
  { id: 'teal', label: 'Teal', light: '#0d9488', dark: '#2dd4bf' },
  { id: 'blue', label: 'Blue', light: '#2563eb', dark: '#60a5fa' },
  { id: 'violet', label: 'Violet', light: '#7c3aed', dark: '#a78bfa' },
  { id: 'pink', label: 'Pink', light: '#db2777', dark: '#f472b6' },
  // Soft fills: the same hues, pale in light and deep in dark.
  { id: 'red-soft', label: 'Soft red', light: '#fee2e2', dark: '#7f1d1d' },
  { id: 'yellow-soft', label: 'Soft yellow', light: '#fef9c3', dark: '#713f12' },
  { id: 'green-soft', label: 'Soft green', light: '#dcfce7', dark: '#14532d' },
  { id: 'blue-soft', label: 'Soft blue', light: '#dbeafe', dark: '#1e3a8a' },
  { id: 'violet-soft', label: 'Soft violet', light: '#ede9fe', dark: '#4c1d95' },
]

const BY_ID = new Map(THEME_COLORS.map((c) => [c.id, c]))

export const isThemeColor = (color: CanvasColor | undefined): boolean => !!color && color.startsWith('theme:') && BY_ID.has(color.slice(6))
export const themeColorId = (color: CanvasColor): string => color.slice(6)

/** The CSS a color draws with inside the editor (a variable for a theme reference). */
export function cssColor(color: CanvasColor | undefined, fallback = 'transparent'): string {
  if (!color) return fallback
  if (color.startsWith('theme:')) return BY_ID.has(color.slice(6)) ? `var(--cv-${color.slice(6)})` : fallback
  return color
}

/** The hex a color is in one theme. */
export function hexColor(color: CanvasColor | undefined, theme: 'light' | 'dark'): string {
  if (!color) return 'transparent'
  if (color.startsWith('theme:')) return BY_ID.get(color.slice(6))?.[theme] ?? 'transparent'
  return color
}

/** The CSS variables the editor's root carries, for one theme. */
export function themeVars(theme: 'light' | 'dark'): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const c of THEME_COLORS) vars[`--cv-${c.id}`] = c[theme]
  return vars
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** A typed color as '#rrggbb' or '#rrggbbaa', or null when it is not one. */
export function parseHex(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s.startsWith('#')) s = `#${s}`
  if (!HEX.test(s)) return null
  if (s.length === 4 || s.length === 5) s = `#${[...s.slice(1)].map((ch) => ch + ch).join('')}`
  return s
}

/** Split '#rrggbb[aa]' into its color and its opacity (0 to 1). */
export function splitAlpha(hex: string): { rgb: string; alpha: number } {
  const full = parseHex(hex)
  if (!full) return { rgb: '#000000', alpha: 1 }
  return { rgb: full.slice(0, 7), alpha: full.length === 9 ? Math.round((parseInt(full.slice(7), 16) / 255) * 100) / 100 : 1 }
}

export function withAlpha(rgb: string, alpha: number): string {
  const base = (parseHex(rgb) ?? '#000000').slice(0, 7)
  const a = Math.max(0, Math.min(1, alpha))
  return a >= 1 ? base : `${base}${Math.round(a * 255).toString(16).padStart(2, '0')}`
}

/** The custom colors already on a canvas (fills, strokes, text), most used first. */
export function usedColors(items: Iterable<{ style: { fill?: string; stroke?: string }; text?: { color?: string } }>, limit = 12): string[] {
  const count = new Map<string, number>()
  const see = (c: string | undefined) => {
    if (!c || c === 'transparent' || c.startsWith('theme:')) return
    const hex = parseHex(c)
    if (hex) count.set(hex, (count.get(hex) ?? 0) + 1)
  }
  for (const it of items) {
    see(it.style.fill)
    see(it.style.stroke)
    see(it.text?.color)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([c]) => c)
}
