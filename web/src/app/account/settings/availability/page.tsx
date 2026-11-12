import { redirect } from 'next/navigation'
import { pageDeepLink } from '@/lib/chat-cards/open-card'

/**
 * Availability moved out of Settings to its own page under Calendar (Liam,
 * 11-11: "Availability (Right now it's in the settings but it needs to be
 * it's own page under Calendar)"). Old links (the desktop app, a bookmark,
 * an email) land on the dashboard, which opens the Availability page's card.
 */
export default function AvailabilitySettingsPage() {
  redirect(pageDeepLink('availability'))
}
