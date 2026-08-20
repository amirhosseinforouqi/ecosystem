'use strict';

const { run, get, all, getSetting } = require('../db');
const {
  verifyCredentials, completeLogin, destroySession, createSession, hashPassword, verifyPassword,
  validatePasswordStrength, minPasswordLength, consumeAuthToken, peekAuthToken, createAuthToken,
  destroyAllSessions, requireAuth, permissionsForRole, sessionCookieMaxAge, STAFF_ROLES,
} = require('../auth');
const mfa = require('../mfa');
const ratelimit = require('../ratelimit');
const { ApiError, now, isEmail, normalizeEmail, str, randomToken, sha256 } = require('../util');
const { audit, activity } = require('../log');
const { sendTemplate, portalBaseUrl } = require('../emails');
const { publicUser } = require('../serialize');
const { unreadCount } = require('../notify');

const COOKIE_NAME = 'sid';
const MFA_COOKIE = 'mfa';

/**
 * Max-Age comes from the same configuration the server enforces, per role, so
 * a staff cookie is not left valid in the browser for days after the shorter
 * staff session has already expired server-side.
 */
async function setSessionCookie(ctx, token, user) {
  const secure = ctx.isSecure ? '; Secure' : '';
  const maxAge = await sessionCookieMaxAge(user ? user.role : 'client');
  ctx.res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

function clearSessionCookie(ctx) {
  ctx.res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    `${MFA_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ]);
}

/**
 * Short-lived cookie holding a half-authenticated login awaiting its second
 * factor. It carries no session — it cannot reach any data endpoint.
 */
function setMfaCookie(ctx, token) {
  const secure = ctx.isSecure ? '; Secure' : '';
  ctx.res.setHeader('Set-Cookie', `${MFA_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
}

async function homeFor(user) {
  if (user.must_change_password) return '/change-password';
  if (await mfa.isRequiredFor(user) && !mfa.isEnrolled(user)) return '/mfa-setup';
  return user.role === 'client' ? '/portal' : '/broker';
}

async function meProfile(ctx) {
  const brokerage = await getSetting('brokerage', {});
  const mustChange = !!ctx.user.must_change_password;
  const mfaRequired = await mfa.isRequiredFor(ctx.user);
  const mfaEnrolled = mfa.isEnrolled(ctx.user);
  const blocked = mustChange || (mfaRequired && !mfaEnrolled);
  return {
    user: publicUser(ctx.user),
    is_staff: STAFF_ROLES.includes(ctx.user.role),
    must_change_password: mustChange,
    mfa: { required: mfaRequired, enrolled: mfaEnrolled },
    permissions: blocked ? [] : await permissionsForRole(ctx.user.role),
    password_min_length: await minPasswordLength(ctx.user.role),
    unread_notifications: blocked ? 0 : await unreadCount(ctx.user.id),
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
    home: await homeFor(ctx.user),
  };
}

function register(router) {
  // ------------------------------------------------------------- login
  router.post('/api/auth/login', async (ctx) => {
    const { email, password } = ctx.body || {};
    if (!isEmail(email) || !password) {
      throw new ApiError(400, 'Please enter your email and password.', 'missing_credentials');
    }
    const { user, mfaRequired, mfaEnrolled } = await verifyCredentials(email, password, ctx.ip);

    // Second factor required and already set up: issue only a challenge.
    if (mfaRequired && mfaEnrolled) {
      const challenge = randomToken(32);
      await run(
        'INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        user.id, 'mfa_challenge', sha256(challenge),
        new Date(Date.now() + 10 * 60 * 1000).toISOString(), now()
      );
      setMfaCookie(ctx, challenge);
      await audit(user.id, 'login_password_ok_mfa_pending', 'user', user.id, ctx.ip);
      return { ok: true, mfa_required: true, redirect: '/mfa' };
    }

    const token = await completeLogin(user, ctx.ip, ctx.req.headers['user-agent']);
    await setSessionCookie(ctx, token, user);
    await audit(user.id, 'login', 'user', user.id, ctx.ip, { mfa: false });
    if (user.role === 'client') {
      for (const a of await all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', user.id)) {
        await activity(a.file_id, user, 'client_login', `${user.first_name} ${user.last_name} logged in`);
      }
    }
    ctx.user = user;
    return { ok: true, redirect: await homeFor(user), ...(await meProfile(ctx)) };
  });

  /** Complete a login by presenting the second factor. */
  router.post('/api/auth/mfa/verify', async (ctx) => {
    const challenge = ctx.cookies[MFA_COOKIE];
    if (!challenge) throw new ApiError(401, 'Your sign-in session expired. Please sign in again.', 'no_challenge');
    const row = await get(
      "SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = 'mfa_challenge' AND used_at IS NULL AND expires_at > ?",
      sha256(challenge), now()
    );
    if (!row) throw new ApiError(401, 'Your sign-in session expired. Please sign in again.', 'no_challenge');

    const user = await get("SELECT * FROM users WHERE id = ? AND status = 'active'", row.user_id);
    if (!user) throw new ApiError(401, 'Your sign-in session expired. Please sign in again.', 'no_challenge');

    const rule = ratelimit.rule('mfa_account');
    await ratelimit.enforce(`mfa:${user.id}`, rule.limit, rule.window, rule.message);

    const result = await mfa.verifySecondFactor(user, (ctx.body || {}).code);
    if (!result.ok) {
      await audit(user.id, 'mfa_failed', 'user', user.id, ctx.ip, { reason: result.reason || 'bad_code' });
      throw new ApiError(400, 'That verification code was not correct.', 'bad_code');
    }

    await run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', now(), row.id);
    const token = await completeLogin(user, ctx.ip, ctx.req.headers['user-agent']);
    await setSessionCookie(ctx, token, user);
    await audit(user.id, 'login', 'user', user.id, ctx.ip, { mfa: true, method: result.method });
    ctx.user = user;
    return {
      ok: true,
      redirect: await homeFor(user),
      recovery_codes_remaining: result.method === 'recovery_code' ? result.remaining : undefined,
      ...(await meProfile(ctx)),
    };
  });

  router.post('/api/auth/logout', async (ctx) => {
    if (ctx.user) await audit(ctx.user.id, 'logout', 'user', ctx.user.id, ctx.ip);
    await destroySession(ctx.sessionToken);
    clearSessionCookie(ctx);
    return { ok: true };
  });

  router.get('/api/auth/me', async (ctx) => {
    requireAuth(ctx);
    return meProfile(ctx);
  });

  // ------------------------------------------------------------- MFA setup
  router.post('/api/auth/mfa/begin', async (ctx) => {
    requireAuth(ctx);
    if (mfa.isEnrolled(ctx.user)) {
      throw new ApiError(400, 'Two-step verification is already set up. Reset it first if you want a new device.', 'already_enrolled');
    }
    const brokerage = await getSetting('brokerage', {});
    const { secret, uri } = await mfa.beginEnrolment(ctx.user, brokerage.name || 'Mortgage Platform');
    await audit(ctx.user.id, 'mfa_enrolment_started', 'user', ctx.user.id, ctx.ip);
    return { ok: true, secret, uri };
  });

  router.post('/api/auth/mfa/confirm', async (ctx) => {
    requireAuth(ctx);
    const rule = ratelimit.rule('mfa_account');
    await ratelimit.enforce(`mfa-setup:${ctx.user.id}`, rule.limit, rule.window, rule.message);
    const codes = await mfa.confirmEnrolment(ctx.user, (ctx.body || {}).code);
    await audit(ctx.user.id, 'mfa_enrolled', 'user', ctx.user.id, ctx.ip);
    ctx.user = await get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    return { ok: true, recovery_codes: codes, redirect: await homeFor(ctx.user) };
  });

  router.post('/api/auth/mfa/recovery-codes', async (ctx) => {
    requireAuth(ctx);
    if (!mfa.isEnrolled(ctx.user)) throw new ApiError(400, 'Set up two-step verification first.', 'not_enrolled');
    if (!(await verifyPassword((ctx.body || {}).password || '', ctx.user.password_hash))) {
      throw new ApiError(400, 'Your password was incorrect.', 'bad_credentials');
    }
    const codes = await mfa.generateRecoveryCodes(ctx.user.id);
    await audit(ctx.user.id, 'mfa_recovery_codes_regenerated', 'user', ctx.user.id, ctx.ip);
    return { ok: true, recovery_codes: codes };
  });

  router.get('/api/auth/mfa/status', async (ctx) => {
    requireAuth(ctx);
    return {
      required: await mfa.isRequiredFor(ctx.user),
      enrolled: mfa.isEnrolled(ctx.user),
      recovery_codes_remaining: mfa.isEnrolled(ctx.user)
        ? await mfa.remainingRecoveryCodes(ctx.user.id)
        : 0,
    };
  });

  // ------------------------------------------------------------- activation
  router.get('/api/auth/token-info', async (ctx) => {
    const kind = ctx.query.kind === 'reset' ? 'reset' : 'activate';
    const row = await peekAuthToken(ctx.query.token, kind);
    if (!row) throw new ApiError(400, 'This link has expired or was already used. Ask your broker to send a new one.', 'bad_token');
    const user = await get('SELECT * FROM users WHERE id = ?', row.user_id);
    return {
      ok: true,
      first_name: user.first_name,
      email: user.email,
      kind,
      password_min_length: await minPasswordLength(user.role),
    };
  });

  router.post('/api/auth/activate', async (ctx) => {
    const { token, password } = ctx.body || {};
    const row = await consumeAuthToken(token, 'activate');
    if (!row) throw new ApiError(400, 'This activation link has expired or was already used. Ask your broker to send a new one.', 'bad_token');
    const user = await get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) throw new ApiError(400, 'Account not found.', 'bad_token');
    await validatePasswordStrength(password, { role: user.role, user });

    await run(
      "UPDATE users SET password_hash = ?, status = 'active', must_change_password = 0, updated_at = ? WHERE id = ?",
      await hashPassword(password), now(), user.id
    );
    await audit(user.id, 'account_activated', 'user', user.id, ctx.ip);
    for (const a of await all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', user.id)) {
      await activity(a.file_id, user, 'account_activated', `${user.first_name} ${user.last_name} activated their portal account`);
    }
    const fresh = await get('SELECT * FROM users WHERE id = ?', user.id);
    const sessionToken = await completeLogin(fresh, ctx.ip, ctx.req.headers['user-agent']);
    await setSessionCookie(ctx, sessionToken, fresh);
    ctx.user = fresh;
    return { ok: true, redirect: await homeFor(fresh), ...(await meProfile(ctx)) };
  });

  // ------------------------------------------------------------- reset
  router.post('/api/auth/forgot', async (ctx) => {
    const email = normalizeEmail(ctx.body && ctx.body.email);
    const ipRule = ratelimit.rule('forgot_ip');
    await ratelimit.enforce(`forgot:ip:${ctx.ip}`, ipRule.limit, ipRule.window, ipRule.message);

    // Always the same answer, and — because the email is dispatched on the
    // background pass rather than inline — always the same response time, so
    // the endpoint cannot be used to enumerate accounts (audit finding M4).
    const reply = { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
    if (!isEmail(email)) return reply;

    const acctRule = ratelimit.rule('forgot_account');
    const quota = await ratelimit.consume(`forgot:acct:${email}`, acctRule.limit, acctRule.window);
    if (!quota.allowed) return reply;

    const user = await get("SELECT * FROM users WHERE lower(email) = lower(?) AND status IN ('active','invited')", email);
    if (!user) return reply;

    const token = await createAuthToken(user.id, 'reset', 2);
    const link = `${portalBaseUrl()}/reset?token=${token}`;
    // Fire-and-forget: the caller is not made to wait for SMTP/Graph.
    sendTemplate('password_reset', {
      toEmail: user.email,
      toName: `${user.first_name} ${user.last_name}`.trim(),
      userId: user.id,
      vars: { client_first_name: user.first_name, client_last_name: user.last_name, portal_link: link },
    }).catch((err) => console.error('[auth] reset email failed:', err.message));
    await audit(user.id, 'password_reset_requested', 'user', user.id, ctx.ip);
    return reply;
  });

  router.post('/api/auth/reset', async (ctx) => {
    const { token, password } = ctx.body || {};
    const rule = ratelimit.rule('reset_ip');
    await ratelimit.enforce(`reset:ip:${ctx.ip}`, rule.limit, rule.window);

    const row = await consumeAuthToken(token, 'reset');
    if (!row) throw new ApiError(400, 'This reset link has expired or was already used. Please request a new one.', 'bad_token');
    const user = await get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) throw new ApiError(400, 'Account not found.', 'bad_token');
    await validatePasswordStrength(password, { role: user.role, user });

    // A completed reset is a deliberate credential change, so it also clears
    // the forced-change flag (audit finding M3).
    await run(
      `UPDATE users SET password_hash = ?, status = 'active', must_change_password = 0,
         failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      await hashPassword(password), now(), row.user_id
    );
    await destroyAllSessions(row.user_id);
    await audit(row.user_id, 'password_reset', 'user', row.user_id, ctx.ip);
    return { ok: true, message: 'Your password has been updated. You can sign in now.' };
  });

  router.post('/api/auth/change-password', async (ctx) => {
    requireAuth(ctx);
    const { current_password, new_password } = ctx.body || {};
    if (!(await verifyPassword(current_password || '', ctx.user.password_hash))) {
      throw new ApiError(400, 'Your current password was incorrect.', 'bad_credentials');
    }
    await validatePasswordStrength(new_password, { role: ctx.user.role, user: ctx.user });
    if (String(new_password) === String(current_password)) {
      throw new ApiError(400, 'Please choose a password different from your current one.', 'same_password');
    }
    await run(
      "UPDATE users SET password_hash = ?, must_change_password = 0, status = 'active', updated_at = ? WHERE id = ?",
      await hashPassword(new_password), now(), ctx.user.id
    );
    const wasForced = !!ctx.user.must_change_password;
    await destroyAllSessions(ctx.user.id);
    const token = await createSession(ctx.user.id, ctx.ip, ctx.req.headers['user-agent'], { role: ctx.user.role });
    await setSessionCookie(ctx, token, ctx.user);
    await audit(ctx.user.id, 'password_changed', 'user', ctx.user.id, ctx.ip, { forced: wasForced });
    if (wasForced) {
      for (const a of await all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', ctx.user.id)) {
        await activity(a.file_id, ctx.user, 'account_activated', `${ctx.user.first_name} ${ctx.user.last_name} set their permanent password`);
      }
    }
    ctx.user = await get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    return { ok: true, redirect: await homeFor(ctx.user) };
  });

  router.post('/api/auth/welcome-seen', async (ctx) => {
    requireAuth(ctx);
    await run('UPDATE users SET welcomed_at = ?, updated_at = ? WHERE id = ?', now(), now(), ctx.user.id);
    return { ok: true };
  });
}

module.exports = { register, COOKIE_NAME, MFA_COOKIE, homeFor };
