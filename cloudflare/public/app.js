const $ = (id) => document.getElementById(id);
const examples = {
  version: 'SELECT version();\nSELECT 6 * 7 AS answer;',
  create: "CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());\nINSERT INTO notes (body) VALUES ('Hello from a Durable Object');\nSELECT * FROM notes;",
  read: 'SELECT * FROM notes ORDER BY id;',
  json: "SELECT '{\"database\":\"pgrust\",\"durable\":true}'::jsonb ->> 'database' AS engine;\nSELECT n, n*n AS square FROM generate_series(1,5) AS n;",
  rollback: "BEGIN;\nINSERT INTO notes (body) VALUES ('This row should disappear');\nROLLBACK;\nSELECT * FROM notes ORDER BY id;",
};
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) {
  sessionStorage.setItem('pgrust-test-token', fragment.get('token'));
  history.replaceState(null, '', location.pathname);
}
$('token').value = sessionStorage.getItem('pgrust-test-token') || '';

async function api(action, body) {
  const database = $('database').value;
  if (!/^[a-z0-9-]{1,48}$/.test(database)) throw new Error('Database name: 1–48 lowercase letters, numbers, or hyphens.');
  const response = await fetch(`/api/db/${database}/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${$('token').value}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function busy(fn) {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  $('output').classList.remove('error');
  try { await fn(); }
  catch (error) { $('output').textContent = error.message; $('output').classList.add('error'); }
  finally { for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
$('connect').onclick = () => busy(async () => {
  const status = await api('status');
  sessionStorage.setItem('pgrust-test-token', $('token').value);
  $('connection').textContent = `Connected · ${status.bootId.slice(0,8)}`;
  $('output').textContent = status.initialized ? 'Database ready. Saved data is available.' : 'Connected. Run your first query to initialize this database.';
});
$('run').onclick = () => busy(async () => {
  $('output').textContent = 'Running… The first query also initializes storage.';
  const result = await api('query', { sql: $('sql').value });
  $('output').textContent = result.output || (result.ok ? 'Completed.' : result.diagnostics);
  $('diagnostics').textContent = result.diagnostics;
  $('metrics').textContent = `${result.elapsedMs} ms · ${(result.memoryBytes/1048576).toFixed(1)} MiB WASM · boot ${result.bootId.slice(0,8)}`;
  if (!result.ok) $('output').classList.add('error');
});
$('restart').onclick = () => busy(async () => {
  const before = await api('status');
  await api('restart', {});
  const after = await api('status');
  if (before.bootId === after.bootId) throw new Error('Object restart was not confirmed.');
  $('connection').textContent = `Connected · ${after.bootId.slice(0,8)}`;
  $('output').textContent = `Object restarted (${before.bootId.slice(0,8)} → ${after.bootId.slice(0,8)}). Run a SELECT to check your saved rows.`;
});
$('examples').onchange = () => { $('sql').value = examples[$('examples').value]; };
$('sql').onkeydown = (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('run').disabled) { event.preventDefault(); $('run').click(); } };
