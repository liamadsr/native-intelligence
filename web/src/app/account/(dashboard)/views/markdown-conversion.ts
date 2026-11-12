import { parseTableLink, tableLink } from '@/lib/tables/embed'
import type { JSONContent } from 'novel'
import { mentionMarkdown } from '@/lib/documents/mention-markdown'
import { isMentionableType } from '@/lib/entity-links/mentionable'

// --- Markdown <-> JSONContent conversion ---

/** The editor's node for a record @-mentioned in the text (src/components/editor/record-mention.ts). */
export const RECORD_MENTION_NODE = 'recordMention'

/** Optional proposal change map for resolving <!-- proposal:ID --> markers */
export interface ProposalChangeRef {
  byIndex: Map<number, string>  // sort_order index → change ID
  byId: Map<string, string>     // full or short UUID → change ID
  allIds: string[]              // all change IDs (for appending unmatched ones)
}

const PROPOSAL_MARKER_RE = /<!--\s*proposal:([^\s>]+)\s*-->/

/** Matches a line that is exactly a bare URL (rendered as a link preview). */
export const URL_REGEX = /^https?:\/\/[^\s]+$/

export function markdownToJSONContent(markdown: string, proposalRefs?: ProposalChangeRef): JSONContent {
  if (!markdown.trim()) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }

  const content: JSONContent[] = []
  const lines = markdown.split('\n')
  let i = 0

  // Track which change ids have already produced a proposalNode. A capture's
  // ai_summary can legitimately contain the SAME `<!-- proposal:ID -->` marker
  // more than once — the batch agent isn't guaranteed to emit each id exactly
  // once across its write_summary/update_summary calls, and reconcileSummaryMarkers
  // doesn't collapse repeated valid-id markers. Without this guard every repeat
  // marker renders another identical card, so the same action item shows twice.
  const emittedChangeIds = new Set<string>()

  while (i < lines.length) {
    const line = lines[i]

    // Proposal marker — check before other patterns
    const proposalMatch = line.match(PROPOSAL_MARKER_RE)
    if (proposalMatch) {
      const ref = proposalMatch[1]

      if (proposalRefs) {
        const numIndex = parseInt(ref, 10)
        const changeId = (!isNaN(numIndex) && proposalRefs.byIndex.get(numIndex))
          || proposalRefs.byId.get(ref)
          || undefined

        if (changeId && !emittedChangeIds.has(changeId)) {
          // If previous content is a bullet list, check if the last item is the one
          // this proposal card replaces — remove it to avoid duplication
          const lineWithoutMarker = line.replace(PROPOSAL_MARKER_RE, '').trim()
          if (!lineWithoutMarker) {
            const prev = content[content.length - 1]
            if (prev && (prev.type === 'bulletList' || prev.type === 'orderedList') && prev.content && prev.content.length > 0) {
              prev.content.pop()
              if (prev.content.length === 0) content.pop()
            }
          }

          emittedChangeIds.add(changeId)
          content.push({
            type: 'proposalNode',
            attrs: { changeId },
          })
        } else if (changeId) {
          // Duplicate marker for an id we already rendered. Still drop the
          // preceding bullet if the marker was on its own line, so the stale
          // bullet text doesn't linger above the (single) card.
          const lineWithoutMarker = line.replace(PROPOSAL_MARKER_RE, '').trim()
          if (!lineWithoutMarker) {
            const prev = content[content.length - 1]
            if (prev && (prev.type === 'bulletList' || prev.type === 'orderedList') && prev.content && prev.content.length > 0) {
              prev.content.pop()
              if (prev.content.length === 0) content.pop()
            }
          }
        }
        // Unmatched marker — skip the line (HTML comments are invisible)
      }
      // No proposalRefs — skip marker lines (HTML comments are invisible)
      i++
      continue
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      content.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: [{ type: 'text', text: headingMatch[2] }],
      })
      i++
      continue
    }

    // GFM table — a header row followed by a delimiter row of dashes/colons.
    // Detected before horizontal rules and lists so pipe-delimited content
    // becomes a real table node instead of falling through to a paragraph.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableDelimiterRow(lines[i + 1])
    ) {
      const headerCells = parseTableRow(line)
      const alignments = parseTableAlignments(lines[i + 1])
      i += 2 // consume header + delimiter

      const bodyRows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        // A second delimiter-looking row would mark a new table; stop here.
        if (isTableDelimiterRow(lines[i])) break
        bodyRows.push(parseTableRow(lines[i]))
        i++
      }

      content.push(
        buildTableNode(headerCells, bodyRows, alignments),
      )
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      content.push({ type: 'horizontalRule' })
      i++
      continue
    }

    // Lists (bullet / task / ordered) — collect the whole run of consecutive
    // list lines, including indented ones, then build nested structures.
    // A list block only STARTS at column 0 (same as the old flat parser);
    // indented lines are consumed as nested children of the run.
    const listStart = matchListLine(line)
    if (listStart && listStart.indentWidth === 0) {
      const entries: ListLineEntry[] = []
      while (i < lines.length) {
        const entry = matchListLine(lines[i])
        if (!entry) break
        // If a bullet/task line contains a proposal marker, stop collecting —
        // let the outer loop handle it (matches the pre-nesting behavior;
        // ordered lines never broke on markers and still don't).
        if (!entry.ordered && PROPOSAL_MARKER_RE.test(lines[i])) break
        entries.push(entry)
        i++
      }
      if (entries.length === 0) {
        // Unreachable in practice (marker-only lines are handled above);
        // skip defensively rather than looping forever.
        i++
        continue
      }
      const pos = { index: 0 }
      while (pos.index < entries.length) {
        content.push(buildListFromEntries(entries, pos, 0))
      }
      continue
    }

    // Blockquote
    if (/^>\s/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      content.push({
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: parseInlineMarkdown(quoteLines.join('\n')),
          },
        ],
      })
      continue
    }

    // Code block
    if (/^```/.test(line)) {
      // Fence info string — first token is the language (```ts, ```python …).
      const info = line.slice(3).trim()
      const language = info ? info.split(/\s+/)[0] : ''
      const codeLines: string[] = []
      i++ // skip opening ```
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      const code = codeLines.join('\n')
      const codeBlock: JSONContent = { type: 'codeBlock' }
      if (language) codeBlock.attrs = { language }
      // ProseMirror forbids empty TEXT nodes — an empty fence must produce a
      // codeBlock with NO content (an empty text node makes Tiptap's
      // createNodeFromContent throw and fall back to an EMPTY document,
      // blanking the entire note).
      if (code) codeBlock.content = [{ type: 'text', text: code }]
      content.push(codeBlock)
      continue
    }

    // Empty line
    if (!line.trim()) {
      i++
      continue
    }

    // HTML comments (non-proposal) — skip silently, just like ReactMarkdown does
    if (/^\s*<!--.*-->\s*$/.test(line)) {
      i++
      continue
    }

    // Link preview — a line that is just a bare URL. A table's link is the
    // table itself, embedded (lib/tables/embed.ts).
    if (URL_REGEX.test(line.trim())) {
      const table = parseTableLink(line.trim())
      content.push(
        table
          ? { type: 'tableEmbed', attrs: { tableId: table.tableId, viewId: table.viewId } }
          : { type: 'linkPreview', attrs: { url: line.trim() } },
      )
      i++
      continue
    }

    // Regular paragraph
    content.push({
      type: 'paragraph',
      content: parseInlineMarkdown(line),
    })
    i++
  }

  // Append unmatched proposal nodes at the end (proposals without markers in the
  // markdown). `emittedChangeIds` already holds every id rendered in the loop, so
  // this both skips ids that were anchored AND never double-appends.
  if (proposalRefs) {
    for (const id of proposalRefs.allIds) {
      if (!emittedChangeIds.has(id)) {
        emittedChangeIds.add(id)
        content.push({ type: 'proposalNode', attrs: { changeId: id } })
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: 'paragraph' })
  }

  return { type: 'doc', content }
}

// --- List helpers ---

/** One markdown list line, e.g. `  - [x] text` or `1. text`. */
interface ListLineEntry {
  /** Leading whitespace width (tab = 2). */
  indentWidth: number
  /** Nesting depth: 2 spaces of indent per level. */
  level: number
  /** True for `1.`-style markers, false for `-`/`*`. */
  ordered: boolean
  /** Raw item text after the marker (may still hold `[x]` task syntax). */
  text: string
}

const LIST_LINE_RE = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/

function matchListLine(line: string): ListLineEntry | null {
  const m = line.match(LIST_LINE_RE)
  if (!m) return null
  const indentWidth = m[1].replace(/\t/g, '  ').length
  return {
    indentWidth,
    level: Math.floor(indentWidth / 2),
    ordered: m[3] !== undefined,
    text: m[4],
  }
}

const LIST_NODE_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])

/**
 * Build one list node from consecutive list-line entries starting at
 * `pos.index`, consuming everything at `level` or deeper. Deeper entries
 * become nested lists inside the preceding item (Tiptap shape:
 * `listItem.content = [paragraph, bulletList?]`). Stops when the marker
 * family (bullet vs task vs ordered) changes at this level, so the caller can
 * start a sibling list — same block-splitting the old flat parser produced.
 */
function buildListFromEntries(
  entries: ListLineEntry[],
  pos: { index: number },
  level: number,
): JSONContent {
  const listType = listTypeOfEntry(entries[pos.index])

  const items: JSONContent[] = []
  while (pos.index < entries.length && entries[pos.index].level >= level) {
    const entry = entries[pos.index]

    if (entry.level > level) {
      // Deeper entry — nest a sublist inside the previous item.
      const nested = buildListFromEntries(entries, pos, level + 1)
      const parent = items[items.length - 1]
      if (parent) {
        parent.content = [...(parent.content ?? []), nested]
      } else {
        // Orphan deep entry with no parent item at this level (e.g. an
        // indent jump of 2+ levels) — wrap it so the doc stays valid.
        items.push(makeWrapperListItem(listType, nested))
      }
      continue
    }

    // A task line and a plain bullet line can't share a list (taskList only
    // holds taskItems, bulletList only listItems), so a family change at this
    // level ends the list and the caller starts a sibling one.
    if (listTypeOfEntry(entry) !== listType) break
    items.push(makeListItemFromEntry(listType, entry.text))
    pos.index++
  }

  return { type: listType, content: items }
}

function listTypeOfEntry(entry: ListLineEntry): 'orderedList' | 'taskList' | 'bulletList' {
  if (entry.ordered) return 'orderedList'
  return /^\[[ xX]\]/.test(entry.text) ? 'taskList' : 'bulletList'
}

function makeListItemFromEntry(listType: string, text: string): JSONContent {
  // Task syntax only applies to bullet-family lines (never `1. [x]`),
  // matching the old parser.
  if (listType !== 'orderedList') {
    const taskMatch = text.match(/^\[([ xX])\]\s*(.*)/)
    if (taskMatch) {
      return {
        type: 'taskItem',
        attrs: { checked: taskMatch[1] !== ' ' },
        content: [
          {
            type: 'paragraph',
            content: taskMatch[2] ? parseInlineMarkdown(taskMatch[2]) : [],
          },
        ],
      }
    }
  }
  return {
    type: 'listItem',
    content: [{ type: 'paragraph', content: parseInlineMarkdown(text) }],
  }
}

/** An item with an empty paragraph, used to host an orphan nested list. */
function makeWrapperListItem(listType: string, nested: JSONContent): JSONContent {
  if (listType === 'taskList') {
    return {
      type: 'taskItem',
      attrs: { checked: false },
      content: [{ type: 'paragraph', content: [] }, nested],
    }
  }
  return {
    type: 'listItem',
    content: [{ type: 'paragraph', content: [] }, nested],
  }
}

// --- GFM table helpers ---

type TableAlign = 'left' | 'center' | 'right' | null

/** True when a line is a GFM table delimiter row, e.g. `| --- | :--: |`. */
function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false
  // Every cell must be dashes with optional surrounding colons.
  return parseTableRow(line).every((cell) => /^:?-+:?$/.test(cell.trim()))
}

/** Split a table row into cell strings, honouring escaped `\|` pipes. */
function parseTableRow(line: string): string[] {
  let row = line.trim()
  // Drop a single leading/trailing pipe so empty edge cells aren't produced.
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)

  const cells: string[] = []
  let current = ''
  for (let j = 0; j < row.length; j++) {
    const ch = row[j]
    if (ch === '\\' && row[j + 1] === '|') {
      current += '|'
      j++
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

/** Read per-column alignment from a delimiter row. */
function parseTableAlignments(line: string): TableAlign[] {
  return parseTableRow(line).map((cell) => {
    const c = cell.trim()
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** Build a Tiptap `table` JSONContent node from parsed cells. */
function buildTableNode(
  headerCells: string[],
  bodyRows: string[][],
  alignments: TableAlign[],
): JSONContent {
  const colCount = Math.max(
    headerCells.length,
    ...bodyRows.map((r) => r.length),
    1,
  )

  const makeCell = (
    type: 'tableHeader' | 'tableCell',
    text: string,
    align: TableAlign,
  ): JSONContent => {
    // `<br>` separates paragraphs within a cell — a markdown table row is a
    // single line, so multi-paragraph cells serialize with `<br>` and are
    // split back here (a user-typed literal `<br>` is treated as a break).
    const paragraphs: JSONContent[] = text
      .split(/<br\s*\/?>/i)
      .map((part) => {
        const inline = parseInlineMarkdown(part.trim())
        return {
          type: 'paragraph',
          ...(align ? { attrs: { textAlign: align } } : {}),
          content: inline.length > 0 ? inline : [],
        }
      })
    return {
      type,
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: paragraphs,
    }
  }

  const rows: JSONContent[] = []

  // Header row
  rows.push({
    type: 'tableRow',
    content: Array.from({ length: colCount }, (_, c) =>
      makeCell('tableHeader', headerCells[c] ?? '', alignments[c] ?? null),
    ),
  })

  // Body rows
  for (const bodyRow of bodyRows) {
    rows.push({
      type: 'tableRow',
      content: Array.from({ length: colCount }, (_, c) =>
        makeCell('tableCell', bodyRow[c] ?? '', alignments[c] ?? null),
      ),
    })
  }

  return { type: 'table', content: rows }
}

/** A word character for the intraword-underscore rule (CommonMark-style). */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u

/**
 * Parse `inner` (the text inside a link/bold/italic/strike delimiter) and add
 * `mark` to every resulting node. The serializer nests marks (`_**x**_`,
 * `[**x**](url)`, `~~**x**~~`), so the inner text must be parsed too or the
 * inner delimiters come back as literal characters.
 */
function parseInlineWithMark(inner: string, mark: NonNullable<JSONContent['marks']>[number]): JSONContent[] {
  return parseInlineMarkdown(inner).map((node) => ({
    ...node,
    marks: [...(node.marks ?? []), mark],
  }))
}

function parseInlineMarkdown(text: string): JSONContent[] {
  if (!text) return []

  const nodes: JSONContent[] = []
  // Simple inline parsing: links, bold, italic, code, strikethrough. Links are
  // parsed so a [text](url) the serializer wrote (and agents write in briefs)
  // survives a reload as a link instead of literal brackets. Only http(s),
  // mailto and app-relative hrefs become links; anything else stays text.
  // `_`/`__` only delimit emphasis at word boundaries (the closing side is the
  // lookahead here, the opening side is checked in the loop), so snake_case
  // identifiers keep their underscores.
  // A record mention (`[@Maya Chen](mention://contact/<id>)`,
  // src/lib/documents/mention-markdown.ts) is a chip, matched in place like
  // the rest: inside bold it is bold, inside backticks it stays code text.
  const regex = /(\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|\/)[^)\s]*)\)|\*\*(.+?)\*\*|__(.+?)__(?![\p{L}\p{N}_])|_(.+?)_(?![\p{L}\p{N}_])|\*(.+?)\*|`(.+?)`|~~(.+?)~~|\[@([^\]\n]{1,200})\]\(mention:\/\/([a-z_]+)\/([0-9a-fA-F-]{36})\))/gu
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // An underscore delimiter that opens mid-word (`workspace_id`) is literal
    // text: retry from the next character, keeping it in the pending text.
    if (match[0].startsWith('_') && match.index > 0 && WORD_CHAR_RE.test(text[match.index - 1])) {
      regex.lastIndex = match.index + 1
      continue
    }

    // Text before the match
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }

    if (match[2] && match[3]) {
      // Link
      nodes.push(...parseInlineWithMark(match[2], { type: 'link', attrs: { href: match[3] } }))
    } else if (match[4] || match[5]) {
      // Bold
      nodes.push(...parseInlineWithMark(match[4] || match[5], { type: 'bold' }))
    } else if (match[6] || match[7]) {
      // Italic
      nodes.push(...parseInlineWithMark(match[6] || match[7], { type: 'italic' }))
    } else if (match[8]) {
      // Code
      nodes.push({
        type: 'text',
        marks: [{ type: 'code' }],
        text: match[8],
      })
    } else if (match[9]) {
      // Strikethrough
      nodes.push(...parseInlineWithMark(match[9], { type: 'strike' }))
    } else if (match[10] && match[11] && match[12]) {
      // A record mention (a link to no mentionable kind stays its words)
      nodes.push(
        isMentionableType(match[11])
          ? { type: RECORD_MENTION_NODE, attrs: { kind: match[11], id: match[12].toLowerCase(), label: match[10].trim() } }
          : { type: 'text', text: match[0] },
      )
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text }]
}

export function jsonContentToMarkdown(doc: JSONContent): string {
  if (!doc.content) return ''
  return doc.content.map(nodeToMarkdown).join('\n')
}

function nodeToMarkdown(node: JSONContent): string {
  switch (node.type) {
    case 'heading': {
      const level = (node.attrs?.level as number) || 1
      const prefix = '#'.repeat(level)
      return `${prefix} ${inlineToMarkdown(node.content)}`
    }
    case 'paragraph':
      return inlineToMarkdown(node.content)
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listToMarkdown(node, 0)
    case 'blockquote':
      // Prefix EVERY line, not just each child's first: a multi-line quote
      // paragraph (`> a\n> b` parses to one paragraph "a\nb") would otherwise
      // serialize as `> a\nb` and its second line would fall out of the quote.
      return (
        node.content
          ?.flatMap((c) => nodeToMarkdown(c).split('\n').map((l) => `> ${l}`))
          .join('\n') ?? ''
      )
    case 'codeBlock': {
      const language = (node.attrs?.language as string | null | undefined) ?? ''
      const code = inlineToMarkdown(node.content)
      // An empty code block serializes WITHOUT a body line — `\`\`\`\n\n\`\`\``
      // would reparse into an empty text node (invalid) or a one-blank-line
      // body; `\`\`\`\n\`\`\`` round-trips to the same empty codeBlock.
      return code
        ? `\`\`\`${language}\n${code}\n\`\`\``
        : `\`\`\`${language}\n\`\`\``
    }
    case 'horizontalRule':
      return '---'
    case 'table':
      // Pad with blank lines so the table is parsed as its own block by
      // standard GFM parsers (e.g. remark-gfm in read-only views).
      return `\n${tableNodeToMarkdown(node)}\n`
    case 'linkPreview':
      return (node.attrs?.url as string) || ''
    case 'tableEmbed': {
      // One not yet pointed at a table (the slash menu's picker) is nothing.
      const tableId = node.attrs?.tableId as string | null | undefined
      return tableId ? tableLink({ tableId, viewId: (node.attrs?.viewId as string | null | undefined) ?? null }) : ''
    }
    case 'proposalNode':
      return `<!-- proposal:${node.attrs?.changeId ?? ''} -->`
    default:
      return inlineToMarkdown(node.content)
  }
}

/**
 * Serialize a list node (and any nested sublists) to markdown. Nested lists
 * are indented 2 spaces per level — the exact convention `matchListLine`
 * reads back, so nested structures round-trip losslessly.
 */
function listToMarkdown(node: JSONContent, level: number): string {
  const indent = '  '.repeat(level)
  const lines: string[] = []

  ;(node.content ?? []).forEach((item, index) => {
    const marker =
      node.type === 'orderedList'
        ? `${index + 1}. `
        : node.type === 'taskList'
          ? `- [${item.attrs?.checked ? 'x' : ' '}] `
          : '- '

    // Split item children: nested lists recurse one level deeper; everything
    // else (normally the single leading paragraph) joins onto the marker line.
    const inlineParts: string[] = []
    const nestedLists: string[] = []
    for (const child of item.content ?? []) {
      if (LIST_NODE_TYPES.has(child.type ?? '')) {
        nestedLists.push(listToMarkdown(child, level + 1))
      } else {
        inlineParts.push(inlineToMarkdown(child.content))
      }
    }

    lines.push(`${indent}${marker}${inlineParts.join('\n')}`)
    lines.push(...nestedLists)
  })

  return lines.join('\n')
}

/** Serialize a Tiptap `table` node back to a GFM pipe table. */
function tableNodeToMarkdown(node: JSONContent): string {
  const rows = node.content ?? []
  if (rows.length === 0) return ''

  // Extract every row as an array of { text, align } cells.
  const grid = rows.map((row) =>
    (row.content ?? []).map((cell) => {
      const paragraphs = cell.content ?? []
      const text = paragraphs
        .map((para) =>
          inlineToMarkdown(para.content)
            // Escape pipes so they don't break the table syntax.
            .replace(/\|/g, '\\|')
            // Collapse newlines — a markdown table cell is single-line.
            .replace(/\n+/g, ' '),
        )
        // `<br>` keeps every paragraph of the cell on the single row line;
        // the parser splits it back into separate paragraphs.
        .join('<br>')
      const align =
        (paragraphs[0]?.attrs?.textAlign as string | undefined) ?? null
      return { text, align }
    }),
  )

  const [headerRow, ...bodyRows] = grid
  const colCount = Math.max(...grid.map((r) => r.length), 1)

  const renderRow = (cells: { text: string }[]) => {
    const padded = Array.from({ length: colCount }, (_, c) => cells[c]?.text ?? '')
    return `| ${padded.join(' | ')} |`
  }

  const delimiter = Array.from({ length: colCount }, (_, c) => {
    const align = headerRow[c]?.align
    if (align === 'center') return ':---:'
    if (align === 'right') return '---:'
    if (align === 'left') return ':---'
    return '---'
  })

  const lines = [
    renderRow(headerRow),
    `| ${delimiter.join(' | ')} |`,
    ...bodyRows.map(renderRow),
  ]

  return lines.join('\n')
}

/** Wrap `text` in the delimiters of `marks`, innermost first (the order the node lists them). */
function wrapMarks(text: string, marks: JSONContent['marks']): string {
  let out = text
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        out = `**${out}**`
        break
      case 'italic':
        out = `_${out}_`
        break
      case 'code':
        out = `\`${out}\``
        break
      case 'strike':
        out = `~~${out}~~`
        break
      case 'link':
        out = `[${out}](${mark.attrs?.href ?? ''})`
        break
    }
  }
  return out
}

/** A record mention's markdown, without its marks; null for a node that isn't a whole one. */
function mentionNodeMarkdown(node: JSONContent): string | null {
  if (node.type !== RECORD_MENTION_NODE || !isMentionableType(node.attrs?.kind) || typeof node.attrs?.id !== 'string') return null
  return mentionMarkdown({ type: node.attrs.kind, id: node.attrs.id, label: String(node.attrs.label ?? '') })
}

/** The bold, italic and strike marks a run shares with a chip (a chip carries no code or link). */
const RUN_MARKS = new Set(['bold', 'italic', 'strike'])
function runKey(node: JSONContent): string | null {
  const marks = node.marks ?? []
  if (marks.length === 0 || marks.some((m) => !RUN_MARKS.has(m.type))) return null
  if (node.type !== 'text' && mentionNodeMarkdown(node) === null) return null
  return marks.map((m) => m.type).join(',')
}

function inlineToMarkdown(content?: JSONContent[]): string {
  if (!content) return ''
  const out: string[] = []
  for (let i = 0; i < content.length; i++) {
    const node = content[i]
    // A chip inside bold (or italic, or struck) text: the run around it,
    // chip included, is wrapped once (`**the [@Renewal](…) now**`), so the
    // marks stay on the chip and the run reads back as it was written.
    // Plain text runs are written node by node, as before.
    const key = runKey(node)
    if (key !== null) {
      let j = i
      while (j < content.length && runKey(content[j]) === key) j++
      const run = content.slice(i, j)
      if (run.some((n) => n.type === RECORD_MENTION_NODE)) {
        const words = run.map((n) => (n.type === 'text' ? (n.text ?? '') : (mentionNodeMarkdown(n) ?? ''))).join('')
        out.push(wrapMarks(words, node.marks))
        i = j - 1
        continue
      }
    }
    if (node.type === 'text') out.push(wrapMarks(node.text ?? '', node.marks))
    else if (node.type === 'hardBreak') out.push('\n')
    else out.push(mentionNodeMarkdown(node) ?? '')
  }
  return out.join('')
}
