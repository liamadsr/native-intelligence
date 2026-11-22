'use client'

/**
 * What shows under a formula as it is typed: the functions whose names start
 * with what was typed (arrows to choose, Tab or Enter to take one), or, once
 * inside a function's brackets, its arguments. One list serves the cell's
 * editor and the formula bar: it sits under whichever is being typed in.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import { enclosingFunction, functionPrefix } from '@/lib/spreadsheets/formula-edit'
import { completeFunction, functionInfo, type FunctionInfo } from '@/lib/spreadsheets/functions'
import type { CaretState } from './sheet-grid'

export interface FormulaSuggestHandle {
  /** A key typed in an editor: true when the list took it (so the editor must not). */
  handleKey: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => boolean
}

interface Props {
  workbook: WorkbookController
  caret: React.MutableRefObject<CaretState>
  handle: Ref<FormulaSuggestHandle>
  /** The caret moved without the draft changing (a click, an arrow). */
  caretTick: number
}

export function FormulaSuggest({ workbook, caret, handle, caretTick }: Props) {
  const editing = workbook.editing
  const draft = editing?.draft ?? ''
  const at = Math.min(caret.current.start, draft.length)
  const typing = useMemo(() => (editing ? functionPrefix(draft, at) : null), [editing, draft, at])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo<FunctionInfo[]>(() => (typing ? completeFunction(typing.prefix) : []), [typing?.prefix])
  const inside = useMemo(() => (editing && !options.length ? enclosingFunction(draft, at) : null), [editing, draft, at, options.length])
  const help = inside ? functionInfo(inside.name) : null
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [box, setBox] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => setIndex(0), [typing?.prefix])
  useEffect(() => {
    if (!editing) setDismissed(null)
  }, [editing])

  const open = Boolean(editing) && options.length > 0 && dismissed !== typing?.prefix
  const showHelp = Boolean(editing) && !open && Boolean(help?.signature)

  useLayoutEffect(() => {
    if (!open && !showHelp) {
      setBox(null)
      return
    }
    const source = editing?.source ?? 'cell'
    const el = document.querySelector<HTMLElement>(`[data-formula-input="${source}"]`)
    if (!el) {
      setBox(null)
      return
    }
    const rect = el.getBoundingClientRect()
    setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)), top: rect.bottom + 4 })
  }, [open, showHelp, editing?.source, draft, caretTick])

  const take = (choice: FunctionInfo) => {
    if (!typing) return
    const next = `${draft.slice(0, typing.from)}${choice.name}(${draft.slice(at)}`
    const position = typing.from + choice.name.length + 1
    caret.current = { start: position, end: position, pointed: null }
    workbook.setDraft(next)
  }

  useImperativeHandle(
    handle,
    () => ({
      handleKey: (event) => {
        if (!open) return false
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          setIndex((i) => (i + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
          return true
        }
        if (event.key === 'Tab' || event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          take(options[Math.min(index, options.length - 1)])
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setDismissed(typing?.prefix ?? null)
          return true
        }
        return false
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, options, index, typing?.prefix, typing?.from, draft, at],
  )

  if (!box || typeof document === 'undefined') return null

  if (open) {
    const chosen = options[Math.min(index, options.length - 1)]
    return createPortal(
      <div className={cn(FLOATING_CARD_CLASS, 'fixed z-[70] w-[320px] overflow-hidden p-1 text-sm shadow-lg')} style={box} data-formula-suggest>
        <ul role="listbox" aria-label="Functions" className="max-h-56 overflow-y-auto">
          {options.map((option, i) => (
            <li
              key={option.name}
              role="option"
              aria-selected={i === index}
              className={cn('flex cursor-default items-baseline gap-2 rounded-lg px-2 py-1', i === index && 'bg-accent text-accent-foreground')}
              onPointerDown={(event) => {
                // Keep the focus in the editor.
                event.preventDefault()
                take(option)
              }}
              onPointerEnter={() => setIndex(i)}
            >
              <span className="font-mono text-[12px] font-medium">{option.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{option.categoryLabel}</span>
            </li>
          ))}
        </ul>
        {chosen?.summary && (
          <p className="border-t border-border/60 px-2 pb-1 pt-1.5 text-[12px] leading-snug text-muted-foreground">
            <span className="font-mono text-foreground">{chosen.signature}</span>
            <br />
            {chosen.summary}
          </p>
        )}
      </div>,
      document.body,
    )
  }

  if (showHelp && help?.signature && inside) {
    // The signature, with the argument being typed in bold.
    const openAt = help.signature.indexOf('(')
    const args = help.signature.slice(openAt + 1, -1).split(', ')
    const current = Math.min(inside.argument, args.length) - 1
    return createPortal(
      <div className={cn(FLOATING_CARD_CLASS, 'fixed z-[70] max-w-[420px] px-2.5 py-1.5 text-[12px] shadow-lg')} style={box} data-formula-help>
        <p className="font-mono leading-snug text-muted-foreground">
          <span className="text-foreground">{help.name}</span>(
          {args.map((arg, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <span className={cn(i === current && 'font-semibold text-foreground')}>{arg}</span>
            </span>
          ))}
          )
        </p>
        {help.summary && <p className="mt-0.5 leading-snug text-muted-foreground">{help.summary}</p>}
      </div>,
      document.body,
    )
  }
  return null
}
