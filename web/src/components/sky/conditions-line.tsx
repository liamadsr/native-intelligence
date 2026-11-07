'use client'

/**
 * The empty chat's conditions line: one quiet greeting for the hour, and
 * under it what it's like where the person is ("Light rain · 9° · Toronto"),
 * centred in the space above the composer. Reads the one sky store
 * (useSkyState), which the shell feeds whichever background is on, so it shows
 * with the Sky background off too.
 *
 * Client only: nothing renders until the store has an answer (`fetchedAt`), so
 * the server's HTML and hydration agree. A reading saved on the device counts
 * (sky-cache.ts), so on launch it shows at once; its condition and temperature
 * only while that weather is under three hours old, otherwise just the
 * greeting until the fetch answers. It fades in once, with a CSS
 * transition (no keyframes, nothing looping), and moves only when the store
 * does (its five-minute sun step, its thirty-minute weather).
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useSkyState } from '@/lib/sky/sky-state'
import { applyOverrideTime } from '@/lib/sky/dev-override'
import { nextSunCrossing } from '@/lib/sky/sun'
import { conditionsLine, greetingLine, temperatureUnit } from '@/lib/sky/conditions'
import { isWeatherFresh } from '@/lib/sky/sky-cache'

/** The person's display name, as the dashboard shell has it, for the greeting. */
const GreetingNameContext = createContext<string | null>(null)
export const GreetingNameProvider = GreetingNameContext.Provider

function browserLocale(): string | null {
  try {
    return navigator.languages?.[0] ?? navigator.language ?? null
  } catch {
    return null
  }
}

export function ConditionsLine() {
  const sky = useSkyState()
  const name = useContext(GreetingNameContext)
  const ready = sky.fetchedAt !== null
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!ready) return
    // One frame at opacity 0 first, so the transition has somewhere to start.
    // A timeout, not rAF: a hidden pane never runs rAF.
    const t = setTimeout(() => setShown(true), 30)
    return () => clearTimeout(t)
  }, [ready])

  const text = useMemo(() => {
    if (!ready) return null
    const now = applyOverrideTime(new Date(), sky.timeOverride)
    const located = !sky.approximate
    // An old reading (saved last session, or a fetch failing since) says nothing about now.
    const fresh = isWeatherFresh(sky.fetchedAt)
    const sunriseAt =
      located && sky.phase === 'night' ? nextSunCrossing(now, sky.latitude, sky.longitude, 'rise') : null
    return {
      greeting: greetingLine(now.getHours(), name),
      line: conditionsLine({
        condition: fresh ? sky.weather.condition : null,
        temperatureC: fresh ? sky.weather.temperatureC : null,
        city: sky.city,
        located,
        unit: temperatureUnit(sky.country, browserLocale()),
        phase: sky.phase,
        sunrise: sunriseAt ? sunriseAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null,
      }),
    }
  }, [ready, sky, name])

  if (!text) return null
  return (
    <div
      data-sky-conditions=""
      className="select-none px-6 text-center transition-opacity duration-1000 ease-out [text-shadow:0_0_14px_hsl(var(--sidebar-background)/0.55)]"
      style={{ opacity: shown ? 1 : 0 }}
    >
      <p className="text-[22px] font-medium leading-tight tracking-tight text-foreground">{text.greeting}</p>
      {text.line && <p className="mt-1.5 text-[13px] leading-snug text-foreground/70">{text.line}</p>}
    </div>
  )
}
