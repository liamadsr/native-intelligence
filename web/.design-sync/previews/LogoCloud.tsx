import { LogoCloud } from '@dial8/ui'

export function Default() {
  return (
    <div
      style={{
        width: '100%',
        padding: '32px 0',
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: 16,
      }}
    >
      <p
        style={{
          margin: '0 0 16px',
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#6b7280',
        }}
      >
        Works with the tools you already use
      </p>
      <LogoCloud />
    </div>
  )
}

export function OnDark() {
  return (
    <div
      style={{
        width: '100%',
        padding: '32px 0',
        background: '#0b0f1a',
        borderRadius: 16,
      }}
    >
      <LogoCloud />
    </div>
  )
}
