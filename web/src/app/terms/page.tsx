import type { Metadata } from 'next'
import Terms from './client'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'The terms that govern your use of Native Intelligence, including subscriptions, cancellation, AI features, and acceptable use.',
  alternates: { canonical: '/terms' },
  openGraph: {
    title: 'Terms of Service – Native Intelligence',
    description:
      'The terms that govern your use of Native Intelligence, including subscriptions, cancellation, AI features, and acceptable use.',
    url: 'https://dial8.ai/terms',
    type: 'website',
  },
}

export default function TermsPage() {
  return <Terms />
}
