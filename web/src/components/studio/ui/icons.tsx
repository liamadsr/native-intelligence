import React from 'react';

export type IconName = 'folder' | 'undo' | 'redo' | 'export' | 'record' | 'background' | 'cursor' | 'zoom' | 'audio' | 'clip' | 'play' | 'pause' | 'previous' | 'next' | 'split' | 'plus' | 'trash' | 'save' | 'close' | 'check' | 'chevron' | 'image' | 'arrowLeft' | 'arrowRight' | 'keyboard' | 'transcript' | 'motion' | 'presenter' | 'agent' | 'browser' | 'search' | 'type' | 'file' | 'home' | 'grid' | 'storyboard' | 'people' | 'timeline' | 'apps' | 'stack';
const paths: Record<IconName, React.ReactNode> = {
  folder: <path d="M3 7h6l2 2h10v11H3zM3 7V4h6l2 3"/>,
  undo: <><path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12"/></>,
  redo: <><path d="m16 5 5 5-5 5M21 10H10a6 6 0 0 0 0 12"/></>,
  export: <><path d="M12 15V2m-5 5 5-5 5 5M4 12v9h16v-9"/></>,
  record: <circle cx="12" cy="12" r="6"/>,
  background: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M1 8V5m0 11v3m22-11V5m0 11v3M8 1H5m11 0h3M8 23H5m11 0h3"/></>,
  cursor: <path d="m6 3 13 11-7 1-4 6z"/>,
  transcript: <><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h8M8 14h5M8 18h8"/></>,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 8h1m3 0h1m3 0h1m3 0h1M5 11h1m3 0h1m3 0h1m3 0h1M5 14h1m3 0h1m3 0h1m3 0h1M7 17h10"/></>,
  motion: <><path d="M2 17c4 0 4-10 8-10s4 10 8 10 4-10 4-10"/><circle cx="10" cy="7" r="1.5"/><circle cx="18" cy="17" r="1.5"/></>,
  agent: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></>,
  presenter: <><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/><circle cx="9" cy="11" r="2"/></>,
  zoom: <><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M10 6v8m-4-4h8"/></>,
  audio: <><path d="M4 9h4l5-5v16l-5-5H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
  clip: <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></>,
  play: <path d="m8 4 12 8-12 8z"/>, pause: <><path d="M8 4v16m8-16v16"/></>,
  previous: <><path d="M5 5v14m14-14L8 12l11 7z"/></>, next: <><path d="M19 5v14M5 5l11 7-11 7z"/></>,
  split: <><circle cx="5" cy="6" r="3"/><circle cx="5" cy="18" r="3"/><path d="m8 8 13 13M8 16 21 3"/></>,
  plus: <path d="M12 4v16M4 12h16"/>, trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
  save: <><path d="M4 3h14l3 3v15H3V3zM7 3v7h10V3M7 21v-7h10v7"/></>,
  close: <path d="m5 5 14 14M5 19 19 5"/>, check: <path d="m4 12 5 5L20 6"/>,
  chevron: <path d="m7 10 5 5 5-5"/>, image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="2"/><path d="m3 18 6-6 4 4 4-7 4 9"/></>,
  stack: <><path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5"/></>,
  home: <><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></>,
  storyboard: <><rect x="3" y="5" width="8" height="6" rx="1.5"/><rect x="13" y="5" width="8" height="6" rx="1.5"/><path d="M3 15h8M3 18.5h5M13 15h8M13 18.5h5"/></>,
  people: <><circle cx="9" cy="8.5" r="3.2"/><path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.8c1.9.6 3.1 2.4 3.5 5.2"/></>,
  timeline: <><path d="M3 6h18M3 12h18M3 18h18"/><rect x="5" y="4.5" width="7" height="3" rx="1"/><rect x="9" y="10.5" width="9" height="3" rx="1"/><rect x="4" y="16.5" width="6" height="3" rx="1"/></>,
  apps: <><rect x="4" y="4" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="2"/><path d="M16.75 13.5v6.5M13.5 16.75H20"/></>,
  browser: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M5.5 8h1.5m-1.5 3h1.5"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/></>,
  type: <path d="M5 7V5h14v2M12 5v14m-3 0h6"/>,
  file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/></>,
  arrowLeft: <path d="m10 5-7 7 7 7M3 12h18"/>, arrowRight: <path d="m14 5 7 7-7 7M21 12H3"/>,
};
export function Icon({name, size = 18}: {name: IconName; size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
