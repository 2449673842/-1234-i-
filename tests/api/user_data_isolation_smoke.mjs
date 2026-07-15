const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(path, token, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function register(label) {
  const { response, data } = await jsonRequest('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify({
      email: `isolation-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Isolation-Test-Password-2026',
    }),
  });
  assert(response.ok && data?.token, `Registration failed for ${label}: ${response.status} ${JSON.stringify(data)}`);
  return data.token;
}

async function main() {
  const tokenA = await register('a');
  const tokenB = await register('b');
  const sharedScript = [
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots(figsize=(2, 1.5))',
    'ax.plot([0, 1], [0, 1])',
    'ax.set_title("shared script isolation")',
  ].join('\n');
  const directRenderA = await jsonRequest('/api/figure/render', tokenA, {
    method: 'POST',
    body: JSON.stringify({ script: sharedScript, language: 'python' }),
  });
  const directRenderB = await jsonRequest('/api/figure/render', tokenB, {
    method: 'POST',
    body: JSON.stringify({ script: sharedScript, language: 'python' }),
  });
  assert(directRenderA.response.ok && directRenderA.data?.sessionId, `User A direct render failed: ${JSON.stringify(directRenderA.data)}`);
  assert(directRenderB.response.ok && directRenderB.data?.sessionId, `User B direct render failed: ${JSON.stringify(directRenderB.data)}`);
  assert(directRenderA.data.sessionId !== directRenderB.data.sessionId, 'Identical scripts from different users must receive different server session IDs');

  const crossUserPatch = await jsonRequest('/api/figure/patch', tokenB, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: directRenderA.data.sessionId,
      patches: [{ gid: 'title.0', prop: 'visible', value: true, mode: 'local_patch' }],
    }),
  });
  assert(crossUserPatch.response.status === 404, `User B must not patch User A session, got ${crossUserPatch.response.status}`);
  const ownerPatchAfterCollision = await jsonRequest('/api/figure/patch', tokenA, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: directRenderA.data.sessionId,
      patches: [{ gid: 'title.0', prop: 'visible', value: true, mode: 'local_patch' }],
    }),
  });
  assert(ownerPatchAfterCollision.response.ok, 'User A session ownership must survive User B rendering the identical script');

  const created = await jsonRequest('/api/projects', tokenA, {
    method: 'POST',
    body: JSON.stringify({ name: 'owner-a-private-project', spec: { plot_type: 'custom' } }),
  });
  assert(created.response.ok && created.data?.id, `Project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;

  try {
    const listA = await jsonRequest('/api/projects', tokenA);
    const listB = await jsonRequest('/api/projects', tokenB);
    assert(listA.data?.projects?.some(project => project.id === projectId), 'Owner cannot list own project');
    assert(!listB.data?.projects?.some(project => project.id === projectId), 'Other user can list owner project');

    const readB = await jsonRequest(`/api/projects/${projectId}`, tokenB);
    assert(readB.response.status === 404, `Other user read should return 404, got ${readB.response.status}`);

    const updateB = await jsonRequest(`/api/projects/${projectId}`, tokenB, {
      method: 'PUT',
      body: JSON.stringify({ name: 'hijacked' }),
    });
    assert(updateB.response.status === 404, `Other user update should return 404, got ${updateB.response.status}`);

    const deleteB = await jsonRequest(`/api/projects/${projectId}`, tokenB, { method: 'DELETE' });
    assert(deleteB.response.status === 404, `Other user delete should return 404, got ${deleteB.response.status}`);

    const readA = await jsonRequest(`/api/projects/${projectId}`, tokenA);
    assert(readA.response.ok, 'Owner project disappeared after unauthorized operations');
  } finally {
    await jsonRequest(`/api/projects/${projectId}`, tokenA, { method: 'DELETE' }).catch(() => null);
  }

  console.log(JSON.stringify({
    status: 'PASS',
    baseUrl: BASE_URL,
    checks: [
      'identical cross-user scripts receive distinct server session IDs',
      'cross-user direct session patch is rejected',
      'original session owner remains valid after another user renders the same script',
      'project list/read/update/delete remain owner-scoped',
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
