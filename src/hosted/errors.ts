import i18n from '../i18n/i18n';

export type HostedRequestFailure =
  | 'connection'
  | 'busy'
  | 'timeout'
  | 'operation';

export class HostedRequestError extends Error {
  constructor(
    readonly code: HostedRequestFailure,
    readonly channel?: string
  ) {
    const key = {
      connection: 'connection_failed',
      busy: 'busy',
      timeout: 'request_timeout',
      operation: 'request_failed',
    }[code];
    super(i18n.t(`reticulum:hosted.${key}`));
    this.name = 'HostedRequestError';
  }
}

export const isHostedRequestError = (
  error: unknown
): error is HostedRequestError => error instanceof HostedRequestError;
