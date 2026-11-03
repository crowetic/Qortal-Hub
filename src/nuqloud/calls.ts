// Embedded chat does not mount the desktop voice stack. Call controls are hidden.
export const useVoiceCallContext = () => ({
  callState: 'idle',
  activeCallChatId: null,
  initiateCall: async () => false,
  hangUp: async () => {},
});
export const useCallSwitchGuard = () => ({
  confirmCallSwitch: async () => false,
});
