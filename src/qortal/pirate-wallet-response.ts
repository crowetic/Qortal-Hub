/** Preserve a Core wallet error without serializing the request or an arbitrary response. */
export function pirateWalletResult(
  result: unknown,
  httpOk: boolean,
  fallback: string
): unknown {
  const record =
    result && typeof result === 'object'
      ? (result as { error?: unknown; message?: unknown })
      : null;
  if (httpOk && !record?.error) return result;

  const detail = record?.message ?? record?.error ?? result;
  const message =
    typeof detail === 'string' &&
    detail.trim() &&
    !/<\/?[a-z][^>]*>/i.test(detail)
      ? detail
          .trim()
          .replace(
            /(["']?(?:entropy58|arrrSeed58|seedPhrase|privateKey|apiKey|foreignKey)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,}]+)/gi,
            '$1…'
          )
          .slice(0, 1000)
      : fallback;
  throw new Error(message);
}
