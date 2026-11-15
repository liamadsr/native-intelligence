// A feature's deep dive: /features/<slug>. The content is data
// (lib/marketing/features), the page is one template
// (components/site/feature-page-view.tsx), and every page is built ahead of
// time: an unknown slug is a 404, not a render.
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { FeaturePageView } from '@/components/site/feature-page-view'
import { StructuredData } from '@/components/structured-data'
import { FEATURES, getFeature } from '@/lib/marketing/features'
import { appUrl } from '@/lib/app-url'

export const dynamicParams = false

export function generateStaticParams() {
  return FEATURES.map((feature) => ({ slug: feature.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const feature = getFeature(slug)
  if (!feature) return {}
  const url = `${appUrl()}/features/${feature.slug}`
  return {
    title: feature.metaTitle,
    description: feature.metaDescription,
    alternates: { canonical: `/features/${feature.slug}` },
    openGraph: { title: feature.metaTitle, description: feature.metaDescription, url, type: 'website' },
  }
}

export default async function FeatureRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const feature = getFeature(slug)
  if (!feature) notFound()

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: feature.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }

  return (
    <>
      <StructuredData id={`feature-${feature.slug}-faq`} data={faqSchema} />
      <FeaturePageView slug={feature.slug} />
    </>
  )
}
