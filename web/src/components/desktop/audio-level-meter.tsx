'use client'

import { cn } from '@/lib/utils'

interface AudioLevelMeterProps {
  level: number // 0-1 RMS
  label: string
  className?: string
}

export function AudioLevelMeter({ level, label, className }: AudioLevelMeterProps) {
  // Convert RMS to visual percentage (apply some scaling for better visibility)
  const pct = Math.min(100, Math.round(level * 300))

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="w-12 text-xs text-muted-foreground shrink-0">{label}</span>
      <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-green-500 transition-[width] duration-75"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
