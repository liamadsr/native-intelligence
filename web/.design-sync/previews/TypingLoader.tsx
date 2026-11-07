import { TypingLoader } from '@dial8/ui'

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
        <TypingLoader size="sm" />
        <span style={caption}>sm</span>
      </div>
      <div style={cell}>
        <TypingLoader size="md" />
        <span style={caption}>md</span>
      </div>
      <div style={cell}>
        <TypingLoader size="lg" />
        <span style={caption}>lg</span>
      </div>
    </div>
  )
}

export function InChatBubble() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '14px 18px',
        background: '#eef2ff',
        border: '1px solid #e0e7ff',
        borderRadius: 16,
        borderBottomLeftRadius: 4,
        width: 'fit-content',
      }}
    >
      <TypingLoader size="lg" />
    </div>
  )
}
