const RETICULUM_QORTAL_HUB_NETWORK_NAME = 'qortal-hub';

export type ReticulumHubEndpoint = {
  name: string;
  host: string;
  port: number;
  /**
   * Outbound hub link. `BackboneInterface` remotes use `remote` on Linux.
   * Non-Linux hosts fall back to TCPClientInterface (Backbone stack is Linux-only in RNS).
   */
  interfaceType?: 'TCPClientInterface' | 'BackboneInterface';
  /** Optional Reticulum virtual network segment (see RNS interface `network_name`). */
  networkName?: string;
};

export const DEFAULT_RETICULUM_HUBS: readonly ReticulumHubEndpoint[] =
  Object.freeze([
    {
      name: 'Backbone Client Qortal Hub',
      host: 'phantom.mobilefabrik.com',
      port: 4400,
      interfaceType: 'BackboneInterface',
      networkName: RETICULUM_QORTAL_HUB_NETWORK_NAME,
    },
    {
      name: 'Crowetic Reticulum Hub',
      host: 'reticulum.qortal.link',
      port: 4444,
      interfaceType: 'BackboneInterface',
      networkName: RETICULUM_QORTAL_HUB_NETWORK_NAME,
    },
    {
      name: 'Crowetic Reticulum Hub 2',
      host: 'reticulum2.qortal.link',
      port: 4444,
      interfaceType: 'BackboneInterface',
      networkName: RETICULUM_QORTAL_HUB_NETWORK_NAME,
    },
    {
      name: 'Crowetic Reticulum Hub 3',
      host: 'reticulum3.qortal.link',
      port: 4444,
      interfaceType: 'BackboneInterface',
      networkName: RETICULUM_QORTAL_HUB_NETWORK_NAME,
    },
    {
      name: 'Crowetic Reticulum Hub 4',
      host: 'reticulum4.qortal.link',
      port: 4444,
      interfaceType: 'BackboneInterface',
      networkName: RETICULUM_QORTAL_HUB_NETWORK_NAME,
    },
    {
      name: 'Crowetic Reticulum Hub 5',
      host: 'reticulum5.qortal.link',
      port: 4444,
      interfaceType: 'BackboneInterface',
      networkName: RETICULUM_QORTAL_HUB_NETWORK_NAME,
    },
  ]);
