/** What auto-opening reads of a take (a recording session of this tab). */
type OpenableSession = { id: string; status: string; projectId?: string };

export type ManualOpenIntent = {
  sessionId: string;
  navigationToken: number;
  projectId: string | null;
  projectSignature: string | null;
  workspaceId: string | null;
};
export type ManualOpenContext = Omit<ManualOpenIntent, 'sessionId'> & {
  editDirty: boolean;
  scriptDirty: boolean;
  profileDirty: boolean;
  busy: boolean;
  gestureEditing: boolean;
  appSettingsOpen: boolean;
  otherDialogOpen: boolean;
  presenterRecording: boolean;
};

export function manualOriginMatches(intent: ManualOpenIntent, context: ManualOpenContext): boolean {
  return context.navigationToken === intent.navigationToken
    && context.projectId === intent.projectId
    && context.projectSignature === intent.projectSignature
    && context.workspaceId === intent.workspaceId;
}
export function manualContextUnchanged(intent: ManualOpenIntent, context: ManualOpenContext): boolean {
  return manualOriginMatches(intent, context)
    && !context.editDirty && !context.scriptDirty && !context.profileDirty
    && !context.busy && !context.gestureEditing && !context.appSettingsOpen
    && !context.otherDialogOpen && !context.presenterRecording;
}

/** Auto-open only the session this tab started, while its saved editing context is unchanged. */
export function canAutoOpenManual(intent: ManualOpenIntent, session: OpenableSession, context: ManualOpenContext): boolean {
  return session.id === intent.sessionId && (session.status === 'completed' || session.status === 'failed') && !!session.projectId
    && manualContextUnchanged(intent, context);
}

