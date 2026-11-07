'use client'

/**
 * Dev only: the sky preview's weather, time-of-day and place controls, shared
 * by Settings → Developer → Sky preview and the floating panel
 * (sky-dev-panel.tsx). They write the dev store (sky-dev-store.ts); the sky
 * follows live.
 *
 * The time is this device's clock, as `?skyTime=` is: with a place picked,
 * the label also gives that place's own clock at the same moment, since that
 * is what the sun there answers to.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SKY_PRESETS, applyOverrideTime } from '@/lib/sky/dev-override'
import {
  SKY_DEV_PLACES,
  setSkyDevScrubbing,
  setSkyDevSettings,
  useSkyDevSettings,
  type SkyDevPlaceKey,
} from '@/lib/sky/sky-dev-store'

const WEATHER_KEYS = Object.keys(SKY_PRESETS)
const PLACE_KEYS = Object.keys(SKY_DEV_PLACES) as SkyDevPlaceKey[]
export const SKY_DEV_TIME_STEP = 5
const LAST_MINUTE = 24 * 60 - SKY_DEV_TIME_STEP

/** 1120 → "6:40 PM". */
export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** The clock in `timeZone` at `at`, or null without Intl time zones. */
function clockIn(at: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(at)
  } catch {
    return null
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-1 text-xs transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background/60 text-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

export function SkyDevControls({ className }: { className?: string }) {
  const s = useSkyDevSettings()
  const now = new Date()
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  const sliderValue = s.minuteOfDay ?? Math.min(LAST_MINUTE, Math.round(nowMinute / SKY_DEV_TIME_STEP) * SKY_DEV_TIME_STEP)
  const place = s.place ? SKY_DEV_PLACES[s.place] : null
  const placeClock = place ? clockIn(applyOverrideTime(now, s.minuteOfDay), place.timeZone) : null

  const startScrub = () => {
    setSkyDevScrubbing(true)
    const end = () => {
      setSkyDevScrubbing(false)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return (
    <div className={cn('space-y-4', className)}>
      <Group label="Weather">
        <Chip active={s.weather === null} onClick={() => setSkyDevSettings({ weather: null })}>
          Real weather
        </Chip>
        {WEATHER_KEYS.map((key) => (
          <Chip key={key} active={s.weather === key} onClick={() => setSkyDevSettings({ weather: key })}>
            {capitalize(key)}
          </Chip>
        ))}
      </Group>

      <div role="group" aria-label="Time of day">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Time of day</span>
          <span className="text-xs tabular-nums" data-testid="sky-dev-time-label">
            {s.minuteOfDay === null ? `Now (${formatMinuteOfDay(nowMinute)})` : formatMinuteOfDay(s.minuteOfDay)}
            {place && placeClock && (
              <span className="text-muted-foreground">
                {' '}
                · {placeClock} in {place.label}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            aria-label="Time of day"
            aria-valuetext={formatMinuteOfDay(sliderValue)}
            min={0}
            max={LAST_MINUTE}
            step={SKY_DEV_TIME_STEP}
            value={sliderValue}
            onPointerDown={startScrub}
            onChange={(e) => setSkyDevSettings({ minuteOfDay: Number(e.currentTarget.value) })}
            className={cn('h-1.5 min-w-0 flex-1 cursor-pointer accent-primary', s.minuteOfDay === null && 'opacity-60')}
          />
          <Chip active={s.minuteOfDay === null} onClick={() => setSkyDevSettings({ minuteOfDay: null })}>
            Now
          </Chip>
        </div>
      </div>

      <Group label="Place">
        <Chip active={s.place === null} onClick={() => setSkyDevSettings({ place: null })}>
          Real location
        </Chip>
        {PLACE_KEYS.map((key) => (
          <Chip key={key} active={s.place === key} onClick={() => setSkyDevSettings({ place: key })}>
            {SKY_DEV_PLACES[key].label}
          </Chip>
        ))}
      </Group>
    </div>
  )
}
