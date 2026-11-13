// The Studio's pages rail, down its left edge, always there (Liam, 11-13: "a panel … where you saw all the different
// pages like overview storyboard cast edit"; "the side panel should be on the left side and … integrated within the
// overall panel"). The app's sub-nav beside its own rail switches between Outreach's pages now, the Studio one of them,
// so this is where the Studio's own navigation lives.
//
//   What     Projects and videos (the chooser, a page of its own beside the rail: open a video, New recording, New
//            blank video, New Studio project; ⌘O), the Studio project's overview, then the open video's pages:
//            Overview, Storyboard, Cast, Edit. Any of them leaves Apps setup. Navigation only: the Edit page's tools
//            stay on the Edit page.
//   Look     the page's own navigation column: on the Studio's ground, no fill, edge or shadow of its own, so the
//            header and the editor beside it read as one page. Icons only, as slim as the app's own rail (Liam,
//            11-13: "we don't need the page names lets only show it on hover"): each page's name, and its shortcut
//            where it has one, shows beside it on hover and on keyboard focus, in the app's tooltip, and is its
//            accessible name. The groups (Projects and videos · Project overview · the video's four pages) are set
//            apart by a faint short divider. The page on screen wears the selected fill (`aria-current="page"`).
//
// First in the row and in the reading order: a page's navigation comes before its content.
import React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { filmPages, type FilmPage } from './FilmPages';
import { Icon, type IconName } from './icons';

const PAGE_ICONS: Record<FilmPage, IconName> = { project: 'stack', overview: 'grid', storyboard: 'storyboard', cast: 'people', edit: 'timeline' };

/** The rail's names, in its order (the tests read them). */
export const RAIL_LABELS = { projects: 'Projects and videos', project: 'Project overview' } as const;

/** The app rail's tooltip and shortcut key (app/account/(dashboard)/rail/app-rail.tsx), so both rails speak alike. */
const TIP = 'flex items-center gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md';
const KBD = 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground';

function RailItem({ id, icon, label, shortcut, keys, current, disabled, onClick }: {
  id: string; icon: IconName; label: string; shortcut?: string; keys?: string; current: boolean; disabled?: boolean; onClick: () => void;
}) {
  // A disabled button takes no pointer or focus, so its name rides on a wrapper that does: the tooltip still says what it is.
  const button = <button type="button" className={`rail-button${current ? ' active' : ''}`} data-rail-item={id} aria-label={label} aria-current={current ? 'page' : undefined}
    aria-keyshortcuts={keys} disabled={disabled} onClick={onClick}>
    <Icon name={icon} size={18} />
  </button>;
  return <Tooltip>
    <TooltipTrigger asChild>{disabled ? <span className="rail-slot" data-rail-tip={id}>{button}</span> : button}</TooltipTrigger>
    <TooltipContent side="right" sideOffset={8} collisionPadding={8} className={TIP} data-rail-tooltip={id}>
      <span>{label}</span>{shortcut ? <kbd className={KBD}>{shortcut}</kbd> : null}
    </TooltipContent>
  </Tooltip>;
}

export function AppRail({ page, hasProject, chooserOpen, settingsOpen, locked, openProjects, openPage }: {
  page: FilmPage; hasProject: boolean; chooserOpen: boolean; settingsOpen: boolean; locked: boolean;
  openProjects: () => void; openPage: (page: FilmPage) => void;
}) {
  const onFilm = hasProject && !settingsOpen && !chooserOpen;
  const off = !hasProject || locked;
  return <TooltipProvider delayDuration={300} skipDelayDuration={200}>
    <nav className="app-rail" aria-label="Studio pages" data-studio-rail="">
      <RailItem id="projects" icon="folder" label={RAIL_LABELS.projects} shortcut="⌘O" keys="Meta+O Control+O" current={chooserOpen} disabled={locked} onClick={openProjects} />
      <span className="rail-sep" aria-hidden="true" />
      <RailItem id="project" icon={PAGE_ICONS.project} label={RAIL_LABELS.project} current={onFilm && page === 'project'} disabled={off} onClick={() => openPage('project')} />
      <span className="rail-sep" aria-hidden="true" />
      <div className="rail-group" role="group" aria-label="Video">
        {filmPages.map(p => <RailItem key={p.id} id={p.id} icon={PAGE_ICONS[p.id]} label={p.label} current={onFilm && page === p.id} disabled={off} onClick={() => openPage(p.id)} />)}
      </div>
    </nav>
  </TooltipProvider>;
}
