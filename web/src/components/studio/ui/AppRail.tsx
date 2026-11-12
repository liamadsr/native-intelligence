// The side rail: where you are in the app, always one click away. Projects, the film's pages (Overview, Storyboard,
// Cast, Edit) and the project this film is an ad of (its overview) — instead of a row of buttons and tabs across the top. Any of them leaves
// Apps setup. (The Browser belongs to the Edit page, so its toggle is there, above the preview.) Apps setup has no entry here in this version.
import React from 'react';
import { filmPages, type FilmPage } from './FilmPages';
import { Icon, type IconName } from './icons';

const PAGE_ICONS: Record<FilmPage, IconName> = { project: 'stack', overview: 'grid', storyboard: 'storyboard', cast: 'people', edit: 'timeline' };

function RailButton({ icon, label, hint, active, disabled, onClick }: { icon: IconName; label: string; hint?: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={`rail-button${active ? ' active' : ''}`} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>
    <Icon name={icon} size={18} /><span className="rail-label" aria-hidden="true">{label}{hint ? <kbd>{hint}</kbd> : null}</span>
  </button>;
}

export function AppRail({ page, hasProject, chooserOpen, settingsOpen, locked, openProjects, openPage }: {
  page: FilmPage; hasProject: boolean; chooserOpen: boolean; settingsOpen: boolean; locked: boolean;
  openProjects: () => void; openPage: (page: FilmPage) => void; openSettings?: () => void;
}) {
  const onFilm = hasProject && !settingsOpen && !chooserOpen;
  return <nav className="app-rail" aria-label="App">
    <div className="rail-group">
      <RailButton icon="home" label="Projects" hint="⌘O" active={chooserOpen} disabled={locked} onClick={openProjects} />
      <span className="rail-sep" aria-hidden="true" />
      <RailButton icon="stack" label="Project overview" active={onFilm && page === 'project'} disabled={!hasProject || locked} onClick={() => openPage('project')} />
      <span className="rail-sep" aria-hidden="true" />
      {filmPages.map(p => <RailButton key={p.id} icon={PAGE_ICONS[p.id]} label={p.label} active={onFilm && page === p.id} disabled={!hasProject || locked} onClick={() => openPage(p.id)} />)}
    </div>
  </nav>;
}
