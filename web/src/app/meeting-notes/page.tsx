import type { Metadata } from 'next'
import MeetingNotesPage from './meeting-notes-page'

// The "meeting notes" persona pitch, at its own stable URL (it was also an arm
// of the homepage's A/B switch until 2026-11-14). No signed-in redirect here on purpose: a
// signed-in teammate reviewing the page shouldn't be bounced to /account.
const TITLE = 'Native Intelligence — Remarkably good meeting notes'
const DESCRIPTION =
  'AI notes, action items, automations, and answers — from every conversation you have. No meeting bots.'

// The canonical and social cards describe THIS page. Inherited from layout.tsx
// they would describe the homepage's sales pitch: canonical and og:url `/`,
// and a shared link previewing as the sales platform. The card image is
// ./opengraph-image.tsx; X falls back to it, so there is no twitter-image here.
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/meeting-notes' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: '/meeting-notes',
    type: 'website',
    siteName: 'Native Intelligence',
  },
  twitter: {
    card: 'summary_large_image',
    site: '@Dial8_ai',
    creator: '@Dial8_ai',
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function MeetingNotesRoute() {
  return <MeetingNotesPage />
}
