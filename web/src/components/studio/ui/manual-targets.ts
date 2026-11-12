import type { ManualTarget, ManualTargetCatalog } from '@/lib/studio/engine/api';

export type ManualTargetOption = { key: string; group: 'saved' | 'running'; label: string; detail: string; target: ManualTarget };

/** Never silently switch to a different app when a chosen window disappears. With nothing chosen, start on a real window, not a saved web app. */
export function selectedManualTarget(options: ManualTargetOption[], key: string): ManualTargetOption | undefined {
  return key ? options.find(option => option.key === key) : options.find(option => option.target.kind === 'native') ?? options[0];
}

/** A saved app names the target; the exact live PID and window still have to be selected. */
export function manualTargetOptions(catalog: ManualTargetCatalog): ManualTargetOption[] {
  const saved: ManualTargetOption[] = [];
  const running: ManualTargetOption[] = [];
  for (const profile of catalog.desktopProfiles) {
    for (const app of catalog.native.filter(item => profile.runningPids.includes(item.pid))) {
      for (const window of app.windows) saved.push({
        key: `profile:${profile.id}:${profile.revision}:${app.pid}:${window.windowId}`,
        group: 'saved', label: `${profile.name} · ${window.title || 'Window'}`,
        detail: app.name,
        target: { kind: 'native', pid: app.pid, windowId: window.windowId, profileId: profile.id, revision: profile.revision },
      });
    }
  }
  for (const profile of catalog.webProfiles) saved.push({
    key: `web:${profile.id}:${profile.revision}`, group: 'saved', label: profile.name,
    detail: `Local web app · ${profile.url}`,
    target: { kind: 'web', url: profile.url, profileId: profile.id, revision: profile.revision },
  });
  for (const app of catalog.native) {
    const known = catalog.desktopProfiles.some(profile => profile.runningPids.includes(app.pid));
    if (known) continue;
    for (const window of app.windows) running.push({
      key: `native:${app.pid}:${window.windowId}`, group: 'running',
      label: !window.title || window.title === app.name ? app.name : `${app.name} · ${window.title}`,
      detail: `Running ${app.name}`,
      target: { kind: 'native', pid: app.pid, windowId: window.windowId },
    });
  }
  return [...saved, ...running];
}

