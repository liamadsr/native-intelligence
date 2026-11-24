'use client'
// The script and checklist shown while a take records, never in the picture: in the floating control's panel
// (desktop, content-protected) or in the Record dialog when what is recorded is another window or tab. The script
// follows the speaker (when the words come live) with the current line a third of the way down; scrolling by hand
// pauses that until Resume. The checklist is checked by hand at any time, and checks itself when an item is clearly
// said (never one the person unchecked). The text is the person's: nothing here logs it.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { ChecklistItem } from '@/lib/studio/prompter/checklist'
import type { Following } from '@/lib/studio/prompter/channel'
import { currentLine, type ScriptLine } from '@/lib/studio/prompter/follow'
import type { Heard } from '@/lib/studio/prompter/live-words'
import { easeStep, scrollTarget } from '@/lib/studio/prompter/scroll'
import { usePrompter } from './usePrompter'

const SIZE_KEY = 'ni:studio:prompter-text-size'
export const TEXT_SIZES = { min: 14, max: 44, step: 2 } as const

/** What the person is told about following, by why it is or isn't on. */
export function followingNote(following: Following): string | null {
  switch (following) {
    case 'on': return null
    case 'no-local': return 'Following needs Local transcription (Settings › Audio). Scroll by hand for now.'
    case 'old-app': return 'Following needs a newer version of the app. Scroll by hand for now.'
    case 'browser': return 'Scroll by hand. Following works in the desktop app.'
  }
}

function readSize(fallback: number): number {
  try { const n = Number(localStorage.getItem(SIZE_KEY)); return n >= TEXT_SIZES.min && n <= TEXT_SIZES.max ? n : fallback } catch { return fallback }
}

type Props = {
  lines: ScriptLine[]
  items: ChecklistItem[]
  heard: Heard
  following: Following
  /** Bigger text and a tighter frame in the floating control. */
  variant?: 'hud' | 'page'
  className?: string
}

export function PrompterPanel({ lines, items, heard, following, variant = 'page', className }: Props) {
  const { index, place, checks, next, toggleItem, startAt } = usePrompter(lines, items, heard)
  const [size, setSize] = useState(() => readSize(variant === 'hud' ? 22 : 18))
  const [paused, setPaused] = useState(false)
  const view = useRef<HTMLDivElement | null>(null)
  const rows = useRef<(HTMLParagraphElement | null)[]>([])
  const current = currentLine(index, place.shown)
  const live = following === 'on'

  const changeSize = (delta: number) => setSize((s) => {
    const n = Math.max(TEXT_SIZES.min, Math.min(TEXT_SIZES.max, s + delta))
    try { localStorage.setItem(SIZE_KEY, String(n)) } catch { /* a preference only */ }
    return n
  })

  // The smooth scroll toward the current line, one eased step per frame, while following.
  useEffect(() => {
    if (!live || paused) return
    let frame = 0, last = performance.now()
    const step = (now: number) => {
      const el = view.current, row = rows.current[current]
      if (el && row) {
        const target = scrollTarget(row.offsetTop, row.offsetHeight, el.clientHeight, el.scrollHeight)
        const at = easeStep(el.scrollTop, target, now - last)
        if (at !== el.scrollTop) el.scrollTop = at
      }
      last = now
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [live, paused, current, size])

  // Scrolling by hand takes over until Resume.
  const takeOver = () => { if (live) setPaused(true) }
  const onKey = (e: React.KeyboardEvent) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) takeOver() }

  // Words of the current line already said, dimmed.
  const said = place.shown >= 0 ? index.tokens[place.shown] : undefined
  const saidTo = said && said.line === current ? said.to : 0
  const done = items.filter((i) => checks.checked.has(i.id)).length
  const note = followingNote(following)
  const hud = variant === 'hud'

  return <div className={cn('flex min-h-0 flex-col gap-2 text-neutral-900 dark:text-neutral-100', className)} data-testid="prompter-panel">
    {lines.length ? <section aria-label="Script" className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 pb-1 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
        <span className="uppercase tracking-wide">Script</span>
        {live ? <span className={cn('rounded-full px-1.5 py-px', paused ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')} role="status">{paused ? 'Paused' : 'Following'}</span> : null}
        <span className="flex-1" />
        <button type="button" className="h-6 rounded px-1.5 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10" onClick={() => changeSize(-TEXT_SIZES.step)} disabled={size <= TEXT_SIZES.min} aria-label="Smaller text">A−</button>
        <button type="button" className="h-6 rounded px-1.5 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10" onClick={() => changeSize(TEXT_SIZES.step)} disabled={size >= TEXT_SIZES.max} aria-label="Bigger text">A+</button>
      </div>
      <div ref={view} tabIndex={0} onWheel={takeOver} onTouchMove={takeOver} onKeyDown={onKey}
        onPointerDown={(e) => { if (e.target === e.currentTarget) takeOver() }}
        className={cn('min-h-0 flex-1 overflow-y-auto rounded-lg outline-none', hud ? 'pb-[60%]' : 'max-h-72 pb-24')}
        style={{ fontSize: size, lineHeight: 1.35 }} aria-label="Script lines">
        {lines.map((line, i) => <p key={i} ref={(el) => { rows.current[i] = el }} onClick={() => { startAt(i); setPaused(false) }}
          className={cn('cursor-pointer rounded-md px-2 py-1 transition-opacity', i === current ? 'bg-black/[0.04] font-semibold opacity-100 dark:bg-white/[0.06]' : 'opacity-45 hover:opacity-70')}
          aria-current={i === current ? 'true' : undefined} title="Start here">
          {line.label ? <span className="mr-1.5 text-[0.6em] font-medium uppercase tracking-wide text-neutral-500">{line.label}</span> : null}
          {i === current && saidTo > 0 ? <><span className="opacity-50">{line.text.slice(0, saidTo)}</span>{line.text.slice(saidTo)}</> : line.text}
        </p>)}
      </div>
      {live && paused ? <button type="button" onClick={() => setPaused(false)} className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-neutral-900 px-3 py-1 text-xs font-semibold text-white shadow-md dark:bg-white dark:text-neutral-900">Resume following</button> : null}
    </section> : null}
    {note && lines.length ? <p className="text-[11px] text-neutral-500 dark:text-neutral-400" data-testid="prompter-note">{note}</p> : null}
    {items.length ? <section aria-label="Checklist" className={cn('flex min-h-0 flex-col', lines.length ? 'max-h-[45%] shrink-0' : 'flex-1')}>
      <div className="flex items-center gap-1.5 pb-1 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
        <span className="uppercase tracking-wide">Checklist</span><span>{done} of {items.length}</span>
      </div>
      <ul className="min-h-0 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const on = checks.checked.has(item.id), isNext = item.id === next
          return <li key={item.id}>
            <button type="button" role="checkbox" aria-checked={on} onClick={() => toggleItem(item.id)}
              className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left', hud ? 'text-[15px]' : 'text-sm',
                isNext ? 'bg-blue-500/10 ring-1 ring-blue-500/40' : 'hover:bg-black/5 dark:hover:bg-white/10')}
              title={on && checks.auto.has(item.id) ? 'Checked when you said it. Click to uncheck.' : undefined}>
              <span aria-hidden className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-[11px] leading-none', on ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-neutral-400')}>{on ? '✓' : ''}</span>
              <span className={cn(on && 'text-neutral-500 line-through')}>{item.text}</span>
            </button>
          </li>
        })}
      </ul>
    </section> : null}
  </div>
}
