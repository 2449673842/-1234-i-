export const AUTH_TOKEN_STORAGE_KEY = 'scifigure:auth-token';

let installed = false;
let refreshPromise: Promise<string | null> | null = null;
let accessToken: string | null = null;
let legacyStorageChecked = false;

export function getAccessToken(): string | null {
  if (accessToken) return accessToken;
  if (typeof window === 'undefined') return null;
  try {
    accessToken = window.sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (accessToken) return accessToken;
  } catch { /* session storage unavailable */ }
  if (!legacyStorageChecked) {
    legacyStorageChecked = true;
    try {
      const legacyToken = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
      window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      if (legacyToken) {
        setAccessToken(legacyToken);
        return legacyToken;
      }
    } catch { /* legacy storage unavailable */ }
  }
  return null;
}

export function setAccessToken(token: string): void {
  accessToken = token;
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token); } catch { /* memory token remains */ }
  try { window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY); } catch { /* legacy storage unavailable */ }
}

export function clearAccessToken(): void {
  accessToken = null;
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY); } catch { /* storage unavailable */ }
  try { window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY); } catch { /* storage unavailable */ }
}

function isProtectedApiRequest(input: RequestInfo | URL): boolean {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl, window.location.origin);
  return url.origin === window.location.origin
    && (
      url.pathname.startsWith('/api/projects')
      || url.pathname.startsWith('/api/figure')
      || url.pathname === '/api/export-assets'
      || url.pathname.startsWith('/api/export-assets/')
      || url.pathname.startsWith('/api/license')
      || url.pathname.startsWith('/api/admin')
      || url.pathname === '/api/error-reports'
      || url.pathname === '/api/auth/me'
      || url.pathname === '/api/auth/logout'
      || url.pathname === '/api/internal/legacy-retire-observation'
    );
}

export function installAuthenticatedFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  const refreshAccessToken = () => {
    if (!refreshPromise) {
      refreshPromise = nativeFetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      }).then(async response => {
        if (!response.ok) return null;
        const data = await response.json().catch(() => null);
        const token = typeof data?.token === 'string' ? data.token : null;
        if (token) setAccessToken(token);
        return token;
      }).finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  };
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!isProtectedApiRequest(input)) return nativeFetch(input, init);
    const token = getAccessToken();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    const response = await nativeFetch(input, { ...init, headers, credentials: init.credentials || 'same-origin' });
    if (response.status !== 401) return response;
    const nextToken = await refreshAccessToken();
    if (nextToken) {
      headers.set('Authorization', `Bearer ${nextToken}`);
      return nativeFetch(input, { ...init, headers, credentials: init.credentials || 'same-origin' });
    }
    clearAccessToken();
    window.dispatchEvent(new CustomEvent('scifigure:auth-required'));
    return response;
  };
}

export async function downloadAuthenticatedFile(url: string, fileName: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `下载失败 (${response.status})`);
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
