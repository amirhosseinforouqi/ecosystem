'use strict';

const { run, all, get, getSetting } = require('./db');
const { now } = require('./util');

/** Create an in-portal notification for one user. */
async function notifyUser(userId, kind, title, body = '', fileId = null, link = '') {
  if (!userId) return;
  await run(
    `INSERT INTO notifications (user_id, kind, title, body, file_id, link, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, kind, title, body, fileId, link, now()
  );
}

/**
 * Notify the staff responsible for a file: the assigned broker, or (per
 * settings) every active staff member when the file is unassigned.
 */
async function notifyStaffForFile(file, kind, title, body = '', link = '') {
  const targets = new Set();
  if (file.assigned_broker_id) {
    targets.add(file.assigned_broker_id);
  } else if ((await getSetting('automation', {})).notify_all_staff_if_unassigned !== false) {
    for (const u of await all("SELECT id FROM users WHERE role <> 'client' AND status = 'active'")) {
      targets.add(u.id);
    }
  }
  for (const id of targets) await notifyUser(id, kind, title, body, file.id, link);
}

/** Notify every portal user attached to a file (all applicants with access). */
async function notifyClientsForFile(fileId, kind, title, body = '', link = '') {
  const users = await all(
    'SELECT DISTINCT portal_user_id AS id FROM applicants WHERE file_id = ? AND portal_user_id IS NOT NULL',
    fileId
  );
  for (const u of users) await notifyUser(u.id, kind, title, body, fileId, link);
}

async function unreadCount(userId) {
  const row = await get('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId);
  return row ? row.n : 0;
}

module.exports = { notifyUser, notifyStaffForFile, notifyClientsForFile, unreadCount };
