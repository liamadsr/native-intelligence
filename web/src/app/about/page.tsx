import type { Metadata } from 'next'
import About from './client'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Dial8 is building the system that turns conversations into action — capturing meetings, keeping projects current, and letting AI agents execute.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About Dial8',
    description:
      'Dial8 is building the system that turns conversations into action — capturing meetings, keeping projects current, and letting AI agents execute.',
    url: 'https://dial8.ai/about',
    type: 'website',
  },
}

export default function AboutPage() {
  return <About />
}
