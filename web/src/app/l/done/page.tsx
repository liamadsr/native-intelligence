import { LINK_DONE_COPY, LinkCard } from '../link-card'

export const metadata = {
  title: { absolute: 'Native Intelligence' },
  robots: { index: false, follow: false },
}

/**
 * Where a single-use link's flow ends in the phone's browser
 * (src/lib/links/oauth-link.ts TEXT_CONNECT_DONE_PATH, src/app/api/links/[token]).
 * The agent says what happened in the text thread, so this only points back there.
 */
export default async function LinkDonePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { status } = await searchParams
  const copy = LINK_DONE_COPY[typeof status === 'string' ? status : ''] ?? LINK_DONE_COPY.invalid
  return <LinkCard title={copy.title} description={copy.description} />
}
