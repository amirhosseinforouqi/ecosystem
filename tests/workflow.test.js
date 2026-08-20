'use strict';

/**
 * The ten UX scenarios from the product spec, exercised end to end against
 * the HTTP API: create a client → the checklist appears automatically →
 * the client uploads → the broker reviews → the stage moves → everyone is
 * told what happens next.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');

let ctx;
let admin;
let client;      // the primary applicant's portal user
let fileId;
let temporaryPassword;
const CLIENT_PASSWORD = 'Harbour-Lantern-Quartz-27';

before(async () => {
  ctx = await helpers.startTestServer('workflow');
  admin = await helpers.signInAdmin(ctx.base);
});

after(async () => { if (ctx) await ctx.stop(); });

describe('scenario 1 — creating a client is one step', () => {
  test('the file, the checklist and the portal account are all automatic', async () => {
    const res = await admin.post('/api/broker/clients', {
      client: {
        first_name: 'Priya', last_name: 'Patel', email: 'priya@test.local',
        phone: '647-555-0100', employment_type: 'employee',
      },
      application: {
        application_type_id: 1, purchase_price: 850000, down_payment: 170000,
        mortgage_amount: 680000, property_address: '12 Bloor St W', fthb: true,
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    fileId = res.data.file.id;

    assert.match(res.data.file.file_number, /^MTG-\d{4}-\d{5}$/, 'a human-readable file number');
    assert.equal(res.data.file.client_name, 'Priya Patel');
    assert.ok(res.data.file.checklist.total_required > 0, 'the checklist is generated, not typed in');
    assert.equal(res.data.file.stage.id, 1, 'the file starts at the first stage');

    const invite = res.data.invites[0];
    assert.equal(invite.username, 'priya@test.local');
    assert.ok(invite.temporary_password, 'a temporary password is issued');
    assert.equal(invite.emailed, true);
    temporaryPassword = invite.temporary_password;
  });

  test('the welcome email is logged with the password redacted', async () => {
    const emails = await admin.get(`/api/broker/files/${fileId}/emails`);
    const welcome = emails.data.emails.find((e) => e.template_key === 'welcome');
    assert.ok(welcome, 'a welcome email should have been queued');
    const full = await admin.get(`/api/broker/emails/${welcome.id}`);
    assert.ok(
      !full.data.email.body.includes(temporaryPassword),
      'the stored copy must not contain the temporary password'
    );
  });

  test('the activity timeline records what happened, in plain words', async () => {
    const activity = await admin.get(`/api/broker/files/${fileId}/activity`);
    const kinds = activity.data.activity.map((a) => a.kind);
    assert.ok(kinds.includes('client_created'));
    assert.ok(kinds.includes('checklist_created'));
  });
});

describe('scenario 2 — the client signs in and is forced to set their own password', () => {
  test('the temporary password works exactly once', async () => {
    client = await helpers.signInFreshClient(ctx.base, 'priya@test.local', temporaryPassword, CLIENT_PASSWORD);
    const me = await client.get('/api/auth/me');
    assert.equal(me.data.must_change_password, false);

    const reuse = helpers.makeClient(ctx.base);
    const res = await reuse.post('/api/auth/login', { email: 'priya@test.local', password: temporaryPassword });
    assert.equal(res.status, 401, 'the temporary password must stop working once changed');
  });

  test('the portal opens on a single clear next step', async () => {
    const overview = await client.get('/api/client/overview');
    assert.equal(overview.status, 200);
    const file = overview.data.files[0];
    assert.equal(file.file_id, fileId);
    assert.equal(file.next_step.kind, 'upload');
    assert.match(file.next_step.text, /upload/i);
  });
});

describe('scenario 3 — the rule engine decides what is needed', () => {
  test('an employed purchaser gets the employee document set', async () => {
    const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
    const names = docs.data.requests.map((r) => r.document_name);
    for (const expected of ['Government ID', 'Recent Pay Stub', 'Purchase Agreement', 'Down Payment Verification']) {
      assert.ok(names.includes(expected), `expected "${expected}" in ${names.join(', ')}`);
    }
  });

  test('adding a self-employed co-borrower extends the checklist automatically', async () => {
    const before = (await admin.get(`/api/broker/files/${fileId}/documents`)).data.requests.length;
    const added = await admin.post(`/api/broker/files/${fileId}/applicants`, {
      first_name: 'Raj', last_name: 'Patel', role: 'co_borrower',
      employment_type: 'self_employed', email: 'raj@test.local',
    });
    assert.equal(added.status, 200);
    assert.ok(added.data.checklist_sync.added > 0, 'new applicant, new documents');
    const after = (await admin.get(`/api/broker/files/${fileId}/documents`)).data.requests;
    const names = after.map((r) => r.document_name);
    assert.ok(names.includes('T1 General'), 'self-employed documents were added');
    assert.ok(after.length > before);
  });
});

describe('scenario 4 — the client uploads', () => {
  let requestIds;

  test('three uploads succeed and the broker is notified', async () => {
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    requestIds = docs.data.requests.slice(0, 3).map((r) => r.id);
    for (const id of requestIds) {
      const res = await client.upload(`/api/client/requests/${id}/upload`, helpers.PDF, 'statement.pdf');
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.request.status, 'uploaded');
    }
    const notifications = await admin.get('/api/broker/notifications');
    const kinds = notifications.data.notifications.map((n) => n.kind);
    assert.ok(kinds.includes('document_uploaded'));
  });

  test('the client now sees "being reviewed" rather than "needed"', async () => {
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const uploaded = docs.data.requests.find((r) => r.id === requestIds[0]);
    assert.equal(uploaded.client_status.kind, 'waiting');
    assert.match(uploaded.client_status.label, /review/i);
  });

  test('a file type outside the allowed list is refused', async () => {
    const res = await client.upload(
      `/api/client/requests/${requestIds[0]}/upload`,
      Buffer.from('MZ\x90\x00 not a document'),
      'malware.exe'
    );
    assert.equal(res.status, 400);
  });

  test('an over-size upload is told why, not dropped', async () => {
    // The limit has to be enforced while the body is still arriving, so the
    // easy mistake is to kill the socket and leave the client with a network
    // error instead of an explanation.
    const limits = await require('../server/storage').uploadLimits();
    const tooBig = Buffer.alloc(limits.maxBytes + 1024, 0x41);
    tooBig.write('%PDF-1.4\n');
    const res = await client.upload(`/api/client/requests/${requestIds[0]}/upload`, tooBig, 'huge.pdf');
    assert.equal(res.status, 413);
    assert.equal(res.data.code, 'too_large');
    assert.match(res.data.message, /too large/i);
  });

  test('a file whose contents do not match its extension is refused', async () => {
    const res = await client.upload(
      `/api/client/requests/${requestIds[0]}/upload`,
      Buffer.from('this is plainly not a PDF'),
      'pretend.pdf'
    );
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'bad_file_content');
  });
});

describe('scenario 5 — the broker reviews', () => {
  let approvedId;
  let rejectedId;

  test('approving and rejecting both work, and rejection requires a reason', async () => {
    const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
    const uploaded = docs.data.requests.filter((r) => r.status === 'uploaded');
    assert.ok(uploaded.length >= 2);
    approvedId = uploaded[0].id;
    rejectedId = uploaded[1].id;

    const approve = await admin.post(`/api/broker/requests/${approvedId}/review`, { action: 'approve' });
    assert.equal(approve.status, 200);
    assert.equal(approve.data.request.status, 'approved');

    const noReason = await admin.post(`/api/broker/requests/${rejectedId}/review`, { action: 'reject' });
    assert.equal(noReason.status, 400, 'a rejection without a client-facing note is refused');
    assert.equal(noReason.data.code, 'note_required');

    const rejected = await admin.post(`/api/broker/requests/${rejectedId}/review`, {
      action: 'reject', client_note: 'This page is cut off — please re-scan the whole document.',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.request.status, 'rejected');
  });

  test('the client is told exactly what to fix, in their own portal', async () => {
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const rejected = docs.data.requests.find((r) => r.id === rejectedId);
    assert.equal(rejected.client_status.kind, 'action');
    assert.match(rejected.client_status.reason, /re-scan/i);
  });

  test('internal review notes never reach the client', async () => {
    await admin.post(`/api/broker/requests/${rejectedId}/review`, {
      action: 'request_replacement',
      client_note: 'Please send a clearer copy.',
      internal_note: 'Third attempt — call the lender if this one is bad too.',
    });
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const serialized = JSON.stringify(docs.data);
    assert.ok(!serialized.includes('call the lender'), 'internal notes must not be serialized to a client');
    assert.ok(!serialized.includes('internal_note'));
  });
});

describe('scenario 6 — a replacement keeps the history', () => {
  test('re-uploading creates version 2 and preserves version 1', async () => {
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const needsReplacement = docs.data.requests.find((r) => r.client_status.kind === 'action' && r.current_version);
    assert.ok(needsReplacement, 'expected a document awaiting replacement');

    const res = await client.upload(`/api/client/requests/${needsReplacement.id}/upload`, helpers.PDF, 'clean-scan.pdf');
    assert.equal(res.status, 200);
    assert.equal(res.data.request.current_version.version, 2);

    const brokerView = await admin.get(`/api/broker/files/${fileId}/documents`);
    const request = brokerView.data.requests.find((r) => r.id === needsReplacement.id);
    assert.equal(request.versions.length, 2, 'both versions are retained');
    assert.ok(request.versions.some((v) => v.status === 'rejected'), 'the earlier decision is still on the record');
  });
});

describe('scenario 7 — messaging', () => {
  test('a client message reaches the broker, and the reply comes back', async () => {
    const sent = await client.post(`/api/client/files/${fileId}/messages`, {
      body: 'Do you need my bonus letter as well?',
    });
    assert.equal(sent.status, 200);

    const inbox = await admin.get(`/api/broker/files/${fileId}/messages`);
    assert.ok(inbox.data.messages.some((m) => m.body.includes('bonus letter')));

    const reply = await admin.post(`/api/broker/files/${fileId}/messages`, {
      body: 'Yes please — upload it under Employment Letter.',
    });
    assert.equal(reply.status, 200);

    const clientView = await client.get(`/api/client/files/${fileId}/messages`);
    const bodies = clientView.data.messages.map((m) => m.body);
    assert.ok(bodies.some((b) => b.includes('bonus letter')));
    assert.ok(bodies.some((b) => b.includes('Employment Letter')));
  });

  test('unread client messages show up on the broker dashboard', async () => {
    await client.post(`/api/client/files/${fileId}/messages`, { body: 'One more question.' });
    const dashboard = await admin.get('/api/broker/dashboard');
    const row = dashboard.data.attention.find((a) => a.file_id === fileId);
    assert.ok(row, 'the file should be flagged for attention');
    assert.ok(row.reasons.some((r) => r.kind === 'message'));
    await admin.post(`/api/broker/files/${fileId}/messages/read`);
    const after = await admin.get('/api/broker/dashboard');
    const afterRow = after.data.attention.find((a) => a.file_id === fileId);
    assert.ok(!afterRow || !afterRow.reasons.some((r) => r.kind === 'message'));
  });
});

describe('scenario 8 — moving the file forward', () => {
  test('a stage change updates the client view and emails them', async () => {
    const meta = await admin.get('/api/settings/meta');
    const documentsRequested = meta.data.stages.find((s) => s.key === 'docs_requested');
    const res = await admin.post(`/api/broker/files/${fileId}/stage`, {
      stage_id: documentsRequested.id, note: 'Checklist sent.',
    });
    assert.equal(res.status, 200);

    const overview = await client.get('/api/client/overview');
    assert.equal(overview.data.files[0].stage.label, documentsRequested.client_label);

    const emails = await admin.get(`/api/broker/files/${fileId}/emails`);
    assert.ok(
      emails.data.emails.some((e) => e.template_key === 'stage_changed' || e.template_key === documentsRequested.email_template_key),
      'the configured stage email was sent'
    );

    const history = await admin.get(`/api/broker/files/${fileId}`);
    assert.ok(history.data.stage_history.length >= 1);
    assert.equal(history.data.stage_history[0].to_name, documentsRequested.name);
  });
});

describe('scenario 9 — nothing is forgotten', () => {
  test('a follow-up task appears in the task views and on the dashboard', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const created = await admin.post('/api/broker/tasks', {
      title: 'Call Priya about the bonus letter', file_id: fileId, due_date: today, priority: 'high',
    });
    assert.equal(created.status, 200);

    const tasks = await admin.get('/api/broker/tasks?filter=today');
    assert.ok(tasks.data.tasks.some((t) => t.id === created.data.id));

    const dashboard = await admin.get('/api/broker/dashboard');
    assert.ok(dashboard.data.cards.tasks_today >= 1);
    assert.ok(dashboard.data.tasks.some((t) => t.id === created.data.id));

    const done = await admin.patch(`/api/broker/tasks/${created.data.id}`, { status: 'completed' });
    assert.equal(done.status, 200);
    const after = await admin.get('/api/broker/tasks?filter=today');
    assert.ok(!after.data.tasks.some((t) => t.id === created.data.id));
  });

  test('the outstanding-documents email lists exactly what is still needed', async () => {
    const res = await admin.post(`/api/broker/files/${fileId}/request-outstanding`);
    assert.equal(res.status, 200);
    assert.ok(res.data.documents > 0);

    const emails = await admin.get(`/api/broker/files/${fileId}/emails`);
    const summary = emails.data.emails.find((e) => e.template_key === 'documents_outstanding');
    const full = await admin.get(`/api/broker/emails/${summary.id}`);

    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const outstanding = docs.data.requests.filter((r) => r.client_status.kind === 'action');
    for (const item of outstanding) {
      assert.ok(
        full.data.email.body.includes(item.document_name),
        `the email should mention ${item.document_name}, matching the portal`
      );
    }
  });
});

describe('housekeeping', () => {
  test('duplicate detection warns before a second record is created', async () => {
    const duplicate = await admin.post('/api/broker/clients', {
      client: { first_name: 'Priya', last_name: 'Patel', email: 'priya@test.local' },
      application: { application_type_id: 1 },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'possible_duplicate');
    assert.ok(duplicate.data.duplicates[0].reasons.includes('Same email'));

    const forced = await admin.post('/api/broker/clients', {
      client: { first_name: 'Priya', last_name: 'Patel', email: 'priya2@test.local' },
      application: { application_type_id: 1 },
      ignore_duplicates: true,
    });
    assert.equal(forced.status, 200, 'the broker can still proceed deliberately');
  });

  test('the client list paginates in the database, not in memory', async () => {
    // Create enough files to need a second page.
    for (let i = 0; i < 26; i++) {
      await admin.post('/api/broker/clients', {
        client: { first_name: `Test${i}`, last_name: `Case${i}`, email: `bulk${i}@test.local` },
        application: { application_type_id: 1 },
        ignore_duplicates: true,
        send_welcome: false,
      });
    }
    const page1 = await admin.get('/api/broker/clients?status=active&page=1');
    const page2 = await admin.get('/api/broker/clients?status=active&page=2');
    assert.equal(page1.data.per_page, 25);
    assert.equal(page1.data.clients.length, 25, 'a page is exactly one page');
    assert.ok(page1.data.total > 25);
    assert.ok(page2.data.clients.length > 0);
    const overlap = page1.data.clients
      .map((c) => c.id)
      .filter((id) => page2.data.clients.some((c) => c.id === id));
    assert.deepEqual(overlap, [], 'pages must not repeat rows');
  });

  test('an out-of-range page is clamped rather than returning nothing useful', async () => {
    const res = await admin.get('/api/broker/clients?status=active&page=9999');
    assert.equal(res.status, 200);
    assert.ok(res.data.clients.length > 0);
    assert.ok(res.data.page * res.data.per_page >= res.data.total);
  });

  test('search finds a client by name, file number and address', async () => {
    const byName = await admin.get('/api/broker/search?q=priya');
    assert.ok(byName.data.results.some((r) => r.id === fileId));

    const fileNumber = (await admin.get(`/api/broker/files/${fileId}`)).data.file.file_number;
    const byNumber = await admin.get(`/api/broker/search?q=${encodeURIComponent(fileNumber.toLowerCase())}`);
    assert.ok(byNumber.data.results.some((r) => r.id === fileId));

    const byAddress = await admin.get('/api/broker/search?q=bloor');
    assert.ok(byAddress.data.results.some((r) => r.id === fileId));
  });

  test('the retention policy archives on the schedule the brokerage sets', async () => {
    const db = require('../server/db');
    const jobs = require('../server/jobs');

    // Off by default: nothing is touched.
    await jobs.retentionPass();
    const before = await db.get("SELECT COUNT(*)::int AS n FROM client_files WHERE status = 'archived'");
    assert.equal(before.n, 0);

    // Make one file look long-untouched, then turn the policy on.
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    await db.run('UPDATE client_files SET last_activity_at = ?, updated_at = ? WHERE id = ?', old, old, fileId);
    assert.equal(
      (await admin.put('/api/settings/config/retention', { value: { archive_inactive_after_days: 365 } })).status,
      200
    );
    await jobs.retentionPass();

    const file = await db.get('SELECT status FROM client_files WHERE id = ?', fileId);
    assert.equal(file.status, 'archived', 'an inactive file is archived, not deleted');
    const activity = await admin.get(`/api/broker/files/${fileId}/activity`);
    assert.ok(activity.data.activity.some((a) => /archived automatically/i.test(a.message)));

    // Nothing is ever removed by the policy.
    const stillThere = await admin.get(`/api/broker/files/${fileId}`);
    assert.equal(stillThere.status, 200);

    await admin.put('/api/settings/config/retention', { value: {} });
    await admin.post(`/api/broker/files/${fileId}/status`, { status: 'active' });
  });

  test('an out-of-range retention window is refused', async () => {
    assert.equal((await admin.put('/api/settings/config/retention', { value: { archive_inactive_after_days: 0 } })).status, 400);
    assert.equal((await admin.put('/api/settings/config/retention', { value: { archive_inactive_after_days: 99999 } })).status, 400);
  });

  test('reports summarize the book without loading it', async () => {
    const res = await admin.get('/api/broker/reports');
    assert.equal(res.status, 200);
    assert.ok(res.data.active_clients > 25);
    assert.ok(Array.isArray(res.data.by_stage));
    assert.equal(typeof res.data.documents_outstanding, 'number');
  });
});
