'use client'

/**
 * A QR code, drawn as one SVG path (`uqr` encodes it): crisp at any size,
 * and quick. Dark modules on a light ground always, whatever the theme, so a
 * phone's camera reads it in dark mode too.
 */
import { useMemo } from 'react'
import { encode } from 'uqr'
import { cn } from '@/lib/utils'

export function QrCode({ value, size = 176, label, className }: { value: string; size?: number; label: string; className?: string }) {
  const { path, modules } = useMemo(() => {
    const { data, size: n } = encode(value, { ecc: 'M', border: 0 })
    let d = ''
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (data[y][x]) d += `M${x} ${y}h1v1h-1z`
    }
    return { path: d, modules: n }
  }, [value])
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={cn('block', className)}
      data-qr-code={value}
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
