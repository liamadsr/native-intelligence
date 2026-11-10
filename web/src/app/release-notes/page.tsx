import type { Metadata } from 'next'
import ReleaseNotes from './client'
import { appUrl } from '@/lib/app-url'

export const metadata: Metadata = {
  title: 'Release Notes',
  description:
    'What’s new in Native Intelligence — the latest features, improvements, and fixes across meeting capture, project management, and AI execution.',
  alternates: { canonical: '/release-notes' },
  openGraph: {
    title: 'Native Intelligence Release Notes',
    description:
      'What’s new in Native Intelligence — the latest features, improvements, and fixes across meeting capture, project management, and AI execution.',
    url: `${appUrl()}/release-notes`,
    type: 'website',
  },
}

export default function ReleaseNotesPage() {
  return <ReleaseNotes />
}
