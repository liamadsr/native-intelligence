// Next.js App Router hooks outside a Next app: a still page with nowhere to go (kit captures only).
const noop = () => {}
export const useRouter = () => ({ push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop })
export const usePathname = () => '/account'
export const useSearchParams = () => new URLSearchParams()
export const useParams = () => ({})
export const useSelectedLayoutSegment = () => null
export const useSelectedLayoutSegments = () => []
export const redirect = noop,
  permanentRedirect = noop,
  notFound = noop
