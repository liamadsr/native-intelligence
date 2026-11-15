import type { FeaturePage } from './types'

export const skills: FeaturePage = {
  slug: 'skills',
  name: 'Skills',
  title: 'Write it down once. Every agent does it that way.',
  lead: 'A skill is a playbook for one job: how your team writes release notes, preps for a renewal or runs a discovery call. Save it once, and the assistant, your agents and your flows follow it.',
  metaTitle: 'Skills: teach your agents how your team works',
  metaDescription:
    'Save how your team does a job as a skill. Run it from chat, give it to an agent, run it in a flow, or use it as a playbook on your calls.',
  intro: [
    'Every team has a way it does things: the format of a weekly update, the questions asked on a first call, the checklist before a launch. Usually it lives in someone’s head, and every new request to an assistant starts from scratch.',
    'Skills put that way of working into the workspace. The chat can save one from a conversation that went well, and the same skill then runs from a slash command, inside an agent, in a flow on a schedule, or on a live call.',
  ],
  sections: [
    {
      id: 'what',
      nav: 'What it is',
      title: 'A playbook in plain words.',
      body: 'A skill has a name, a line that says when it applies, and the steps written as instructions. It reads like a note to a new teammate, not a program.',
      points: [
        'Steps and format in plain markdown',
        'A short description that tells the assistant when to use it',
        'Optional limits on which tools it may use',
      ],
    },
    {
      id: 'from-chat',
      nav: 'From chat',
      title: 'Save one from a chat that worked.',
      body: 'When the assistant gets something right, ask it to save the approach as a skill. It shows you the name, the description and the steps before it saves, and swaps this run’s names and dates for placeholders.',
    },
    {
      id: 'run-it',
      nav: 'Run it',
      title: 'Run it from any chat box.',
      body: 'Type its slash command, or pick it with @ in any chat box. Your next message goes out with the skill’s playbook.',
    },
    {
      id: 'agents',
      nav: 'In agents',
      title: 'Give it to an agent.',
      body: 'An agent can carry up to five skills it always checks. Two agents with the same skill do the job the same way.',
    },
    {
      id: 'flows',
      nav: 'In flows',
      title: 'Put it on a trigger.',
      body: 'A flow can run a skill when a meeting ends, when mail arrives or on a schedule. In report mode it only reads and drafts. In act mode it uses the tool categories you gave it, and you see those categories before the flow switches on.',
    },
    {
      id: 'calls',
      nav: 'On calls',
      title: 'Use it as a playbook on your calls.',
      body: 'Save a skill as a call playbook, and the agent on your calls follows it on that kind of call. A built-in playbook, like the one for a discovery call, can be replaced with your own.',
    },
    {
      id: 'share',
      nav: 'Share',
      title: 'Keep it to yourself, or share it.',
      body: 'A new skill is personal until you share it with the workspace. Import a SKILL.md file to bring one in, export one to take it elsewhere, and add skills other teams published from Discover.',
    },
  ],
  faq: [
    {
      q: 'Do I need to write code to make a skill?',
      a: 'No. A skill is written instructions. You can also ask the assistant to write one from a conversation and check it before it is saved.',
    },
    {
      q: 'Who sees the skills I make?',
      a: 'Only you, until you share one with the workspace. Publishing to Discover, where other workspaces can find it, is for workspace owners and admins.',
    },
    {
      q: 'Can I bring skills I already have?',
      a: 'Yes. Import a SKILL.md file: its name, description and instructions come in, and you set its tool access inside Native Intelligence.',
    },
    {
      q: 'Can a skill change things on its own?',
      a: 'Only in a flow set to act, and only with the tool categories you gave it. Without them it reads and drafts, and never changes the board or the CRM.',
    },
  ],
  related: ['agents', 'flows', 'meetings'],
}
