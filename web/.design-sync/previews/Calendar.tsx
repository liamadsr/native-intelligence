import { Calendar } from '@dial8/ui'

export function Single() {
  return (
    <Calendar
      mode="single"
      defaultMonth={new Date(2026, 5, 1)}
      selected={new Date(2026, 5, 18)}
      className="rounded-md border"
    />
  )
}

export function Range() {
  return (
    <Calendar
      mode="range"
      defaultMonth={new Date(2026, 5, 1)}
      selected={{ from: new Date(2026, 5, 16), to: new Date(2026, 5, 20) }}
      className="rounded-md border"
    />
  )
}

export function Dropdown() {
  return (
    <Calendar
      mode="single"
      captionLayout="dropdown"
      defaultMonth={new Date(2026, 5, 1)}
      selected={new Date(2026, 5, 18)}
      startMonth={new Date(2025, 0, 1)}
      endMonth={new Date(2027, 11, 1)}
      className="rounded-md border"
    />
  )
}
