// Build-time substitution for the desktop application shell. Chat components
// continue importing their existing public services without loading a wallet.
export { QORTAL_APP_CONTEXT } from '../context/AppContext';
export type { extStates } from '../types/app';
export {
  globalApiKey,
  handleSetGlobalApikey,
  getBaseApiReact,
  getBaseApiReactForAvatar,
  getBaseApiReactForPrimaryName,
  getBaseApiReactSocket,
  getArbitraryEndpointReact,
  getArbitrarySearchSimpleEndpointReact,
} from './globalApi';
export const isMainWindow = true;
export const allQueues = {};
export const pauseAllQueues = () => {};
export const resumeAllQueues = () => {};
export const clearAllQueues = () => {};
