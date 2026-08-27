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

  function formatAmount(amount) {
    return `₹${Number(amount?.rupees || 0).toFixed(2)}`;
  }

  function renderPayments(rows) {
    const target = document.getElementById('payments-body');
    target.replaceChildren();
    for (const row of rows) {
      const values = [row.created_at, String(row.device_id || '').slice(0, 16), row.utr, row.payer_name || '', formatAmount({ rupees: Number(row.amount_paise || 0) / 100 }), row.status];
      const tr = document.createElement('tr');
      for (const value of values) {
        const td = document.createElement('td');
        td.textContent = String(value ?? '');
        tr.appendChild(td);
      }
      const actions = document.createElement('td');
      if (row.status === 'pending') {
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.textContent = 'Approve';
        approve.dataset.paymentAction = 'approve';
        approve.dataset.paymentId = row.id;
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'secondary';
        reject.textContent = 'Reject';
        reject.dataset.paymentAction = 'reject';
        reject.dataset.paymentId = row.id;
        actions.append(approve, reject);
      } else {
        actions.textContent = (row.approved_by || row.rejected_by) ? `By ${row.approved_by || row.rejected_by}` : '';
      }
      tr.appendChild(actions);
      target.appendChild(tr);
    }
  }

  function renderUsage(rows) {
    const target = document.getElementById('usage-body');
    target.replaceChildren();
    for (const row of rows) {
      const values = [row.created_at, row.operation, formatAmount({ rupees: Number(row.amount_paise || 0) / 100 }), row.free_use === 1 ? 'Yes' : 'No', row.status, row.completed_at || ''];
      const tr = document.createElement('tr');
      for (const value of values) {
        const td = document.createElement('td');
        td.textContent = String(value ?? '');
        tr.appendChild(td);
      }
      target.appendChild(tr);
    }
  }

  function renderSummary(summary) {
    const payments = summary.manualPayments || {};
    const pending = payments.pending || {};
    const approved = payments.approved || {};
    const rejected = payments.rejected || {};
    const removeBg = summary.removeBg || {};
    const usage = summary.usage || {};
    document.getElementById('payments-total').textContent = String(payments.totalCount || 0);
    document.getElementById('payments-total-amount').textContent = formatAmount(payments.totalAmount);
    document.getElementById('payments-pending').textContent = String(pending.count || 0);
    document.getElementById('payments-pending-amount').textContent = formatAmount(pending.amount);
    document.getElementById('payments-approved').textContent = String(approved.count || 0);
    document.getElementById('payments-approved-amount').textContent = formatAmount(approved.amount);
    document.getElementById('payments-rejected').textContent = String(rejected.count || 0);
    document.getElementById('payments-rejected-amount').textContent = formatAmount(rejected.amount);
    document.getElementById('remove-bg-usage').textContent = `${removeBg.used || 0} / ${removeBg.limit || 0}`;
    document.getElementById('remove-bg-remaining').textContent = `${removeBg.remaining || 0} remaining`;
    document.getElementById('paid-usage').textContent = String(usage.paidCount || 0);
    document.getElementById('free-usage').textContent = String(usage.freeCount || 0);
    document.getElementById('supervisor-sessions').textContent = String(summary.activeSupervisorSessions || 0);
    renderPayments(summary.recentManualPayments || []);
    renderUsage(summary.recentUsage || []);
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
    const [uploads, logs, siteState, summary] = await Promise.all([
      request('uploads?limit=200'), request('logs?limit=200'), request('site-state'),
      request('summary?limit=50'),
    ]);
    renderRows(uploads.uploads, document.getElementById('uploads-body'));
    renderRows(logs.logs, document.getElementById('logs-body'));
    document.getElementById('maintenance').checked = Boolean(siteState.maintenance);
    message.value = siteState.message || '';
    renderSummary(summary);
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

  document.getElementById('supervisor-form').addEventListener('submit', async event => {
    event.preventDefault();
    showError(document.getElementById('dashboard-error'), '');
    const code = document.getElementById('supervisor-code');
    const confirmation = document.getElementById('supervisor-confirmation');
    try {
      await request('supervisor-code', {
        method: 'POST',
        body: JSON.stringify({ code: code.value, confirmation: confirmation.value }),
      });
      code.value = '';
      confirmation.value = '';
      document.getElementById('supervisor-message').textContent = 'Supervisor code updated.';
      await refresh();
    } catch (error) {
      showError(document.getElementById('dashboard-error'), error.message);
    }
  });

  document.getElementById('reset-supervisor').addEventListener('click', async () => {
    showError(document.getElementById('dashboard-error'), '');
    try {
      await request('supervisor-code', {
        method: 'POST',
        body: JSON.stringify({ code: '', confirmation: '' }),
      });
      document.getElementById('supervisor-message').textContent = 'Supervisor code disabled.';
      await refresh();
    } catch (error) {
      showError(document.getElementById('dashboard-error'), error.message);
    }
  });

  document.getElementById('refresh').addEventListener('click', () => refresh()
    .catch(error => showError(document.getElementById('dashboard-error'), error.message)));
  document.getElementById('payments-body').addEventListener('click', async event => {
    const button = event.target.closest('[data-payment-action]');
    if (!button) return;
    const action = button.dataset.paymentAction;
    const id = button.dataset.paymentId;
    const reason = action === 'reject' ? window.prompt('Optional rejection reason:') : '';
    if (action === 'reject' && reason === null) return;
    button.disabled = true;
    try {
      await request(`manual-payments/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        body: JSON.stringify(action === 'reject' ? { reason } : {}),
      });
      await refresh();
    } catch (error) {
      showError(document.getElementById('dashboard-error'), error.message);
      button.disabled = false;
    }
  });
  document.getElementById('logout').addEventListener('click', async () => {
    try { await request('logout', { method: 'POST', body: '{}' }); } catch {}
    window.location.reload();
  });

  request('session').then(data => {
    csrf.value = data.csrfToken;
    showDashboard();
  }).catch(() => {});
})();
