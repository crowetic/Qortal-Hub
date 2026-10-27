import { configuration, parentRequest } from './bridge';
import { getBaseApiReact } from './globalApi';
import i18n from '../i18n/i18n';

export const walletVersion = 2;
export const groupApi = '';
export const groupApiSocket = '';
export const gateways = [];
export const groupSecretkeys = {};
export const cleanUrl = (url: string) => url.replace(/^https?:\/\//, '');
export const getProtocol = (url: string) =>
  new URL(url).protocol.replace(':', '');
export const isExtMsg = () => false;
export const getBaseApi = async () => getBaseApiReact();
export const createEndpoint = async (endpoint: string) =>
  `${getBaseApiReact()}${endpoint}`;
export const getFee = async (type: string) => {
  const response = await fetch(
    `${getBaseApiReact()}/transactions/unitfee?txType=${encodeURIComponent(type)}`
  );
  return Number(await response.json()) / 1e8;
};
export const getNameInfo = async (address: string) => {
  const response = await fetch(
    `${getBaseApiReact()}/names/primary/${encodeURIComponent(address)}`
  );
  return (await response.json())?.name || '';
};
export const getNameInfoForOthers = getNameInfo;
export const getUserInfo = async () => configuration.account;
export const getSaveWallet = async () => ({
  address0: configuration.account.address,
});
export const getApiKeyFromStorage = async () => null;
export const getCustomNodesFromStorage = async () => [];
export const isUsingLocal = async () => false;
export const pauseAllQueues = () => {};
export const resumeAllQueues = () => {};
export const getTempPublish = async () => ({});
export const saveTempPublish = async () => true;
export const getTimestampEnterChat = async () => ({});
export const addTimestampEnterChat = async () => true;
export const getTimestampGroupAnnouncement = async () => ({});
export const getUserSettings = async () => ({});
export const addUserSettings = async () => true;
export const getGroupDataSingle = async () => null;
export const parseErrorResponse = async () => {
  throw new Error(i18n.t('reticulum:nuqloud.request_failed'));
};
const unavailable = async (..._args: unknown[]) => {
  throw new Error(i18n.t('reticulum:nuqloud.unsupported'));
};
// These desktop-only operations fail closed if a dormant legacy control reaches
// them. No local wallet, transaction signer or native background listener ships.
export const addDataPublishes = unavailable,
  addEnteredQmailTimestamp = unavailable,
  addTimestampGroupAnnouncement = unavailable,
  addTimestampMention = unavailable,
  banFromGroup = unavailable,
  buyName = unavailable,
  cancelBan = unavailable,
  cancelInvitationToGroup = unavailable,
  cancelSellName = unavailable,
  checkLocalFunc = unavailable,
  checkNewMessages = unavailable,
  checkThreads = unavailable,
  createBuyOrderTx = unavailable,
  createGroup = unavailable,
  decryptDirectFunc = unavailable,
  decryptSingleForPublishes = unavailable,
  decryptSingleFunc = unavailable,
  decryptWallet = unavailable,
  findUsableApi = unavailable,
  fireOsNotificationPayment = unavailable,
  getAddressInfo = unavailable,
  getAssetBalanceInfo = unavailable,
  getAssetInfo = unavailable,
  getBalanceInfo = unavailable,
  getDataPublishes = unavailable,
  getEnteredQmailTimestamp = unavailable,
  getKeyPair = unavailable,
  getLTCBalance = unavailable,
  getLastRef = unavailable,
  getNameOrAddress = unavailable,
  getPublicKey = unavailable,
  getTimestampMention = unavailable,
  getWallets = unavailable,
  handleActiveGroupDataFromSocket = unavailable,
  inviteToGroup = unavailable,
  joinGroup = unavailable,
  kickFromGroup = unavailable,
  leaveGroup = unavailable,
  makeAdmin = unavailable,
  markAllMemberGroupsRead = unavailable,
  notifyAdminRegenerateSecretKey = unavailable,
  performPowTask = unavailable,
  processTransactionVersion2 = unavailable,
  registerName = unavailable,
  removeAdmin = unavailable,
  sellName = unavailable,
  sendChatDirect = unavailable,
  sendChatGroup = unavailable,
  sendChatNotification = unavailable,
  sendCoin = unavailable,
  sendQortFee = unavailable,
  setGroupData = unavailable,
  signChatFunc = unavailable,
  storeWallets = unavailable,
  transferAsset = unavailable,
  updateGroup = unavailable,
  updateName = unavailable,
  updateThreadActivity = unavailable;

export async function background(action: string, data: any = {}) {
  if (action === 'signReticulumChatEvent')
    return parentRequest('sign', { event: data });
  if (action === 'userInfo') return configuration.account;
  if (
    action === 'getTimestampEnterChat' ||
    action === 'getUserSettings' ||
    action === 'getTempPublish'
  )
    return {};
  if (
    [
      'addTimestampEnterChat',
      'setGroupData',
      'saveTempPublish',
      'pauseAllQueues',
      'resumeAllQueues',
    ].includes(action)
  )
    return true;
  return unavailable();
}
