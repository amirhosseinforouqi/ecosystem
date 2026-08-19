'use strict';

/* Shared client-side utilities: API access, DOM building, modals, toasts. */

const api = (() => {
  async function call(method, url, body, rawFile, filename) {
    const options = {
      method,
      headers: { 'X-Requested-With': 'fetch' },
      credentials: 'same-origin',
    };
    if (rawFile) {
      options.body = rawFile;
      options.headers['Content-Type'] = 'application/octet-stream';
      options.headers['X-Filename'] = encodeURIComponent(filename || rawFile.name || 'document');
    } else if (body !== undefined) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(url, options);
    } catch {
      throw { ok: false, code: 'network', message: 'We could not reach the server. Check your connection and try again.' };
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.location.href = '/login';
      throw { ok: false, code: 'unauthenticated', message: 'Please sign in.' };
    }
    if (!res.ok) {
      throw { ok: false, status: res.status, code: data.code || 'error', message: data.message || 'Something went wrong. Please try again.', data };
    }
    return data;
  }
  return {
    get: (url) => call('GET', url),
    post: (url, body) => call('POST', url, body),
    patch: (url, body) => call('PATCH', url, body),
    put: (url, body) => call('PUT', url, body),
    del: (url) => call('DELETE', url),
    upload: (url, file, filename) => call('POST', url, undefined, file, filename),
  };
})();

/** Hyperscript-style DOM builder. Strings become text nodes (XSS-safe). */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value; // only for trusted, app-authored markup
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  const days = Math.floor(secs / 86400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return fmtDate(iso);
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function toast(message, kind) {
  let holder = document.getElementById('toast-holder');
  if (!holder) {
    holder = el('div', { id: 'toast-holder' });
    document.body.append(holder);
  }
  const t = el('div', { class: `toast ${kind || ''}`, role: 'status' }, message);
  holder.append(t);
  setTimeout(() => t.remove(), 4200);
}

/** Open a modal. Returns { close }. body may be a node or array of nodes. */
function openModal(title, body, actions) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('h2', null, title),
    body,
    actions ? el('div', { class: 'modal-actions' }, actions(close)) : null
  );
  backdrop.append(dialog);
  document.body.append(backdrop);
  const first = dialog.querySelector('input, select, textarea, button');
  if (first) first.focus();
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  return { close };
}

function confirmDialog(message, { danger = false, confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    openModal('Are you sure?', el('p', null, message), (close) => [
      el('button', { class: 'btn secondary', onclick: () => { close(); resolve(false); } }, 'Cancel'),
      el('button', { class: `btn ${danger ? 'danger' : ''}`, onclick: () => { close(); resolve(true); } }, confirmLabel),
    ]);
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Map internal request status to broker-facing pill config. */
function brokerDocPill(status) {
  return {
    required: { label: 'Required', cls: 'warn' },
    uploaded: { label: 'Uploaded', cls: 'info' },
    under_review: { label: 'Under review', cls: 'info' },
    approved: { label: 'Approved', cls: 'good' },
    rejected: { label: 'Not approved', cls: 'bad' },
    replacement_requested: { label: 'Replacement requested', cls: 'bad' },
    expired: { label: 'Expired', cls: 'bad' },
    waived: { label: 'Waived', cls: '' },
  }[status] || { label: status, cls: '' };
}

function applyBranding(brokerage) {
  if (brokerage && brokerage.primary_color && /^#[0-9a-fA-F]{6}$/.test(brokerage.primary_color)) {
    document.documentElement.style.setProperty('--brand', brokerage.primary_color);
    document.documentElement.style.setProperty('--brand-dark', brokerage.primary_color);
  }
  if (brokerage && brokerage.name) {
    document.title = document.title.replace('Client Portal', brokerage.name).replace('Broker Portal', brokerage.name + ' — Broker');
  }
}
