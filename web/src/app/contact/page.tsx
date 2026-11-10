import type { Metadata } from 'next'
import Contact from './client'
import { appUrl } from '@/lib/app-url'

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Get in touch with the Native Intelligence team. Questions about meeting capture, project management, AI execution, or anything else — we’d love to hear from you.',
  alternates: { canonical: '/contact' },
  openGraph: {
    title: 'Contact Native Intelligence',
    description:
      'Get in touch with the Native Intelligence team. Questions about meeting capture, project management, AI execution, or anything else — we’d love to hear from you.',
    url: `${appUrl()}/contact`,
    type: 'website',
  },
}

export default function ContactPage() {
  return <Contact />
}
