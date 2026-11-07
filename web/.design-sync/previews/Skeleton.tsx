import { Skeleton } from '@dial8/ui'

export function CaptureCard() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 320 }}>
      <Skeleton style={{ height: 20, width: '60%' }} />
      <Skeleton style={{ height: 14, width: '40%' }} />
      <Skeleton style={{ height: 80, width: '100%' }} />
    </div>
  )
}

export function ListRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', maxWidth: 320 }}>
      <Skeleton style={{ height: 40, width: 40, borderRadius: 9999 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <Skeleton style={{ height: 14, width: '70%' }} />
        <Skeleton style={{ height: 12, width: '45%' }} />
      </div>
    </div>
  )
}
