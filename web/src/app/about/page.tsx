import type { Metadata } from 'next'
import About from './client'
import { appUrl } from '@/lib/app-url'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Native Intelligence is building one workspace for the whole company, where everything your team says becomes shared memory and agents use it to do the work.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About Native Intelligence',
    description:
      'Native Intelligence is building one workspace for the whole company, where everything your team says becomes shared memory and agents use it to do the work.',
    url: `${appUrl()}/about`,
    type: 'website',
  },
}

export default function AboutPage() {
  return <About />
}
