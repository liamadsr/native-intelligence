/**
 * Environments (migration 420), the server library: what E2's routing and UI
 * build on. Client components import './types' directly instead (this pulls
 * in server code).
 */
export * from './types'
export { ensureMacEnvironment, macEnvironmentId } from './mac'
export { projectRunEnvironment, resolveRunEnvironment, runEnvironmentIdFor } from './resolve'
export { pickChatEnvironment, resolveChatEnvironment, setChatEnvironment } from './chat'
export {
  actionJobRequest,
  folderForRepo,
  startActionOnMac,
  startInEnvironment,
  type ActionOnMacResult,
  type StartInEnvironmentInput,
  type StartInEnvironmentResult,
} from './start'
export {
  MAC_BUSY_REASON,
  archiveEnvironment,
  cleanCloudFields,
  createCloudEnvironment,
  getDefault,
  getEnvironment,
  listCloudEnvironments,
  listEnvironments,
  removeMac,
  setDefault,
  setFolderSetting,
  updateEnvironment,
  type CloudFields,
  type CloudFieldsInput,
} from './store'
