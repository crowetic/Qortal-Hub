import type { PresenceManager } from './presence';

export type ReticulumReachability =
  | 'unknown'
  | 'lan-only'
  | 'hub-connected'
  | 'disconnected';
export type ReticulumBridgeState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'degraded';

export type ReticulumPythonLaunch =
  | {
      cmd: string;
      args: string[];
      cwd: string;
      mode: 'frozen' | 'venv' | 'system';
      envExtra?: Record<string, string>;
    }
  | { error: string };

/** Transport launch/lifecycle, independent of Electron and its shared desktop daemon. */
export interface ReticulumBridgePlatform {
  configDir(): string;
  identityPath(): string;
  instanceIndex(): number;
  logPath?(): string;
  sourceEnvironment(): Record<string, string>;
  launch(script: string, args: string[]): ReticulumPythonLaunch;
  persistTransportState(state: Record<string, unknown>): void;
  presenceManager?(): PresenceManager | null;
}

let desktopPlatform: ReticulumBridgePlatform | undefined;
export function configureDefaultReticulumBridgePlatform(
  value: ReticulumBridgePlatform
): void {
  desktopPlatform = value;
}
export function defaultReticulumBridgePlatform(): ReticulumBridgePlatform {
  if (!desktopPlatform)
    throw new Error(
      'Reticulum bridge launch platform has not been initialized'
    );
  return desktopPlatform;
}
