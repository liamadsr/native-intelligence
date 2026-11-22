/**
 * Number and date formats: the ones the toolbar offers, by the name a person
 * sees, as the Excel format codes the engine draws them with. Pure.
 */

export type NumberFormatId = 'automatic' | 'number' | 'currency' | 'accounting' | 'percent' | 'scientific' | 'date' | 'time' | 'text'

export interface NumberFormat {
  id: NumberFormatId
  label: string
  code: string
  /** What 1234.5 (or, for dates and times, 9 March 2026 at 2:30 PM) looks like in it. */
  example: string
}

export const GENERAL = 'general'
export const PLAIN_TEXT = '@'
export const DEFAULT_DATE = 'mm/dd/yyyy'
export const DEFAULT_TIME = 'h:mm AM/PM'

export const NUMBER_FORMATS: readonly NumberFormat[] = [
  { id: 'automatic', label: 'Automatic', code: GENERAL, example: '1234.5' },
  { id: 'number', label: 'Number', code: '#,##0.00', example: '1,234.50' },
  { id: 'currency', label: 'Currency', code: '"$"#,##0.00', example: '$1,234.50' },
  { id: 'accounting', label: 'Accounting', code: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)', example: '$ 1,234.50' },
  { id: 'percent', label: 'Percent', code: '0.00%', example: '12.50%' },
  { id: 'scientific', label: 'Scientific', code: '0.00E+00', example: '1.23E+03' },
  { id: 'date', label: 'Date', code: DEFAULT_DATE, example: '03/09/2026' },
  { id: 'time', label: 'Time', code: DEFAULT_TIME, example: '2:30 PM' },
  { id: 'text', label: 'Plain text', code: PLAIN_TEXT, example: '1234.5' },
]

export interface DateFormat {
  code: string
  example: string
}

/** The date formats on offer, each with 9 March 2026 written in it. */
export const DATE_FORMATS: readonly DateFormat[] = [
  { code: 'mmm yyyy', example: 'Mar 2026' },
  { code: 'mmm dd, yyyy', example: 'Mar 09, 2026' },
  { code: 'mm/dd/yyyy', example: '03/09/2026' },
  { code: 'dd/mm/yyyy', example: '09/03/2026' },
  { code: 'yyyy-mm-dd', example: '2026-03-09' },
  { code: 'd mmm yyyy', example: '9 Mar 2026' },
  { code: 'dddd, mmmm d, yyyy', example: 'Monday, March 9, 2026' },
]

/** The parts of a code outside quotes and brackets, where the letters mean something. */
function bare(code: string): string {
  return code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
}

export function isDateFormat(code: string): boolean {
  const c = bare(code).toLowerCase()
  if (c === GENERAL || c === PLAIN_TEXT) return false
  return /[ymd]/.test(c) || /h|s|am\/pm/.test(c)
}

/** Which of the toolbar's formats a cell's code is: the one the menu ticks. */
export function formatKind(code: string): NumberFormatId | 'custom' {
  const c = code.trim()
  if (!c || c.toLowerCase() === GENERAL) return 'automatic'
  if (c === PLAIN_TEXT) return 'text'
  const b = bare(c).toLowerCase()
  if (isDateFormat(c)) return /[yd]/.test(b) || /m/.test(b.replace(/h+:m+|m+:s+/g, '')) ? 'date' : 'time'
  if (b.includes('e+') || b.includes('e-')) return 'scientific'
  if (b.includes('%')) return 'percent'
  if (c.includes('_(') || c.includes('* ')) return 'accounting'
  if (/[$€£¥]/.test(c)) return 'currency'
  if (/[0#]/.test(b)) return 'number'
  return 'custom'
}

/** How many decimal places a code shows (its first section). */
export function decimalsOf(code: string): number {
  const section = code.split(';')[0]
  const m = /\.([0#?]+)/.exec(bare(section))
  return m ? m[1].length : 0
}

/**
 * The same format with more or fewer decimal places, in every section of
 * it. `general` becomes a plain number with that many places. Dates and
 * text are left as they are. Thirty places at most, as in Excel.
 */
export function changeDecimals(code: string, delta: number, shown?: string): string {
  const c = code.trim()
  if (c === PLAIN_TEXT || isDateFormat(c)) return code
  if (!c || c.toLowerCase() === GENERAL) {
    // Start from the places the value is showing, so the first press changes what is seen.
    const now = shown && /^-?[\d,]*\.(\d+)$/.exec(shown.trim()) ? (/\.(\d+)$/.exec(shown.trim()) as RegExpExecArray)[1].length : 0
    const places = Math.max(0, Math.min(30, now + delta))
    return places ? `0.${'0'.repeat(places)}` : '0'
  }
  const places = Math.max(0, Math.min(30, decimalsOf(c) + delta))
  let out = ''
  let i = 0
  // Walk the code, leaving quoted text and bracketed parts alone.
  while (i < c.length) {
    const ch = c[i]
    if (ch === '"') {
      const end = c.indexOf('"', i + 1)
      const stop = end < 0 ? c.length : end + 1
      out += c.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '[') {
      const end = c.indexOf(']', i + 1)
      const stop = end < 0 ? c.length : end + 1
      out += c.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '0' || ch === '#') {
      // A run of digit places, with its decimal part when it has one.
      let j = i
      while (j < c.length && /[0#,?]/.test(c[j])) j += 1
      let k = j
      if (c[k] === '.') {
        k += 1
        while (k < c.length && /[0#?]/.test(c[k])) k += 1
      }
      out += c.slice(i, j) + (places ? `.${'0'.repeat(places)}` : '')
      i = k
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Font sizes the size box steps through, in points. */
export const FONT_SIZES: readonly number[] = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72]
export const MIN_FONT_SIZE = 6
export const MAX_FONT_SIZE = 96

export function clampFontSize(size: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size)))
}

/** Fonts the family menu offers: faces every reader's machine has, so two people see the same sheet. */
export const FONT_FAMILIES: readonly { name: string; label: string }[] = [
  { name: 'Inter', label: 'Default' },
  { name: 'Arial', label: 'Arial' },
  { name: 'Helvetica', label: 'Helvetica' },
  { name: 'Georgia', label: 'Georgia' },
  { name: 'Times New Roman', label: 'Times New Roman' },
  { name: 'Courier New', label: 'Courier New' },
  { name: 'Verdana', label: 'Verdana' },
  { name: 'Trebuchet MS', label: 'Trebuchet MS' },
]

export interface NamedColor {
  name: string
  hex: string
}

/** The text and fill palette: ten hues in a strong and a soft shade, and five grays. */
export const PALETTE: readonly NamedColor[] = [
  { name: 'Black', hex: '#000000' },
  { name: 'Dark gray', hex: '#434343' },
  { name: 'Gray', hex: '#808080' },
  { name: 'Light gray', hex: '#D9D9D9' },
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Red', hex: '#D92D20' },
  { name: 'Orange', hex: '#E8710A' },
  { name: 'Amber', hex: '#F2B705' },
  { name: 'Green', hex: '#1E8E3E' },
  { name: 'Teal', hex: '#0E9384' },
  { name: 'Blue', hex: '#1A73E8' },
  { name: 'Indigo', hex: '#4F46E5' },
  { name: 'Purple', hex: '#9334E6' },
  { name: 'Pink', hex: '#D6336C' },
  { name: 'Brown', hex: '#8D5A2B' },
  { name: 'Soft red', hex: '#FDE2DF' },
  { name: 'Soft orange', hex: '#FCE8D5' },
  { name: 'Soft amber', hex: '#FEF3C7' },
  { name: 'Soft green', hex: '#DDF3E1' },
  { name: 'Soft teal', hex: '#D5F2EE' },
  { name: 'Soft blue', hex: '#DCEBFD' },
  { name: 'Soft indigo', hex: '#E4E3FB' },
  { name: 'Soft purple', hex: '#F0E1FB' },
  { name: 'Soft pink', hex: '#FBE0EA' },
  { name: 'Soft brown', hex: '#EFE3D6' },
]
