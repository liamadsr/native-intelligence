import type { Metadata } from 'next'
import Welcome from './client'

// Post-auth handoff page (deep-links back into the desktop app). No SEO value.
export const metadata: Metadata = {
  title: 'Welcome',
  robots: { index: false, follow: false },
}

export default function WelcomePage() {
  return <Welcome />
}
