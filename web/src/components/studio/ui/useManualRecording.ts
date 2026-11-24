import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { manualSessionActive, recordingController, type RecordingController } from '../record/controller';

export { manualSessionActive, type PrompterMark, type RecorderState, type RecordingSession, type RecordingStart } from '../record/controller';

/**
 * The Record dialog's recorder, as the Studio card sees it: which backend, what it can record, and the takes. The takes
 * themselves live in the page's recording controller (record/controller.ts), not in this card, so a take keeps
 * recording, uploading and filing while the person is elsewhere in the app, and this card finds it as it was when it
 * opens again. While the card is on screen, `notify` says what happens to a take (otherwise the app's shell does).
 */
export function useManualRecording(notify: (text: string, error?: boolean) => void, controller: RecordingController = recordingController()) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const say = useRef(notify); say.current = notify;
  useEffect(() => controller.attach((text, error) => say.current(text, error)), [controller]);
  const active = snap.sessions.find(manualSessionActive) ?? null;
  const selected = snap.sessions.find(session => session.id === snap.selectedId) ?? null;
  return useMemo(() => ({
    ...snap, active, selected,
    setSelectedId: controller.setSelectedId, records: controller.records, adoptWith: controller.adoptWith, inUseWith: controller.inUseWith,
    claimed: controller.claimed, wordsSettled: controller.wordsSettled, refreshLocalTakes: controller.refreshLocalTakes, retryLocal: controller.retryLocal,
    discardLocal: controller.discardLocal, refreshTargets: controller.refreshTargets, refreshSessions: controller.refreshSessions, checkPermissions: controller.checkPermissions,
    requestPermissions: controller.requestPermissions, unlockDevices: controller.unlockDevices, chooseShare: controller.chooseShare, clearShare: controller.clearShare,
    start: controller.start, stop: controller.stop, cancel: controller.cancel, retry: controller.retry, mark: controller.mark, openPartial: controller.openPartial,
    refreshSavedTakes: controller.refreshSavedTakes, recoverSaved: controller.recoverSaved, discardSaved: controller.discardSaved, refile: controller.refile,
    adopted: controller.adopted, releaseTake: controller.releaseTake, wordsTaken: controller.wordsTaken, takeKey: controller.takeKey,
  }), [snap, active, selected, controller]);
}
export type ManualRecording = ReturnType<typeof useManualRecording>;
