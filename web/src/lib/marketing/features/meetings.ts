import type { FeaturePage } from './types'

export const meetings: FeaturePage = {
  slug: 'meetings',
  name: 'Meetings',
  title: 'Meeting notes for every call.',
  lead: 'The Mac app captures every call you take, in any app. You get notes, a transcript and next steps when you hang up, and an agent that helps while you talk.',
  worksWith: 'Records any call you take on your Mac',
  metaTitle: 'Meetings: notes and transcripts for every call',
  metaDescription:
    'The Mac app captures every call you take, in any app. Notes, a transcript, decisions and next steps when you hang up, and an agent on the call.',
  intro: [
    'Notes from a call usually live with whoever took them, if anyone did. The decisions and promises in them reach the task list a day later, or not at all.',
    'Native Intelligence records from your side of the call, so nobody has to invite a bot. What was said becomes notes, tasks and decisions, the people on the call are linked to their contact records, and the whole team can ask about it later.',
  ],
  demo: 'live-agent',
  sections: [
    {
      id: 'no-bot',
      nav: 'No bot',
      title: 'Captures any call on your Mac.',
      body: 'The Mac app notices when a call app starts using your microphone and offers to record, or starts on its own once you turn on Auto-record meetings. It records your microphone and the call’s sound as two separate streams, so both sides come out clearly in the transcript.',
      points: [
        'A live transcript while you talk',
        'Starts with a calendar meeting that has other people on it, if you want',
        'Pause and resume at any time',
        'Keeps your Mac awake while it records',
      ],
    },
    {
      id: 'notes',
      nav: 'Notes',
      title: 'Notes, transcript and next steps when you hang up.',
      body: 'Each meeting becomes a capture: a summary, the full transcript, the decisions the group made and the tasks it took on. Keep, edit or dismiss the suggested tasks, and confirm the decisions that are right.',
      points: [
        'Meeting types for standups, brainstorms and customer calls, or your own',
        'Draft a follow-up email from the meeting',
        'Comment on the notes and @mention a teammate',
      ],
      demo: 'capture',
    },
    {
      id: 'live-agent',
      nav: 'Agent on the call',
      title: 'An agent that works while you talk.',
      body: 'During the call an agent follows the conversation, looks up mail, projects and docs when they come up, and stages the tasks and decisions as they are made. Ask it something in the meeting’s chat, or tell it what to put in the notes.',
    },
    {
      id: 'hud',
      nav: 'Heads-up display',
      title: 'A small window that keeps you prepared.',
      body: 'On the Mac, a heads-up display floats over your call. It shows who is on the call, your goal for the meeting and a short briefing, and the agent drops in what you need to know as the conversation turns.',
      demo: 'hud-tips',
    },
    {
      id: 'speakers',
      nav: 'Who said what',
      title: 'Every line has a name on it.',
      body: 'Voice ID learns the voices of the people you meet and links each speaker to their contact. When it is not sure, it suggests a name, and once you accept, every line from that voice is relabelled.',
      points: [
        'Reassign any line it got wrong',
        'Corrections make it more sure of each voice',
        'Names and terms your team uses are learned, so transcripts spell them right',
      ],
      demo: 'speaker-id',
    },
    {
      id: 'before',
      nav: 'Before the call',
      title: 'Walk in knowing what happened last time.',
      body: 'Ask the agent to prepare you for a meeting and it pulls the earlier calls, open tasks, decisions and what is known about the people coming. Tell it what you want out of the call, and the goal shows on your screen once the meeting starts.',
    },
    {
      id: 'sharing',
      nav: 'Sharing',
      title: 'Share a meeting with people outside the workspace.',
      body: 'Send a share link that lets someone read the notes, or read and comment. Inside the workspace, a meeting links to its calendar event, its people and the calls before it, so a series of meetings reads as one story.',
    },
  ],
  faq: [
    {
      q: 'Does a bot join the call?',
      a: 'No. The Mac app records from your computer, so nothing joins the call and nobody sees a new participant.',
    },
    {
      q: 'Which call apps does it work with?',
      a: 'The Mac app notices a call when a call app starts using your microphone, and the common ones are picked up on their own. You can also start a recording yourself on any call.',
    },
    {
      q: 'Can I record without the Mac app?',
      a: 'Yes. In the browser you can record from your microphone, which suits a meeting in the room. For calls on your computer, the Mac app also records the other side.',
    },
    {
      q: 'Is our data used to train AI models?',
      a: 'No. Your conversations, documents, contacts and notes are never used to train AI models.',
    },
    {
      q: 'How much does it cost?',
      a: 'Start with a 7-day free trial. The pricing page has the details.',
    },
  ],
  related: ['desktop-app', 'crm', 'tasks'],
}
