// @vitest-environment jsdom
/**
 * The two surfaces read the same markdown the same way. Each fixture goes
 * through the REAL renderers — rendered markdown (components/ui/markdown.tsx,
 * react-markdown) and the note editor's markdown → TipTap conversion
 * (views/markdown-conversion.ts) — and every anchor must give the same
 * section: the same sentences, the same coversAll, the same button decision.
 *
 * Inline `[text](url)` links included: the editor's markdown import makes
 * them link marks (as the note editor's TiptapLink does), and the editor side
 * reads a link as its text, as rendered markdown reads the <a>.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { Node as TiptapNode } from '@tiptap/core'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }))

import { Markdown } from '@/components/ui/markdown'
import { markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'
import {
  collectDomSection,
  collectPmSection,
  domAnchorRank,
  linesToSentences,
  pmAnchorRank,
  sectionHasButton,
  type SectionSpeech,
} from '../sections'

const schema = getSchema([
  StarterKit,
  Link,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
  TiptapNode.create({ name: 'linkPreview', group: 'block', atom: true, addAttributes: () => ({ url: { default: null } }) }),
])

const LONG = 'The team agreed to ship the beta on Friday, after the last round of fixes lands and support has read the release notes twice.'

const FIXTURES: Record<string, string> = {
  'headings and lead-ins': [
    'Intro before the plan.',
    '# Launch',
    '## Plan',
    LONG,
    '### Phase one',
    `Phase one is the ${LONG.toLowerCase()}`,
    '**Risks**',
    '- Vendor delay on the **API** keys',
    '- Nobody owns the docs',
    '**Owners:**',
    'Sam and Priya.',
    '## Budget',
    `${LONG} Finance signed off.`,
  ].join('\n\n'),
  'what is skipped': [
    '## Setup',
    'Run the installer first, then check the logs, and when it is green tell the rest of the team in the channel.',
    '```bash\nnpm install\n```',
    '| Area | Owner |\n| --- | --- |\n| Web | Sam |',
    '---',
    '> Quote the release notes to the customer, word for word, before the call on Friday.',
    '1. Book the room',
    '2. Send the deck',
  ].join('\n\n'),
  'inline links': [
    '## Reading list',
    'Start with [the setup guide](https://nativeintelligence.dev/docs/setup) and then [the changelog](https://nativeintelligence.dev/changelog), so the call on Friday has no surprises for anyone at all.',
  ].join('\n\n'),
  'links and emoji': [
    '## Links 🔗',
    'Read https://www.nativeintelligence.dev/docs/setup before the call 🎉 and the release notes at https://nativeintelligence.dev/changelog after it, so nothing surprises you.',
  ].join('\n\n'),
}

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = null
  container = null
})

async function renderDom(markdown: string): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(h(Markdown, { children: markdown })))
  return container.firstElementChild as HTMLElement
}

interface Reading {
  sentences: string[]
  coversAll: boolean
  button: boolean
}

const reading = (section: SectionSpeech): Reading => ({
  sentences: linesToSentences(section.lines),
  coversAll: section.coversAll,
  button: sectionHasButton(section),
})

describe('rendered markdown and the note editor read a section the same way', () => {
  it.each(Object.entries(FIXTURES))('%s', async (_name, markdown) => {
    const markdownRoot = await renderDom(markdown)
    const fromDom = [...markdownRoot.children]
      .filter((el) => domAnchorRank(el) !== null)
      .map((el) => reading(collectDomSection(el, markdownRoot)!))

    const doc = schema.nodeFromJSON(markdownToJSONContent(markdown))
    const fromEditor: Reading[] = []
    doc.forEach((node, _offset, index) => {
      if (pmAnchorRank(node) !== null) fromEditor.push(reading(collectPmSection(doc, index)!))
    })

    expect(fromDom.length).toBeGreaterThan(0)
    expect(fromEditor).toEqual(fromDom)
  })
})
