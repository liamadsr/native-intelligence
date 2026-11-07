'use client'

import { Button } from '@/components/ui/button'
import { AdminPageHeader } from '@/components/admin/shared'

export default function DecisionsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="space-y-4" role="alert">
    <AdminPageHeader title="Jev Performance" description="The report could not be loaded." />
    <p className="text-sm text-muted-foreground">No metrics are shown because their availability could not be confirmed.</p>
    <Button onClick={reset} variant="outline">Try again</Button>
  </div>
}
