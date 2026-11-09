import type { Metadata } from 'next'
import About from './client'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Native Intelligence is building the system that turns conversations into action — capturing meetings, keeping projects current, and letting AI agents execute.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About Native Intelligence',
    description:
      'Native Intelligence is building the system that turns conversations into action — capturing meetings, keeping projects current, and letting AI agents execute.',
    url: 'https://dial8.ai/about',
    type: 'website',
  },
}

export default function AboutPage() {
  return <About />
}
