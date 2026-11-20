import { notFound } from 'next/navigation'
import DemoAppProbe from './probe'

/** DEV ONLY: the whole app shell on demo data (lib/demo/demo-fetch.ts), to see what it asks for. */
export const metadata = { robots: { index: false } }

export default function DemoAppPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <DemoAppProbe />
}
