import { AdminPageHeader } from '@/components/admin/shared'

export default function DecisionsLoading() {
  return <div role="status" aria-live="polite" className="space-y-6">
    <AdminPageHeader title="Jev Performance" description="Loading measured performance and reporting coverage…" />
    <div aria-hidden="true" className="grid animate-pulse gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map(item => <div key={item} className="h-28 rounded-xl bg-muted" />)}
    </div>
  </div>
}
