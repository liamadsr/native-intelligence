'use client'
// The Record dialog's "Script & checklist" row: the script to read while recording (typed, pasted, or copied from one
// of the workspace's scripts) and the points to make, one per item. Kept for the next take (usePrompterContent).
import { useState } from 'react'
import { cleanItemText, itemsFromText } from '@/lib/studio/prompter/checklist'
import { MAX_ITEM_CHARS, MAX_ITEMS, MAX_SCRIPT_CHARS, type PrompterContent } from '@/lib/studio/prompter/content'
import { StudioSelect } from '../ui/controls'
import { newItemId, type PrompterStore } from './usePrompterContent'

type ScriptSummary = { id: string; title: string; beats: { text: string; label?: string }[] }

type Props = {
  store: PrompterStore
  /** The workspace's scripts, to copy one in. */
  scripts: ScriptSummary[]
  /** The storyboard beats' own lines, when recording into beats (they are the script then). */
  beatLines?: { text: string }[] | null
  disabled?: boolean
}

export function PrompterSetup({ store, scripts, beatLines, disabled }: Props) {
  const { content, change } = store
  const [draft, setDraft] = useState('')
  const set = (patch: Partial<PrompterContent>) => change({ ...content, ...patch })
  const useScript = (id: string) => {
    const script = scripts.find((s) => s.id === id)
    if (script) set({ script: script.beats.map((b) => b.text).join('\n').slice(0, MAX_SCRIPT_CHARS) })
  }
  const add = (text: string) => {
    // A pasted list makes one item per line.
    const fresh = itemsFromText(text, newItemId).map((i) => ({ ...i, text: i.text.slice(0, MAX_ITEM_CHARS) }))
    if (!fresh.length) return
    set({ items: [...content.items, ...fresh].slice(0, MAX_ITEMS) })
    setDraft('')
  }
  const full = content.items.length >= MAX_ITEMS

  return <div className="rd-prompter-setup flex w-full flex-col gap-2">
    {beatLines?.length
      ? <small className="rd-note">The beats’ own lines are the script ({beatLines.length}).</small>
      : <>
        <label className="sr-only" htmlFor="rd-prompter-script">Script</label>
        <textarea id="rd-prompter-script" className="rd-prompter-text w-full resize-y rounded-md border px-2.5 py-2 text-sm" rows={4} maxLength={MAX_SCRIPT_CHARS} disabled={disabled}
          placeholder="Paste or type what you’ll say. One line per thought. You don’t have to read it word for word."
          value={content.script} onChange={(e) => set({ script: e.target.value })} />
        {scripts.length ? <StudioSelect size="normal" aria-label="Use a script" value="" disabled={disabled} onChange={useScript}>
          <option value="">Use a script…</option>
          {scripts.map((s) => <option key={s.id} value={s.id}>{s.title} · {s.beats.length} lines</option>)}
        </StudioSelect> : null}
      </>}
    <div className="flex w-full flex-col gap-1" role="group" aria-label="Checklist">
      <span className="rd-note">Checklist{content.items.length ? ` · ${content.items.length}` : ''}</span>
      {content.items.length ? <ol className="flex w-full flex-col gap-1">
        {content.items.map((item, i) => <li key={item.id} className="flex items-center gap-1.5">
          <span className="w-5 shrink-0 text-right text-xs tabular-nums opacity-60">{i + 1}.</span>
          <input className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm" aria-label={`Item ${i + 1}`} maxLength={MAX_ITEM_CHARS} disabled={disabled} value={item.text}
            onChange={(e) => set({ items: content.items.map((x) => (x.id === item.id ? { ...x, text: e.target.value } : x)) })}
            onBlur={(e) => { const text = cleanItemText(e.target.value); set({ items: text ? content.items.map((x) => (x.id === item.id ? { ...x, text } : x)) : content.items.filter((x) => x.id !== item.id) }) }} />
          <button type="button" className="rd-link" disabled={disabled} aria-label={`Remove item ${i + 1}`} onClick={() => set({ items: content.items.filter((x) => x.id !== item.id) })}>Remove</button>
        </li>)}
      </ol> : null}
      {!full ? <input className="w-full rounded-md border px-2 py-1 text-sm" aria-label="Add an item" placeholder="Add an item, then Enter" disabled={disabled} value={draft} maxLength={MAX_ITEM_CHARS * MAX_ITEMS}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft) } }}
        onPaste={(e) => { const text = e.clipboardData.getData('text'); if (text.includes('\n')) { e.preventDefault(); add(text) } }} /> : <small className="rd-note">That’s the most items a checklist holds.</small>}
    </div>
    {store.error ? <small className="rd-note rd-note-warn" role="alert">{store.error}</small> : null}
  </div>
}
