import { configuration } from './bridge';
export const globalApiKey = null;
export const handleSetGlobalApikey = () => {};
export const getBaseApiReact = () =>
  configuration?.coreUrl || '/__chat_not_ready__';
export const getBaseApiReactForAvatar = getBaseApiReact;
export const getBaseApiReactForPrimaryName = getBaseApiReact;
export const getBaseApiReactSocket = () => '';
export const getArbitraryEndpointReact = () => '/arbitrary/resources/search';
export const getArbitrarySearchSimpleEndpointReact = () =>
  '/arbitrary/resources/searchsimple';
