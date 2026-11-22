/**
 * Export a workbook to .xlsx (ECMA-376 SpreadsheetML), written by hand over a
 * zip container (jszip, MIT). Isomorphic: the editor exports the open workbook
 * in the browser, the route exports a stored one on the server, both through
 * this one function. The engine's own save format is never shipped out.
 *
 * Every sheet is written with its name, hidden state and tab color; each cell
 * with the right type (number, shared or inline string, boolean, error); each
 * formula beside its last calculated value, cached so a reader that does not
 * recalculate still shows the right thing; styles (number format, font, fill,
 * borders, alignment, wrap), column widths, row heights, hidden rows and
 * columns, merged cells, frozen panes, gridlines and defined names. Styles are
 * deduplicated into styles.xml, as Excel writes them.
 *
 * Calculated values are not stored by the engine, so to cache a formula's
 * value (and to read a date typed as a date back as its serial) the workbook is
 * cloned and its cells reformatted to "general" on the copy, which the original
 * never sees.
 */
import { Model, type CellStyle, type Color } from '@ironcalc/wasm'
import JSZip from 'jszip'
import { columnName } from './a1'
import {
  DEFAULT_COLUMN_WIDTH_PX,
  DEFAULT_ROW_HEIGHT_PX,
  hexToArgb,
  pxToExcelChars,
  pxToPoints,
  xmlEscape,
} from './xlsx-shared'
import { MAX_COLUMNS } from './a1'
import { CELL_TYPE, listSheets, usedRange, type SheetInfo } from './workbook'

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** The first id Excel gives a custom number format; 0–163 are built in. */
const CUSTOM_NUM_FMT_BASE = 164

/** The engine's border style tokens as the camelCase an .xlsx wants. */
const BORDER_STYLE_OUT: Record<string, string> = {
  slantdashdot: 'slantDashDot',
  mediumdashed: 'mediumDashed',
  mediumdashdotdot: 'mediumDashDotDot',
  mediumdashdot: 'mediumDashDot',
}

interface FontKey {
  b: boolean
  i: boolean
  u: boolean
  strike: boolean
  sz: number
  name: string
  color: string
}
interface BorderEdge {
  style: string
  color: string
}
interface BorderKey {
  top: BorderEdge | null
  right: BorderEdge | null
  bottom: BorderEdge | null
  left: BorderEdge | null
}
interface XfKey {
  numFmtId: number
  fontId: number
  fillId: number
  borderId: number
  horizontal: string
  vertical: string
  wrap: boolean
  quotePrefix: boolean
}

/** A pool that hands each distinct value one index and remembers the order they came in. */
class Pool<T> {
  private readonly index = new Map<string, number>()
  readonly items: T[] = []
  constructor(seed: T[] = []) {
    for (const item of seed) this.intern(item)
  }
  intern(item: T): number {
    const key = JSON.stringify(item)
    const found = this.index.get(key)
    if (found !== undefined) return found
    const id = this.items.length
    this.index.set(key, id)
    this.items.push(item)
    return id
  }
}

/** Interns shared strings across the whole workbook, so a cell's `t="s"` index points into the one sharedStrings.xml. */
class StringPool {
  private readonly index = new Map<string, number>()
  readonly items: string[] = []
  intern(text: string): number {
    const found = this.index.get(text)
    if (found !== undefined) return found
    const id = this.items.length
    this.index.set(text, id)
    this.items.push(text)
    return id
  }
}

/** Resolve a `Color` to a css hex, or '' when there is none. */
function resolveHex(model: Model, color: Color): string {
  if (color === undefined || color === null) return ''
  try {
    return model.resolveColor(color) || ''
  } catch {
    return ''
  }
}

function fontKey(model: Model, style: CellStyle): FontKey {
  const f = style.font
  return {
    b: !!f?.b,
    i: !!f?.i,
    u: !!f?.u,
    strike: !!f?.strike,
    sz: f?.sz ?? 11,
    name: f?.name || 'Calibri',
    color: resolveHex(model, f?.color),
  }
}

function edge(model: Model, item: { style: string; color?: Color } | undefined): BorderEdge | null {
  if (!item) return null
  const token = String(item.style)
  return { style: BORDER_STYLE_OUT[token] ?? token, color: resolveHex(model, item.color) }
}

function borderKey(model: Model, style: CellStyle): BorderKey {
  const b = style.border
  return {
    top: edge(model, b?.top),
    right: edge(model, b?.right),
    bottom: edge(model, b?.bottom),
    left: edge(model, b?.left),
  }
}

export async function workbookToXlsx(model: Model): Promise<Uint8Array> {
  model.evaluate()
  const sheets = listSheets(model)
  const usedRanges = sheets.map((s) => usedRange(model, s.index))

  // A reformatted clone, for cached values. The original model is untouched.
  const clone = Model.fromBytes(model.toBytes(), 'en')
  for (const s of sheets) {
    const used = usedRanges[s.index]
    if (used) {
      clone.updateRangeStyle(
        { sheet: s.index, row: used.r1, column: used.c1, width: used.c2 - used.c1 + 1, height: used.r2 - used.r1 + 1 },
        'num_fmt',
        'general',
      )
    }
  }
  clone.evaluate()

  // The engine's own default style, read from a cell no sheet uses.
  const maxUsedRow = Math.max(1, ...usedRanges.map((u) => u?.r2 ?? 0))
  const maxUsedCol = Math.max(1, ...usedRanges.map((u) => u?.c2 ?? 0))
  const defaultStyle = model.getCellStyle(0, Math.min(maxUsedRow + 2, 100_000), Math.min(maxUsedCol + 2, 16_384)).style

  const numFmts = new Pool<string>([String(defaultStyle.num_fmt || 'general')])
  const fonts = new Pool<FontKey>([fontKey(model, defaultStyle)])
  // Fill 0 is "none" and fill 1 is "gray125"; Excel reserves both, so real fills start at 2.
  const fills = new Pool<string>(['none', 'gray125'])
  const borders = new Pool<BorderKey>([{ top: null, right: null, bottom: null, left: null }])
  const strings = new StringPool()

  function numFmtIdOf(code: string): number {
    const c = code || 'general'
    if (c === 'general') return 0
    if (c === '@') return 49
    return CUSTOM_NUM_FMT_BASE + numFmts.intern(c)
  }

  const xfs = new Pool<XfKey>([
    { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, horizontal: 'general', vertical: 'bottom', wrap: false, quotePrefix: false },
  ])

  /** The xf index for a cell's style, interning its font, fill, border and format. */
  function xfFor(style: CellStyle): number {
    const numFmtId = numFmtIdOf(String(style.num_fmt || 'general'))
    const fontId = fonts.intern(fontKey(model, style))
    const fillHex = resolveHex(model, style.fill?.color)
    const fillId = fillHex ? fills.intern(fillHex) : 0
    const borderId = borders.intern(borderKey(model, style))
    const horizontal = style.alignment?.horizontal ?? 'general'
    const vertical = style.alignment?.vertical ?? 'bottom'
    const wrap = !!style.alignment?.wrap_text
    return xfs.intern({ numFmtId, fontId, fillId, borderId, horizontal, vertical, wrap, quotePrefix: !!style.quote_prefix })
  }

  const sheetXml = sheets.map((s) => writeSheet(model, clone, s, usedRanges[s.index], xfFor, strings))

  clone.free()

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes(sheets.length))
  zip.file('_rels/.rels', rootRels())
  zip.file('xl/workbook.xml', workbookXml(model, sheets))
  zip.file('xl/_rels/workbook.xml.rels', workbookRels(sheets.length))
  zip.file('xl/styles.xml', stylesXml(numFmts, fonts, fills, borders, xfs))
  zip.file('xl/sharedStrings.xml', sharedStringsXml(strings.items))
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml[i]))

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

// ── Package parts ────────────────────────────────────────────────────────---

function contentTypes(sheetCount: number): string {
  const overrides = [
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`,
  ]
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
  }
  return `${XML_HEAD}<Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`
}

function rootRels(): string {
  return `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
}

function workbookRels(sheetCount: number): string {
  const rels: string[] = []
  for (let i = 1; i <= sheetCount; i++) rels.push(`<Relationship Id="rId${i}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i}.xml"/>`)
  rels.push(`<Relationship Id="rId${sheetCount + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`)
  rels.push(`<Relationship Id="rId${sheetCount + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>`)
  return `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">${rels.join('')}</Relationships>`
}

function workbookXml(model: Model, sheets: SheetInfo[]): string {
  const indexById = new Map(sheets.map((s) => [s.id, s.index]))
  const sheetTags = sheets
    .map((s, i) => {
      const state = s.hidden ? ' state="hidden"' : ''
      return `<sheet name="${xmlEscape(s.name)}" sheetId="${s.id}"${state} r:id="rId${i + 1}"/>`
    })
    .join('')
  const nameTags = model
    .getDefinedNameList()
    .map((n) => {
      const scopeIndex = n.scope !== undefined && n.scope !== null ? indexById.get(n.scope) : undefined
      const local = scopeIndex !== undefined ? ` localSheetId="${scopeIndex}"` : ''
      return `<definedName name="${xmlEscape(n.name)}"${local}>${xmlEscape(n.formula)}</definedName>`
    })
    .join('')
  const definedNames = nameTags ? `<definedNames>${nameTags}</definedNames>` : ''
  return `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><workbookPr/><sheets>${sheetTags}</sheets>${definedNames}</workbook>`
}

// ── styles.xml ───────────────────────────────────────────────────────────---

function fontXml(f: FontKey): string {
  const parts: string[] = []
  if (f.b) parts.push('<b/>')
  if (f.i) parts.push('<i/>')
  if (f.u) parts.push('<u/>')
  if (f.strike) parts.push('<strike/>')
  parts.push(`<sz val="${f.sz}"/>`)
  const argb = hexToArgb(f.color)
  if (argb) parts.push(`<color rgb="${argb}"/>`)
  parts.push(`<name val="${xmlEscape(f.name)}"/>`)
  return `<font>${parts.join('')}</font>`
}

function fillXml(fill: string): string {
  if (fill === 'none') return '<fill><patternFill patternType="none"/></fill>'
  if (fill === 'gray125') return '<fill><patternFill patternType="gray125"/></fill>'
  const argb = hexToArgb(fill)
  return `<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor indexed="64"/></patternFill></fill>`
}

function borderXml(b: BorderKey): string {
  const side = (name: string, e: BorderEdge | null) => {
    if (!e) return `<${name}/>`
    const argb = hexToArgb(e.color)
    const color = argb ? `<color rgb="${argb}"/>` : ''
    return `<${name} style="${e.style}">${color}</${name}>`
  }
  return `<border>${side('left', b.left)}${side('right', b.right)}${side('top', b.top)}${side('bottom', b.bottom)}<diagonal/></border>`
}

function stylesXml(numFmts: Pool<string>, fonts: Pool<FontKey>, fills: Pool<string>, borders: Pool<BorderKey>, xfs: Pool<XfKey>): string {
  const customFmts = numFmts.items.map((code, i) => ({ code, i })).filter(({ code }) => code !== 'general' && code !== '@')
  const numFmtTags = customFmts.map(({ code, i }) => `<numFmt numFmtId="${CUSTOM_NUM_FMT_BASE + i}" formatCode="${xmlEscape(code)}"/>`).join('')
  const numFmtBlock = customFmts.length ? `<numFmts count="${customFmts.length}">${numFmtTags}</numFmts>` : ''

  const fontTags = fonts.items.map(fontXml).join('')
  const fillTags = fills.items.map(fillXml).join('')
  const borderTags = borders.items.map(borderXml).join('')

  const xfTags = xfs.items
    .map((x) => {
      const applyNumFmt = x.numFmtId !== 0 ? ' applyNumberFormat="1"' : ''
      const applyFont = x.fontId !== 0 ? ' applyFont="1"' : ''
      const applyFill = x.fillId !== 0 ? ' applyFill="1"' : ''
      const applyBorder = x.borderId !== 0 ? ' applyBorder="1"' : ''
      const quote = x.quotePrefix ? ' quotePrefix="1"' : ''
      const alignParts: string[] = []
      if (x.horizontal && x.horizontal !== 'general') alignParts.push(`horizontal="${x.horizontal}"`)
      if (x.vertical && x.vertical !== 'bottom') alignParts.push(`vertical="${x.vertical}"`)
      if (x.wrap) alignParts.push('wrapText="1"')
      const applyAlign = alignParts.length ? ' applyAlignment="1"' : ''
      const align = alignParts.length ? `<alignment ${alignParts.join(' ')}/>` : ''
      const body = align ? `>${align}</xf>` : '/>'
      return `<xf numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="${x.borderId}"${applyNumFmt}${applyFont}${applyFill}${applyBorder}${applyAlign}${quote} xfId="0"${body}`
    })
    .join('')

  return `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">${numFmtBlock}<fonts count="${fonts.items.length}">${fontTags}</fonts><fills count="${fills.items.length}">${fillTags}</fills><borders count="${borders.items.length}">${borderTags}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.items.length}">${xfTags}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
}

function sharedStringsXml(strings: string[]): string {
  const sis = strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('')
  return `${XML_HEAD}<sst xmlns="${MAIN_NS}" count="${strings.length}" uniqueCount="${strings.length}">${sis}</sst>`
}

// ── A worksheet ──────────────────────────────────────────────────────────---

function writeSheet(
  model: Model,
  clone: Model,
  sheet: SheetInfo,
  used: ReturnType<typeof usedRange>,
  xfFor: (style: CellStyle) => number,
  strings: StringPool,
): string {
  const index = sheet.index
  const rowsXml: string[] = []
  if (used) {
    for (let r = used.r1; r <= used.r2; r++) {
      const columns = model.getColumnsWithData(index, r)
      if (!columns.length) continue
      const cells: string[] = []
      for (const c of columns) cells.push(cellXml(model, clone, index, r, c, xfFor, strings))
      const height = model.getRowHeight(index, r)
      let rowAttrs = ` r="${r}"`
      if (height === 0) rowAttrs += ' hidden="1"'
      else if (Math.round(height) !== DEFAULT_ROW_HEIGHT_PX) rowAttrs += ` ht="${pxToPoints(height)}" customHeight="1"`
      rowsXml.push(`<row${rowAttrs}>${cells.join('')}</row>`)
    }
  }

  const tabArgb = sheet.color ? hexToArgb(sheet.color) : null
  const sheetPr = tabArgb ? `<sheetPr><tabColor rgb="${tabArgb}"/></sheetPr>` : ''
  const views = sheetViewsXml(model, index)
  const cols = colsXml(model, index, used)
  const merges = mergesXml(model, index)
  const defaultRowHeight = pxToPoints(DEFAULT_ROW_HEIGHT_PX)
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${sheetPr}${views}<sheetFormatPr defaultRowHeight="${defaultRowHeight}"/>${cols}<sheetData>${rowsXml.join('')}</sheetData>${merges}</worksheet>`
}

/** One `<c>` element: its reference, style index and value, typed. */
function cellXml(
  model: Model,
  clone: Model,
  sheet: number,
  row: number,
  column: number,
  xfFor: (style: CellStyle) => number,
  strings: StringPool,
): string {
  const ref = `${columnName(column)}${row}`
  const style = model.getCellStyle(sheet, row, column).style
  const s = xfFor(style)
  const sAttr = s ? ` s="${s}"` : ''
  const content = model.getCellContent(sheet, row, column)
  const type = model.getCellType(sheet, row, column)
  const isFormula = content.startsWith('=')

  if (isFormula) {
    const formula = xmlEscape(content.slice(1))
    const cached = clone.getFormattedCellValue(sheet, row, column)
    if (type === CELL_TYPE.boolean) return `<c r="${ref}"${sAttr} t="b"><f>${formula}</f><v>${cached === 'TRUE' ? 1 : 0}</v></c>`
    if (type === CELL_TYPE.error) return `<c r="${ref}"${sAttr} t="e"><f>${formula}</f><v>${xmlEscape(cached)}</v></c>`
    if (type === CELL_TYPE.text) return `<c r="${ref}"${sAttr} t="str"><f>${formula}</f><v>${xmlEscape(cached)}</v></c>`
    // Number (dates included: the cache holds the serial).
    const num = Number(cached)
    const v = Number.isFinite(num) ? `<v>${num}</v>` : ''
    return `<c r="${ref}"${sAttr}><f>${formula}</f>${v}</c>`
  }

  // An empty cell that only carries a format (a bold, bordered blank) is written with no value: the engine
  // calls an empty cell a number, and a blank must not come out as 0.
  if (content === '') return `<c r="${ref}"${sAttr}/>`

  if (type === CELL_TYPE.boolean) return `<c r="${ref}"${sAttr} t="b"><v>${content === 'TRUE' ? 1 : 0}</v></c>`
  if (type === CELL_TYPE.error) return `<c r="${ref}"${sAttr} t="e"><v>${xmlEscape(content)}</v></c>`
  if (type === CELL_TYPE.number) {
    // A plain number's input is exact; a date typed as a date reads back as its serial off the clone.
    const direct = Number(content)
    const value = Number.isFinite(direct) && content.trim() !== '' ? content : clone.getFormattedCellValue(sheet, row, column)
    const num = Number(value)
    return Number.isFinite(num) ? `<c r="${ref}"${sAttr}><v>${num}</v></c>` : `<c r="${ref}"${sAttr}/>`
  }
  // Text: the shown value, with a quote prefix (if any) recorded on the style, not in the text.
  const text = model.getFormattedCellValue(sheet, row, column)
  if (!text && !s) return `<c r="${ref}"/>`
  if (!text) return `<c r="${ref}"${sAttr}/>`
  return `<c r="${ref}"${sAttr} t="s"><v>${strings.intern(text)}</v></c>`
}

function sheetViewsXml(model: Model, sheet: number): string {
  const grid = model.getShowGridLines(sheet) ? '' : ' showGridLines="0"'
  const frozenRows = model.getFrozenRowsCount(sheet)
  const frozenCols = model.getFrozenColumnsCount(sheet)
  let pane = ''
  if (frozenRows > 0 || frozenCols > 0) {
    const topLeft = `${columnName(frozenCols + 1)}${frozenRows + 1}`
    const xSplit = frozenCols > 0 ? ` xSplit="${frozenCols}"` : ''
    const ySplit = frozenRows > 0 ? ` ySplit="${frozenRows}"` : ''
    pane = `<pane${xSplit}${ySplit} topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>`
  }
  return `<sheetViews><sheetView workbookViewId="0"${grid}>${pane}</sheetView></sheetViews>`
}

/**
 * Column widths and hidden columns. A hidden or resized column can sit outside
 * the data, so every column is scanned (a fast engine call each) and the ones
 * that differ from the default are emitted, consecutive identical ones coalesced
 * into one `<col min max>` as Excel writes them.
 */
function colsXml(model: Model, sheet: number, used: ReturnType<typeof usedRange>): string {
  const limit = Math.max(used?.c2 ?? 0, MAX_COLUMNS)
  const cols: string[] = []
  let run: { min: number; max: number; tag: string } | null = null
  const flush = () => {
    if (run) cols.push(`<col min="${run.min}" max="${run.max}" ${run.tag}/>`)
    run = null
  }
  for (let c = 1; c <= limit; c++) {
    const width = model.getColumnWidth(sheet, c)
    let tag: string | null = null
    if (width === 0) tag = `width="${pxToExcelChars(DEFAULT_COLUMN_WIDTH_PX)}" hidden="1" customWidth="1"`
    else if (Math.round(width) !== DEFAULT_COLUMN_WIDTH_PX) tag = `width="${pxToExcelChars(width)}" customWidth="1"`
    if (tag === null) {
      flush()
    } else if (run && run.tag === tag && run.max === c - 1) {
      run.max = c
    } else {
      flush()
      run = { min: c, max: c, tag }
    }
  }
  flush()
  return cols.length ? `<cols>${cols.join('')}</cols>` : ''
}

function mergesXml(model: Model, sheet: number): string {
  const merged = model.getMergedCells(sheet)
  if (!merged.length) return ''
  const tags = merged
    .map((m) => {
      const ref = `${columnName(m.column)}${m.row}:${columnName(m.column + m.width - 1)}${m.row + m.height - 1}`
      return `<mergeCell ref="${ref}"/>`
    })
    .join('')
  return `<mergeCells count="${merged.length}">${tags}</mergeCells>`
}
