'use client'

/**
 * The channel header's notifications menu (docs/plans/channels-inbox.md,
 * phase 1): Signal or Noise, and mute or snooze.
 *
 *   Signal  560's `all`: every message here reaches the person's inbox.
 *   Noise   560's `mentions` (a channel's default): the rest stays in the
 *           channel; their @-mentions and their threads' replies still
 *           reach them.
 *   Mute for 1 hour / until tomorrow (8:00) / for a week: a snooze (702's
 *           muted_until): nothing notifies until then, the unread count
 *           keeps counting.
 *   Mute until I turn it back on: 560's `muted` (no unread count either).
 *   Turn notifications back on: ends either; a muted channel goes back to
 *           its kind's default.
 */
import { Bell, BellOff, Check } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { defaultNotifyLevel, type TeamChatNotifyLevel } from '@/lib/team-chat/notify'
import { SNOOZE_CHOICES, isSnoozed, snoozeChoiceLabel, snoozeLabel, snoozeUntil } from '@/lib/team-chat/snooze'
import type { TeamChatChannel } from '@/lib/team-chat/types'

/** The header's icon button style (card-header-slot's own, passed in so this file needs none of the card's). */
export interface TeamChatNotifyMenuProps {
  kind: TeamChatChannel['kind']
  level: TeamChatNotifyLevel
  mutedUntil: string | null | undefined
  onChange: (level: TeamChatNotifyLevel) => void
  onSnooze: (until: string | null) => void
  inHeader?: boolean
  /** The class a card header's icon button takes (CARD_HEADER_ICON_BUTTON). */
  headerButtonClass?: string
}

/** What the trigger says: the channel's state in a few words. */
export function notifyMenuSummary(level: TeamChatNotifyLevel, mutedUntil: string | null | undefined, now: Date = new Date()): string {
  if (level === 'muted') return 'Muted'
  if (mutedUntil && isSnoozed(mutedUntil, now)) return snoozeLabel(mutedUntil, now)
  return level === 'all' ? 'Signal' : 'Noise'
}

export function TeamChatNotifyMenu({ kind, level, mutedUntil, onChange, onSnooze, inHeader = false, headerButtonClass }: TeamChatNotifyMenuProps) {
  const snoozed = isSnoozed(mutedUntil)
  const quiet = level === 'muted' || snoozed
  const Icon = quiet ? BellOff : Bell
  const summary = notifyMenuSummary(level, mutedUntil)
  const what = kind === 'channel' ? 'channel' : 'conversation'
  const options: ReadonlyArray<{ level: TeamChatNotifyLevel; label: string; hint: string }> = [
    { level: 'all', label: 'Signal', hint: 'Every message reaches your inbox' },
    { level: 'mentions', label: 'Noise', hint: `Stays in the ${what}; only @-mentions and your threads reach you` },
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-team-chat-notify={level}
          data-team-chat-snoozed={snoozed ? '' : undefined}
          aria-label={`Notifications: ${summary}`}
          title={`Notifications: ${summary}`}
          className={
            inHeader
              ? cn('grid size-7 shrink-0 place-items-center data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground', headerButtonClass)
              : 'shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent'
          }
        >
          <Icon className={inHeader ? 'size-3.5' : 'h-4 w-4'} strokeWidth={inHeader ? 1.75 : undefined} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <p className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">Where this {what}&rsquo;s messages go</p>
        {options.map((o) => {
          const chosen = o.level === level
          return (
            <DropdownMenuItem key={o.level} data-team-chat-notify-option={o.level} onSelect={() => !chosen && onChange(o.level)} className="items-start">
              {chosen ? <Check className="mt-0.5 h-4 w-4" aria-label="Chosen" /> : <span className="h-4 w-4 shrink-0" aria-hidden />}
              <span className="flex min-w-0 flex-col">
                <span className="text-sm text-foreground">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        {quiet ? (
          <>
            <p className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground" data-team-chat-snooze-state="">
              {level === 'muted' ? 'Muted until you turn it back on' : summary}
            </p>
            <DropdownMenuItem
              data-team-chat-unmute=""
              onSelect={() => {
                if (snoozed) onSnooze(null)
                if (level === 'muted') onChange(defaultNotifyLevel(kind))
              }}
            >
              <Bell className="h-4 w-4" />
              <span className="text-sm">Turn notifications back on</span>
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {SNOOZE_CHOICES.map((choice) => (
              <DropdownMenuItem key={choice} data-team-chat-snooze-option={choice} onSelect={() => onSnooze(snoozeUntil(choice).toISOString())}>
                <BellOff className="h-4 w-4" />
                <span className="text-sm">{snoozeChoiceLabel(choice)}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem data-team-chat-notify-option="muted" onSelect={() => onChange('muted')} className="items-start">
              <BellOff className="mt-0.5 h-4 w-4" />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm text-foreground">Mute until I turn it back on</span>
                <span className="text-xs text-muted-foreground">No notifications, no unread count</span>
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
