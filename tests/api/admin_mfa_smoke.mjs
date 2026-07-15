import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const roleScript = path.join(repoRoot, 'scripts', 'security', 'set-user-role.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-admin-mfa-'));
const dataDir = path.join(tempDir, 'data');
const dbPath = path.join(dataDir, 'scifigure.db');
const port = 34_000 + Math.floor(Math.random() * 2_000);
const baseUrl = `http://127.0.0.1:${port}`;
const adminEmail = `admin-mfa-${Date.now()}@example.test`;
const userEmail = `admin-mfa-user-${Date.now()}@example.test`;
const bootstrapEmail = `admin-mfa-bootstrap-${Date.now()}@example.test`;
const uiEmail = `admin-mfa-ui-${Date.now()}@example.test`;
const bruteEmail = `admin-mfa-brute-${Date.now()}@example.test`;
const password = 'Admin-Mfa-Smoke-Password-2026';
const deviceFingerprint = `admin-mfa-device-${crypto.randomUUID()}`;
const mfaKey = Buffer.alloc(32, 11).toString('base64');
const serverOutput = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function authHeaders(token, fingerprint = deviceFingerprint) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Device-Fingerprint': fingerprint,
    'X-Device-Name': 'admin-mfa-smoke',
  };
}

function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function jsonResponse(response) {
  return response.json().catch(() => null);
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/health/live');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not start. Output:\n${serverOutput.join('')}`);
}

function setRole(email, role) {
  const result = spawnSync(process.execPath, [
    tsxCli,
    roleScript,
    '--email', email,
    '--role', role,
    '--reason', 'admin_mfa_smoke',
  ], {
    cwd: repoRoot,
    env: { ...process.env, SCIFIGURE_DB_PATH: dbPath, SCIFIGURE_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert(result.status === 0, `Role provisioning failed: ${result.stderr || result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert(payload?.user?.role === role, `Role provisioning returned wrong role: ${result.stdout}`);
  assert(!JSON.stringify(payload).includes(email), 'Offline role output must not repeat the raw email');
}

function runBootstrap(args) {
  const result = spawnSync(process.execPath, [tsxCli, path.join(repoRoot, 'scripts', 'security', 'admin-mfa-bootstrap.ts'), ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SCIFIGURE_DB_PATH: dbPath,
      SCIFIGURE_DATA_DIR: dataDir,
      SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY: mfaKey,
      SCIFIGURE_TEST_ISOLATED: '1',
    },
    encoding: 'utf8',
  });
  assert(result.status === 0, `Offline MFA bootstrap failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = value.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totp(secret, nowMs = Date.now()) {
  const counter = Math.floor(nowMs / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % 1_000_000).padStart(6, '0');
}

function recoveryCodeHash(userId, code) {
  const normalized = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(`scifigure-admin-recovery:v1:${userId}:${normalized}`).digest('hex');
}

async function register(email, displayName) {
  const response = await request('/api/auth/register', {
    method: 'POST',
    headers: authHeaders(null),
    body: JSON.stringify({ email, password, displayName }),
  });
  const data = await jsonResponse(response);
  assert(response.ok && data?.token && data?.user?.id, `Registration failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function passwordLogin(email, fingerprint = deviceFingerprint) {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: authHeaders(null, fingerprint),
    body: JSON.stringify({ email, password }),
  });
  return { response, data: await jsonResponse(response) };
}

function assertMfaDatabaseDoesNotContain(values) {
  const database = new Database(dbPath, { readonly: true });
  try {
    const factors = database.prepare('SELECT * FROM admin_mfa_factors').all();
    const recovery = database.prepare('SELECT * FROM admin_mfa_recovery_codes').all();
    const challenges = database.prepare('SELECT * FROM admin_mfa_login_challenges').all();
    const audit = database.prepare('SELECT metadata FROM admin_audit_logs').all();
    const serialized = JSON.stringify({ factors, recovery, challenges, audit });
    for (const value of values) {
      assert(!serialized.includes(value), `MFA database storage leaked plaintext value: ${value}`);
    }
    assert(factors.every(row => String(row.secret_envelope).startsWith('v2.primary.')), 'TOTP secret must use a versioned key-id encrypted envelope');
    assert(recovery.every(row => /^[a-f0-9]{64}$/.test(row.code_hash)), 'Recovery codes must be stored as hashes');
  } finally {
    database.close();
  }
}

const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
    SCIFIGURE_TEST_ISOLATED: '1',
    SCIFIGURE_DATA_DIR: dataDir,
    SCIFIGURE_DB_PATH: dbPath,
    SCIFIGURE_RENDER_MODE: 'local',
    SCIFIGURE_ADMIN_CONSOLE_ENABLED: '1',
    SCIFIGURE_ADMIN_OPERATIONS_ENABLED: '1',
    SCIFIGURE_ADMIN_MFA_MODE: 'observe',
    SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY: mfaKey,
    SCIFIGURE_AUTH_THROTTLE_SECRET: 'isolated-admin-mfa-auth-throttle-secret-2026',
    ADMIN_MFA_USER_ATTEMPT_LIMIT_PER_15_MINUTES: '6',
    ADMIN_MFA_IP_ATTEMPT_LIMIT_PER_15_MINUTES: '200',
    ADMIN_MFA_GLOBAL_ATTEMPT_LIMIT_PER_15_MINUTES: '500',
    AUTH_RATE_LIMIT_PER_15_MINUTES: '500',
    DISABLE_HMR: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', chunk => serverOutput.push(chunk.toString()));
server.stderr.on('data', chunk => serverOutput.push(chunk.toString()));

try {
  await waitForServer();
  const admin = await register(adminEmail, 'MFA Administrator');
  const ordinary = await register(userEmail, 'MFA Ordinary User');
  await register(bootstrapEmail, 'MFA Bootstrap Administrator');
  const uiAdmin = await register(uiEmail, 'MFA UI Administrator');
  await register(bruteEmail, 'MFA Brute Budget Administrator');
  setRole(adminEmail, 'admin');
  setRole(bootstrapEmail, 'admin');
  setRole(uiEmail, 'admin');
  setRole(bruteEmail, 'admin');

  const revokedAdminToken = await request('/api/auth/me', { headers: authHeaders(admin.token) });
  const revokedUiToken = await request('/api/auth/me', { headers: authHeaders(uiAdmin.token) });
  assert(revokedAdminToken.status === 401 && revokedUiToken.status === 401, 'Role promotion must revoke every pre-promotion session');
  const freshAdminLogin = await passwordLogin(adminEmail);
  const freshUiLogin = await passwordLogin(uiEmail, 'ui-admin-device');
  assert(freshAdminLogin.response.ok && freshAdminLogin.data?.token, 'Fresh administrator login after promotion failed');
  assert(freshUiLogin.response.ok && freshUiLogin.data?.token, 'Fresh UI administrator login after promotion failed');
  let adminToken = freshAdminLogin.data.token;
  const uiAdminToken = freshUiLogin.data.token;

  const browser = await chromium.launch({ headless: true });
  let uiSecret = '';
  let uiRecoveryCodes = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(({ token }) => {
      window.sessionStorage.setItem('scifigure:auth-token', token);
    }, { token: uiAdminToken });
    await page.goto(`${baseUrl}/admin/security`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '管理员安全设置' }).waitFor();
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole('button', { name: '开始绑定' }).click();
    const secretLocator = page.locator('.admin-secret-block code');
    await secretLocator.waitFor();
    uiSecret = (await secretLocator.textContent())?.trim() || '';
    assert(/^[A-Z2-7]{32}$/.test(uiSecret), 'Admin security UI did not display a valid one-time manual key');
    await page.getByLabel('6 位动态代码').fill(totp(uiSecret));
    await page.getByRole('button', { name: '确认并启用' }).click();
    await page.getByRole('heading', { name: '一次性恢复码' }).waitFor();
    uiRecoveryCodes = await page.locator('.admin-recovery-codes code').allTextContents();
    assert(uiRecoveryCodes.length === 10, `Admin security UI must show ten one-time recovery codes, got ${uiRecoveryCodes.length}`);
    await page.screenshot({ path: path.join(tempDir, 'admin-mfa-security-page.png'), fullPage: true });
  } finally {
    await browser.close();
  }

  const bootstrap = runBootstrap(['--email', bootstrapEmail]);
  assert(bootstrap?.status === 'pending_confirmation' && bootstrap?.manualKey && bootstrap?.enrollmentToken, 'Offline MFA bootstrap did not create a pending factor');
  assert(!JSON.stringify(bootstrap).includes(bootstrapEmail), 'Offline MFA bootstrap output must mask the administrator email');
  const bootstrapCode = totp(bootstrap.manualKey);
  const bootstrapConfirmed = runBootstrap(['--email', bootstrapEmail, '--confirm-token', bootstrap.enrollmentToken, '--code', bootstrapCode]);
  assert(bootstrapConfirmed?.enabled && bootstrapConfirmed?.recoveryCodes?.length === 10, 'Offline MFA bootstrap did not confirm the factor');
  assert(!JSON.stringify(bootstrapConfirmed).includes(bootstrapEmail), 'Offline MFA confirmation output must mask the administrator email');

  const bootstrapLoginResponse = await request('/api/auth/login', {
    method: 'POST',
    headers: authHeaders(null, 'bootstrap-device'),
    body: JSON.stringify({ email: bootstrapEmail, password }),
  });
  const bootstrapLogin = await jsonResponse(bootstrapLoginResponse);
  assert(bootstrapLoginResponse.status === 202 && bootstrapLogin?.challenge?.challengeToken, 'Offline-enrolled administrator must receive an MFA login challenge');
  const bootstrapMfaResponse = await request('/api/auth/admin-mfa', {
    method: 'POST',
    headers: authHeaders(null, 'bootstrap-device'),
    body: JSON.stringify({ challengeToken: bootstrapLogin.challenge.challengeToken, recoveryCode: bootstrapConfirmed.recoveryCodes[0] }),
  });
  const bootstrapMfa = await jsonResponse(bootstrapMfaResponse);
  assert(bootstrapMfaResponse.ok && bootstrapMfa?.token, `Offline-enrolled administrator could not complete MFA login: ${bootstrapMfaResponse.status}`);

  const lifecycleDb = new Database(dbPath);
  try {
    for (const code of bootstrapConfirmed.recoveryCodes.slice(1, 9)) {
      lifecycleDb.prepare(`
        UPDATE admin_mfa_recovery_codes SET used_at = datetime('now') WHERE code_hash = ?
      `).run(recoveryCodeHash(bootstrap.user.id, code));
    }
  } finally {
    lifecycleDb.close();
  }
  const lastBootstrapRecovery = await request('/api/admin/reauth', {
    method: 'POST',
    headers: authHeaders(bootstrapMfa.token, 'bootstrap-device'),
    body: JSON.stringify({ password, recoveryCode: bootstrapConfirmed.recoveryCodes[9] }),
  });
  assert(lastBootstrapRecovery.ok, `Last recovery code must remain usable: ${lastBootstrapRecovery.status}`);
  const recoveryRequiredResponse = await request('/api/admin/security', { headers: authHeaders(bootstrapMfa.token, 'bootstrap-device') });
  const recoveryRequired = await jsonResponse(recoveryRequiredResponse);
  assert(recoveryRequiredResponse.ok && recoveryRequired?.security?.enabled && recoveryRequired.security.recoveryRequired, 'Consuming the final recovery code must require recovery-code regeneration without disabling TOTP');
  const bootstrapRotateResponse = await request('/api/admin/security/recovery-codes/regenerate', {
    method: 'POST',
    headers: authHeaders(bootstrapMfa.token, 'bootstrap-device'),
    body: JSON.stringify({ password, code: totp(bootstrap.manualKey, Date.now() + 30_000) }),
  });
  const bootstrapRotated = await jsonResponse(bootstrapRotateResponse);
  assert(bootstrapRotateResponse.ok && bootstrapRotated?.recoveryCodes?.length === 10, `TOTP must regenerate an exhausted recovery set: ${bootstrapRotateResponse.status} ${JSON.stringify(bootstrapRotated)}`);
  const recoveryRestored = await jsonResponse(await request('/api/admin/security', { headers: authHeaders(bootstrapMfa.token, 'bootstrap-device') }));
  assert(recoveryRestored?.security?.enabled && !recoveryRestored.security.recoveryRequired && recoveryRestored.security.recoveryCodesRemaining === 10, 'Recovery regeneration must restore the active lifecycle state');

  const initialSecurityResponse = await request('/api/admin/security', { headers: authHeaders(adminToken) });
  const initialSecurity = await jsonResponse(initialSecurityResponse);
  assert(initialSecurityResponse.ok && initialSecurity?.security?.enabled === false, `Initial security state failed: ${initialSecurityResponse.status} ${JSON.stringify(initialSecurity)}`);

  const enrollResponse = await request('/api/admin/security/totp/enroll', {
    method: 'POST',
    headers: authHeaders(adminToken),
    body: JSON.stringify({ password }),
  });
  const enroll = await jsonResponse(enrollResponse);
  const secret = enroll?.enrollment?.manualKey;
  assert(enrollResponse.ok && /^[A-Z2-7]{32}$/.test(secret) && String(enroll?.enrollment?.otpAuthUrl).startsWith('otpauth://'), `Enrollment failed: ${enrollResponse.status} ${JSON.stringify(enroll)}`);
  assert(!String(enroll.enrollment.otpAuthUrl).includes(adminEmail), 'OTP URI must not contain the administrator email');

  const confirmCode = totp(secret);
  const confirmResponse = await request('/api/admin/security/totp/confirm', {
    method: 'POST',
    headers: authHeaders(adminToken),
    body: JSON.stringify({ enrollmentToken: enroll.enrollment.enrollmentToken, code: confirmCode }),
  });
  const confirmed = await jsonResponse(confirmResponse);
  assert(confirmResponse.ok && confirmed?.enabled === true && confirmed?.recoveryCodes?.length === 10, `Enrollment confirmation failed: ${confirmResponse.status} ${JSON.stringify(confirmed)}`);
  const recoveryCodes = confirmed.recoveryCodes;
  assertMfaDatabaseDoesNotContain([secret, confirmCode, ...recoveryCodes, adminEmail, userEmail]);

  const securityResponse = await request('/api/admin/security', { headers: authHeaders(adminToken) });
  const security = await jsonResponse(securityResponse);
  assert(securityResponse.ok && security?.security?.enabled && security.security.sessionVerified, 'Confirmed session must be marked MFA verified');

  const usersResponse = await request(`/api/admin/users?query=${encodeURIComponent(ordinary.user.id)}`, { headers: authHeaders(adminToken) });
  const users = await jsonResponse(usersResponse);
  assert(usersResponse.ok && users?.items?.[0]?.id === ordinary.user.id && users.items[0].accountLabel, 'Admin user list must retain a pseudonymous account selector');
  assert(!JSON.stringify(users).includes(userEmail) && !('email' in users.items[0]) && !('displayName' in users.items[0]), 'Admin user list exposed raw identity data');

  const passwordOnlyReauth = await request('/api/admin/reauth', {
    method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ password }),
  });
  assert(passwordOnlyReauth.status === 400, `MFA-enabled password-only reauth must fail, got ${passwordOnlyReauth.status}`);

  const recoveryReauthResponse = await request('/api/admin/reauth', {
    method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ password, recoveryCode: recoveryCodes[0] }),
  });
  const recoveryReauth = await jsonResponse(recoveryReauthResponse);
  assert(recoveryReauthResponse.ok && recoveryReauth?.reauthToken, `Recovery-code reauth failed: ${recoveryReauthResponse.status} ${JSON.stringify(recoveryReauth)}`);
  const adjustmentResponse = await request(`/api/admin/users/${ordinary.user.id}/subscription`, {
    method: 'POST',
    headers: authHeaders(adminToken),
    body: JSON.stringify({
      plan: 'pro', status: 'active', endsAt: null, reason: 'isolated MFA smoke',
      requestId: `admin-mfa-${crypto.randomUUID()}`, reauthToken: recoveryReauth.reauthToken,
    }),
  });
  assert(adjustmentResponse.ok, `MFA reauth token did not authorize subscription adjustment: ${adjustmentResponse.status}`);

  const replayRecovery = await request('/api/admin/reauth', {
    method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ password, recoveryCode: recoveryCodes[0] }),
  });
  assert(replayRecovery.status === 401, `Recovery code replay must fail, got ${replayRecovery.status}`);

  const loginResponse = await request('/api/auth/login', {
    method: 'POST',
    headers: authHeaders(null),
    body: JSON.stringify({ email: adminEmail, password }),
  });
  const login = await jsonResponse(loginResponse);
  assert(loginResponse.status === 202 && login?.adminMfaRequired && login?.challenge?.challengeToken && !login?.token, `Admin password login must stop at MFA challenge: ${loginResponse.status} ${JSON.stringify(login)}`);

  const wrongDeviceResponse = await request('/api/auth/admin-mfa', {
    method: 'POST',
    headers: authHeaders(null, `wrong-${deviceFingerprint}`),
    body: JSON.stringify({ challengeToken: login.challenge.challengeToken, recoveryCode: recoveryCodes[1] }),
  });
  assert(wrongDeviceResponse.status === 401, `MFA challenge must be device-bound, got ${wrongDeviceResponse.status}`);
  const loginMfaResponse = await request('/api/auth/admin-mfa', {
    method: 'POST',
    headers: authHeaders(null),
    body: JSON.stringify({ challengeToken: login.challenge.challengeToken, recoveryCode: recoveryCodes[1] }),
  });
  const loginMfa = await jsonResponse(loginMfaResponse);
  assert(loginMfaResponse.ok && loginMfa?.token, `Recovery-code login challenge failed: ${loginMfaResponse.status} ${JSON.stringify(loginMfa)}`);
  const refreshCookie = String(loginMfaResponse.headers.get('set-cookie') || '').split(';')[0];
  assert(refreshCookie.startsWith('scifigure_refresh='), 'MFA login must issue a refresh cookie');
  const refreshResponse = await request('/api/auth/refresh', {
    method: 'POST',
    headers: { Cookie: refreshCookie },
  });
  const refreshed = await jsonResponse(refreshResponse);
  assert(refreshResponse.ok && refreshed?.token, `MFA session refresh failed: ${refreshResponse.status} ${JSON.stringify(refreshed)}`);
  adminToken = refreshed.token;
  const refreshedAdminAccess = await request('/api/admin/security', { headers: authHeaders(adminToken) });
  assert(refreshedAdminAccess.ok, `Refresh must preserve the MFA assurance on the same session row: ${refreshedAdminAccess.status}`);

  const nextStepCode = totp(secret, Date.now() + 30_000);
  const totpReauthResponse = await request('/api/admin/reauth', {
    method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ password, code: nextStepCode }),
  });
  assert(totpReauthResponse.ok, `TOTP reauth failed: ${totpReauthResponse.status} ${JSON.stringify(await jsonResponse(totpReauthResponse))}`);
  const replayTotp = await request('/api/admin/reauth', {
    method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ password, code: nextStepCode }),
  });
  assert(replayTotp.status === 401, `TOTP counter replay must fail, got ${replayTotp.status}`);

  const regenerateResponse = await request('/api/admin/security/recovery-codes/regenerate', {
    method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ password, recoveryCode: recoveryCodes[2] }),
  });
  const regenerated = await jsonResponse(regenerateResponse);
  assert(regenerateResponse.ok && regenerated?.recoveryCodes?.length === 10, `Recovery-code regeneration failed: ${regenerateResponse.status} ${JSON.stringify(regenerated)}`);
  const oldRecovery = await request('/api/admin/reauth', {
    method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ password, recoveryCode: recoveryCodes[3] }),
  });
  assert(oldRecovery.status === 401, `Old recovery set must be invalidated, got ${oldRecovery.status}`);

  const ordinaryLogin = await request('/api/auth/login', {
    method: 'POST', headers: authHeaders(null, 'ordinary-device'), body: JSON.stringify({ email: userEmail, password }),
  });
  const ordinaryLoginData = await jsonResponse(ordinaryLogin);
  assert(ordinaryLogin.ok && ordinaryLoginData?.token && !ordinaryLoginData?.adminMfaRequired, 'Ordinary user login must remain unchanged');

  const bruteBootstrap = runBootstrap(['--email', bruteEmail]);
  const bruteCode = totp(bruteBootstrap.manualKey);
  const bruteConfirmed = runBootstrap(['--email', bruteEmail, '--confirm-token', bruteBootstrap.enrollmentToken, '--code', bruteCode]);
  const invalidBruteCode = String((Number(bruteCode) + 137) % 1_000_000).padStart(6, '0');
  const firstBruteLogin = await passwordLogin(bruteEmail, 'brute-device');
  assert(firstBruteLogin.response.status === 202, 'Brute-force fixture did not receive an MFA challenge');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request('/api/auth/admin-mfa', {
      method: 'POST',
      headers: authHeaders(null, 'brute-device'),
      body: JSON.stringify({ challengeToken: firstBruteLogin.data.challenge.challengeToken, code: invalidBruteCode }),
    });
    assert(response.status === (attempt === 4 ? 429 : 401), `Unexpected first-challenge failure status at attempt ${attempt + 1}: ${response.status}`);
  }
  const secondBruteLogin = await passwordLogin(bruteEmail, 'brute-device');
  assert(secondBruteLogin.response.status === 202, 'A fresh password login should create a new challenge before persistent MFA lockout is checked');
  const sixthFailure = await request('/api/auth/admin-mfa', {
    method: 'POST',
    headers: authHeaders(null, 'brute-device'),
    body: JSON.stringify({ challengeToken: secondBruteLogin.data.challenge.challengeToken, code: invalidBruteCode }),
  });
  assert(sixthFailure.status === 401, `Sixth cumulative failure should consume the configured persistent budget, got ${sixthFailure.status}`);
  const persistentLockout = await request('/api/auth/admin-mfa', {
    method: 'POST',
    headers: authHeaders(null, 'brute-device'),
    body: JSON.stringify({ challengeToken: secondBruteLogin.data.challenge.challengeToken, recoveryCode: bruteConfirmed.recoveryCodes[0] }),
  });
  assert(persistentLockout.status === 429 && persistentLockout.headers.get('retry-after'), 'A fresh challenge must not reset the persistent per-admin MFA attempt budget');

  setRole(adminEmail, 'user');
  const demotedResponse = await request('/api/admin/security', { headers: authHeaders(adminToken) });
  assert(demotedResponse.status === 401, `Role change must revoke an MFA-verified session, got ${demotedResponse.status}`);

  setRole(adminEmail, 'admin');
  const auditPasswordLogin = await passwordLogin(adminEmail);
  assert(auditPasswordLogin.response.status === 202 && auditPasswordLogin.data?.challenge?.challengeToken, 'Re-promoted administrator must complete a fresh MFA login');
  const auditMfaResponse = await request('/api/auth/admin-mfa', {
    method: 'POST',
    headers: authHeaders(null),
    body: JSON.stringify({ challengeToken: auditPasswordLogin.data.challenge.challengeToken, recoveryCode: regenerated.recoveryCodes[0] }),
  });
  const auditMfa = await jsonResponse(auditMfaResponse);
  assert(auditMfaResponse.ok && auditMfa?.token, 'Re-promoted administrator could not complete fresh MFA');
  const auditResponse = await request('/api/admin/audit-logs?limit=200', { headers: authHeaders(auditMfa.token) });
  const audit = await jsonResponse(auditResponse);
  assert(auditResponse.ok && audit?.logs?.some(entry => entry.action === 'admin_mfa.enrollment.confirmed'), 'MFA enrollment audit is missing');
  assert(audit.logs.some(entry => entry.action === 'admin_mfa.login'), 'MFA login audit is missing');
  const auditText = JSON.stringify(audit);
  for (const value of [secret, confirmCode, nextStepCode, bootstrap.manualKey, bootstrapCode, bruteBootstrap.manualKey, bruteCode, ...recoveryCodes, ...regenerated.recoveryCodes, ...bootstrapConfirmed.recoveryCodes, ...bootstrapRotated.recoveryCodes, ...bruteConfirmed.recoveryCodes, ...uiRecoveryCodes, adminEmail, userEmail, bootstrapEmail, uiEmail, bruteEmail]) {
    assert(!auditText.includes(value), `Admin audit leaked MFA or raw identity value: ${value}`);
  }

  assertMfaDatabaseDoesNotContain([secret, confirmCode, nextStepCode, bootstrap.manualKey, bootstrapCode, bruteBootstrap.manualKey, bruteCode, uiSecret, ...recoveryCodes, ...regenerated.recoveryCodes, ...bootstrapConfirmed.recoveryCodes, ...bootstrapRotated.recoveryCodes, ...bruteConfirmed.recoveryCodes, ...uiRecoveryCodes, adminEmail, userEmail, bootstrapEmail, uiEmail, bruteEmail]);
  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'encrypted TOTP enrollment and one-time recovery display',
      'administrator security page enrollment workflow',
      'offline production bootstrap enrollment',
      'admin API raw identity minimization',
      'MFA-protected login and subscription reauth',
      'device-bound login challenge',
      'persistent per-admin MFA attempt budget across fresh challenges',
      'TOTP and recovery-code replay rejection',
      'recovery-set rotation',
      'recovery exhaustion state and TOTP recovery',
      'ordinary user login unchanged',
      'role changes revoke all existing sessions',
      'MFA assurance survives refresh rotation',
      'MFA audit excludes secrets and raw emails',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message, stack: error.stack, serverOutput: serverOutput.join('').slice(-12_000) }, null, 2));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
