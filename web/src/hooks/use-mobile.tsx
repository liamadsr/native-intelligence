import * as React from "react"
import { subscribeMedia } from '@/lib/media-query'

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    const unsubscribe = subscribeMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`, onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return unsubscribe
  }, [])

  return !!isMobile
}
