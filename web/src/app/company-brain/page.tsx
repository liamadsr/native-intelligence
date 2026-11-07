import type { Metadata } from 'next'
import {
  StructuredData,
  organizationSchema,
  websiteSchema,
  softwareApplicationSchema,
} from '@/components/structured-data'
import CompanyBrainPage from './company-brain-page'

const BASE_URL = 'https://dial8.ai'
const TITLE = 'Company Brain — One brain. Every tool. Always in sync.'
const DESCRIPTION =
  'Dial8 captures your meetings live, turns them into action items, and pushes them into Slack, Jira, Linear, or Asana — while staying the one place that always knows what is true.'

// The social cards describe THIS page rather than inheriting layout.tsx's sales
// pitch. The card image is ./opengraph-image.tsx — without it, defining
// openGraph here drops the inherited og:image entirely — and X falls back to
// it, so there is no twitter-image here.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/company-brain' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${BASE_URL}/company-brain`,
    type: 'website',
    siteName: 'Dial8',
  },
  twitter: {
    card: 'summary_large_image',
    site: '@Dial8_ai',
    creator: '@Dial8_ai',
    title: TITLE,
    description: DESCRIPTION,
  },
}

// Pure marketing variation page — no Supabase signed-in redirect on purpose, so
// it stays dependency-free and renders identically for every visitor.
export default function Page() {
  return (
    <>
      <StructuredData
        data={[organizationSchema, websiteSchema, softwareApplicationSchema]}
      />
      <CompanyBrainPage />
    </>
  )
}
