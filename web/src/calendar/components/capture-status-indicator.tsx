'use client'

import { Check, FileText, Mic } from 'lucide-react'
import type { IEventCapture } from '@/calendar/interfaces'

interface CaptureStatusIndicatorProps {
  capture: IEventCapture
  compact?: boolean
}

export function CaptureStatusIndicator({ capture, compact = false }: CaptureStatusIndicatorProps) {
  if (capture.auto_capture_status === 'completed' || capture.ai_processed) {
    if (compact) {
      return (
        <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400" title="Captured">
          <Check className="size-3" />
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <Check className="size-2.5" />
        {capture.source_action_count > 0 && `${capture.source_action_count} actions`}
        {capture.source_action_count === 0 && 'Captured'}
      </span>
    )
  }

  if (capture.auto_capture_status === 'recording') {
    if (compact) {
      return (
        <span className="inline-flex items-center text-red-500" title="Recording">
          <span className="size-2 animate-pulse rounded-full bg-red-500" />
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
        <Mic className="size-2.5" />
        Recording
      </span>
    )
  }

  if (capture.auto_capture_status === 'pending' || capture.auto_capture_status === 'ready') {
    if (compact) {
      return (
        <span className="inline-flex items-center text-muted-foreground" title="Ready to capture">
          <FileText className="size-3" />
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        <FileText className="size-2.5" />
        Ready
      </span>
    )
  }

  return null
}
