'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useEffect, useRef, useState } from 'react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { Copy, Check } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type EntityType = 'action' | 'capture' | 'document' | 'project' | 'initiative' | 'contact' | 'company'

interface CopyIdButtonProps {
  /** The entity type, used as the label prefix in the copied text. */
  entityType: EntityType
  /** The entity's UUID. */
  id: string
}

/**
 * Small toolbar button that copies `"<entityType> <uuid>"` to the clipboard.
 *
 * Designed to be pasted into AI prompts so the agent can address a specific
 * entity by ID without ambiguity. E.g. clicking on a capture's button copies
 * `capture c78450b4-…` which the agent can route to `dial8_get_capture`.
 *
 * Shows a green check + "Copied!" tooltip for 1.5s after click.
 */
export function CopyIdButton({ entityType, id }: CopyIdButtonProps) {
  const [copied, setCopied] = useState(false)
  // Track the timeout so rapid re-clicks reset cleanly and we don't
  // setState on an unmounted component if the panel closes mid-confirmation.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PreferenceActionButton label={copied ? 'Copied ID' : 'Copy ID'}
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={async () => {
              try {
                if (!(await copyTextToClipboard(`${entityType} ${id}`))) {
                  toast.error("Couldn't copy the ID")
                  return
                }
                if (timerRef.current) clearTimeout(timerRef.current)
                setCopied(true)
                timerRef.current = setTimeout(() => {
                  setCopied(false)
                  timerRef.current = null
                }, 1500)
              } catch (err) {
                console.error('Failed to copy ID:', err)
              }
            }}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </PreferenceActionButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {copied ? 'Copied!' : 'Copy ID'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
