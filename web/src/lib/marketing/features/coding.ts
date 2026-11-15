import type { FeaturePage } from './types'

export const coding: FeaturePage = {
  slug: 'coding',
  name: 'Coding',
  title: 'Assign a task, get a pull request.',
  lead: 'Give a task to the coding agent like you would to a developer on the team. It works on your repository in a fresh sandbox and opens a pull request for your review.',
  worksWith: 'Works with GitHub',
  metaTitle: 'A coding agent that opens pull requests',
  metaDescription:
    'Assign a task to the coding agent. It works on your GitHub repository in a sandbox, gets its change reviewed, and opens a pull request linked to the task.',
  intro: [
    'Small fixes pile up because writing them up takes as long as doing them. Here the task already exists: it came out of a call, an email or a channel, it sits in a project, and the project knows its repository.',
    'The coding agent picks it up from there. It works from the task, writes its acceptance criteria first, makes the change, and has a second reviewer check the real diff before any pull request opens. The pull request stays linked to the task, so its state shows where your team already looks.',
  ],
  demo: 'execution',
  sections: [
    {
      id: 'assign',
      nav: 'Assign',
      title: 'Hand it a task like a teammate.',
      body: 'Assign a task to a developer agent and press Start, or ask in chat for a code change. The run works on the GitHub repository set on the task’s project.',
      points: [
        'Start from the task itself, or from the chat',
        'The repository comes from the project',
        'Follow the run’s progress on the task as it works',
        'Stop a run at any time',
      ],
    },
    {
      id: 'clear-first',
      nav: 'Clear first',
      title: 'It checks the task is clear before it starts.',
      body: 'Before any code is written, a quick check reads the task. If something would risk building the wrong thing, the run asks you once. Then it writes the acceptance criteria the change has to meet.',
    },
    {
      id: 'sandbox',
      nav: 'Sandbox',
      title: 'It works on a copy of your code.',
      body: 'Each run starts a fresh sandbox with your repository checked out on its own branch. It reads the code, makes focused commits and pushes only its own working branch. Your GitHub token stays on our server and is never handed to the sandbox.',
    },
    {
      id: 'review',
      nav: 'Review',
      title: 'A second reviewer reads the diff first.',
      body: 'When the agent says it is done, a reviewer on a different model reads the actual change against the task and its acceptance criteria. It can send the work back for changes up to twice, or stop it.',
      points: [
        'Each criterion is marked as passed or failed, with evidence',
        'A criterion it cannot judge opens the pull request as a draft',
        'A rejected change opens no pull request',
      ],
    },
    {
      id: 'pull-request',
      nav: 'Pull request',
      title: 'You review and merge, as always.',
      body: 'The pull request opens on GitHub, linked to the task. Your team reviews it and merges it the way it already does.',
    },
    {
      id: 'linked-prs',
      nav: 'Linked PRs',
      title: 'Every pull request finds its task.',
      body: 'Connect GitHub and a pull request that mentions a task’s identifier, like ENG-42, links itself to that task. When it opens, merges, closes or reopens, the task shows it.',
      points: [
        'Pull requests from people and agents alike',
        'A flow can run when a linked pull request changes state',
        'Ask the assistant for a pull request’s status in chat',
      ],
    },
    {
      id: 'ci',
      nav: 'Red checks',
      title: 'It can fix its own failing checks.',
      body: 'Switch on the CI fix flow for a repository, and when checks fail on a pull request a coding run opened, it starts a fix run on that branch, at most twice per pull request. Its instructions rule out deleting or weakening a test to turn the checks green.',
    },
  ],
  faq: [
    {
      q: 'Does the agent merge its own pull requests?',
      a: 'No. It opens a pull request. Your team reviews and merges it on GitHub.',
    },
    {
      q: 'Which repositories can it work on?',
      a: 'GitHub repositories in your workspace’s projects. Set a repository on a project, and the project’s tasks can be handed to the coding agent.',
    },
    {
      q: 'What if the task is vague?',
      a: 'A check before the run reads the task. If it is unclear enough to risk building the wrong thing, the run asks you one round of questions before it starts.',
    },
    {
      q: 'Does the sandbox get our GitHub token?',
      a: 'No. Clones and pushes go through our server, which adds the token on its side. The sandbox can push only the run’s own working branch.',
    },
  ],
  related: ['agents', 'tasks', 'flows'],
}
