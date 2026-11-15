import type { FeaturePage } from './types'

export const agents: FeaturePage = {
  slug: 'agents',
  name: 'Agents',
  title: 'Agents that already know how your team works.',
  lead: 'Each agent starts with what your workspace knows: the calls, the mail, the docs and the tasks. Hand it work the way you would hand it to a teammate.',
  metaTitle: 'Agents that work from your team’s memory',
  metaDescription:
    'Agents that start with what your team knows, follow your skills, are checked against examples, and draft, propose or do the work for you to review.',
  intro: [
    'Most of the time spent briefing an assistant is spent explaining context. In Native Intelligence the context is already there. What was said on Tuesday’s call, what Lena wrote on Wednesday and what the project plan says all sit in one shared memory, and every agent reads from it.',
    'Agents work across the whole workspace. They write documents and email drafts, stage changes to tasks and records for you to accept, follow the skills your team has written down, and report back where you can reply and keep going.',
  ],
  demo: 'execution',
  sections: [
    {
      id: 'shared-memory',
      nav: 'Shared memory',
      title: 'They start with what your team knows.',
      body: 'Calls, mail, chat and docs feed one memory of facts, decisions and commitments, each with the place it came from. An agent searches it before it acts, so you don’t paste the background into every request.',
      points: [
        'Facts keep a link to the call, thread or doc they came from',
        'Agents read projects, tasks, contacts and documents directly',
        'Work an agent finishes goes back into the same memory',
      ],
      demo: 'intelligence-loop',
    },
    {
      id: 'build-an-agent',
      nav: 'Build one',
      title: 'Give each agent a job.',
      body: 'An agent has its own instructions, the tools it may use and up to five skills it always checks. Owners and admins choose whether it can only read, or read and change records in the workspace.',
      points: [
        'Roles for research, writing, correspondence and code',
        'Pick its tools from the workspace’s tool list',
        'Start from a built-in agent or one from Discover',
        'Several agents can share one persona, or each get their own copy',
      ],
    },
    {
      id: 'propose-or-do',
      nav: 'Propose or do',
      title: 'They propose, or they do the work.',
      body: 'When a call or an email turns up something to do, an agent can stage it as a proposal you accept, change or dismiss with one click. When you press Start on a task, it does the work end to end and hands you what it made.',
      points: [
        'Email replies come back as drafts, never sent on their own',
        'Documents are written and linked to the task',
        'Changes to tasks and records are staged for your click',
      ],
      demo: 'action-stream',
    },
    {
      id: 'on-calls',
      nav: 'On calls',
      title: 'An agent can sit in on the call.',
      body: 'During a captured meeting, the live agent listens, looks things up while you talk and stages the tasks and decisions the call made. You can ask it a question mid-call and it answers from what your team knows.',
      demo: 'live-agent',
    },
    {
      id: 'evals',
      nav: 'Evals',
      title: 'Check an agent before it runs alone.',
      body: 'An eval is a set of example meetings, each with what the agent should and should not do. Run it against an agent and see which cases pass before you trust it with real calls.',
      points: [
        'Write cases yourself or ask the assistant to draft them',
        'See each run’s outcome, case by case',
        'Re-run after you change the agent’s instructions',
      ],
    },
    {
      id: 'limits',
      nav: 'Limits',
      title: 'Work done on its own stops short of sending.',
      body: 'When an agent works without you watching, it cannot send mail, delete anything or change your calendar. It drafts, writes and stages, and the step that reaches another person stays yours.',
    },
    {
      id: 'report-back',
      nav: 'Report back',
      title: 'Results come back where you can reply.',
      body: 'Each agent posts what it finished, and you can answer it to keep the work going. The finished work lands in For you, next to everything else that needs your eyes.',
    },
  ],
  faq: [
    {
      q: 'Do I have to explain our company to every agent?',
      a: 'No. Agents read the workspace’s shared memory: past calls, mail, chat, documents, tasks and customer records. What you write down once as a skill, every agent can follow.',
    },
    {
      q: 'Can an agent send email for me?',
      a: 'An agent writes email drafts. When it works on its own, sending is withheld by design, so a draft waits for you to review and send.',
    },
    {
      q: 'How do I know an agent will behave?',
      a: 'Give it an eval: example meetings with what it should and should not do. Run the eval, read the results case by case, and change the agent until it passes.',
    },
    {
      q: 'Who can change what an agent is allowed to do?',
      a: 'Workspace owners and admins set whether an agent may only read, or read and change records in the workspace.',
    },
    {
      q: 'How much does it cost?',
      a: 'Start with a 7-day free trial. The pricing page has the details.',
    },
  ],
  related: ['skills', 'flows', 'coding'],
}
