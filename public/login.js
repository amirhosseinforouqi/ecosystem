'use strict';

(async function () {
  const box = document.getElementById('auth-box');
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  function show(...nodes) {
    clearNode(box);
    box.append(...nodes);
    const first = box.querySelector('input');
    if (first) first.focus();
  }

  function errorLine() {
    return el('p', { class: 'form-error', id: 'auth-error', role: 'alert' });
  }

  function setError(message) {
    const line = document.getElementById('auth-error');
    if (line) line.textContent = message || '';
  }

  // Already signed in? Go straight home.
  if (path === '/' || path === '/login') {
    try {
      const me = await api.get('/api/auth/me');
      window.location.href = me.home;
      return;
    } catch { /* not signed in — show the form */ }
  }

  // ---------------------------------------------------------------- login
  function loginForm() {
    const email = el('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' });
    const password = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Your password' });
    const submit = el('button', { class: 'btn block', type: 'submit' }, 'Sign in');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        setError('');
        submit.disabled = true;
        try {
          const res = await api.post('/api/auth/login', { email: email.value.trim(), password: password.value });
          window.location.href = res.redirect;
        } catch (err) {
          setError(err.message);
          submit.disabled = false;
        }
      },
    },
      el('h1', { class: 'auth-title' }, 'Welcome back'),
      el('p', { class: 'auth-sub' }, 'Sign in to your portal'),
      el('label', { class: 'field' }, el('span', null, 'Email'), email),
      el('label', { class: 'field' }, el('span', null, 'Password'), password),
      errorLine(),
      submit,
      el('p', { class: 'small', style: 'text-align:center;margin-top:14px' },
        el('button', { class: 'btn-link', type: 'button', onclick: forgotForm }, 'Forgot your password?'))
    );
    show(form);
  }

  // ---------------------------------------------------------------- forgot
  function forgotForm() {
    const email = el('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' });
    const submit = el('button', { class: 'btn block', type: 'submit' }, 'Send reset link');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const res = await api.post('/api/auth/forgot', { email: email.value.trim() });
          show(
            el('h1', { class: 'auth-title' }, 'Check your email'),
            el('p', { class: 'auth-sub' }, res.message),
            el('button', { class: 'btn secondary block', onclick: loginForm }, 'Back to sign in')
          );
        } catch (err) {
          setError(err.message);
          submit.disabled = false;
        }
      },
    },
      el('h1', { class: 'auth-title' }, 'Reset your password'),
      el('p', { class: 'auth-sub' }, "Enter your email and we'll send you a reset link."),
      el('label', { class: 'field' }, el('span', null, 'Email'), email),
      errorLine(),
      submit,
      el('p', { class: 'small', style: 'text-align:center;margin-top:14px' },
        el('button', { class: 'btn-link', type: 'button', onclick: loginForm }, 'Back to sign in'))
    );
    show(form);
  }

  // ------------------------------------------------- activate / reset link
  async function tokenForm(kind) {
    const token = params.get('token') || '';
    let info;
    try {
      info = await api.get(`/api/auth/token-info?kind=${kind}&token=${encodeURIComponent(token)}`);
    } catch (err) {
      show(
        el('h1', { class: 'auth-title' }, 'Link expired'),
        el('p', { class: 'auth-sub' }, err.message),
        el('a', { class: 'btn secondary block', href: '/login' }, 'Go to sign in')
      );
      return;
    }
    const password = el('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'At least 8 characters' });
    const confirm = el('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Repeat your password' });
    const submit = el('button', { class: 'btn block', type: 'submit' }, kind === 'activate' ? 'Create my account' : 'Set new password');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        setError('');
        if (password.value !== confirm.value) {
          setError('The two passwords do not match.');
          return;
        }
        submit.disabled = true;
        try {
          if (kind === 'activate') {
            const res = await api.post('/api/auth/activate', { token, password: password.value });
            window.location.href = res.redirect;
          } else {
            await api.post('/api/auth/reset', { token, password: password.value });
            show(
              el('h1', { class: 'auth-title' }, 'Password updated'),
              el('p', { class: 'auth-sub' }, 'You can sign in with your new password now.'),
              el('a', { class: 'btn block', href: '/login' }, 'Sign in')
            );
          }
        } catch (err) {
          setError(err.message);
          submit.disabled = false;
        }
      },
    },
      el('h1', { class: 'auth-title' }, kind === 'activate' ? `Welcome${info.first_name ? ', ' + info.first_name : ''}!` : 'Choose a new password'),
      el('p', { class: 'auth-sub' }, kind === 'activate'
        ? 'Choose a password to activate your secure portal account.'
        : `Setting a new password for ${info.email}.`),
      el('label', { class: 'field' }, el('span', null, 'New password'), password),
      el('label', { class: 'field' }, el('span', null, 'Confirm password'), confirm),
      el('p', { class: 'faint' }, 'Use at least 8 characters, with at least one letter and one number.'),
      errorLine(),
      submit
    );
    show(form);
  }

  if (path === '/activate') tokenForm('activate');
  else if (path === '/reset') tokenForm('reset');
  else loginForm();
})();
