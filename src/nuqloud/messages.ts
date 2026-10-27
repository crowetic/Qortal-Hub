import { background } from './background';
export const sendMessageBackground = background;
window.sendMessage = background as any;
