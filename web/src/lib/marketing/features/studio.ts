import type { FeaturePage } from './types'

export const studio: FeaturePage = {
  slug: 'studio',
  name: 'Studio',
  title: 'Make videos and ads where your team already works.',
  lead: 'Write the script, record the screen, edit on a timeline and export an MP4, all inside the workspace. The agent can do any of those steps with you.',
  metaTitle: 'Studio: videos and ads inside your workspace',
  metaDescription:
    'Script, record, edit and export product videos and ads inside your workspace, with an agent that writes from your own docs and checks the brand.',
  intro: [
    'A product walkthrough usually means a doc in one tool, a recording in another, an editor in a third, and the brand guide in a folder somewhere. The words drift from how the team actually describes the product.',
    'The Studio keeps it together. Scripts come from your own documents, word for word, and the agent reads your product doc and your voice doc before it writes. The finished video is a record like any other, so you can mention it in chat, make a task about it, or send a link that opens it.',
  ],
  sections: [
    {
      id: 'projects',
      nav: 'Projects',
      title: 'One project per launch or client.',
      body: 'A Studio project groups the videos you make with the same people, brand and media. Its brand holds a name, colors, fonts and a logo.',
      points: [
        'Mark each video Draft, Review or Approved',
        'Every change is kept as a version you can go back to',
        'Deleted videos go to the trash, and their media stays in the library',
      ],
    },
    {
      id: 'script',
      nav: 'Script',
      title: 'Start from a document you already have.',
      body: 'Turn one of your workspace documents into the script, one beat per paragraph. Or open the script as a document so the team can edit and comment on it there. The storyboard then makes one beat per line of the script.',
    },
    {
      id: 'record',
      nav: 'Record',
      title: 'Record beat by beat, with a teleprompter.',
      body: 'In the Mac app, the Studio records your screen, camera and microphone as separate files, and keeps where you clicked so the editor can zoom in on each click. In a browser it records through the browser’s own screen share.',
    },
    {
      id: 'edit',
      nav: 'Edit',
      title: 'Edit on a timeline.',
      body: 'A preview in the shape you chose, a timeline of clips, zooms, text and sound, and an inspector for whatever you select. Recordings with speech can be transcribed, and the transcript lines up with the timeline.',
    },
    {
      id: 'agent',
      nav: 'The agent',
      title: 'Ask the agent to do a step.',
      body: 'From the chat, ask for a project, a script from a doc, a tighter hook, a title over the first beat, or a vertical version. Each change it makes is saved as a version first, and it never overwrites an edit you are making at the same time.',
    },
    {
      id: 'formats',
      nav: 'Formats',
      title: 'One video, every shape.',
      body: 'Make a video widescreen, vertical, 4:5 for feeds or square. A new version for another shape is reframed for it and kept as its own video, with that platform’s safe areas and loudness target.',
    },
    {
      id: 'ads',
      nav: 'Ads',
      title: 'Ads that follow your brand.',
      body: 'Save a brand kit for a project, and the agent makes static ads in four sizes, each checked against the kit’s palette, type, logo rules and banned phrases. Motion ads open as videos you can keep editing.',
    },
    {
      id: 'export',
      nav: 'Export',
      title: 'Export an MP4.',
      body: 'Exports render on the Studio’s own worker. When the agent exported for you, or you left before it finished, the video arrives in For you with a link to open it and a link to download it.',
    },
  ],
  faq: [
    {
      q: 'Do I need the Mac app to use the Studio?',
      a: 'No. The Studio works in the browser, where it records through the browser’s screen share. The Mac app adds pointer and click tracking, so the editor can zoom in on your clicks.',
    },
    {
      q: 'Who can open the Studio?',
      a: 'Members of the workspace. A workspace guest cannot open it.',
    },
    {
      q: 'Will the agent’s edits overwrite mine?',
      a: 'No. If you are editing the same video, the agent reads it again and redoes its change. Every change it makes is saved as a version first.',
    },
    {
      q: 'What shapes can I export?',
      a: 'Widescreen 16:9, vertical 9:16, 4:5 for feeds, and square. Each is an MP4.',
    },
  ],
  related: ['docs', 'desktop-app', 'seo'],
}
