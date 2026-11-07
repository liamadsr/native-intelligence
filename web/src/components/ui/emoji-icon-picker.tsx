'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Folder } from 'lucide-react'
import { cn } from '@/lib/utils'

// The emoji picker and its dataset are ~1.5MB of parsed JS — and `@emoji-mart/
// data` is one enormous JSON blob. This module also exports two tiny helpers
// (`isEmoji`, `ProjectIcon`) that list rows and property pickers import, so a
// STATIC import here dragged the whole picker into the bundle for every screen
// that renders a row — the dashboard included, where it is never opened.
//
// Loading it on demand keeps the helpers free. The picker only ever renders
// inside an OPEN popover, so the fetch happens on the click that reveals it.
// The chat's reactions open the same one (chat/message-reaction-controls.tsx).
export const EmojiPicker = dynamic(
  async () => {
    const [{ default: Picker }, { default: data }] = await Promise.all([
      import('@emoji-mart/react'),
      import('@emoji-mart/data'),
    ])
    return function LoadedPicker(props: Record<string, unknown>) {
      return <Picker data={data} {...props} />
    }
  },
  {
    ssr: false,
    loading: () => <div className="h-[435px] w-[352px]" aria-hidden />,
  },
)

// ── Helpers ─────────────────────────────────────────────────

/**
 * Returns true if the string contains at least one emoji character.
 * Used to distinguish actual emoji icons from plain-text strings like "folder".
 */
export function isEmoji(str: string): boolean {
  // Matches emoji presentation sequences, emoji modifiers, regional indicators, etc.
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u
  return emojiRegex.test(str)
}

// ── Component ───────────────────────────────────────────────

interface EmojiIconPickerProps {
  value: string | null
  onChange: (emoji: string | null) => void
  className?: string
}

export function EmojiIconPicker({ value, onChange, className }: EmojiIconPickerProps) {
  const [open, setOpen] = useState(false)
  // Treat non-emoji strings (e.g. "folder") as no icon
  const hasEmoji = value != null && isEmoji(value)

  function handleSelect(emojiData: { native: string }) {
    onChange(emojiData.native)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center justify-center rounded-lg border border-transparent transition-colors hover:border-border hover:bg-muted/50',
            'h-10 w-10 text-xl',
            className,
          )}
          title={hasEmoji ? 'Change icon' : 'Set icon'}
        >
          {hasEmoji ? (
            <span>{value}</span>
          ) : (
            <Folder className="h-5 w-5 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 border-none shadow-lg" align="start" sideOffset={4}>
        <EmojiPicker
          onEmojiSelect={handleSelect}
          theme="auto"
          previewPosition="none"
          skinTonePosition="search"
          set="native"
          perLine={8}
          maxFrequentRows={2}
        />
        {hasEmoji && (
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
            className="w-full border-t border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            Remove icon
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Renders a project icon — either the custom emoji or the default Folder.
 * Use this everywhere a project icon is displayed for consistency.
 */
export function ProjectIcon({
  icon,
  className,
  size = 'sm',
}: {
  icon: string | null | undefined
  className?: string
  size?: 'xs' | 'sm' | 'md'
}) {
  const sizeClasses = {
    xs: 'h-3.5 w-3.5 text-xs',
    sm: 'h-4 w-4 text-sm',
    md: 'h-5 w-5 text-base',
  }

  // Only render the icon if it's an actual emoji, not a plain-text string like "folder"
  if (icon && isEmoji(icon)) {
    return <span className={cn(sizeClasses[size], 'flex items-center justify-center leading-none', className)}>{icon}</span>
  }

  return <Folder className={cn(sizeClasses[size], 'text-muted-foreground', className)} />
}
