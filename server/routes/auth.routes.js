'use strict';

const { run, get, getSetting } = require('../db');
const {
  login, destroySession, createSession, hashPassword, verifyPassword, validatePasswordStrength,
  consumeAuthToken, peekAuthToken, createAuthToken, destroyAllSessions, requireAuth,
  permissionsForRole, STAFF_ROLES,
} = require('../auth');
const { ApiError, now, isEmail, normalizeEmail, str } = require('../util');
const { audit, activity } = require('../log');
const { sendTemplate, portalBaseUrl } = require('../emails');
const { publicUser } = require('../serialize');
const { unreadCount } = require('../notify');

const COOKIE_NAME = 'sid';

function setSessionCookie(ctx, token) {
  const secure = ctx.isSecure ? '; Secure' : '';
  const days = getSetting('security', {}).session_days || 7;
  ctx.res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`
  );
}

function clearSessionCookie(ctx) {
  ctx.res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function homeFor(user) {
  if (user.must_change_password) return '/change-password';
  return user.role === 'client' ? '/portal' : '/broker';
}

function meProfile(ctx) {
  const brokerage = getSetting('brokerage', {});
  const mustChange = !!ctx.user.must_change_password;
  return {
    user: publicUser(ctx.user),
    is_staff: STAFF_ROLES.includes(ctx.user.role),
    must_change_password: mustChange,
    permissions: mustChange ? [] : permissionsForRole(ctx.user.role),
    unread_notifications: mustChange ? 0 : unreadCount(ctx.user.id),
    brokerage: {
      name: brokerage.name,
      broker_name: brokerage.broker_name,
      phone: brokerage.phone,
      email: brokerage.email,
      website: brokerage.website,
      welcome_message: brokerage.welcome_message,
      primary_color: brokerage.primary_color,
      logo_text: brokerage.logo_text,
    },
    home: homeFor(ctx.user),
  };
}

function register(router) {
  router.post('/api/auth/login', async (ctx) => {
    const { email, password } = ctx.body || {};
    if (!isEmail(email) || !password) {
      throw new ApiError(400, 'Please enter your email and password.', 'missing_credentials');
    }
    const { user, token } = login(email, password, ctx.ip, ctx.req.headers['user-agent']);
    setSessionCookie(ctx, token);
    audit(user.id, 'login', 'user', user.id, ctx.ip);
    if (user.role === 'client') {
      // Client logins appear on the file's activity timeline.
      const { all } = require('../db');
      for (const a of all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', user.id)) {
        activity(a.file_id, user, 'client_login', `${user.first_name} ${user.last_name} logged in`);
      }
    }
    ctx.user = user;
    return { ok: true, redirect: homeFor(user), ...meProfile(ctx) };
  });

  router.post('/api/auth/logout', (ctx) => {
    if (ctx.user) audit(ctx.user.id, 'logout', 'user', ctx.user.id, ctx.ip);
    destroySession(ctx.sessionToken);
    clearSessionCookie(ctx);
    return { ok: true };
  });

  router.get('/api/auth/me', (ctx) => {
    requireAuth(ctx);
    return meProfile(ctx);
  });

  // Peek at an activation/reset token so the page can greet the person.
  router.get('/api/auth/token-info', (ctx) => {
    const kind = ctx.query.kind === 'reset' ? 'reset' : 'activate';
    const row = peekAuthToken(ctx.query.token, kind);
    if (!row) throw new ApiError(400, 'This link has expired or was already used. Ask your broker to send a new one.', 'bad_token');
    const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
    return { ok: true, first_name: user.first_name, email: user.email, kind };
  });

  router.post('/api/auth/activate', (ctx) => {
    const { token, password } = ctx.body || {};
    validatePasswordStrength(password);
    const row = consumeAuthToken(token, 'activate');
    if (!row) throw new ApiError(400, 'This activation link has expired or was already used. Ask your broker to send a new one.', 'bad_token');
    const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) throw new ApiError(400, 'Account not found.', 'bad_token');
    run(
      "UPDATE users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?",
      hashPassword(password), now(), user.id
    );
    audit(user.id, 'account_activated', 'user', user.id, ctx.ip);
    const { all } = require('../db');
    for (const a of all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', user.id)) {
      activity(a.file_id, user, 'account_activated', `${user.first_name} ${user.last_name} activated their portal account`);
    }
    const sessionToken = createSession(user.id, ctx.ip, ctx.req.headers['user-agent']);
    setSessionCookie(ctx, sessionToken);
    ctx.user = get('SELECT * FROM users WHERE id = ?', user.id);
    return { ok: true, redirect: homeFor(user), ...meProfile(ctx) };
  });

  router.post('/api/auth/forgot', async (ctx) => {
    const email = normalizeEmail(ctx.body && ctx.body.email);
    // Always answer the same way — never reveal whether an account exists.
    const reply = { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
    if (!isEmail(email)) return reply;
    const user = get("SELECT * FROM users WHERE email = ? AND status IN ('active','invited')", email);
    if (!user) return reply;
    const token = createAuthToken(user.id, 'reset', 2);
    const link = `${portalBaseUrl()}/reset?token=${token}`;
    await sendTemplate('password_reset', {
      toEmail: user.email,
      toName: `${user.first_name} ${user.last_name}`.trim(),
      userId: user.id,
      vars: { client_first_name: user.first_name, client_last_name: user.last_name, portal_link: link },
    });
    audit(user.id, 'password_reset_requested', 'user', user.id, ctx.ip);
    return reply;
  });

  router.post('/api/auth/reset', (ctx) => {
    const { token, password } = ctx.body || {};
    validatePasswordStrength(password);
    const row = consumeAuthToken(token, 'reset');
    if (!row) throw new ApiError(400, 'This reset link has expired or was already used. Please request a new one.', 'bad_token');
    run(
      "UPDATE users SET password_hash = ?, status = 'active', failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
      hashPassword(password), now(), row.user_id
    );
    destroyAllSessions(row.user_id);
    audit(row.user_id, 'password_reset', 'user', row.user_id, ctx.ip);
    return { ok: true, message: 'Your password has been updated. You can sign in now.' };
  });

  router.post('/api/auth/change-password', (ctx) => {
    requireAuth(ctx);
    const { current_password, new_password } = ctx.body || {};
    if (!verifyPassword(current_password || '', ctx.user.password_hash)) {
      throw new ApiError(400, 'Your current password was incorrect.', 'bad_credentials');
    }
    validatePasswordStrength(new_password);
    if (String(new_password) === String(current_password)) {
      throw new ApiError(400, 'Please choose a password different from your current one.', 'same_password');
    }
    // Replacing the hash is what invalidates the temporary password: it is
    // never stored in plaintext and cannot be verified against the new hash.
    run(
      "UPDATE users SET password_hash = ?, must_change_password = 0, status = 'active', updated_at = ? WHERE id = ?",
      hashPassword(new_password), now(), ctx.user.id
    );
    const wasForced = !!ctx.user.must_change_password;
    // Keep this session, drop all others.
    destroyAllSessions(ctx.user.id);
    const token = createSession(ctx.user.id, ctx.ip, ctx.req.headers['user-agent']);
    setSessionCookie(ctx, token);
    audit(ctx.user.id, 'password_changed', 'user', ctx.user.id, ctx.ip, { forced: wasForced });
    if (wasForced) {
      const { all } = require('../db');
      for (const a of all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', ctx.user.id)) {
        activity(a.file_id, ctx.user, 'account_activated', `${ctx.user.first_name} ${ctx.user.last_name} set their permanent password`);
      }
    }
    ctx.user = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    return { ok: true, redirect: homeFor(ctx.user) };
  });

  router.post('/api/auth/welcome-seen', (ctx) => {
    requireAuth(ctx);
    run('UPDATE users SET welcomed_at = ?, updated_at = ? WHERE id = ?', now(), now(), ctx.user.id);
    return { ok: true };
  });
}

module.exports = { register, COOKIE_NAME };
