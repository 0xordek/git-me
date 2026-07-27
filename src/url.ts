const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function assertSafeUrl(value: string, secretBearing: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.username || url.password) throw new Error('URL must not contain embedded credentials');
  if (secretBearing && url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error('secret-bearing URLs must use HTTPS (HTTP is allowed only for loopback)');
  }
}
