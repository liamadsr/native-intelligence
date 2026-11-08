import { Suspense } from 'react'
import { BillingView } from './billing-view'

export const metadata = {
  title: 'Billing – Settings',
}

export default function BillingPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <h1 className="text-lg font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your subscription and view usage.
        </p>
        <div className="mt-8">
          <Suspense fallback={
            <div className="space-y-4">
              <div className="h-32 animate-pulse rounded-lg bg-muted" />
              <div className="h-64 animate-pulse rounded-lg bg-muted" />
            </div>
          }>
            <BillingView />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
