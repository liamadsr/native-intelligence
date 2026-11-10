import { McpConnectorView } from '../../mcp-connector-view'

export const metadata = {
  title: 'Connector – Settings',
}

export default async function McpConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <McpConnectorView id={id} />
}
