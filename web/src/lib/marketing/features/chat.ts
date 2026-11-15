import type { FeaturePage } from './types'

export const chat: FeaturePage = {
  slug: 'chat',
  name: 'Chat',
  title: 'Team chat and calls, with your agents in the room.',
  lead: 'Channels, direct messages, threads and calls live in the same workspace as your tasks, docs and customers. Mention your agent in a conversation and it answers from what the team knows.',
  metaTitle: 'Chat: team channels, messages and calls',
  metaDescription:
    'Channels, direct messages, threads and audio or video calls in one workspace, with notes for calls and an agent you can mention in any conversation.',
  intro: [
    'Most decisions start as a message. When chat lives in its own app, the decision stays there, and someone has to copy it into a task, a doc or a customer record.',
    'Native Intelligence puts team chat beside everything else. A message becomes a task, an email thread can be shared into a channel, a call ends with notes, and your agent reads the conversation and pitches in when you mention it.',
  ],
  sections: [
    {
      id: 'channels',
      nav: 'Channels and DMs',
      title: 'Channels, direct messages and threads.',
      body: 'Each team has its channels, and anyone can start a direct message. Reply in a thread that opens beside the channel, react to a message, attach files and images, and get a preview of any link you paste.',
      points: [
        'See who is typing',
        'A failed send says so, and Retry sends it once',
        'Messages turn up in the workspace’s search',
      ],
    },
    {
      id: 'agents',
      nav: 'Agents in chat',
      title: 'Mention your agent and it joins in.',
      body: 'Type @ and your agent’s name in any channel or direct message. It reads the recent messages, does the work with your access, and posts its reply into the conversation as your agent.',
      points: [
        'It can look things up in mail, meetings, docs and tasks',
        'Its reply notifies only the person who asked',
        'What teammates write is read as information, never as orders to it',
      ],
    },
    {
      id: 'calls',
      nav: 'Calls',
      title: 'Call from any channel or direct message.',
      body: 'Start an audio or video call from a conversation’s header and share your screen. The call shows as a message in the conversation with Join while it runs, and when it ends it says how long it lasted and who was there.',
      points: ['Audio, video and screen sharing', 'One live call per channel, joined from its message', 'Missed calls show as missed'],
    },
    {
      id: 'call-notes',
      nav: 'Call notes',
      title: 'Calls that end with notes.',
      body: 'Turn notes on and one recorder on the server writes the call down, with every speaker named from who joined. An agent listens along and stages the next steps, and the notes open from the call’s message for everyone who can read the conversation.',
      points: ['Live notes while the call runs', 'A recording link when recording is on', 'Guests are told before they join when notes or recording are on'],
      demo: 'live-agent',
    },
    {
      id: 'guests',
      nav: 'Guests',
      title: 'Bring in people from outside with a link.',
      body: 'Make a meeting link and send it to anyone. A guest opens it in the browser without an account, waits in a lobby, and joins when someone on the call lets them in.',
    },
    {
      id: 'messages-to-tasks',
      nav: 'Messages to tasks',
      title: 'A message becomes a task without leaving the chat.',
      body: 'Hover over any message and make it a task, linked back to where it was said. Share an email thread into a channel with a note, and teammates read it there without anyone forwarding it.',
    },
    {
      id: 'notifications',
      nav: 'Notifications',
      title: 'Hear about what is meant for you.',
      body: 'Set each channel to all messages, mentions only, or muted. Direct messages, mentions and thread replies reach you in the app and as a desktop banner, and if you are away, one email gathers what you missed.',
    },
  ],
  faq: [
    {
      q: 'Do we still need a separate chat app?',
      a: 'No. Channels, direct messages, threads and calls are all here, with your agent in the conversation.',
    },
    {
      q: 'Can people outside the company join a call?',
      a: 'Yes, with a meeting link. They join from the browser without an account, once someone on the call lets them in.',
    },
    {
      q: 'Who can read the notes from a call?',
      a: 'Everyone who can read the conversation the call happened in.',
    },
    {
      q: 'Can my agent read every channel?',
      a: 'No. It works with your access, so it reads only the conversations you can read. Mentioning it in a channel hands it that channel’s recent messages.',
    },
  ],
  related: ['meetings', 'agents', 'mail'],
}
