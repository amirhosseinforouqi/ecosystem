'use strict';

/**
 * Microsoft Graph (Outlook mail + OneDrive) and Claude document review.
 *
 * These run against local HTTP servers that speak the real protocols — the
 * OAuth2 client-credentials token exchange, Graph sendMail / driveItem, and
 * the Anthropic Messages API wire format — reached through the MS_LOGIN_BASE
 * / MS_GRAPH_BASE / ANTHROPIC_BASE_URL overrides. Nothing is stubbed at the
 * module boundary, so the request shapes this code actually sends are
 * asserted rather than assumed.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');

// --- Mock Microsoft identity platform + Graph ------------------------------
const graphCalls = { tokenRequests: [], sentMail: [], created: [], uploads: [] };
let graphServer;

function startGraphMock() {
  graphServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url;

      if (url.includes('/oauth2/v2.0/token')) {
        const form = new URLSearchParams(raw.toString('utf8'));
        graphCalls.tokenRequests.push(Object.fromEntries(form));
        if (form.get('client_secret') !== 'test-secret') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_client', error_description: 'bad secret' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }));
      }

      if (req.headers.authorization !== 'Bearer mock-access-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: 'missing token' } }));
      }

      if (url.endsWith('/sendMail') && req.method === 'POST') {
        graphCalls.sentMail.push(JSON.parse(raw.toString('utf8')));
        res.writeHead(202);
        return res.end();
      }

      if (url.endsWith('/children') && req.method === 'POST') {
        const body = JSON.parse(raw.toString('utf8'));
        graphCalls.created.push({ url, name: body.name });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: `folder-${graphCalls.created.length}`, name: body.name }));
      }

      if (url.includes(':/content') && req.method === 'PUT') {
        graphCalls.uploads.push({ url, size: raw.length, body: raw });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: `item-${graphCalls.uploads.length}`, webUrl: 'https://example/onedrive' }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'itemNotFound', message: url } }));
    });
  });
  return new Promise((resolve) => graphServer.listen(0, '127.0.0.1', resolve));
}

// --- Mock Anthropic Messages API ------------------------------------------
const claudeCalls = [];
let claudeServer;
let claudeMode = 'ok'; // ok | fail-once | always-fail

function startClaudeMock() {
  let failures = 0;
  claudeServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      claudeCalls.push({ headers: req.headers, body, url: req.url });

      if (claudeMode === 'always-fail' || (claudeMode === 'fail-once' && failures++ === 0)) {
        res.writeHead(529, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
        stop_reason: 'end_turn',
        content: [{
          type: 'text',
          text: JSON.stringify({
            detected_type: 'T4 Statement of Remuneration Paid',
            matches_expected: true,
            confidence: 'high',
            summary: 'A 2025 T4 for John Smith from Acme Manufacturing showing employment income.',
            extracted: { tax_year: '2025', employer: 'Acme Manufacturing', box_14_employment_income: '86,400.00' },
            issues: [],
            suggested_action: 'Looks complete — ready for review',
          }),
        }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }));
    });
  });
  return new Promise((resolve) => claudeServer.listen(0, '127.0.0.1', resolve));
}

let ctx;
let admin;
let client;
let fileId;
let creds;
const CLIENT_PASSWORD = 'Thistle-Compass-Ember-63';

async function runJobs() {
  return require('../server/jobs').runAllJobs();
}

before(async () => {
  await startGraphMock();
  await startClaudeMock();
  const graphPort = graphServer.address().port;
  const claudePort = claudeServer.address().port;

  ctx = await helpers.startTestServer('integrations', {
    MS_LOGIN_BASE: `http://127.0.0.1:${graphPort}`,
    MS_GRAPH_BASE: `http://127.0.0.1:${graphPort}/v1.0`,
    MS_TENANT_ID: 'test-tenant',
    MS_CLIENT_ID: 'test-client',
    MS_CLIENT_SECRET: 'test-secret',
    MS_MAILBOX: 'broker@brokerage.test',
    EMAIL_TRANSPORT: 'graph',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudePort}`,
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    ANTHROPIC_MODEL: 'claude-opus-5',
    AI_DOCUMENT_REVIEW_ENABLED: 'true',
    AI_PROCESSING_AGREEMENT_REF: 'DPA-2026-TEST',
    ONEDRIVE_ROOT: 'Mortgage Clients',
  });
  admin = await helpers.signInAdmin(ctx.base);
});

after(async () => {
  if (graphServer) graphServer.close();
  if (claudeServer) claudeServer.close();
  if (ctx) await ctx.stop();
});

// ---------------------------------------------------------------------------

describe('Microsoft 365 mail (no mailbox password anywhere)', () => {
  test('the welcome email goes out through Graph using client credentials', async () => {
    const meta = await admin.get('/api/settings/meta');
    assert.equal(meta.data.integrations.microsoft_graph, true);
    assert.equal(meta.data.integrations.onedrive, true);

    const purchase = meta.data.application_types.find((t) => t.key === 'purchase');
    const res = await admin.post('/api/broker/clients', {
      client: { first_name: 'John', last_name: 'Smith', email: 'john@client.test', employment_type: 'employee' },
      application: { application_type_id: purchase.id, purchase_price: 800000, down_payment: 160000 },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    fileId = res.data.file.id;
    creds = res.data.invites.find((i) => i.temporary_password);
    assert.ok(creds);

    assert.ok(graphCalls.tokenRequests.length >= 1, 'the token endpoint was called');
    const tokenReq = graphCalls.tokenRequests[0];
    assert.equal(tokenReq.grant_type, 'client_credentials');
    assert.equal(tokenReq.scope, 'https://graph.microsoft.com/.default');
    assert.equal(tokenReq.client_id, 'test-client');
    assert.ok(!('password' in tokenReq), 'no mailbox password is involved');
    assert.ok(!('username' in tokenReq));

    const mail = graphCalls.sentMail.find((m) => /Welcome/i.test(m.message.subject));
    assert.ok(mail, 'the welcome email was sent via Graph');
    assert.equal(mail.message.toRecipients[0].emailAddress.address, 'john@client.test');
    assert.ok(mail.message.body.content.includes(creds.username));
    assert.ok(mail.message.body.content.includes(creds.temporary_password));
    assert.ok(mail.message.body.content.includes('/login'));
  });

  test('the access token is reused rather than re-fetched for every message', async () => {
    const before = graphCalls.tokenRequests.length;
    await admin.post(`/api/broker/files/${fileId}/messages`, { body: 'Hello John.', send_email: true });
    assert.equal(graphCalls.tokenRequests.length, before, 'the cached token is reused until it expires');
  });
});

describe('OneDrive / SharePoint filing', () => {
  test('the client folder tree is created and named after the file number', async () => {
    await runJobs();
    const folderNames = graphCalls.created.map((c) => c.name);
    assert.ok(folderNames.includes('Mortgage Clients'), 'the root folder is ensured');
    assert.ok(
      folderNames.some((n) => /John Smith - MTG-\d{4}-\d{5}/.test(n)),
      `the client folder is "<client> - <file number>", got: ${folderNames.join(', ')}`
    );
    for (const sub of ['Identity', 'Income', 'Assets', 'Property', 'Mortgage', 'Other', 'AI Review']) {
      assert.ok(folderNames.includes(sub), `subfolder ${sub} created`);
    }
  });
});

describe('Claude document review (audit finding C6)', () => {
  test('with the brokerage setting off, no document is sent to Anthropic', async () => {
    client = await helpers.signInFreshClient(ctx.base, creds.username, creds.temporary_password, CLIENT_PASSWORD);
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const target = docs.data.requests.find((r) => r.document_name === 'Government ID');

    const before = claudeCalls.length;
    const up = await client.upload(`/api/client/requests/${target.id}/upload`, helpers.PDF, 'id.pdf');
    assert.equal(up.status, 200);
    await runJobs();
    assert.equal(claudeCalls.length, before, 'the feature is off, so nothing was sent');

    const db = require('../server/db');
    const review = await db.get('SELECT * FROM ai_reviews WHERE request_id = ? ORDER BY id DESC LIMIT 1', target.id);
    assert.equal(review.status, 'disabled', 'and the reason is recorded rather than left pending');
  });

  test('with the setting on but no client consent, still nothing is sent', async () => {
    await admin.put('/api/settings/config/ai_review', {
      value: { enabled: true, require_client_consent: true },
    });
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const target = docs.data.requests.find((r) => r.document_name === 'Notice of Assessment');

    const before = claudeCalls.length;
    await client.upload(`/api/client/requests/${target.id}/upload`, helpers.PDF, 'noa.pdf');
    await runJobs();
    assert.equal(claudeCalls.length, before, 'consent is a real gate, not a UI checkbox');
  });

  test('recording consent is an auditable broker action', async () => {
    const res = await admin.post(`/api/broker/files/${fileId}/ai-consent`, {
      consent: true, source: 'Signed consent form, 2026-08-20',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ai_consent, true);

    const file = await admin.get(`/api/broker/files/${fileId}`);
    assert.equal(file.data.file.ai_consent, true);
    assert.ok(file.data.file.ai_consent_at);

    const audit = await admin.get('/api/broker/audit');
    assert.ok(audit.data.audit.some((a) => a.action === 'ai_consent_changed'));
  });

  test('with all three gates open: review runs via the project skill, and never blocks the upload', async () => {
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const t4 = docs.data.requests.find((r) => r.document_name === 'T4');
    assert.ok(t4, 'T4 is on the checklist');

    const before = claudeCalls.length;
    const up = await client.upload(`/api/client/requests/${t4.id}/upload`, helpers.PDF, 'T4-2025.pdf');
    assert.equal(up.status, 200, 'the upload succeeds immediately');
    assert.equal(up.data.request.status, 'uploaded');
    assert.equal(claudeCalls.length, before, 'the upload did NOT wait for Claude');

    await runJobs();

    const call = claudeCalls[claudeCalls.length - 1];
    assert.equal(call.url, '/v1/messages');
    assert.equal(call.headers['x-api-key'], 'test-anthropic-key');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.body.model, 'claude-opus-5');

    const skillText = fs.readFileSync(path.join(__dirname, '..', 'skills', 'document-review', 'SKILL.md'), 'utf8');
    assert.equal(call.body.system, skillText, 'the configured skill file IS the system prompt');

    const docBlock = call.body.messages[0].content.find((b) => b.type === 'document');
    assert.ok(docBlock, 'the document is sent as a document block');
    assert.equal(docBlock.source.media_type, 'application/pdf');
    assert.equal(Buffer.from(docBlock.source.data, 'base64').toString('latin1'), helpers.PDF.toString('latin1'));
    assert.match(
      call.body.messages[0].content.find((b) => b.type === 'text').text,
      /Expected document type[^"]*"T4"/,
      'the expected checklist document type is passed to the model'
    );

    const brokerDocs = await admin.get(`/api/broker/files/${fileId}/documents`);
    const brokerT4 = brokerDocs.data.requests.find((r) => r.id === t4.id);
    assert.equal(brokerT4.ai_review.status, 'done');
    assert.equal(brokerT4.ai_review.result.detected_type, 'T4 Statement of Remuneration Paid');
    assert.equal(brokerT4.ai_review.result.extracted.tax_year, '2025');
    assert.equal(brokerT4.ai_review.model, 'claude-opus-5');

    const version = brokerT4.versions[0];
    assert.equal(version.onedrive_status, 'done');
    assert.ok(version.onedrive_item_id);
    assert.match(version.onedrive_path, /Mortgage Clients\/John Smith - MTG-\d{4}-\d{5}\/Income\//);
    assert.ok(graphCalls.uploads.some((u) => u.body.equals(helpers.PDF)), 'the exact bytes reached OneDrive');
    assert.ok(
      graphCalls.uploads.some((u) => decodeURIComponent(u.url).includes('/AI Review/')),
      'the review summary was mirrored to the AI Review folder'
    );
  });

  test('the stored review result is encrypted at rest', async () => {
    const db = require('../server/db');
    const row = await db.get("SELECT result FROM ai_reviews WHERE status = 'done' ORDER BY id DESC LIMIT 1");
    assert.ok(row.result, 'a result was stored');
    assert.ok(!row.result.includes('Acme Manufacturing'), 'extracted client data is not stored in the clear');
    const envelope = JSON.parse(row.result);
    assert.equal(envelope.v, 1);
    assert.ok(envelope.key_id && envelope.data);
  });

  test('review results are never exposed to the client portal', async () => {
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const serialized = JSON.stringify(docs.data);
    assert.ok(!serialized.includes('ai_review'), 'no ai_review key in a client payload');
    assert.ok(!serialized.includes('T4 Statement of Remuneration Paid'));
    assert.ok(!serialized.includes('onedrive'), 'no storage locations leaked');
    assert.ok(!serialized.includes('scan_status'));
  });

  test('withdrawing consent stops future reviews', async () => {
    await admin.post(`/api/broker/files/${fileId}/ai-consent`, { consent: false });
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const target = docs.data.requests.find((r) => r.document_name === 'Employment Letter');
    const before = claudeCalls.length;
    await client.upload(`/api/client/requests/${target.id}/upload`, helpers.PDF, 'letter.pdf');
    await runJobs();
    assert.equal(claudeCalls.length, before, 'consent withdrawn means no further processing');
    await admin.post(`/api/broker/files/${fileId}/ai-consent`, { consent: true });
  });

  test('a retry cannot be used to bypass a disabled feature', async () => {
    const db = require('../server/db');
    const review = await db.get("SELECT * FROM ai_reviews WHERE status = 'done' ORDER BY id DESC LIMIT 1");
    await admin.post(`/api/broker/files/${fileId}/ai-consent`, { consent: false });
    const res = await admin.post(`/api/broker/ai-reviews/${review.id}/retry`, {});
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'ai_disabled');
    await admin.post(`/api/broker/files/${fileId}/ai-consent`, { consent: true });
  });
});

describe('resilience', () => {
  test('a Claude outage is retried and never loses the document', async () => {
    const db = require('../server/db');
    claudeMode = 'fail-once';

    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const stub = docs.data.requests.find((r) => r.document_name === 'Recent Pay Stub');
    const up = await client.upload(`/api/client/requests/${stub.id}/upload`, helpers.PDF, 'paystub.pdf');
    assert.equal(up.status, 200, 'the upload still succeeds while Claude is down');

    await runJobs(); // first attempt fails (529)
    let review = await db.get('SELECT * FROM ai_reviews WHERE request_id = ? ORDER BY id DESC LIMIT 1', stub.id);
    assert.equal(review.status, 'pending', 'it stays queued for retry');
    assert.equal(review.attempts, 1);

    await runJobs(); // retry succeeds
    review = await db.get('SELECT * FROM ai_reviews WHERE request_id = ? ORDER BY id DESC LIMIT 1', stub.id);
    assert.equal(review.status, 'done');

    const brokerDocs = await admin.get(`/api/broker/files/${fileId}/documents`);
    const brokerStub = brokerDocs.data.requests.find((r) => r.id === stub.id);
    assert.equal(brokerStub.status, 'uploaded');
    assert.equal(brokerStub.versions.length, 1, 'the document itself was never at risk');
    claudeMode = 'ok';
  });

  test('a review stuck in "running" is reclaimed rather than lost', async () => {
    const db = require('../server/db');
    const review = await db.get("SELECT * FROM ai_reviews WHERE status = 'done' ORDER BY id DESC LIMIT 1");
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.run("UPDATE ai_reviews SET status = 'running', running_since = ? WHERE id = ?", stale, review.id);

    const reclaimed = await require('../server/ai-review').reclaimStalled();
    assert.ok(reclaimed >= 1, 'a stalled lease is returned to the queue');
    const after = await db.get('SELECT * FROM ai_reviews WHERE id = ?', review.id);
    assert.ok(['pending', 'done'].includes(after.status));
  });

  test('a permanently failed review can be retried by the broker', async () => {
    const db = require('../server/db');
    const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
    const t4 = docs.data.requests.find((r) => r.document_name === 'T4');
    const reviewId = t4.ai_review.id;
    await db.run("UPDATE ai_reviews SET status = 'failed', attempts = 3, error = 'boom' WHERE id = ?", reviewId);

    const retry = await admin.post(`/api/broker/ai-reviews/${reviewId}/retry`, {});
    assert.equal(retry.status, 200);
    assert.equal((await db.get('SELECT * FROM ai_reviews WHERE id = ?', reviewId)).status, 'pending');

    await runJobs();
    assert.equal((await db.get('SELECT * FROM ai_reviews WHERE id = ?', reviewId)).status, 'done');
  });

  test('a Graph outage does not lose a document either', async () => {
    const db = require('../server/db');
    const version = await db.get("SELECT * FROM document_versions WHERE onedrive_status = 'done' ORDER BY id DESC LIMIT 1");
    await db.run("UPDATE document_versions SET onedrive_status = 'pending', onedrive_attempts = 0 WHERE id = ?", version.id);
    await runJobs();
    const after = await db.get('SELECT * FROM document_versions WHERE id = ?', version.id);
    assert.equal(after.onedrive_status, 'done', 'the sync is retried from the queue');
    const bytes = await admin.get(`/api/broker/versions/${version.id}/file`);
    assert.equal(bytes.status, 200, 'and the local copy is still authoritative');
  });
});

describe('notification email', () => {
  test('the outstanding-documents email lists the items and mirrors the portal', async () => {
    const sentBefore = graphCalls.sentMail.length;
    const res = await admin.post(`/api/broker/files/${fileId}/request-outstanding`, {});
    assert.equal(res.status, 200);
    assert.ok(res.data.documents > 0);
    assert.ok(graphCalls.sentMail.length > sentBefore, 'an email was sent');

    const mail = graphCalls.sentMail[graphCalls.sentMail.length - 1];
    assert.match(mail.message.subject, /Documents Required/i);
    assert.match(mail.message.body.content, /^- /m, 'the body lists the outstanding documents');

    const overview = await client.get('/api/client/overview');
    assert.ok(overview.data.files[0].needed.length > 0, 'the portal shows the same items');
  });
});
