const AUTH_TOKEN_STORAGE_KEY = 'scifigure:auth-token';
const TEST_EMAIL = 'capability-regression-smoke@example.test';
const TEST_PASSWORD = 'Capability-Regression-Smoke-2026';

export async function authenticateCapabilitySmokeUser(baseUrl, suiteName) {
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      displayName: `Capability smoke: ${suiteName}`,
    }),
  });
  let data = await register.json().catch(() => null);
  if (register.status === 409) {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    data = await login.json().catch(() => null);
    if (!login.ok) {
      throw new Error(`Capability smoke login failed: ${login.status} ${JSON.stringify(data)}`);
    }
  } else if (!register.ok) {
    throw new Error(`Capability smoke registration failed: ${register.status} ${JSON.stringify(data)}`);
  }
  const token = data?.token || '';
  if (!token) throw new Error('Capability smoke authentication returned no access token');
  return token;
}

export function bearerHeaders(token, headers = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
}

export async function installBrowserAuthentication(context, token) {
  await context.setExtraHTTPHeaders(bearerHeaders(token));
  await context.addInitScript(({ storageKey, accessToken }) => {
    window.localStorage.setItem(storageKey, accessToken);
  }, { storageKey: AUTH_TOKEN_STORAGE_KEY, accessToken: token });
}
