const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cookieValue(setCookie) {
  return String(setCookie || '').split(';')[0];
}

async function main() {
  const email = `refresh-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const registered = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Refresh-Test-Password-2026' }),
  });
  const registeredData = await registered.json().catch(() => null);
  const initialCookie = cookieValue(registered.headers.get('set-cookie'));
  assert(registered.ok && registeredData?.token, `Registration failed: ${registered.status} ${JSON.stringify(registeredData)}`);
  assert(initialCookie.startsWith('scifigure_refresh='), 'Registration did not set refresh cookie');
  assert((registered.headers.get('set-cookie') || '').includes('HttpOnly'), 'Refresh cookie is not HttpOnly');
  assert((registered.headers.get('set-cookie') || '').includes('SameSite=Strict'), 'Refresh cookie is not SameSite=Strict');

  const refreshed = await fetch(`${BASE_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: initialCookie },
  });
  const refreshedData = await refreshed.json().catch(() => null);
  const rotatedCookie = cookieValue(refreshed.headers.get('set-cookie'));
  assert(refreshed.ok && refreshedData?.token, `Refresh failed: ${refreshed.status} ${JSON.stringify(refreshedData)}`);
  assert(rotatedCookie && rotatedCookie !== initialCookie, 'Refresh token was not rotated');

  const replay = await fetch(`${BASE_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: initialCookie },
  });
  assert(replay.status === 401, `Old refresh token replay should be rejected, got ${replay.status}`);

  const projects = await fetch(`${BASE_URL}/api/projects`, {
    headers: { Authorization: `Bearer ${refreshedData.token}` },
  });
  assert(projects.ok, `Refreshed access token cannot access projects: ${projects.status}`);

  console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
