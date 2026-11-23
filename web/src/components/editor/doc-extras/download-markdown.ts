/**
 * "Download as Markdown" (docs/plans/doc-editor-extras.md, phase 4): the
 * document as a `.md` file, its title as a heading, then its body as the
 * editor writes it (math as `$`/`$$`, code fences with their language), so it
 * opens anywhere that reads markdown.
 */
import { documentMarkdown, markdownFileName } from '@/lib/documents/revision-sessions'

export function downloadMarkdown(title: string | null | undefined, body: string | null | undefined) {
  const blob = new Blob([documentMarkdown(title, body)], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = markdownFileName(title)
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
