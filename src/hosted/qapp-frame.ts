export function hostedQappOrigin(
  url: string,
  hubOrigin = location.origin
): string | null {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.origin !== hubOrigin
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export function isHostedQappMessage(
  event: MessageEvent,
  frame?: HTMLIFrameElement,
  hubOrigin = location.origin
) {
  return Boolean(
    frame?.contentWindow &&
    event.source === frame.contentWindow &&
    event.origin === hostedQappOrigin(frame.src, hubOrigin) &&
    event.data &&
    typeof event.data === 'object' &&
    event.ports?.[0]
  );
}
