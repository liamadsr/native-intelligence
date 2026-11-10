import type { Metadata } from 'next'
import About from './client'
import { appUrl } from '@/lib/app-url'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Native Intelligence is building the system that turns conversations into action — capturing meetings, keeping projects current, and letting AI agents execute.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About Native Intelligence',
    description:
      'Native Intelligence is building the system that turns conversations into action — capturing meetings, keeping projects current, and letting AI agents execute.',
    url: `${appUrl()}/about`,
    type: 'website',
  },
}

export default function AboutPage() {
  return <About />
}
