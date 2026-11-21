const origin = 'https://sharkai.invalid';
const paths = new Set(['/', '/wallet', '/chat', '/dashboard', '/admin', '/pricing', '/tests', '/download']);

/** Only user-facing, same-site pages are valid post-login destinations. */
export function safeReturnPath(value: string | null) {
  if (!value?.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && paths.has(url.pathname) ? url.pathname + url.search + url.hash : null;
  } catch { return null; }
}

export function currentReturnPath(fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const location = window.location;
  return safeReturnPath(location.pathname + location.search + location.hash) ?? fallback;
}

const resumeChatKey = 'sharkai:resume-quick-chat';
export function rememberQuickChat(destination: string) {
  try { sessionStorage.setItem(resumeChatKey, destination); } catch { /* Navigation still works. */ }
}

export function consumeQuickChat(destination: string) {
  try {
    if (sessionStorage.getItem(resumeChatKey) !== destination) return false;
    sessionStorage.removeItem(resumeChatKey);
    return true;
  } catch { return false; }
}
