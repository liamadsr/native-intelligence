'use client'

/**
 * Availability as a card (Liam, 11-11: "Availability (Right now it's in the
 * settings but it needs to be it's own page under Calendar)"): the real
 * Availability view (working hours, the calendars that count, sharing busy
 * times, booking links and their dialogs), with its own reads and saves. It
 * is not a views-system list, so there is nothing of the person's to keep
 * with the card, and no rows for the agent's note.
 */
import * as React from 'react'
import { AvailabilitySettingsView } from '@/app/account/settings/availability/availability-settings-view'
import type { PageCardProps } from './page-card'

export default function AvailabilityCard(_props: PageCardProps) {
  return (
    <div className="h-full min-h-0" data-availability-card="">
      <AvailabilitySettingsView />
    </div>
  )
}
