import type { Metadata } from 'next'
import ReleaseNotes from './client'

export const metadata: Metadata = {
  title: 'Release Notes',
  description:
    'What’s new in Dial8 — the latest features, improvements, and fixes across meeting capture, project management, and AI execution.',
  alternates: { canonical: '/release-notes' },
  openGraph: {
    title: 'Dial8 Release Notes',
    description:
      'What’s new in Dial8 — the latest features, improvements, and fixes across meeting capture, project management, and AI execution.',
    url: 'https://dial8.ai/release-notes',
    type: 'website',
  },
}

export default function ReleaseNotesPage() {
  return <ReleaseNotes />
}
