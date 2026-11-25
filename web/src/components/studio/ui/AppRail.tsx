// The Studio's pages, as tabs across the top of the page (Liam, 11-24, of the column of icons down its left edge: "the
// side panel … look kinda crazy and I don't like how the buttons are just floating on the sides"; he chose tabs on
// top). The app's sub-nav beside its own rail switches between Outreach's pages, the Studio one of them, so this is
// where the Studio's own navigation lives.
//
//   What     Projects (the chooser, a page of its own under the tabs: open a video, New recording, New blank video,
//            New Studio project; ⌘O), the Studio project's overview, then the open video's pages: Overview,
//            Storyboard, Cast, Edit. Any of them leaves Apps setup. Navigation only: the Edit page's tools stay on the
//            Edit page.
//   Look     the app's page tabs (components/views/page-tabs.tsx: a 28px pill per page, 13px text, the page on screen
//            filled, in a 48px row 10px from the card's corner), drawn by studio.css because the Studio's own button
//            rules win over utility classes, 4px apart like the app's. The page on screen is `aria-current="page"`;
//            each tab's full name and its shortcut, where it has one, is its tooltip. The video's four are a group of
//            their own for assistive technology, with no mark on screen.
//
// First in the column and in the reading order: a page's navigation comes before its content. The tests still find
// it by `data-studio-rail` and its tabs by `data-rail-item`.
import React from 'react';
import { useModKeyLabel } from '@/lib/hotkeys';
import { filmPages, type FilmPage } from './FilmPages';

/** The tabs' full names, in their order (the tests read them); the tab itself shows the short word. */
export const RAIL_LABELS = { projects: 'Projects and videos', project: 'Project overview' } as const;

function Tab({ id, text, label, shortcut, keys, current, disabled, onClick }: {
  id: string; text: string; label: string; shortcut?: string; keys?: string; current: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className={`studio-tab${current ? ' active' : ''}`} data-rail-item={id} aria-label={label} aria-current={current ? 'page' : undefined}
    aria-keyshortcuts={keys} title={shortcut ? `${label} (${shortcut})` : label} disabled={disabled} onClick={onClick}>{text}</button>;
}

export function AppRail({ page, hasProject, chooserOpen, settingsOpen, locked, openProjects, openPage }: {
  page: FilmPage; hasProject: boolean; chooserOpen: boolean; settingsOpen: boolean; locked: boolean;
  openProjects: () => void; openPage: (page: FilmPage) => void;
}) {
  const onFilm = hasProject && !settingsOpen && !chooserOpen;
  const off = !hasProject || locked;
  // ⌘O on a Mac, Ctrl+O elsewhere (the app's own label, lib/hotkeys.ts); the Studio's handler takes either key.
  const openKeys = useModKeyLabel('O'), mac = openKeys.startsWith('⌘');
  return <nav className="studio-tabs" aria-label="Studio pages" data-studio-rail="">
    <Tab id="projects" text="Projects" label={RAIL_LABELS.projects} shortcut={openKeys} keys={mac ? 'Meta+O' : 'Control+O'} current={chooserOpen} disabled={locked} onClick={openProjects} />
    <Tab id="project" text="Project" label={RAIL_LABELS.project} current={onFilm && page === 'project'} disabled={off} onClick={() => openPage('project')} />
    <div className="studio-tabs-group" role="group" aria-label="Video">
      {filmPages.map(p => <Tab key={p.id} id={p.id} text={p.label} label={p.label} current={onFilm && page === p.id} disabled={off} onClick={() => openPage(p.id)} />)}
    </div>
  </nav>;
}
