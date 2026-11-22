/**
 * Import an .xlsx (ECMA-376 SpreadsheetML) into a new workbook, read by hand
 * from the public file format over a zip container (jszip, MIT). Isomorphic,
 * so the editor reads a dropped file in the browser and the route reads an
 * uploaded one on the server through this one function. The engine must be
 * initialised by the caller first (the route calls ensureEngine; the editor
 * loads the binary); this only builds a Model.
 *
 * What it carries over: shared and inline strings (rich-text runs flattened),
 * numbers, booleans, errors, formulas (shared formulas expanded cell by cell,
 * array formulas entered as their formula), number formats (built-in and
 * custom), fonts, fills, borders, alignment and wrap, column widths and row
 * heights, hidden rows, columns and sheets, merges, frozen panes, tab colors,
 * the 1904 date system (serials shifted), theme colors where they resolve, and
 * defined names.
 *
 * What it cannot carry becomes a warning in plain words, never a failure:
 * charts, images, pivot tables, conditional formatting, data validation,
 * comments, tables (their structured references show #NAME?), links to other
 * workbooks and macros. Only the parts looked up by name are read, so a crafted
 * path cannot escape the archive; the file, and the archive it expands to, are
 * capped, and anything that is not an .xlsx is refused with a sentence.
 */
import { Model, hexWithTintToRgb, type CellStyle } from '@ironcalc/wasm'
import JSZip from 'jszip'
import { MAX_COLUMNS, MAX_ROWS, MAX_SHEETS, sheetNameProblem } from './a1'
import { saveWorkbook } from './workbook'
import {
  DATE_1904_OFFSET,
  MAX_PART_BYTES,
  MAX_XLSX_BYTES,
  MAX_XLSX_EXPANDED,
  XlsxError,
  childText,
  excelCharsToPx,
  isDateFormat,
  parseA1,
  parseAttrs,
  pointsToPx,
  rgbToHex,
} from './xlsx-shared'

export interface XlsxImport {
  /** The new workbook as base64 (saveWorkbook), ready for the store. */
  workbook: string
  sheetNames: string[]
  warnings: string[]
}

/** The built-in number formats an .xlsx may reference by id without defining. */
const BUILTIN_NUM_FMTS: Record<number, string> = {
  0: 'general', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
}

interface Xf {
  numFmt: string
  font: { b: boolean; i: boolean; u: boolean; strike: boolean; sz: number | null; name: string | null; color: string | null }
  fill: string | null
  border: { top?: BorderEdge; right?: BorderEdge; bottom?: BorderEdge; left?: BorderEdge }
  horizontal: string | null
  vertical: string | null
  wrap: boolean
  quotePrefix: boolean
}
interface BorderEdge {
  style: string
  color: string | null
}

interface SheetMeta {
  name: string
  rid: string | null
  hidden: boolean
}

export async function xlsxToWorkbook(bytes: Uint8Array): Promise<XlsxImport> {
  if (bytes.byteLength > MAX_XLSX_BYTES) {
    throw new XlsxError('This file is larger than 50 MB. Export a smaller workbook, or split it across files.')
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new XlsxError('This is not a spreadsheet this app can open. Save it as .xlsx or .csv and try again.')
  }

  // A zip bomb check: the parts must not expand past the ceiling.
  let expanded = 0
  for (const file of Object.values(zip.files)) {
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (typeof size === 'number') expanded += size
  }
  if (expanded > MAX_XLSX_EXPANDED) {
    throw new XlsxError('This workbook expands to more than the import can hold. Export a smaller one and try again.')
  }

  const read = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    if (!file) return null
    const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (typeof declared === 'number' && declared > MAX_PART_BYTES) throw new XlsxError('This workbook is too large to read.')
    const text = await file.async('string')
    if (text.length > MAX_PART_BYTES) throw new XlsxError('This workbook is too large to read.')
    return text
  }

  const workbookXml = await read('xl/workbook.xml')
  if (!workbookXml) throw new XlsxError('This is not a spreadsheet this app can open. Save it as .xlsx or .csv and try again.')

  const warnings: string[] = []
  warnFromParts(zip, warnings)

  const rels = parseRels((await read('xl/_rels/workbook.xml.rels')) ?? '')
  const date1904 = /\bdate1904\s*=\s*"(1|true|on)"/i.test(workbookXml)

  let sheetMetas = parseWorkbookSheets(workbookXml)
  if (sheetMetas.length > MAX_SHEETS) {
    warnings.push(`This workbook has more than ${MAX_SHEETS} sheets; the rest were left out.`)
    sheetMetas = sheetMetas.slice(0, MAX_SHEETS)
  }
  if (!sheetMetas.length) sheetMetas = [{ name: 'Sheet1', rid: null, hidden: false }]

  const shared = parseSharedStrings((await read('xl/sharedStrings.xml')) ?? '')
  const theme = parseTheme((await read('xl/theme/theme1.xml')) ?? '')
  const { xfs } = parseStyles((await read('xl/styles.xml')) ?? '', theme)

  const model = new Model('Workbook', 'en', 'UTC', 'en')
  model.pauseEvaluation()

  // Make the right number of sheets and name them.
  const names: string[] = []
  sheetMetas.forEach((meta, i) => {
    if (i > 0) model.newSheet()
    const taken = names.slice()
    let name = meta.name
    if (sheetNameProblem(name, taken)) name = uniqueName(name || `Sheet${i + 1}`, taken)
    try {
      model.renameSheet(i, name)
    } catch {
      name = uniqueName(`Sheet${i + 1}`, taken)
      try {
        model.renameSheet(i, name)
      } catch {
        name = sheetMetas[i].name
      }
    }
    names.push(name)
  })

  const base = model.getCellStyle(0, 1, 1).style
  let warnedRows = false
  let warnedCols = false
  let warnedTables = false
  const limits = {
    rows: () => {
      if (!warnedRows) warnings.push(`Some rows past ${MAX_ROWS.toLocaleString('en-US')} were left out.`)
      warnedRows = true
    },
    cols: () => {
      if (!warnedCols) warnings.push(`Some columns past ${MAX_COLUMNS.toLocaleString('en-US')} were left out.`)
      warnedCols = true
    },
    tables: () => {
      if (!warnedTables) warnings.push('A formula uses a table reference (Table[Column]); those are not supported and show #NAME?.')
      warnedTables = true
    },
  }

  let warnedCf = false
  let warnedDv = false
  for (let i = 0; i < sheetMetas.length; i++) {
    const meta = sheetMetas[i]
    const target = meta.rid ? rels.get(meta.rid) : null
    const path = sheetPartPath(target, i)
    const xml = path ? await read(path) : null
    if (!xml) continue
    if (!warnedCf && /<conditionalFormatting\b/.test(xml)) {
      warnings.push('Conditional formatting was left out.')
      warnedCf = true
    }
    if (!warnedDv && /<dataValidation\b/.test(xml)) {
      warnings.push('Data validation rules were left out.')
      warnedDv = true
    }
    parseSheet(model, i, xml, { shared, xfs, base, date1904, limits, theme })
  }

  // Hidden sheets, tab colors and defined names after the cells.
  sheetMetas.forEach((meta, i) => {
    if (meta.hidden && sheetMetas.some((m, j) => j !== i && !m.hidden)) {
      try {
        model.hideSheet(i)
      } catch {
        /* a workbook keeps one sheet visible */
      }
    }
  })
  applyDefinedNames(model, workbookXml, warnings)

  model.resumeEvaluation()
  model.evaluate()
  const workbook = saveWorkbook(model)
  const sheetNames = model.getWorksheetsProperties().map((p) => p.name)
  model.free()
  return { workbook, sheetNames, warnings: [...new Set(warnings)] }
}

// ── Package navigation ───────────────────────────────────────────────────---

function parseRels(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = parseAttrs(m[1])
    if (attrs.Id && attrs.Target) map.set(attrs.Id, attrs.Target)
  }
  return map
}

/** The worksheet part for a relationship target, kept inside xl/ (no path tricks). */
function sheetPartPath(target: string | null | undefined, index: number): string {
  if (!target) return `xl/worksheets/sheet${index + 1}.xml`
  let path = target.replace(/^\.\//, '')
  if (path.startsWith('/')) path = path.slice(1)
  else path = `xl/${path}`
  // Normalise and refuse anything that climbs out of the package.
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '..' || seg === '.' || seg === '') continue
    parts.push(seg)
  }
  const safe = parts.join('/')
  return safe.startsWith('xl/') ? safe : `xl/worksheets/sheet${index + 1}.xml`
}

function parseWorkbookSheets(xml: string): SheetMeta[] {
  const block = /<sheets>([\s\S]*?)<\/sheets>/.exec(xml)?.[1] ?? ''
  const out: SheetMeta[] = []
  for (const m of block.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = parseAttrs(m[1])
    out.push({ name: a.name ?? '', rid: a['r:id'] ?? a.id ?? null, hidden: a.state === 'hidden' || a.state === 'veryHidden' })
  }
  return out
}

function applyDefinedNames(model: Model, workbookXml: string, warnings: string[]): void {
  const block = /<definedNames>([\s\S]*?)<\/definedNames>/.exec(workbookXml)?.[1]
  if (!block) return
  let failed = false
  for (const m of block.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const a = parseAttrs(m[1])
    const name = a.name
    const formula = childTextRaw(m[2])
    if (!name || !formula) continue
    if (/^_xlnm\./i.test(name)) continue // print areas and the like
    const scope = a.localSheetId !== undefined ? Number(a.localSheetId) : null
    try {
      model.newDefinedName(name, Number.isFinite(scope as number) ? (scope as number) : null, formula)
    } catch {
      failed = true
    }
  }
  if (failed) warnings.push('A defined name could not be imported.')
}

function childTextRaw(inner: string): string {
  return inner
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

// ── Shared strings ──────────────────────────────────────────────────────---

function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) out.push(flattenRuns(m[1]))
  return out
}

/** A shared-string item's text: the plain `<t>`, or the `<t>` of each rich-text `<r>` run joined. */
function flattenRuns(inner: string): string {
  const runs = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
  return runs.map((r) => decodePreserve(r[1])).join('')
}

function decodePreserve(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x?[0-9a-fA-F]+;/g, (e) => {
      const body = e.slice(2, -1)
      const code = e[1] === '#' && (e[2] === 'x' || e[2] === 'X') ? parseInt(body.slice(1), 16) : parseInt(body, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&amp;/g, '&')
}

// ── Theme ────────────────────────────────────────────────────────────────---

/** The twelve theme colors by the index a cell color uses (0=lt1, 1=dk1, 2=lt2, 3=dk2, 4-9=accents, 10-11=links). */
function parseTheme(xml: string): (string | null)[] {
  const scheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml)?.[1]
  if (!scheme) return []
  const pick = (tag: string): string | null => {
    const block = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(scheme)?.[1]
    if (!block) return null
    const srgb = /<a:srgbClr\s+val="([0-9a-fA-F]{6})"/.exec(block)?.[1]
    if (srgb) return `#${srgb.toUpperCase()}`
    const sys = /<a:sysClr\b[^>]*\blastClr="([0-9a-fA-F]{6})"/.exec(block)?.[1]
    return sys ? `#${sys.toUpperCase()}` : null
  }
  const dk1 = pick('dk1')
  const lt1 = pick('lt1')
  const dk2 = pick('dk2')
  const lt2 = pick('lt2')
  const accents = [1, 2, 3, 4, 5, 6].map((n) => pick(`accent${n}`))
  const hlink = pick('hlink')
  const folHlink = pick('folHlink')
  return [lt1, dk1, lt2, dk2, ...accents, hlink, folHlink]
}

/** A color tag's attributes (rgb, or theme + tint) to a css hex, or null when it does not resolve. */
function resolveColorTag(tag: string, theme: (string | null)[]): string | null {
  const a = parseAttrs(tag)
  if (a.rgb) return rgbToHex(a.rgb)
  if (a.theme !== undefined) {
    const baseHex = theme[Number(a.theme)] ?? null
    if (!baseHex) return null
    const tint = a.tint !== undefined ? Number(a.tint) : 0
    if (!tint) return baseHex
    try {
      const out = hexWithTintToRgb(baseHex, tint)
      return out ? (out.startsWith('#') ? out.toUpperCase() : `#${out.toUpperCase()}`) : baseHex
    } catch {
      return baseHex
    }
  }
  return null
}

// ── Styles ──────────────────────────────────────────────────────────────---

function parseStyles(xml: string, theme: (string | null)[]): { xfs: Xf[] } {
  const numFmts: Record<number, string> = { ...BUILTIN_NUM_FMTS }
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = parseAttrs(m[1])
    const id = Number(a.numFmtId)
    if (Number.isFinite(id) && a.formatCode !== undefined) numFmts[id] = a.formatCode
  }

  const colorOf = (tag: string): string | null => resolveColorTag(tag, theme)

  const fonts = parseList(xml, 'fonts', 'font').map((f) => ({
    b: /<b\/?>/.test(f) && !/<b val="0"/.test(f),
    i: /<i\/?>/.test(f) && !/<i val="0"/.test(f),
    u: /<u\b/.test(f),
    strike: /<strike\/?>/.test(f),
    sz: numAttr(f, 'sz', 'val'),
    name: strAttr(f, 'name', 'val'),
    color: firstColor(f, colorOf),
  }))

  const fills = parseList(xml, 'fills', 'fill').map((f) => {
    if (/patternType="none"/.test(f) || !/patternType=/.test(f)) {
      // gray125 and none are not real fills.
      return /patternType="gray125"/.test(f) ? null : null
    }
    const fg = /<fgColor\b([^>]*)\/?>/.exec(f)
    return fg ? colorOf(fg[1]) : null
  })

  const borders = parseList(xml, 'borders', 'border').map((b) => {
    const edge = (name: string): BorderEdge | undefined => {
      const m = new RegExp(`<${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${name}>)`).exec(b)
      if (!m) return undefined
      const style = parseAttrs(m[1]).style
      if (!style) return undefined
      const colorTag = m[2] ? /<color\b([^>]*)\/?>/.exec(m[2])?.[1] : undefined
      return { style: borderStyleIn(style), color: colorTag ? colorOf(colorTag) : null }
    }
    return { top: edge('top'), right: edge('right'), bottom: edge('bottom'), left: edge('left') }
  })

  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  const xfs: Xf[] = []
  for (const m of cellXfsBlock.matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
    const a = parseAttrs(m[1])
    const numFmtId = Number(a.numFmtId ?? 0)
    const fontId = Number(a.fontId ?? 0)
    const fillId = Number(a.fillId ?? 0)
    const borderId = Number(a.borderId ?? 0)
    const font = fonts[fontId] ?? { b: false, i: false, u: false, strike: false, sz: null, name: null, color: null }
    const alignTag = m[2] ? /<alignment\b([^>]*)\/?>/.exec(m[2])?.[1] : undefined
    const align = alignTag ? parseAttrs(alignTag) : {}
    xfs.push({
      numFmt: numFmts[numFmtId] ?? 'general',
      font,
      fill: fills[fillId] ?? null,
      border: borders[borderId] ?? {},
      horizontal: align.horizontal ?? null,
      vertical: align.vertical ?? null,
      wrap: align.wrapText === '1' || align.wrapText === 'true',
      quotePrefix: a.quotePrefix === '1' || a.quotePrefix === 'true',
    })
  }
  return { xfs }
}

function parseList(xml: string, container: string, tag: string): string[] {
  const block = new RegExp(`<${container}\\b[^>]*>([\\s\\S]*?)</${container}>`).exec(xml)?.[1]
  if (!block) return []
  return [...block.matchAll(new RegExp(`<${tag}\\b[^>]*?(?:\\/>|>([\\s\\S]*?)</${tag}>)`, 'g'))].map((m) => m[0])
}

function firstColor(fontXml: string, colorOf: (tag: string) => string | null): string | null {
  const m = /<color\b([^>]*)\/?>/.exec(fontXml)
  return m ? colorOf(m[1]) : null
}

function numAttr(xml: string, tag: string, attr: string): number | null {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`).exec(xml)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) ? n : null
}
function strAttr(xml: string, tag: string, attr: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`).exec(xml)
  return m ? m[1] : null
}

/** An .xlsx border style token as the engine's (lowercase) form. */
function borderStyleIn(style: string): string {
  return style.toLowerCase()
}

// ── A worksheet ─────────────────────────────────────────────────────────---

interface SheetContext {
  shared: string[]
  xfs: Xf[]
  base: CellStyle
  date1904: boolean
  limits: { rows: () => void; cols: () => void; tables: () => void }
  theme: (string | null)[]
}

function parseSheet(model: Model, sheet: number, xml: string, ctx: SheetContext): void {
  // Tab color, from the sheet properties.
  const tabTag = /<sheetPr\b[^>]*>[\s\S]*?<tabColor\b([^>]*)\/?>/.exec(xml)?.[1]
  if (tabTag) {
    const hex = resolveColorTag(tabTag, ctx.theme)
    if (hex) try { model.setSheetColor(sheet, hex) } catch { /* ignore */ }
  }
  // Gridlines and frozen panes.
  const view = /<sheetView\b([^>]*)>([\s\S]*?)<\/sheetView>|<sheetView\b([^>]*)\/>/.exec(xml)
  const viewAttrs = view ? parseAttrs(view[1] ?? view[3] ?? '') : {}
  if (viewAttrs.showGridLines === '0' || viewAttrs.showGridLines === 'false') model.setShowGridLines(sheet, false)
  const paneTag = view?.[2] ? /<pane\b([^>]*)\/?>/.exec(view[2])?.[1] : undefined
  if (paneTag) {
    const p = parseAttrs(paneTag)
    const xSplit = Math.floor(Number(p.xSplit ?? 0)) || 0
    const ySplit = Math.floor(Number(p.ySplit ?? 0)) || 0
    if (p.state === 'frozen' || p.state === 'frozenSplit') {
      if (ySplit > 0) try { model.setFrozenRowsCount(sheet, ySplit) } catch { /* ignore */ }
      if (xSplit > 0) try { model.setFrozenColumnsCount(sheet, xSplit) } catch { /* ignore */ }
    }
  }

  // Column widths and hidden columns.
  const colsBlock = /<cols>([\s\S]*?)<\/cols>/.exec(xml)?.[1]
  if (colsBlock) {
    for (const m of colsBlock.matchAll(/<col\b([^>]*)\/?>/g)) {
      const a = parseAttrs(m[1])
      const min = Math.max(1, Math.floor(Number(a.min ?? 1)))
      const max = Math.min(MAX_COLUMNS, Math.floor(Number(a.max ?? a.min ?? 1)))
      if (max > MAX_COLUMNS) ctx.limits.cols()
      const hidden = a.hidden === '1' || a.hidden === 'true'
      if (a.width && (a.customWidth === '1' || a.customWidth === 'true')) {
        const px = excelCharsToPx(Number(a.width))
        try { model.setColumnsWidth(sheet, min, max, px) } catch { /* ignore */ }
      }
      if (hidden) try { model.setColumnsHidden(sheet, min, max, true) } catch { /* ignore */ }
    }
  }

  const sheetData = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? ''
  const sharedFormulas = new Map<string, { formula: string; row: number; column: number }>()

  for (const rowMatch of sheetData.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const ra = parseAttrs(rowMatch[1])
    const r = Math.floor(Number(ra.r ?? 0))
    if (!r) continue
    if (r > MAX_ROWS) {
      ctx.limits.rows()
      continue
    }
    // Styles for this row, applied in one paste over its span.
    const styled: Array<{ column: number; style: CellStyle }> = []
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = parseAttrs(cellMatch[1])
      const ref = a.r ? parseA1(a.r) : null
      const column = ref ? ref.column : 0
      if (!column) continue
      if (column > MAX_COLUMNS) {
        ctx.limits.cols()
        continue
      }
      const body = cellMatch[2] ?? ''
      const xf = a.s !== undefined ? ctx.xfs[Number(a.s)] : undefined
      setCellValue(model, sheet, r, column, a.t, body, ctx, xf, sharedFormulas)
      if (xf) styled.push({ column, style: buildStyle(ctx.base, xf) })
    }
    applyRowStyles(model, sheet, r, styled, ctx.base)
  }

  // Row heights and hidden rows (a second pass so values are in first).
  for (const rowMatch of sheetData.matchAll(/<row\b([^>]*)>/g)) {
    const a = parseAttrs(rowMatch[1])
    const r = Math.floor(Number(a.r ?? 0))
    if (!r || r > MAX_ROWS) continue
    if (a.hidden === '1' || a.hidden === 'true') {
      try { model.setRowsHidden(sheet, r, r, true) } catch { /* ignore */ }
    } else if (a.ht && (a.customHeight === '1' || a.customHeight === 'true')) {
      try { model.setRowsHeight(sheet, r, r, pointsToPx(Number(a.ht))) } catch { /* ignore */ }
    }
  }

  // Merges.
  const mergeBlock = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml)?.[1]
  if (mergeBlock) {
    for (const m of mergeBlock.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)) {
      const parts = m[1].split(':')
      const a = parseA1(parts[0])
      const b = parseA1(parts[1] ?? parts[0])
      if (!a || !b) continue
      const area = { sheet, row: Math.min(a.row, b.row), column: Math.min(a.column, b.column), width: Math.abs(b.column - a.column) + 1, height: Math.abs(b.row - a.row) + 1 }
      try { model.mergeCells(area) } catch { /* ignore */ }
    }
  }
}

function setCellValue(
  model: Model,
  sheet: number,
  row: number,
  column: number,
  type: string | undefined,
  body: string,
  ctx: SheetContext,
  xf: Xf | undefined,
  sharedFormulas: Map<string, { formula: string; row: number; column: number }>,
): void {
  const formulaTag = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body)
  if (formulaTag) {
    const fa = parseAttrs(formulaTag[1])
    let formula = formulaTag[2] !== undefined ? childTextRaw(formulaTag[2]) : ''
    if (fa.t === 'shared') {
      if (formula) sharedFormulas.set(fa.si ?? '', { formula, row, column })
      else {
        const master = sharedFormulas.get(fa.si ?? '')
        if (master) formula = shiftFormula(master.formula, row - master.row, column - master.column)
      }
    }
    // Array and normal formulas are entered as the formula itself.
    if (formula) {
      if (/[A-Za-z_][\w.]*\[/.test(formula)) ctx.limits.tables()
      try {
        model.setUserInput(sheet, row, column, `=${formula}`)
      } catch {
        /* a formula the engine will not take is left blank */
      }
      return
    }
  }

  const v = childText(body, 'v')
  if (type === 's') {
    const text = v !== null ? ctx.shared[Number(v)] ?? '' : ''
    setText(model, sheet, row, column, text)
    return
  }
  if (type === 'inlineStr') {
    const is = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? ''
    setText(model, sheet, row, column, flattenRuns(is))
    return
  }
  if (type === 'str') {
    setText(model, sheet, row, column, v ?? '')
    return
  }
  if (type === 'b') {
    model.setUserInput(sheet, row, column, v === '1' ? 'TRUE' : 'FALSE')
    return
  }
  if (type === 'e') {
    model.setUserInput(sheet, row, column, v ?? '#VALUE!')
    return
  }
  if (v === null) return
  // A number. A date typed under the 1904 system sits 1462 days behind ours.
  let num = Number(v)
  if (Number.isFinite(num) && ctx.date1904 && xf && isDateFormat(xf.numFmt)) num += DATE_1904_OFFSET
  model.setUserInput(sheet, row, column, Number.isFinite(num) ? String(num) : (v ?? ''))
}

/** A string cell: set as text, guarding a value the engine would otherwise read as a number, formula, boolean or date. */
function setText(model: Model, sheet: number, row: number, column: number, text: string): void {
  model.setUserInput(sheet, row, column, needsTextGuard(text) ? `'${text}` : text)
}

function needsTextGuard(text: string): boolean {
  if (text === '') return false
  if (/^[=+\-@']/.test(text)) return true
  if (/^(true|false)$/i.test(text)) return true
  if (text.trim() !== '' && Number.isFinite(Number(text))) return true
  if (/^\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?$/.test(text.trim())) return true
  return false
}

/** Build a full CellStyle from a resolved xf, over the engine's default. */
function buildStyle(base: CellStyle, xf: Xf): CellStyle {
  const style: CellStyle = JSON.parse(JSON.stringify(base))
  style.num_fmt = xf.numFmt || 'general'
  style.quote_prefix = xf.quotePrefix
  style.font = {
    ...style.font,
    b: xf.font.b,
    i: xf.font.i,
    u: xf.font.u,
    strike: xf.font.strike,
    sz: xf.font.sz ?? style.font.sz,
    name: xf.font.name ?? style.font.name,
  }
  if (xf.font.color) style.font.color = xf.font.color
  else delete (style.font as { color?: unknown }).color
  style.fill = xf.fill ? { color: xf.fill } : {}
  const border: CellStyle['border'] = {}
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const e = xf.border[side]
    if (e) border[side] = e.color ? { style: e.style as never, color: e.color } : { style: e.style as never }
  }
  style.border = border
  if (xf.horizontal || xf.vertical || xf.wrap) {
    style.alignment = {
      horizontal: (xf.horizontal ?? 'general') as never,
      vertical: (xf.vertical ?? 'bottom') as never,
      wrap_text: xf.wrap,
    }
  }
  return style
}

/** Apply a row's styles in one paste over the span they cover; gaps take the default style. */
function applyRowStyles(model: Model, sheet: number, row: number, styled: Array<{ column: number; style: CellStyle }>, base: CellStyle): void {
  if (!styled.length) return
  let min = styled[0].column
  let max = styled[0].column
  for (const s of styled) {
    if (s.column < min) min = s.column
    if (s.column > max) max = s.column
  }
  const byColumn = new Map(styled.map((s) => [s.column, s.style]))
  const line: CellStyle[] = []
  for (let c = min; c <= max; c++) line.push(byColumn.get(c) ?? base)
  try {
    model.setSelectedSheet(sheet)
    model.setSelectedCell(row, min)
    model.setSelectedRange(row, min, row, max)
    model.onPasteStyles([line])
  } catch {
    /* a style the engine will not take is skipped */
  }
}

// ── Formula reference shifting (shared formulas) ───────────────────────────---

/** Shift the relative references in an A1 formula by (dRow, dColumn); absolute `$` parts stay. Strings are left alone. */
export function shiftFormula(formula: string, dRow: number, dColumn: number): string {
  if (!dRow && !dColumn) return formula
  let out = ''
  let i = 0
  while (i < formula.length) {
    const ch = formula[i]
    if (ch === '"') {
      // Copy a string literal verbatim (doubled quotes included).
      out += ch
      i++
      while (i < formula.length) {
        out += formula[i]
        if (formula[i] === '"') {
          if (formula[i + 1] === '"') {
            out += formula[i + 1]
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    // A cell reference: optional $, 1-3 letters, optional $, digits — not part of a longer name and not a function call.
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/.exec(formula.slice(i))
    const prev = out.slice(-1)
    const after = formula[i + (m?.[0].length ?? 0)]
    const okBefore = !/[A-Za-z0-9_.]/.test(prev)
    const okAfter = after !== '(' && !/[A-Za-z0-9_]/.test(after ?? '')
    if (m && okBefore && okAfter) {
      const [, dollarCol, letters, dollarRow, digits] = m
      const col = columnLetters(letters)
      const rowNum = Number(digits)
      const newCol = dollarCol ? letters : indexToLetters(Math.max(1, col + dColumn))
      const newRow = dollarRow ? digits : String(Math.max(1, rowNum + dRow))
      out += `${dollarCol}${newCol}${dollarRow}${newRow}`
      i += m[0].length
      continue
    }
    out += ch
    i++
  }
  return out
}

function columnLetters(letters: string): number {
  let n = 0
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64)
  return n
}
function indexToLetters(n: number): string {
  let out = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    out = String.fromCharCode(65 + r) + out
    x = Math.floor((x - 1) / 26)
  }
  return out
}

function uniqueName(name: string, taken: string[]): string {
  let candidate = name.slice(0, 31) || 'Sheet'
  let n = 2
  while (taken.some((t) => t.toLowerCase() === candidate.toLowerCase())) {
    const suffix = ` ${n}`
    candidate = `${name.slice(0, 31 - suffix.length)}${suffix}`
    n++
  }
  return candidate
}

// ── Warnings from parts present ────────────────────────────────────────────---

function warnFromParts(zip: JSZip, warnings: string[]): void {
  const names = Object.keys(zip.files)
  const has = (re: RegExp) => names.some((n) => re.test(n))
  if (has(/xl\/charts\//) || has(/\/chart\d*\.xml$/)) warnings.push('Charts were left out.')
  if (has(/xl\/media\//) || has(/xl\/drawings\//)) warnings.push('Images and drawings were left out.')
  if (has(/xl\/pivotTables\//)) warnings.push('Pivot tables were left out.')
  if (has(/xl\/tables\//)) warnings.push('Tables were imported as plain cells; their structured references (Table[Column]) show #NAME?.')
  if (has(/xl\/externalLinks\//)) warnings.push('Links to other workbooks were left out; their values were kept where present.')
  if (has(/(^|\/)comments\d*\.xml$/) || has(/threadedComment/i)) warnings.push('Comments were left out.')
  if (has(/vbaProject\.bin$/i)) warnings.push('Macros were left out.')
}
