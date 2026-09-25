export function normalizeSiteUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) WordPress URL.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Do not put credentials, query parameters, or fragments in the site URL.');
  return url.toString();
}
