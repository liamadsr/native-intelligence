import { Container } from '@native-intelligence/ui'

export function Centered() {
  return (
    <div style={{ width: '100%', background: '#f9fafb', paddingTop: 32, paddingBottom: 32, borderRadius: 16 }}>
      <Container>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 32 }}>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, color: '#030712' }}>
            The workspace where meetings become work
          </h2>
          <p style={{ marginTop: 12, marginBottom: 0, fontSize: 16, color: '#4b5563' }}>
            Container constrains its children to a centered max-width with
            responsive horizontal padding — the backbone of every marketing
            section on dial8.ai.
          </p>
        </div>
      </Container>
    </div>
  )
}

export function WithColumns() {
  return (
    <div style={{ width: '100%', background: '#f9fafb', paddingTop: 32, paddingBottom: 32, borderRadius: 16 }}>
      <Container>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ background: '#eef2ff', borderRadius: 12, padding: 24, fontSize: 14, color: '#3730a3' }}>
            Captures
          </div>
          <div style={{ background: '#ecfdf5', borderRadius: 12, padding: 24, fontSize: 14, color: '#065f46' }}>
            Projects &amp; CRM
          </div>
        </div>
      </Container>
    </div>
  )
}
