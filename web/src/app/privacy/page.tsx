import type { Metadata } from 'next'
import Privacy from './client'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How Dial8 collects, uses, and protects your data. Read our privacy policy.',
  alternates: { canonical: '/privacy' },
  openGraph: {
    title: 'Privacy Policy – Dial8',
    description:
      'How Dial8 collects, uses, and protects your data. Read our privacy policy.',
    url: 'https://dial8.ai/privacy',
    type: 'website',
  },
}

export default function PrivacyPage() {
  return <Privacy />
}
