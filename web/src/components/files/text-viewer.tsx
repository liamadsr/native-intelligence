'use client'

/** A text or source file, as text (never run, never rendered as HTML), with line numbers. */
import * as React from 'react'

const MAX_LINES = 50_000

export default function TextViewer({ blob, name }: { blob: Blob; name: string }) {
  const [text, setText] = React.useState<string | null>(null)
  const [wrap, setWrap] = React.useState(false)
  React.useEffect(() => {
    let live = true
    void blob.text().then((t) => live && setText(t))
    return () => {
      live = false
    }
  }, [blob])
  if (text === null) return null
  const all = text.replace(/\r\n?/g, '\n').split('\n')
  const lines = all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span>{all.length.toLocaleString()} lines</span>
        <button type="button" onClick={() => setWrap((w) => !w)} aria-pressed={wrap} className="rounded px-2 py-0.5 hover:bg-muted/60 hover:text-foreground">
          {wrap ? 'No wrap' : 'Wrap'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-background">
        <table className="font-mono text-xs leading-5" data-file-viewer-text={name}>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i}>
                <td className="select-none border-r border-border px-3 text-right align-top tabular-nums text-muted-foreground/60">{i + 1}</td>
                <td className={wrap ? 'whitespace-pre-wrap break-all px-3' : 'whitespace-pre px-3'}>{line || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {all.length > MAX_LINES && <p className="p-4 text-xs text-muted-foreground">Only the first {MAX_LINES.toLocaleString()} lines are shown. Download the file for the rest.</p>}
      </div>
    </div>
  )
}
