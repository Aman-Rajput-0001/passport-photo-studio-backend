(() => {
  const root = document.querySelector('[data-admin-root]');
  const loginView = document.getElementById('login-view');
  const dashboardView = document.getElementById('dashboard-view');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const message = document.getElementById('message');
  const csrf = { value: '' };
  let refreshTimer = null;
  const api = path => `${root.dataset.basePath}/api/${path}`;

  function showError(target, text) {
    target.textContent = text || '';
    target.hidden = !text;
  }

  function renderRows(rows, target) {
    target.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement('tr');
      const values = target.id === 'uploads-body'
        ? [row.created_at, row.original_name, row.mime_type, row.original_bytes, row.processed_bytes || '', row.status]
        : [row.time, row.method, row.path, row.status, `${row.durationMs}ms`, row.message || '', row.ip || ''];
      for (const value of values) {
        const td = document.createElement('td');
        td.textContent = String(value ?? '');
        tr.appendChild(td);
      }
      target.appendChild(tr);
    }
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (csrf.value && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf.value;
    const response = await fetch(api(path), { ...options, headers, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  async function refresh() {
    const [uploads, logs, siteState] = await Promise.all([
      request('uploads?limit=200'), request('logs?limit=200'), request('site-state'),
    ]);
    renderRows(uploads.uploads, document.getElementById('uploads-body'));
    renderRows(logs.logs, document.getElementById('logs-body'));
    document.getElementById('maintenance').checked = Boolean(siteState.maintenance);
    message.value = siteState.message || '';
  }

  function showDashboard() {
    loginView.hidden = true;
    dashboardView.hidden = false;
    refresh().catch(error => showError(document.getElementById('dashboard-error'), error.message));
    if (!refreshTimer) {
      refreshTimer = setInterval(() => refresh()
        .catch(error => showError(document.getElementById('dashboard-error'), error.message)), 10000);
    }
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    showError(loginError, '');
    const form = new FormData(loginForm);
    try {
      const data = await request('login', {
        method: 'POST',
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      });
      csrf.value = data.csrfToken;
      loginForm.reset();
      showDashboard();
    } catch (error) {
      showError(loginError, error.message);
    }
  });

  document.getElementById('save-state').addEventListener('click', async () => {
    showError(document.getElementById('dashboard-error'), '');
    try {
      const state = await request('site-state', {
        method: 'POST',
        body: JSON.stringify({
          maintenance: document.getElementById('maintenance').checked,
          message: message.value,
        }),
      });
      message.value = state.message || '';
    } catch (error) {
      showError(document.getElementById('dashboard-error'), error.message);
    }
  });

  document.getElementById('refresh').addEventListener('click', () => refresh()
    .catch(error => showError(document.getElementById('dashboard-error'), error.message)));
  document.getElementById('logout').addEventListener('click', async () => {
    try { await request('logout', { method: 'POST', body: '{}' }); } catch {}
    window.location.reload();
  });

  request('session').then(data => {
    csrf.value = data.csrfToken;
    showDashboard();
  }).catch(() => {});
})();
