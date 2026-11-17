'use client'

/**
 * The call's device picker (microphone, speaker where the browser can move
 * it, camera): drawn by the members' panel (./call-panel.tsx) and by a
 * meeting guest's page (src/components/meeting-links/guest-meeting.tsx), so
 * nothing here reads the app's context.
 */

import { ChevronDown, Settings2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { CallDeviceKind, CallSnapshot, TeamCallSession } from '@/lib/team-calls/call-session'

const DEVICE_SECTIONS: ReadonlyArray<{ kind: CallDeviceKind; label: string }> = [
  { kind: 'audioinput', label: 'Microphone' },
  { kind: 'audiooutput', label: 'Speaker' },
  { kind: 'videoinput', label: 'Camera' },
]

export function DevicesMenu({ session, snap }: { session: TeamCallSession; snap: CallSnapshot }) {
  const sections = DEVICE_SECTIONS.filter((s) => (s.kind === 'audiooutput' ? snap.canPickSpeaker : true)).filter((s) => snap.devices[s.kind].length > 0)
  if (sections.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Devices"
          title="Devices"
          data-team-call-devices=""
          className="flex h-11 shrink-0 items-center gap-0.5 rounded-full bg-muted px-3 text-foreground hover:bg-accent"
        >
          <Settings2 className="h-5 w-5" />
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="z-[90] w-72">
        {sections.map((s, i) => (
          <div key={s.kind}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{s.label}</DropdownMenuLabel>
            {snap.devices[s.kind].map((d, n) => (
              <DropdownMenuItem key={d.deviceId} onSelect={() => void session.setDevice(s.kind, d.deviceId)} className="gap-2">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', snap.active[s.kind] === d.deviceId ? 'bg-emerald-500' : 'bg-transparent')} aria-hidden />
                <span className="truncate">{d.label || `${s.label} ${n + 1}`}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
