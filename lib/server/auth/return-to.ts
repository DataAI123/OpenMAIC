const BLOCKED_PATHS = ['/api/auth', '/auth', '/login'];
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

export function safeReturnTo(candidate: string | null, appOrigin: string): string {
  if (!candidate || candidate.length > 2048 || CONTROL_OR_BACKSLASH.test(candidate)) return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';

  try {
    const decoded = decodeURIComponent(candidate);
    if (CONTROL_OR_BACKSLASH.test(decoded)) return '/';
    const target = new URL(candidate, appOrigin);
    const origin = new URL(appOrigin).origin;
    if (target.origin !== origin || target.username || target.password) return '/';
    if (
      BLOCKED_PATHS.some(
        (blocked) => target.pathname === blocked || target.pathname.startsWith(`${blocked}/`),
      )
    ) {
      return '/';
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}
