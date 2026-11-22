'use client'

/**
 * A chart drawn as our own SVG (no chart library): column, bar, line, area,
 * pie, doughnut and scatter, from the data charts.ts prepared. Axes with round
 * ticks, compact value labels, a legend, colors from a fixed accessible
 * palette; an empty range draws a quiet "No numbers in this range".
 *
 * Colors of the surround come from theme tokens (text-foreground, the border),
 * so it reads in dark and light; the series colors are the palette's own hexes.
 */
import type { ChartType } from '@/lib/spreadsheets/extras'
import { compactNumber, niceTicks, pieSlices, type PreparedChart } from '@/lib/spreadsheets/charts'

interface Props {
  type: ChartType
  title: string
  legend: boolean
  prepared: PreparedChart
  width: number
  height: number
}

const AXIS = 'rgb(148 163 184 / 0.5)' // slate-400 at low alpha: reads on dark and light

export function ChartView({ type, title, legend, prepared, width, height }: Props) {
  const titleH = title ? 24 : 6
  const legendH = legend && (prepared.series.length || prepared.scatter.length) ? 22 : 0
  const bodyH = Math.max(20, height - titleH - legendH)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden text-foreground">
      {title && <div className="truncate px-2 pt-1 text-center text-[12px] font-medium">{title}</div>}
      <div className="min-h-0 flex-1">
        {!prepared.ok ? (
          <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-muted-foreground">No numbers in this range</div>
        ) : type === 'pie' || type === 'doughnut' ? (
          <PieChart prepared={prepared} width={width} height={bodyH} doughnut={type === 'doughnut'} />
        ) : type === 'scatter' ? (
          <ScatterChart prepared={prepared} width={width} height={bodyH} />
        ) : (
          <CartesianChart type={type} prepared={prepared} width={width} height={bodyH} />
        )}
      </div>
      {legendH > 0 && prepared.ok && <Legend items={type === 'scatter' ? prepared.scatter : type === 'pie' || type === 'doughnut' ? prepared.categories.map((c, i) => ({ name: c, color: colorFor(prepared, i) })) : prepared.series} />}
    </div>
  )
}

function colorFor(prepared: PreparedChart, index: number): string {
  // Pie slices take the series palette in order.
  const palette = ['#2563EB', '#16A34A', '#EA580C', '#9333EA', '#0891B2', '#DC2626', '#CA8A04', '#DB2777', '#4F46E5', '#65A30D']
  return palette[index % palette.length]
}

function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 px-2 pb-1 text-[10.5px] text-muted-foreground">
      {items.map((s, i) => (
        <span key={`${s.name}:${i}`} className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
          <span className="max-w-[120px] truncate">{s.name || `Series ${i + 1}`}</span>
        </span>
      ))}
    </div>
  )
}

function CartesianChart({ type, prepared, width, height }: { type: ChartType; prepared: PreparedChart; width: number; height: number }) {
  const horizontal = type === 'bar'
  const ticks = niceTicks(prepared.min, prepared.max)
  const padLeft = horizontal ? 70 : 46
  const padBottom = 26
  const padTop = 8
  const padRight = 12
  const plotW = Math.max(10, width - padLeft - padRight)
  const plotH = Math.max(10, height - padBottom - padTop)
  const value = (v: number) => (v - ticks.min) / (ticks.max - ticks.min || 1)
  const categories = prepared.categories
  const series = prepared.series
  const groups = categories.length
  const groupSpan = (horizontal ? plotH : plotW) / Math.max(1, groups)

  const gridlines = ticks.ticks.map((t, i) => {
    const frac = value(t)
    if (horizontal) {
      const x = padLeft + frac * plotW
      return <g key={i}><line x1={x} y1={padTop} x2={x} y2={padTop + plotH} stroke={AXIS} strokeWidth={i === 0 || t === 0 ? 1 : 0.5} /><text x={x} y={padTop + plotH + 14} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.6}>{compactNumber(t)}</text></g>
    }
    const y = padTop + (1 - frac) * plotH
    return <g key={i}><line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke={AXIS} strokeWidth={t === 0 ? 1 : 0.5} /><text x={padLeft - 6} y={y + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.6}>{compactNumber(t)}</text></g>
  })

  const marks: React.ReactNode[] = []
  if (type === 'column' || type === 'bar') {
    const barGap = groupSpan * 0.2
    const bandW = (groupSpan - barGap) / Math.max(1, series.length)
    const zero = value(0)
    series.forEach((s, si) => {
      s.values.forEach((v, gi) => {
        if (v === null) return
        const frac = value(v)
        if (horizontal) {
          const y = padTop + gi * groupSpan + barGap / 2 + si * bandW
          const x0 = padLeft + Math.min(frac, zero) * plotW
          const w = Math.abs(frac - zero) * plotW
          marks.push(<rect key={`${si}-${gi}`} x={x0} y={y} width={Math.max(1, w)} height={Math.max(1, bandW - 1)} fill={s.color} rx={1} />)
        } else {
          const x = padLeft + gi * groupSpan + barGap / 2 + si * bandW
          const yTop = padTop + (1 - Math.max(frac, zero)) * plotH
          const h = Math.abs(frac - zero) * plotH
          marks.push(<rect key={`${si}-${gi}`} x={x} y={yTop} width={Math.max(1, bandW - 1)} height={Math.max(1, h)} fill={s.color} rx={1} />)
        }
      })
    })
  } else {
    // line / area
    series.forEach((s, si) => {
      const pts = s.values.map((v, gi) => (v === null ? null : { x: padLeft + (gi + 0.5) * groupSpan, y: padTop + (1 - value(v)) * plotH }))
      const path = pts.filter(Boolean).map((p, i) => `${i === 0 ? 'M' : 'L'}${(p as { x: number }).x},${(p as { y: number }).y}`).join(' ')
      if (type === 'area' && path) {
        const first = pts.find(Boolean) as { x: number }
        const last = [...pts].reverse().find(Boolean) as { x: number }
        const base = padTop + (1 - value(0)) * plotH
        marks.push(<path key={`a${si}`} d={`${path} L${last.x},${base} L${first.x},${base} Z`} fill={s.color} opacity={0.18} />)
      }
      marks.push(<path key={`l${si}`} d={path} fill="none" stroke={s.color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />)
      pts.forEach((p, gi) => p && marks.push(<circle key={`p${si}-${gi}`} cx={p.x} cy={p.y} r={2} fill={s.color} />))
    })
  }

  const labels = categories.map((c, gi) => {
    if (horizontal) {
      const y = padTop + (gi + 0.5) * groupSpan
      return <text key={gi} x={padLeft - 6} y={y + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.75}>{truncate(c)}</text>
    }
    const x = padLeft + (gi + 0.5) * groupSpan
    return <text key={gi} x={x} y={padTop + plotH + 14} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.75}>{truncate(c)}</text>
  })

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img">
      {gridlines}
      {marks}
      {labels}
    </svg>
  )
}

function PieChart({ prepared, width, height, doughnut }: { prepared: PreparedChart; width: number; height: number; doughnut: boolean }) {
  const series = prepared.series[0]
  const values = (series?.values ?? []).map((v) => v ?? 0)
  const slices = pieSlices(values)
  const cx = width / 2
  const cy = height / 2
  const radius = Math.max(10, Math.min(width, height) / 2 - 10)
  const inner = doughnut ? radius * 0.58 : 0
  if (!slices.length) return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">No numbers in this range</div>
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img">
      {slices.map((slice, i) => (
        <path key={i} d={arc(cx, cy, radius, inner, slice.start, slice.end)} fill={colorFor(prepared, i)} stroke="var(--background, #fff)" strokeWidth={1} />
      ))}
    </svg>
  )
}

function ScatterChart({ prepared, width, height }: { prepared: PreparedChart; width: number; height: number }) {
  const allX = prepared.scatter.flatMap((s) => s.points.map((p) => p.x))
  const allY = prepared.scatter.flatMap((s) => s.points.map((p) => p.y))
  const xTicks = niceTicks(Math.min(...allX), Math.max(...allX))
  const yTicks = niceTicks(Math.min(...allY), Math.max(...allY))
  const padLeft = 46
  const padBottom = 26
  const padTop = 8
  const padRight = 12
  const plotW = Math.max(10, width - padLeft - padRight)
  const plotH = Math.max(10, height - padBottom - padTop)
  const sx = (v: number) => padLeft + ((v - xTicks.min) / (xTicks.max - xTicks.min || 1)) * plotW
  const sy = (v: number) => padTop + (1 - (v - yTicks.min) / (yTicks.max - yTicks.min || 1)) * plotH
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img">
      {yTicks.ticks.map((t, i) => (
        <g key={`y${i}`}><line x1={padLeft} y1={sy(t)} x2={padLeft + plotW} y2={sy(t)} stroke={AXIS} strokeWidth={0.5} /><text x={padLeft - 6} y={sy(t) + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.6}>{compactNumber(t)}</text></g>
      ))}
      {xTicks.ticks.map((t, i) => (
        <text key={`x${i}`} x={sx(t)} y={padTop + plotH + 14} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.6}>{compactNumber(t)}</text>
      ))}
      {prepared.scatter.map((s, si) => s.points.map((p, pi) => <circle key={`${si}-${pi}`} cx={sx(p.x)} cy={sy(p.y)} r={3} fill={s.color} opacity={0.8} />))}
    </svg>
  )
}

/** A pie/doughnut slice path from fraction `start` to `end` (0 at 12 o'clock, clockwise). */
function arc(cx: number, cy: number, radius: number, inner: number, start: number, end: number): string {
  const a0 = start * Math.PI * 2 - Math.PI / 2
  const a1 = end * Math.PI * 2 - Math.PI / 2
  const large = end - start > 0.5 ? 1 : 0
  const x0 = cx + radius * Math.cos(a0)
  const y0 = cy + radius * Math.sin(a0)
  const x1 = cx + radius * Math.cos(a1)
  const y1 = cy + radius * Math.sin(a1)
  if (inner <= 0) {
    if (end - start >= 0.999) return `M${cx} ${cy - radius} A${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`
    return `M${cx},${cy} L${x0},${y0} A${radius},${radius} 0 ${large} 1 ${x1},${y1} Z`
  }
  const ix0 = cx + inner * Math.cos(a0)
  const iy0 = cy + inner * Math.sin(a0)
  const ix1 = cx + inner * Math.cos(a1)
  const iy1 = cy + inner * Math.sin(a1)
  if (end - start >= 0.999) {
    return `M${cx} ${cy - radius} A${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} M${cx} ${cy - inner} A${inner} ${inner} 0 1 0 ${cx - 0.01} ${cy - inner} Z`
  }
  return `M${x0},${y0} A${radius},${radius} 0 ${large} 1 ${x1},${y1} L${ix1},${iy1} A${inner},${inner} 0 ${large} 0 ${ix0},${iy0} Z`
}

function truncate(text: string): string {
  return text.length > 10 ? `${text.slice(0, 9)}…` : text
}
