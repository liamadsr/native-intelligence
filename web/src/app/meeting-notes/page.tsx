import type { Metadata } from 'next'
import MeetingNotesPage from './meeting-notes-page'

// Direct preview URL for the "meeting notes" landing variant. The root page
// also serves this variant to the PostHog `landing-page-variant` test bucket —
// this route exists so the variant can be reviewed and shared at a stable URL
// regardless of flag bucketing. No signed-in redirect here on purpose: a
// signed-in teammate reviewing the page shouldn't be bounced to /account.
const TITLE = 'Dial8 — Remarkably good meeting notes'
const DESCRIPTION =
  'AI notes, action items, automations, and answers — from every conversation you have. No meeting bots.'

// The canonical and social cards describe THIS page. Inherited from layout.tsx
// they would describe the homepage's sales pitch: canonical and og:url `/`,
// and a shared link previewing as the sales platform. The card image is
// ./opengraph-image.tsx; X falls back to it, so there is no twitter-image here.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/meeting-notes' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: '/meeting-notes',
    type: 'website',
    siteName: 'Dial8',
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
