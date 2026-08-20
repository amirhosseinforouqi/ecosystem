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

  // Already signed in? Go straight home (which is the forced password
  // change screen when a temporary password is still in effect).
  if (path === '/' || path === '/login') {
    try {
      const me = await api.get('/api/auth/me');
      window.location.href = me.home;
      return;
    } catch { /* not signed in — show the form */ }
  }

  // ------------------------------------------- forced password change
  async function forcedChangeForm() {
    let me;
    try {
      me = await api.get('/api/auth/me');
    } catch {
      window.location.href = '/login';
      return;
    }
    if (!me.must_change_password) {
      window.location.href = me.home;
      return;
    }
    const current = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'The password from your welcome email' });
    const minLength = me.password_min_length || 10;
    const password = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: String(minLength), placeholder: `At least ${minLength} characters` });
    const confirm = el('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Repeat your new password' });
    const submit = el('button', { class: 'btn block', type: 'submit' }, 'Save my new password');
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
          const res = await api.post('/api/auth/change-password', {
            current_password: current.value, new_password: password.value,
          });
          window.location.href = res.redirect || '/portal';
        } catch (err) {
          setError(err.message);
          submit.disabled = false;
        }
      },
    },
      el('h1', { class: 'auth-title' }, `Welcome${me.user.first_name ? ', ' + me.user.first_name : ''}!`),
      el('p', { class: 'auth-sub' }, 'For your security, please replace the temporary password from your welcome email with one only you know.'),
      el('label', { class: 'field' }, el('span', null, 'Temporary password'), current),
      el('label', { class: 'field' }, el('span', null, 'New password'), password),
      el('label', { class: 'field' }, el('span', null, 'Confirm new password'), confirm),
      el('p', { class: 'faint' }, `Use at least ${minLength} characters, with at least one letter and one number. Avoid your own name or email.`),
      errorLine(),
      submit
    );
    show(form);
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
          if (res.mfa_required) {
            mfaChallengeForm();
            return;
          }
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
    const minLength = info.password_min_length || 10;
    const password = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: String(minLength), placeholder: `At least ${minLength} characters` });
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
      el('p', { class: 'faint' }, `Use at least ${minLength} characters, with at least one letter and one number. Avoid your own name or email.`),
      errorLine(),
      submit
    );
    show(form);
  }

  // -------------------------------------------------- second factor (sign in)
  /**
   * The password was accepted but no session exists yet — the server holds a
   * short-lived challenge and issues the session only once this succeeds.
   */
  function mfaChallengeForm() {
    const code = el('input', {
      type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      required: true, placeholder: '123456', maxlength: '20',
    });
    const submit = el('button', { class: 'btn block', type: 'submit' }, 'Verify and sign in');
    let usingRecovery = false;

    const toggle = el('button', {
      class: 'btn-link', type: 'button',
      onclick: () => {
        usingRecovery = !usingRecovery;
        code.value = '';
        code.placeholder = usingRecovery ? 'xxxxxxxx-xxxxxxxx' : '123456';
        code.setAttribute('inputmode', usingRecovery ? 'text' : 'numeric');
        hint.textContent = usingRecovery
          ? 'Enter one of the recovery codes you saved when you set up two-step verification.'
          : 'Open your authenticator app and enter the current 6-digit code.';
        toggle.textContent = usingRecovery ? 'Use my authenticator app instead' : "I can't use my authenticator app";
        code.focus();
      },
    }, "I can't use my authenticator app");

    const hint = el('p', { class: 'auth-sub' }, 'Open your authenticator app and enter the current 6-digit code.');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        setError('');
        submit.disabled = true;
        try {
          const res = await api.post('/api/auth/mfa/verify', { code: code.value.trim() });
          window.location.href = res.redirect || '/broker';
        } catch (err) {
          setError(err.message);
          submit.disabled = false;
        }
      },
    },
      el('h1', { class: 'auth-title' }, 'One more step'),
      hint,
      el('label', { class: 'field' }, el('span', null, usingRecovery ? 'Recovery code' : 'Verification code'), code),
      errorLine(),
      submit,
      el('p', { class: 'small', style: 'text-align:center;margin-top:14px' }, toggle)
    );
    show(form);
  }

  // ------------------------------------------------- second factor (set-up)
  /**
   * Mandatory enrolment for brokerage staff. The account can reach nothing
   * else until this is finished, so the screen is deliberately the whole page.
   */
  async function mfaSetupForm() {
    let me;
    try {
      me = await api.get('/api/auth/me');
    } catch {
      window.location.href = '/login';
      return;
    }
    if (!me.mfa.required || me.mfa.enrolled) {
      window.location.href = me.home;
      return;
    }

    let begin;
    try {
      begin = await api.post('/api/auth/mfa/begin', {});
    } catch (err) {
      show(
        el('h1', { class: 'auth-title' }, 'Could not start setup'),
        el('p', { class: 'auth-sub' }, err.message),
        el('a', { class: 'btn secondary block', href: '/login' }, 'Back to sign in')
      );
      return;
    }

    const grouped = begin.secret.replace(/(.{4})/g, '$1 ').trim();
    const code = el('input', {
      type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      required: true, placeholder: '123456', maxlength: '10',
    });
    const submit = el('button', { class: 'btn block', type: 'submit' }, 'Turn on two-step verification');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        setError('');
        submit.disabled = true;
        try {
          const res = await api.post('/api/auth/mfa/confirm', { code: code.value.trim() });
          showRecoveryCodes(res.recovery_codes, res.redirect || '/broker');
        } catch (err) {
          setError(err.message);
          submit.disabled = false;
        }
      },
    },
      el('h1', { class: 'auth-title' }, 'Set up two-step verification'),
      el('p', { class: 'auth-sub' },
        'Client files are protected by a second step at sign-in. Add this account to an authenticator app such as Microsoft Authenticator, Google Authenticator or 1Password.'),
      el('ol', { class: 'setup-steps' },
        el('li', null, 'Open your authenticator app and choose "add account", then "enter a setup key".'),
        el('li', null,
          'Enter this key: ',
          el('code', { class: 'mfa-secret' }, grouped)),
        el('li', null,
          'On a phone, you can instead ',
          el('a', { href: begin.uri }, 'open this setup link'),
          ' to add it automatically.'),
        el('li', null, 'Type the 6-digit code the app shows below.')
      ),
      el('label', { class: 'field' }, el('span', null, 'Code from your app'), code),
      errorLine(),
      submit
    );
    show(form);
  }

  /** Shown once, immediately after enrolment. */
  function showRecoveryCodes(codes, next) {
    const list = el('ul', { class: 'recovery-codes' },
      ...(codes || []).map((c) => el('li', null, el('code', null, c))));
    show(
      el('h1', { class: 'auth-title' }, 'Save your recovery codes'),
      el('p', { class: 'auth-sub' },
        'Each of these works once, in place of your authenticator app. Print them or store them in your password manager — they are shown only now.'),
      list,
      el('button', {
        class: 'btn block',
        onclick: () => { window.location.href = next; },
      }, 'I have saved them — continue')
    );
  }

  if (path === '/mfa') mfaChallengeForm();
  else if (path === '/mfa-setup') mfaSetupForm();
  else if (path === '/activate') tokenForm('activate');
  else if (path === '/reset') tokenForm('reset');
  else if (path === '/change-password') forcedChangeForm();
  else loginForm();
})();
