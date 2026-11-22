'use client'

/**
 * The inspector: a floating panel on the right, always there. Sections come
 * in one order (Position, Layout, Appearance, Fill, Stroke, Connection,
 * Typography) and one that does not apply is left out. A field shows blank
 * when the selection disagrees. With nothing selected it shows what the next
 * shape will look like.
 */
import * as React from 'react'
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround, ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, FlipHorizontal2, FlipVertical2, type LucideIcon, Pause, Play } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CanvasItem, CanvasStyle, CanvasTextStyle, ConnectorHead, ConnectorRoute, FontFamily, StrokeStyle } from '@/lib/canvas/types'
import { cssColor, isThemeColor, parseHex, splitAlpha, THEME_COLORS, usedColors, withAlpha } from '@/lib/canvas/engine/colors'
import { DEFAULT_LABEL_STYLE, DEFAULT_TEXT_STYLE, LIMITS } from '@/lib/canvas/engine/defaults'
import { round } from '@/lib/canvas/engine/geometry'
import { boundsOf, leavesOf, selectionRoots } from '@/lib/canvas/engine/scene'
import { cn } from '@/lib/utils'
import { useCanvas, useCanvasStore } from './use-canvas'

const MIXED = Symbol('mixed')
type Maybe<T> = T | typeof MIXED | undefined

function common<T>(items: readonly CanvasItem[], get: (it: CanvasItem) => T | undefined): Maybe<T> {
  let value: T | undefined
  let seen = false
  for (const it of items) {
    const v = get(it)
    if (!seen) {
      value = v
      seen = true
    } else if (v !== value) return MIXED
  }
  return value
}
const known = <T,>(v: Maybe<T>): T | undefined => (v === MIXED ? undefined : v)

/** Play and pause the video on the canvas (it is drawn muted, and takes no pointer of its own). */
function VideoControls({ id }: { id: string }) {
  const find = React.useCallback(() => document.querySelector<HTMLVideoElement>(`[data-canvas-item="${CSS.escape(id)}"] video`), [id])
  const [playing, setPlaying] = React.useState(false)
  React.useEffect(() => {
    const v = find()
    if (!v) return
    const sync = () => setPlaying(!v.paused && !v.ended)
    sync()
    v.addEventListener('play', sync)
    v.addEventListener('pause', sync)
    v.addEventListener('ended', sync)
    return () => {
      v.removeEventListener('play', sync)
      v.removeEventListener('pause', sync)
      v.removeEventListener('ended', sync)
    }
  }, [find])
  return (
    <button
      type="button"
      data-canvas-video-toggle
      onClick={() => {
        const v = find()
        if (!v) return
        if (v.paused || v.ended) void v.play().catch(() => {})
        else v.pause()
      }}
      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border/60 text-xs text-foreground hover:bg-foreground/[0.04]"
    >
      {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      {playing ? 'Pause' : 'Play'}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section data-canvas-section={title} className="border-b border-border/50 px-3 py-2.5 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {label ? <span className="w-12 shrink-0 text-xs text-muted-foreground">{label}</span> : null}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

/** A number you type. Commits on Enter or on leaving; Escape puts the old value back; arrows step. */
export function NumField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
  disabled,
}: {
  label: string
  value: number | undefined
  onCommit: (n: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  disabled?: boolean
}) {
  const shown = value === undefined ? '' : String(round(value, 2))
  const [draft, setDraft] = React.useState<string | null>(null)
  const commit = (text: string) => {
    setDraft(null)
    const n = Number(text.replace(/[^0-9.+\-e]/g, ''))
    if (text.trim() === '' || !Number.isFinite(n)) return
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <label className={cn('flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 text-xs focus-within:border-primary/60', disabled && 'opacity-50')}>
      <span className="shrink-0 select-none text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        className="w-full min-w-0 bg-transparent text-right tabular-nums text-foreground outline-none"
        value={draft ?? shown}
        placeholder={value === undefined ? '—' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => draft !== null && commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value)
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== undefined) {
            e.preventDefault()
            const next = value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            commit(String(next))
          }
        }}
      />
      {suffix ? <span className="shrink-0 select-none text-muted-foreground">{suffix}</span> : null}
    </label>
  )
}

function IconToggle({ label, icon: Icon, active, disabled, onClick }: { label: string; icon: LucideIcon; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-35',
            active && 'bg-foreground/10 text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T | undefined; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-border/60 bg-background/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('h-full min-w-0 flex-1 truncate rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground', value === o.value && 'bg-foreground/10 text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Swatch({ color, label, active, onPick }: { color: string; label: string; active?: boolean; onPick: () => void }) {
  const none = color === 'transparent'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onPick}
      className={cn('relative h-5 w-5 rounded-full border border-border/70', active && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}
      style={{ background: none ? undefined : cssColor(color) }}
    >
      {none ? <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-red-500" /> : null}
    </button>
  )
}

/** A color: the swatch opens the palette (the app's colors, this canvas's own, a hex and an opacity). */
function ColorField({ label, value, onChange, allowNone, used }: { label: string; value: Maybe<string>; onChange: (color: string) => void; allowNone?: boolean; used: readonly string[] }) {
  const cur = known(value)
  const custom = cur && !isThemeColor(cur) && cur !== 'transparent' ? splitAlpha(cur) : null
  const [hex, setHex] = React.useState<string | null>(null)
  const text = value === MIXED ? 'Mixed' : !cur || cur === 'transparent' ? 'None' : isThemeColor(cur) ? (THEME_COLORS.find((c) => `theme:${c.id}` === cur)?.label ?? cur) : cur.slice(0, 7).toUpperCase()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/60 bg-background/60 px-1.5 text-xs hover:border-border">
          <span className="relative h-4 w-4 shrink-0 overflow-hidden rounded-full border border-border/70" style={{ background: cur && cur !== 'transparent' ? cssColor(cur) : undefined }}>
            {!cur || cur === 'transparent' ? <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-red-500" /> : null}
          </span>
          <span className="truncate text-foreground">{text}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" align="start" sideOffset={12} className="w-56 space-y-3 p-3" data-canvas-chrome>
        <div className="flex flex-wrap gap-1.5">
          {allowNone ? <Swatch color="transparent" label="None" active={cur === 'transparent'} onPick={() => onChange('transparent')} /> : null}
          {THEME_COLORS.map((c) => (
            <Swatch key={c.id} color={`theme:${c.id}`} label={c.label} active={cur === `theme:${c.id}`} onPick={() => onChange(`theme:${c.id}`)} />
          ))}
        </div>
        {used.length ? (
          <div>
            <div className="mb-1.5 text-[11px] text-muted-foreground">On this canvas</div>
            <div className="flex flex-wrap gap-1.5">
              {used.map((c) => (
                <Swatch key={c} color={c} label={c.toUpperCase()} active={cur === c} onPick={() => onChange(c)} />
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            aria-label={`${label} picker`}
            className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent p-0"
            value={custom?.rgb ?? '#000000'}
            onChange={(e) => onChange(withAlpha(e.target.value, custom?.alpha ?? 1))}
          />
          <input
            aria-label={`${label} hex`}
            className="h-7 w-full min-w-0 rounded-md border border-border/60 bg-background/60 px-1.5 text-xs uppercase text-foreground outline-none focus:border-primary/60"
            placeholder="#000000"
            value={hex ?? custom?.rgb ?? ''}
            onChange={(e) => setHex(e.target.value)}
            onBlur={() => {
              const parsed = hex !== null ? parseHex(hex) : null
              setHex(null)
              if (parsed) onChange(withAlpha(parsed, parsed.length === 9 ? splitAlpha(parsed).alpha : (custom?.alpha ?? 1)))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </div>
        {custom ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Opacity
            <input
              type="range"
              min={0}
              max={100}
              aria-label={`${label} opacity`}
              className="w-full accent-primary"
              value={Math.round(custom.alpha * 100)}
              onChange={(e) => onChange(withAlpha(custom.rgb, Number(e.target.value) / 100))}
            />
            <span className="w-8 text-right tabular-nums text-foreground">{Math.round(custom.alpha * 100)}%</span>
          </label>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

const HEADS: ReadonlyArray<{ value: ConnectorHead; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'arrow', label: 'Arrow' },
  { value: 'filled', label: 'Filled arrow' },
  { value: 'dot', label: 'Dot' },
  { value: 'small-dot', label: 'Small dot' },
]

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T | undefined; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <select
      aria-label={label}
      className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background/60 px-1 text-xs text-foreground outline-none focus:border-primary/60"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {value === undefined ? <option value="">—</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function CanvasInspector({ sheet = false }: { /** On a narrow screen: open as a sheet over the lower half. */ sheet?: boolean }) {
  const store = useCanvasStore()
  // The panel follows the canvas a beat behind when the canvas is busy (a marquee over hundreds of items, a drag):
  // the drawing comes first.
  const scene = React.useDeferredValue(useCanvas((s) => s.scene))
  const selection = React.useDeferredValue(useCanvas((s) => s.selection))
  const defaults = useCanvas((s) => s.defaults)
  const readOnly = useCanvas((s) => s.readOnly)

  const leaves = React.useMemo(() => leavesOf(scene, selection), [scene, selection])
  const roots = React.useMemo(() => selectionRoots(scene, selection), [scene, selection])
  const used = React.useMemo(() => usedColors(Object.values(scene.items) as Array<{ style: CanvasStyle; text?: CanvasTextStyle }>), [scene])
  if (readOnly) return null

  const none = leaves.length === 0
  const kinds = new Set(leaves.map((it) => it.kind))
  const only = (...ks: string[]) => !none && [...kinds].every((k) => ks.includes(k))
  const any = (...ks: string[]) => [...kinds].some((k) => ks.includes(k))
  const box = none ? null : boundsOf(scene, selection)
  const single = roots.length === 1 ? scene.items[roots[0]] : undefined
  const turnable = single && single.kind !== 'group' && single.kind !== 'connector'
  // A connector tied at both ends is placed by its shapes, not by numbers.
  const fixed = !!single && single.kind === 'connector' && !!single.start.bind && !!single.end.bind

  const style = <K extends keyof CanvasStyle>(key: K): Maybe<CanvasStyle[K]> => (none ? defaults.shape[key] : common(leaves, (it) => it.style[key]))
  const hasFill = none || any('rectangle', 'ellipse')
  const hasStroke = none || any('rectangle', 'ellipse', 'connector', 'pencil')
  const hasDash = none || any('rectangle', 'ellipse', 'connector')
  const texty = leaves.filter((it) => it.kind === 'text' || ((it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector') && !!it.label?.plain))
  const textOf = (it: CanvasItem): CanvasTextStyle => (it.kind === 'text' ? { ...DEFAULT_TEXT_STYLE, ...it.text } : { ...DEFAULT_LABEL_STYLE, ...(it as { text?: CanvasTextStyle }).text })
  const textIds = texty.map((it) => it.id)
  const freeText = leaves.filter((it): it is Extract<CanvasItem, { kind: 'text' }> => it.kind === 'text')

  return (
    <aside
      data-canvas-chrome
      data-canvas-inspector
      aria-label="Inspector"
      data-canvas-sheet={sheet ? 'open' : undefined}
      className={cn(
        FLOATING_CARD_CLASS,
        'absolute z-20 flex-col overflow-y-auto md:bottom-16 md:left-auto md:right-4 md:top-4 md:flex md:max-h-none md:w-64',
        // Narrow: hidden until asked for, then a sheet over the lower half so the shape stays in view.
        sheet ? 'inset-x-2 bottom-[10.25rem] flex max-h-[45%]' : 'hidden',
      )}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {none ? <div className="border-b border-border/50 px-3 py-2.5 text-xs text-muted-foreground">Nothing selected. These are the next shape&rsquo;s colors.</div> : null}

      {box ? (
        <Section title="Position">
          <Row>
            <NumField label="X" value={box.x} disabled={fixed} onCommit={(x) => store.pose({ x })} />
            <NumField label="Y" value={box.y} disabled={fixed} onCommit={(y) => store.pose({ y })} />
          </Row>
          <Row>
            <NumField
              label="∠"
              suffix="°"
              disabled={!turnable}
              value={turnable ? round((single.rotation * 180) / Math.PI, 1) : undefined}
              onCommit={(deg) => store.pose({ rotation: (deg * Math.PI) / 180 })}
            />
            <IconToggle label="Flip horizontally" icon={FlipHorizontal2} onClick={() => store.flip('x')} />
            <IconToggle label="Flip vertically" icon={FlipVertical2} onClick={() => store.flip('y')} />
          </Row>
        </Section>
      ) : null}

      {single?.kind === 'video' ? (
        <Section title="Video">
          <VideoControls key={single.id} id={single.id} />
        </Section>
      ) : null}

      {box ? (
        <Section title="Layout">
          <Row>
            <NumField label="W" min={1} value={turnable ? single.w : box.w} disabled={fixed || only('connector')} onCommit={(w) => store.pose({ w })} />
            <NumField label="H" min={1} value={turnable ? single.h : box.h} disabled={fixed || only('connector')} onCommit={(h) => store.pose({ h })} />
          </Row>
          <Row>
            <IconToggle label="Align left" icon={AlignStartVertical} disabled={roots.length < 2} onClick={() => store.align('left')} />
            <IconToggle label="Align center" icon={AlignCenterVertical} disabled={roots.length < 2} onClick={() => store.align('center')} />
            <IconToggle label="Align right" icon={AlignEndVertical} disabled={roots.length < 2} onClick={() => store.align('right')} />
            <IconToggle label="Align top" icon={AlignStartHorizontal} disabled={roots.length < 2} onClick={() => store.align('top')} />
            <IconToggle label="Align middle" icon={AlignCenterHorizontal} disabled={roots.length < 2} onClick={() => store.align('middle')} />
            <IconToggle label="Align bottom" icon={AlignEndHorizontal} disabled={roots.length < 2} onClick={() => store.align('bottom')} />
          </Row>
          <Row>
            <IconToggle label="Distribute horizontally" icon={AlignHorizontalSpaceAround} disabled={roots.length < 3} onClick={() => store.distribute('x')} />
            <IconToggle label="Distribute vertically" icon={AlignVerticalSpaceAround} disabled={roots.length < 3} onClick={() => store.distribute('y')} />
            <span className="mx-0.5 h-4 w-px bg-border" />
            <IconToggle label="Bring to front" icon={ArrowUpToLine} onClick={() => store.reorder('front')} />
            <IconToggle label="Bring forward" icon={ChevronUp} onClick={() => store.reorder('forward')} />
            <IconToggle label="Send backward" icon={ChevronDown} onClick={() => store.reorder('backward')} />
            <IconToggle label="Send to back" icon={ArrowDownToLine} onClick={() => store.reorder('back')} />
          </Row>
        </Section>
      ) : null}

      <Section title="Appearance">
        <Row label="Opacity">
          <NumField label="" suffix="%" min={0} max={100} value={known(style('opacity')) === undefined && style('opacity') !== MIXED ? 100 : known(style('opacity')) !== undefined ? Math.round(known(style('opacity'))! * 100) : undefined} onCommit={(n) => store.style({ opacity: n / 100 })} />
        </Row>
        {none || any('rectangle') ? (
          <Row label="Radius">
            <NumField
              label=""
              min={0}
              max={LIMITS.radiusMax}
              value={none ? (defaults.shape.radius ?? 0) : known(common(leaves.filter((it) => it.kind === 'rectangle'), (it) => it.style.radius ?? 0))}
              onCommit={(radius) => store.style({ radius })}
            />
          </Row>
        ) : null}
      </Section>

      {hasFill ? (
        <Section title="Fill">
          <Row>
            <ColorField label="Fill color" allowNone used={used} value={none ? defaults.shape.fill : common(leaves.filter((it) => it.kind === 'rectangle' || it.kind === 'ellipse'), (it) => it.style.fill ?? 'transparent')} onChange={(fill) => store.style({ fill })} />
          </Row>
        </Section>
      ) : null}

      {hasStroke ? (
        <Section title="Stroke">
          <Row>
            <ColorField label="Stroke color" allowNone={hasFill} used={used} value={style('stroke') ?? 'transparent'} onChange={(stroke) => store.style({ stroke })} />
          </Row>
          <Row label="Weight">
            <NumField label="" min={0} max={LIMITS.strokeMax} step={0.5} value={known(style('strokeWidth')) ?? (style('strokeWidth') === MIXED ? undefined : 0)} onCommit={(strokeWidth) => store.style({ strokeWidth })} />
          </Row>
          {hasDash ? (
            <Row label="Style">
              <Segmented<StrokeStyle>
                label="Stroke style"
                value={known(style('strokeStyle')) ?? (style('strokeStyle') === MIXED ? undefined : 'solid')}
                options={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'dashed', label: 'Dashed' },
                  { value: 'dotted', label: 'Dotted' },
                ]}
                onChange={(strokeStyle) => store.style({ strokeStyle })}
              />
            </Row>
          ) : null}
        </Section>
      ) : null}

      {any('connector') ? (
        <Section title="Connection">
          <Row label="Route">
            <Segmented<ConnectorRoute>
              label="Route"
              value={known(common(leaves.filter((it) => it.kind === 'connector'), (it) => (it.kind === 'connector' ? it.route : undefined)))}
              options={[
                { value: 'straight', label: 'Straight' },
                { value: 'elbow', label: 'Elbow' },
                { value: 'smooth', label: 'Smooth' },
              ]}
              onChange={(route) => store.connectorStyle({ route })}
            />
          </Row>
          <Row label="Start">
            <Select<ConnectorHead> label="Start head" options={HEADS} value={known(common(leaves.filter((it) => it.kind === 'connector'), (it) => (it.kind === 'connector' ? it.startHead : undefined)))} onChange={(startHead) => store.connectorStyle({ startHead })} />
          </Row>
          <Row label="End">
            <Select<ConnectorHead> label="End head" options={HEADS} value={known(common(leaves.filter((it) => it.kind === 'connector'), (it) => (it.kind === 'connector' ? it.endHead : undefined)))} onChange={(endHead) => store.connectorStyle({ endHead })} />
          </Row>
        </Section>
      ) : null}

      {texty.length ? (
        <Section title="Typography">
          <Row label="Font">
            <Segmented<FontFamily>
              label="Font"
              value={known(common(texty, (it) => textOf(it).fontFamily))}
              options={[
                { value: 'sans', label: 'Sans' },
                { value: 'serif', label: 'Serif' },
                { value: 'mono', label: 'Mono' },
              ]}
              onChange={(fontFamily) => store.apply((s) => applyText(s, textIds, { fontFamily }))}
            />
          </Row>
          <Row label="Size">
            <NumField label="" min={LIMITS.fontMin} max={LIMITS.fontMax} value={known(common(texty, (it) => textOf(it).fontSize))} onCommit={(fontSize) => store.apply((s) => applyText(s, textIds, { fontSize }))} />
          </Row>
          <Row label="Color">
            <ColorField label="Text color" used={used} value={common(texty, (it) => textOf(it).color)} onChange={(color) => store.apply((s) => applyText(s, textIds, { color }))} />
          </Row>
          <Row label="Align">
            <Segmented<'left' | 'center' | 'right'>
              label="Text align"
              value={known(common(texty, (it) => textOf(it).align))}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(align) => store.apply((s) => applyText(s, textIds, { align }))}
            />
          </Row>
          {freeText.length ? (
            <Row label="Width">
              <Segmented<'auto' | 'wrap'>
                label="Text width"
                value={known(common(freeText, (it) => ((it as Extract<CanvasItem, { kind: 'text' }>).autoWidth ? 'auto' : 'wrap')))}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'wrap', label: 'Wrap' },
                ]}
                onChange={(mode) =>
                  store.apply((s) => ({
                    items: {
                      ...s.items,
                      ...Object.fromEntries(freeText.filter((it) => s.items[it.id]).map((it) => [it.id, { ...s.items[it.id], autoWidth: mode === 'auto' }])),
                    },
                  }))
                }
              />
            </Row>
          ) : null}
        </Section>
      ) : null}
    </aside>
  )
}

function applyText(scene: import('@/lib/canvas/engine/scene').Scene, ids: readonly string[], patch: Partial<CanvasTextStyle>) {
  const items = { ...scene.items }
  for (const id of ids) {
    const it = items[id]
    if (!it) continue
    if (it.kind === 'text') items[id] = { ...it, text: { ...it.text, ...patch } }
    else if (it.kind === 'rectangle' || it.kind === 'ellipse' || it.kind === 'connector') items[id] = { ...it, text: { ...it.text, ...patch } }
  }
  return { items }
}
