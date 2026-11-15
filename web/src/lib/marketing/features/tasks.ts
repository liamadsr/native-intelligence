import type { FeaturePage } from './types'

export const tasks: FeaturePage = {
  slug: 'tasks',
  name: 'Tasks',
  title: 'Tasks from every conversation.',
  lead: 'Commitments made on calls, in mail and in chat turn into tasks with an owner and a date. Plan them in projects, initiatives and cycles, with a workflow each team sets up its own way.',
  metaTitle: 'Tasks: projects, cycles and team workflows',
  metaDescription:
    'Tasks staged from calls, mail and chat, planned in projects, initiatives and cycles, with team workflows and saved views.',
  intro: [
    'Most tasks are promised out loud, in a meeting or a message, and then someone has to remember to write them down. The ones nobody writes down are the ones that slip.',
    'Native Intelligence stages tasks from the places work is agreed and links each one back to where it came from. Your team plans them the way it already does, with projects, cycles and boards, and an agent can take one on.',
  ],
  demo: 'action-stream',
  sections: [
    {
      id: 'from-anywhere',
      nav: 'From anywhere',
      title: 'Tasks from calls, mail and chat.',
      body: 'The meeting agent stages the tasks a call took on, an email thread or a chat message becomes a task in one click, and you can ask for one in your own words. Each task keeps a link to the conversation it came from.',
      points: [
        'Change or dismiss what the agent staged',
        'Create many at once from a list',
        'A confirmation email or a finished call can mark a task done, with Undo',
      ],
    },
    {
      id: 'details',
      nav: 'Task details',
      title: 'Everything a task needs, in one place.',
      body: 'Every task gets an identifier like ENG-42, a status, a priority, an assignee, a due date and an estimate. Break it into sub-tasks, mark what blocks what, label it, and discuss it in comments with @mentions.',
      points: ['Blocks, blocked by, related and duplicate links', 'Update many tasks at once', 'Custom fields for what your team tracks'],
    },
    {
      id: 'workflows',
      nav: 'Team workflows',
      title: 'Each team runs its own workflow.',
      body: 'Every team sets its own states, from backlog to done, and its own identifier prefix. A task moves through its team’s states on a list or a board, and the dashboard shows how each cycle is going.',
    },
    {
      id: 'planning',
      nav: 'Projects and cycles',
      title: 'Projects, initiatives and cycles.',
      body: 'Group tasks into projects with milestones and target dates, and tie projects to the initiatives they serve. Plan work in time-boxed cycles, and move what is unfinished to the next one when a cycle ends.',
      points: ['Progress worked out from the tasks that are done', 'Docs kept with their project', 'Use any level on its own'],
    },
    {
      id: 'views',
      nav: 'Views',
      title: 'Saved views for the way you look at work.',
      body: 'Filter by status, assignee, priority, label, project, cycle or due date, then sort, group and save it as a view. Keep a view to yourself, or share it with your team or the whole workspace.',
    },
    {
      id: 'hand-off',
      nav: 'Hand it off',
      title: 'Assign a task to an agent.',
      body: 'Give a task to an agent the way you would to a teammate. It reads the meeting, the project and the code, does the work, and opens a pull request for your team to review.',
      demo: 'execution',
    },
    {
      id: 'pull-requests',
      nav: 'Pull requests',
      title: 'Pull requests show on the task.',
      body: 'A GitHub pull request that names a task’s identifier links itself to that task and shows whether it is open, closed or merged, so the board says where the code is without anyone updating it.',
    },
  ],
  faq: [
    {
      q: 'Do we need a separate task tracker?',
      a: 'No. Tasks, projects, cycles, boards and team workflows are all here, next to the mail, calls and chat the tasks come from.',
    },
    {
      q: 'Where does a task from a call come from?',
      a: 'The agent on the call stages it as the commitment is made, with an owner and a date, and links it to the meeting. Change or dismiss any of them.',
    },
    {
      q: 'Can different teams work differently?',
      a: 'Yes. Each team has its own workflow states and identifier prefix, and a view can be kept to one team.',
    },
    {
      q: 'How much does it cost?',
      a: 'Start with a 7-day free trial. The pricing page has the details.',
    },
  ],
  related: ['coding', 'meetings', 'flows'],
}
