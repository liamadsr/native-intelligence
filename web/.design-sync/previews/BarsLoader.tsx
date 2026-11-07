import { BarsLoader } from '@dial8/ui'

const surface: React.CSSProperties = {
  display: 'flex',
  gap: 48,
  alignItems: 'center',
  padding: 40,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 16,
}
const cell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
}
const caption: React.CSSProperties = { fontSize: 12, color: '#6b7280' }

export function Sizes() {
  return (
    <div style={surface}>
      <div style={cell}>
        <BarsLoader size="sm" />
        <span style={caption}>sm</span>
      </div>
      <div style={cell}>
        <BarsLoader size="md" />
        <span style={caption}>md</span>
      </div>
      <div style={cell}>
        <BarsLoader size="lg" />
        <span style={caption}>lg</span>
      </div>
    </div>
  )
}

export function InContext() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        padding: '14px 18px',
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        width: 'fit-content',
      }}
    >
      <BarsLoader size="lg" />
      <span style={{ fontSize: 14, color: '#374151' }}>Transcribing audio…</span>
    </div>
  )
}
