// The original Group module also renders the desktop shell and memoizes
// ChatGroup at module evaluation. Import its already-extracted services directly
// for an embedded ChatGroup entry, avoiding that circular application startup.
export * from '../components/Group/groupApi';
export { timeDifferenceForNotificationChats } from '../components/Group/groupConstants';
export {
  addDataPublishesFunc,
  decryptResource,
  getDataPublishesFunc,
} from '../components/Group/groupDataPublishes';
export {
  requestQueueAdminMemberNames,
  requestQueueMemberNames,
} from '../components/Group/groupQueues';
export type { GroupProps } from '../components/Group/groupTypes';
export { validateSecretKey } from '../components/Group/groupValidation';
