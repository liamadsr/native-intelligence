import { notFound } from 'next/navigation'
import { isValidProvider, isValidCapability } from '@/lib/oauth/config'
// Plain-data catalog only — this is a SERVER component, so it must not reach
// for `catalog-icons.tsx` (client components). Name + description is all the
// route needs; the detail view resolves its own icons.
import { getIntegration } from '@/lib/integrations/catalog'
// The view lives beside its destination pickers and their tests under integrations/.
import { IntegrationDetailView } from '../../../integrations/[provider]/[capability]/integration-detail-view'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ provider: string; capability: string }>
}) {
  const { provider, capability } = await params
  const meta = getIntegration(provider, capability)
  return {
    title: meta
      ? `${meta.name} – Connectors`
      : 'Connector',
  }
}

export default async function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ provider: string; capability: string }>
}) {
  const { provider, capability } = await params

  if (!isValidProvider(provider) || !isValidCapability(capability)) {
    notFound()
  }

  const meta = getIntegration(provider, capability)
  if (!meta) {
    notFound()
  }

  return (
    <IntegrationDetailView
      provider={provider}
      capability={capability}
      name={meta.name}
      description={meta.description}
    />
  )
}
