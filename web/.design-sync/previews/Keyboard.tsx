import { Keyboard } from '@native-intelligence/ui'

export function QuickCapture() {
  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ margin: '0 0 12px', fontSize: 14, color: '#4b5563' }}>
        Press <strong>⌘K</strong> to open the capture bar from anywhere.
      </p>
      <Keyboard highlighted={['Function', 'K']} />
    </div>
  )
}

export function StartRecording() {
  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ margin: '0 0 12px', fontSize: 14, color: '#4b5563' }}>
        Start a recording instantly with the highlighted shortcut.
      </p>
      <Keyboard highlighted={['Control', 'R']} />
    </div>
  )
}
