'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useEffect, useRef, useState } from 'react'
import { copyRichTextToClipboard } from '@/lib/clipboard'
import { Check, ClipboardCopy } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface CopyDocumentButtonProps {
  /** The document's text as it is now (unsaved edits included), markdown. */
  getMarkdown: () => string
}

/**
 * Copy the whole document so it pastes well into another tool (P9, decision
 * 9): a newsletter Native Intelligence drafted goes into Substack, HubSpot or Mailchimp by
 * the person's own paste. Native Intelligence never sends it. The markdown rides as plain
 * text and its HTML as rich text, so headings, lists and links survive.
 * Beside Copy ID, the same look; the host hides it when the document is empty
 * (hide empty widgets).
 */
export function CopyDocumentButton({ getMarkdown }: CopyDocumentButtonProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PreferenceActionButton
            label={copied ? 'Copied text' : 'Copy text'}
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={async () => {
              const markdown = getMarkdown()
              // Started inside the click; the HTML renders while the write is open.
              const html = import('marked').then(({ marked }) => marked.parse(markdown, { async: false }) as string)
              const ok = await copyRichTextToClipboard(markdown, html)
              if (!ok) return
              if (timerRef.current) clearTimeout(timerRef.current)
              setCopied(true)
              timerRef.current = setTimeout(() => {
                setCopied(false)
                timerRef.current = null
              }, 1500)
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
          </PreferenceActionButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">{copied ? 'Copied!' : 'Copy text (paste into Substack, HubSpot…)'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
