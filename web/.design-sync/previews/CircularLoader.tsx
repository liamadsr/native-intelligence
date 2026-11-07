import { CircularLoader } from '@dial8/ui'

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
        <CircularLoader size="sm" />
        <span style={caption}>sm</span>
      </div>
      <div style={cell}>
        <CircularLoader size="md" />
        <span style={caption}>md</span>
      </div>
      <div style={cell}>
        <CircularLoader size="lg" />
        <span style={caption}>lg</span>
      </div>
    </div>
  )
}

export function InButton() {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 10,
        alignItems: 'center',
        padding: '10px 18px',
        background: '#111827',
        color: '#fff',
        borderRadius: 10,
        fontSize: 14,
        fontWeight: 500,
      }}
    >
      <CircularLoader size="md" className="border-white border-t-transparent" />
      Saving capture…
    </div>
  )
}
