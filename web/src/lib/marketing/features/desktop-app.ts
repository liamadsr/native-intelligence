import type { FeaturePage } from './types'

export const desktopApp: FeaturePage = {
  slug: 'desktop-app',
  name: 'Desktop app',
  title: 'Every call on your Mac, captured.',
  lead: 'The Mac app records from your side of the conversation, on any call you take on your computer, in any app. An agent can help while you talk.',
  worksWith: 'For macOS 13 or later, on Apple silicon and Intel',
  metaTitle: 'The Mac app: capture every call',
  metaDescription:
    'Capture any call on your Mac, in any app. A heads-up before meetings, live notes, and an agent you can ask mid-call.',
  intro: [
    'Meeting bots announce themselves, need an invite, and miss the calls that were never on a calendar. A lot of the most useful conversations happen exactly there: a quick call, a phone call, a huddle.',
    'The Mac app listens from your computer instead. It notices when a call starts, records your microphone and the call’s audio as two streams, and turns them into notes, a transcript and next steps when you hang up. Everything you can do on the web works in the app too, since it runs the full workspace.',
  ],
  demo: 'hud-tips',
  sections: [
    {
      id: 'no-bot',
      nav: 'No bot',
      title: 'Works with any call app.',
      body: 'The app records what your Mac hears: your microphone and the call’s audio, kept as two separate streams so each side is clearer. There is no participant to admit and nothing for the other side to see.',
      points: [
        'Works on any call app that uses your microphone',
        'Pause and resume during a recording',
        'Pick the microphone you want to use',
        'Keeps your Mac awake while it records',
      ],
    },
    {
      id: 'detection',
      nav: 'Detection',
      title: 'It knows when a call starts.',
      body: 'When a call app starts using your microphone, the app notices. It starts recording on its own if you switched on auto-record, or shows a notice so you can start in one click.',
    },
    {
      id: 'heads-up',
      nav: 'Heads-up',
      title: 'A heads-up before each meeting.',
      body: 'The menu bar shows your next meeting with a countdown, and the rest of today’s and tomorrow’s meetings. Before a meeting, you get notified, with prep drawn from what your team already knows about it.',
    },
    {
      id: 'agent-on-call',
      nav: 'On the call',
      title: 'An agent on the call, for you only.',
      body: 'A small window floats over your call. It shows the time left, who is speaking, your goal for the call and a short briefing, and you can ask the agent a question and get an answer from what your team knows. It stays out of screen shares unless you choose to show it.',
      demo: 'live-agent',
    },
    {
      id: 'speakers',
      nav: 'Speakers',
      title: 'It learns who said what.',
      body: 'Voice ID recognizes the voices it has heard before and suggests a name for a new one. Accept a suggestion and every line from that voice is relabeled.',
      demo: 'speaker-id',
    },
    {
      id: 'notes',
      nav: 'Notes',
      title: 'Notes and next steps when you hang up.',
      body: 'Each call becomes a meeting with notes, a transcript, and the tasks and decisions it made, staged for you to accept. Transcription runs on your Mac with an on-device model, and falls back to the cloud when it can’t.',
      demo: 'capture',
    },
    {
      id: 'studio',
      nav: 'Studio',
      title: 'It records for the Studio too.',
      body: 'For a product video, the app records your screen, camera and microphone as separate files, and keeps where you clicked so the editor can zoom in on each click.',
    },
  ],
  faq: [
    {
      q: 'Will the people on the call see a bot?',
      a: 'No. The app records from your computer, so nothing joins the call.',
    },
    {
      q: 'Is there a Windows app?',
      a: 'Capture is on the Mac today, and Windows capture is on the way. The web app works in any browser, and you can also record a meeting there.',
    },
    {
      q: 'What permissions does it need?',
      a: 'Microphone access for your voice and screen recording access for the call’s audio. Calendar access is optional.',
    },
    {
      q: 'Do I need a separate account?',
      a: 'No. Sign in with your Native Intelligence account. The app runs the same workspace as the web.',
    },
  ],
  related: ['meetings', 'agents', 'studio'],
}
