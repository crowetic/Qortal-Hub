/** Process paths are supplied by the desktop shell or the Node daemon. */
export interface NativeRuntimeEnvironment {
  path(name: 'appData' | 'userData' | 'temp'): string;
  resources(): string;
  packaged(): boolean;
  ready(): boolean;
}

let environment: NativeRuntimeEnvironment | undefined;

export function configureNativeRuntimeEnvironment(
  value: NativeRuntimeEnvironment
): void {
  environment = value;
}

export function nativeRuntimeEnvironment(): NativeRuntimeEnvironment {
  if (!environment)
    throw new Error('Native runtime environment has not been initialized');
  return environment;
}
