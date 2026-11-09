import type { Metadata } from 'next'
import Contact from './client'

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Get in touch with the Native Intelligence team. Questions about meeting capture, project management, AI execution, or anything else — we’d love to hear from you.',
  alternates: { canonical: '/contact' },
  openGraph: {
    title: 'Contact Native Intelligence',
    description:
      'Get in touch with the Native Intelligence team. Questions about meeting capture, project management, AI execution, or anything else — we’d love to hear from you.',
    url: 'https://dial8.ai/contact',
    type: 'website',
  },
}

export default function ContactPage() {
  return <Contact />
}
