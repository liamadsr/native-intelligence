import type { FeaturePage } from './types'

export const flows: FeaturePage = {
  slug: 'flows',
  name: 'Flows',
  title: 'Steps that run when something happens.',
  lead: 'A flow is one trigger and the steps that follow it. When mail arrives, a meeting ends, a task moves or it turns 9:00, the steps run and you see what they did.',
  metaTitle: 'Flows: automations on triggers and schedules',
  metaDescription:
    'Run steps when mail arrives, a message lands in a channel, a doc is created, a meeting ends or a schedule fires. Built in chat or on a canvas.',
  intro: [
    'A lot of a team’s week is the same small job done again: write up the call, draft the weekly update, check the inbox for a supplier’s reply. Each one starts with something that happened, and each one could start on its own.',
    'Flows start on those moments. Because they run inside the workspace, their steps can read the call that just ended, the email that just arrived or the doc someone just wrote, and hand the result to a skill, a connected app or a document.',
  ],
  sections: [
    {
      id: 'triggers',
      nav: 'Triggers',
      title: 'Runs when something happens.',
      body: 'Pick what starts the flow. Event triggers run at most 50 times a day each, so a busy inbox never runs away with it.',
      points: [
        'New mail in your inbox, from anyone or one sender',
        'A message in a team chat channel, or one that mentions you',
        'A document created by someone on the team',
        'A meeting’s notes finishing, or a set time before or after a recurring meeting',
        'A task reaching a status, or a linked pull request opening, merging or closing',
      ],
    },
    {
      id: 'schedules',
      nav: 'Schedules',
      title: 'Runs on a schedule.',
      body: 'Run a flow hourly, daily, on weekdays, weekly, monthly, on a custom schedule, or once at a set time, in your own time zone.',
    },
    {
      id: 'steps',
      nav: 'Steps',
      title: 'Each step does one thing.',
      body: 'Steps run in order, and a step can use what an earlier one produced. On a status trigger, a step can carry a condition, such as a label, a priority, an assignee or a project.',
      points: [
        'Run a skill, to report or to act',
        'Use a tool in one of your connected apps',
        'Call a web address with the event’s details',
        'Archive the meeting that triggered it',
      ],
    },
    {
      id: 'build',
      nav: 'Build',
      title: 'Ask for it, or lay it out yourself.',
      body: 'Tell the assistant what you want in plain words and it builds the flow. Or open the Flows page and set the trigger and steps on the canvas. Ready-made flows, like a weekly newsletter or a product doc from customer calls, are a click away.',
    },
    {
      id: 'test',
      nav: 'Test',
      title: 'Try it before you switch it on.',
      body: 'A test run works on a sample, a real task or meeting or a made-up one, and shows what each step would do. Nothing is delivered and nothing reaches anyone else.',
    },
    {
      id: 'approvals',
      nav: 'Approvals',
      title: 'Anything outward waits for your yes.',
      body: 'A step that writes to a connected app or posts somewhere waits for your approval card on each run. A flow that sends data out on its own switches on only from your card.',
    },
    {
      id: 'results',
      nav: 'Results',
      title: 'Every run leaves a record.',
      body: 'Each flow has its own agent that reports what it did. Results can land as a document, a notification or email drafts, and the run history shows every run, step by step.',
    },
  ],
  faq: [
    {
      q: 'Do I need to know how to code?',
      a: 'No. Describe the flow to the assistant in plain words, or set it up on the Flows page. Calling a web address is there for teams that want it.',
    },
    {
      q: 'Whose account does a flow run as?',
      a: 'Its owner’s, with their data and connections. Only the owner changes its trigger or steps, and they can hand it to a teammate, who accepts it.',
    },
    {
      q: 'Can a flow send email on its own?',
      a: 'A flow can write email drafts for you to review. A step that reaches outside the workspace through a connected app waits for your approval on each run.',
    },
    {
      q: 'What happens if a flow fires too often?',
      a: 'Each event trigger runs at most 50 times a day, and you can switch a flow off at any time.',
    },
  ],
  related: ['skills', 'agents', 'mail'],
}
