import { notFound } from 'next/navigation'
import LandingDemosPreview from './landing-demos-preview'

/**
 * Every landing-page demo widget (src/components/landing/*), drawn standalone
 * — DEV ONLY: each in the sales page's feature-panel frame, one per section
 * (`#<name>`), so a demo can be screenshotted without signing out. `?only=`
 * draws just one. `notFound()` keeps it out of production.
 */
export const metadata = {
  robots: { index: false },
}

export default function LandingDemosPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <LandingDemosPreview />
}
