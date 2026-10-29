// Preserve escaped route/query data when handing Hub's app-tab event to the
// existing NuQloud QDN viewer. The parent chooses the viewer URL itself.
export function qortalAppLink(value: any): string | null {
  if (!value || !['APP', 'WEBSITE'].includes(value.service)) return null;
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  if (value.path != null && typeof value.path !== 'string') return null;
  if (value.identifier != null && typeof value.identifier !== 'string')
    return null;
  let path = (value.path || '').replace(/^\/+/, '');
  if (value.identifier) {
    const position = path.indexOf('#');
    const fragment = position >= 0 ? path.slice(position) : '';
    path = position >= 0 ? path.slice(0, position) : path;
    path += `${path.includes('?') ? '&' : '?'}identifier=${encodeURIComponent(value.identifier)}${fragment}`;
  }
  const url = `qortal://${value.service}/${encodeURIComponent(value.name.trim())}/${path}`;
  return url.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(url) ? url : null;
}
