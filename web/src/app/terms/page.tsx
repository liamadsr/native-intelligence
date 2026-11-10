import type { Metadata } from 'next'
import Terms from './client'
import { appUrl } from '@/lib/app-url'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'The terms that govern your use of Native Intelligence, including subscriptions, cancellation, AI features, and acceptable use.',
  alternates: { canonical: '/terms' },
  openGraph: {
    title: 'Terms of Service – Native Intelligence',
    description:
      'The terms that govern your use of Native Intelligence, including subscriptions, cancellation, AI features, and acceptable use.',
    url: `${appUrl()}/terms`,
    type: 'website',
  },
}

export default function TermsPage() {
  return <Terms />
}
