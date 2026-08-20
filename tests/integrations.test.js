'use strict';

/**
 * Integration tests for the Microsoft Graph (Outlook mail + OneDrive) and
 * Claude document-review pipelines.
 *
 * These run against local HTTP servers that speak the real protocols —
 * OAuth2 client-credentials token exchange, Graph sendMail / driveItem
 * endpoints, and the Anthropic Messages API wire format — pointed at via the
 * MS_LOGIN_BASE / MS_GRAPH_BASE / ANTHROPIC_BASE_URL overrides. Nothing is
 * stubbed at the module boundary, so the request shapes this code sends are
 * genuinely asserted rather than assumed.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mortgage-integ-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-test-1234';

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

      // OAuth2 client-credentials token endpoint
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

      // Everything past this point must present the bearer token.
      if (req.headers.authorization !== 'Bearer mock-access-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: 'missing token' } }));
      }

      if (url.endsWith('/sendMail') && req.method === 'POST') {
        graphCalls.sentMail.push(JSON.parse(raw.toString('utf8')));
        res.writeHead(202);
        return res.end();
      }

      // Folder creation: POST .../children
      if (url.endsWith('/children') && req.method === 'POST') {
        const body = JSON.parse(raw.toString('utf8'));
        graphCalls.created.push({ url, name: body.name });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: `folder-${graphCalls.created.length}`, name: body.name }));
      }

      // File upload: PUT .../root:/path:/content
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

let server;
let base;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

function makeClient() {
  let cookie = null;
  return {
    async call(method, url, body, raw, filename) {
      const headers = { 'X-Requested-With': 'fetch' };
      if (cookie) headers.Cookie = cookie;
      let payload;
      if (raw) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['X-Filename'] = encodeURIComponent(filename);
        payload = raw;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers, body: payload });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* streams */ }
      return { status: res.status, data };
    },
    get(u) { return this.call('GET', u); },
    post(u, b) { return this.call('POST', u, b); },
    upload(u, buf, fn) { return this.call('POST', u, undefined, buf, fn); },
  };
}

const admin = makeClient();

before(async () => {
  await startGraphMock();
  await startClaudeMock();
  const graphPort = graphServer.address().port;
  const claudePort = claudeServer.address().port;

  // Point the integrations at the mocks BEFORE the server module loads.
  process.env.MS_LOGIN_BASE = `http://127.0.0.1:${graphPort}`;
  process.env.MS_GRAPH_BASE = `http://127.0.0.1:${graphPort}/v1.0`;
  process.env.MS_TENANT_ID = 'test-tenant';
  process.env.MS_CLIENT_ID = 'test-client';
  process.env.MS_CLIENT_SECRET = 'test-secret';
  process.env.MS_MAILBOX = 'broker@brokerage.test';
  process.env.EMAIL_TRANSPORT = 'graph';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claudePort}`;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.ANTHROPIC_MODEL = 'claude-opus-5';
  process.env.ONEDRIVE_ROOT = 'Mortgage Clients';

  ({ server } = require('../server/index'));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  await admin.post('/api/auth/login', { email: 'admin@test.local', password: 'admin-test-1234' });
});

after(async () => {
  if (server) server.close();
  if (graphServer) graphServer.close();
  if (claudeServer) claudeServer.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

let fileId;
let creds;

test('welcome email is sent through Microsoft Graph with OAuth client credentials', async () => {
  const meta = await admin.get('/api/settings/meta');
  assert.strictEqual(meta.data.integrations.microsoft_graph, true, 'Graph reported as configured');
  assert.strictEqual(meta.data.integrations.onedrive, true);
  assert.strictEqual(meta.data.integrations.ai_review, true);

  const purchase = meta.data.application_types.find((t) => t.key === 'purchase');
  const res = await admin.post('/api/broker/clients', {
    client: {
      first_name: 'John', last_name: 'Smith', email: 'john@client.test',
      employment_type: 'employee',
    },
    application: { application_type_id: purchase.id, purchase_price: 800000, down_payment: 160000 },
  });
  assert.strictEqual(res.status, 200);
  fileId = res.data.file.id;
  creds = res.data.invites.find((i) => i.temporary_password);
  assert.ok(creds, 'temporary credentials generated');

  // The token endpoint was called with the client-credentials grant — no
  // mailbox password is involved anywhere.
  assert.ok(graphCalls.tokenRequests.length >= 1, 'token endpoint was called');
  const tokenReq = graphCalls.tokenRequests[0];
  assert.strictEqual(tokenReq.grant_type, 'client_credentials');
  assert.strictEqual(tokenReq.scope, 'https://graph.microsoft.com/.default');
  assert.strictEqual(tokenReq.client_id, 'test-client');

  // The welcome mail went out through Graph sendMail with the credentials.
  const mail = graphCalls.sentMail.find((m) => /Welcome/i.test(m.message.subject));
  assert.ok(mail, 'welcome email sent via Graph');
  assert.strictEqual(mail.message.toRecipients[0].emailAddress.address, 'john@client.test');
  assert.ok(mail.message.body.content.includes(creds.username), 'email carries the username');
  assert.ok(mail.message.body.content.includes(creds.temporary_password), 'email carries the temporary password');
  assert.ok(mail.message.body.content.includes('/login'), 'email carries the portal link');
  assert.match(mail.message.body.content, /change your temporary password/i, 'email explains the password change');
});

test('OneDrive client folder tree is created with the file number in its name', async () => {
  const { processBackgroundJobs } = require('../server/reminders');
  await processBackgroundJobs();

  const folderNames = graphCalls.created.map((c) => c.name);
  assert.ok(folderNames.includes('Mortgage Clients'), 'root folder ensured');
  const clientFolder = folderNames.find((n) => /John Smith - MTG-\d{4}-\d{5}/.test(n));
  assert.ok(clientFolder, `client folder is named "<client> - <file number>", got: ${folderNames.join(', ')}`);
  for (const sub of ['Identity', 'Income', 'Assets', 'Property', 'Mortgage', 'Other', 'AI Review']) {
    assert.ok(folderNames.includes(sub), `subfolder ${sub} created`);
  }
});

test('client upload → Claude review via the project skill → OneDrive, without blocking the upload', async () => {
  // Client signs in and clears the temporary password.
  const client = makeClient();
  await client.post('/api/auth/login', { email: creds.username, password: creds.temporary_password });
  await client.post('/api/auth/change-password', {
    current_password: creds.temporary_password, new_password: 'JohnPass123',
  });

  const docs = await client.get(`/api/client/files/${fileId}/documents`);
  const t4 = docs.data.requests.find((r) => r.document_name === 'T4');
  assert.ok(t4, 'T4 is on the checklist');

  const before = claudeCalls.length;
  const up = await client.upload(`/api/client/requests/${t4.id}/upload`, PDF, 'T4-2025.pdf');
  assert.strictEqual(up.status, 200, 'upload succeeds immediately');
  assert.strictEqual(up.data.request.status, 'uploaded');
  assert.strictEqual(claudeCalls.length, before, 'upload did NOT wait for Claude');

  // Background pass performs the review and the OneDrive copy.
  const { processBackgroundJobs } = require('../server/reminders');
  await processBackgroundJobs();

  // Claude was called with the document as a base64 PDF block and the
  // project's document-review skill as the system prompt.
  const call = claudeCalls[claudeCalls.length - 1];
  assert.strictEqual(call.url, '/v1/messages');
  assert.strictEqual(call.headers['x-api-key'], 'test-anthropic-key');
  assert.strictEqual(call.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(call.body.model, 'claude-opus-5');
  const skillText = fs.readFileSync(path.join(__dirname, '..', 'skills', 'document-review', 'SKILL.md'), 'utf8');
  assert.strictEqual(call.body.system, skillText, 'the configured skill file IS the system prompt');
  const docBlock = call.body.messages[0].content.find((b) => b.type === 'document');
  assert.ok(docBlock, 'document block sent');
  assert.strictEqual(docBlock.source.media_type, 'application/pdf');
  assert.strictEqual(Buffer.from(docBlock.source.data, 'base64').toString('latin1'), PDF.toString('latin1'));
  assert.match(
    call.body.messages[0].content.find((b) => b.type === 'text').text,
    /Expected document type[^"]*"T4"/,
    'the expected checklist document type is passed to the model'
  );

  // Structured result stored in the database and visible to the broker.
  const brokerDocs = await admin.get(`/api/broker/files/${fileId}/documents`);
  const brokerT4 = brokerDocs.data.requests.find((r) => r.id === t4.id);
  assert.strictEqual(brokerT4.ai_review.status, 'done');
  assert.strictEqual(brokerT4.ai_review.result.detected_type, 'T4 Statement of Remuneration Paid');
  assert.strictEqual(brokerT4.ai_review.result.extracted.tax_year, '2025');
  assert.strictEqual(brokerT4.ai_review.model, 'claude-opus-5');

  // The original document is in OneDrive and the metadata records where.
  const version = brokerT4.versions[0];
  assert.strictEqual(version.onedrive_status, 'done');
  assert.ok(version.onedrive_item_id, 'OneDrive item id stored');
  assert.match(version.onedrive_path, /Mortgage Clients\/John Smith - MTG-\d{4}-\d{5}\/Income\//, 'filed under Income');
  const uploaded = graphCalls.uploads.find((u) => u.body.equals(PDF));
  assert.ok(uploaded, 'the exact file bytes were uploaded to OneDrive');

  // The AI review JSON was mirrored into the AI Review folder.
  assert.ok(
    graphCalls.uploads.some((u) => decodeURIComponent(u.url).includes('/AI Review/')),
    'AI review summary written to the AI Review folder'
  );
});

test('AI review results are never exposed to the client portal', async () => {
  const client = makeClient();
  await client.post('/api/auth/login', { email: creds.username, password: 'JohnPass123' });
  const docs = await client.get(`/api/client/files/${fileId}/documents`);
  const serialized = JSON.stringify(docs.data);
  assert.ok(!serialized.includes('ai_review'), 'no ai_review key in client payload');
  assert.ok(!serialized.includes('T4 Statement of Remuneration Paid'), 'no AI analysis leaked');
  assert.ok(!serialized.includes('onedrive'), 'no storage locations leaked');
});

test('a Claude outage is retried and never loses the document', async () => {
  const { get: dbGet } = require('../server/db');
  const { processBackgroundJobs } = require('../server/reminders');

  claudeMode = 'fail-once';
  const client = makeClient();
  await client.post('/api/auth/login', { email: creds.username, password: 'JohnPass123' });
  const docs = await client.get(`/api/client/files/${fileId}/documents`);
  const stub = docs.data.requests.find((r) => r.document_name === 'Recent Pay Stub');

  const up = await client.upload(`/api/client/requests/${stub.id}/upload`, PDF, 'paystub.pdf');
  assert.strictEqual(up.status, 200, 'upload still succeeds while Claude is down');

  await processBackgroundJobs(); // first attempt fails (529)
  let review = dbGet(
    'SELECT * FROM ai_reviews WHERE request_id = ? ORDER BY id DESC LIMIT 1', stub.id
  );
  assert.strictEqual(review.status, 'pending', 'stays queued for retry');
  assert.strictEqual(review.attempts, 1);

  await processBackgroundJobs(); // retry succeeds
  review = dbGet('SELECT * FROM ai_reviews WHERE request_id = ? ORDER BY id DESC LIMIT 1', stub.id);
  assert.strictEqual(review.status, 'done', 'retry completed the review');

  // The document itself was never at risk.
  const brokerDocs = await admin.get(`/api/broker/files/${fileId}/documents`);
  const brokerStub = brokerDocs.data.requests.find((r) => r.id === stub.id);
  assert.strictEqual(brokerStub.status, 'uploaded');
  assert.strictEqual(brokerStub.versions.length, 1);
  claudeMode = 'ok';
});

test('a permanently failed review can be retried by the broker', async () => {
  const { get: dbGet, run: dbRun } = require('../server/db');
  const { processBackgroundJobs } = require('../server/reminders');

  const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
  const t4 = docs.data.requests.find((r) => r.document_name === 'T4');
  const reviewId = t4.ai_review.id;
  dbRun("UPDATE ai_reviews SET status = 'failed', attempts = 3, error = 'boom' WHERE id = ?", reviewId);

  const retry = await admin.post(`/api/broker/ai-reviews/${reviewId}/retry`, {});
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(dbGet('SELECT * FROM ai_reviews WHERE id = ?', reviewId).status, 'pending');

  await processBackgroundJobs();
  assert.strictEqual(dbGet('SELECT * FROM ai_reviews WHERE id = ?', reviewId).status, 'done');
});

test('outstanding-documents email lists the items and mirrors the portal', async () => {
  const sentBefore = graphCalls.sentMail.length;
  const res = await admin.post(`/api/broker/files/${fileId}/request-outstanding`, {});
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.documents > 0);

  const mail = graphCalls.sentMail[graphCalls.sentMail.length - 1];
  assert.ok(graphCalls.sentMail.length > sentBefore, 'an email was sent');
  assert.match(mail.message.subject, /Documents Required/i);
  assert.match(mail.message.body.content, /^- /m, 'body lists the outstanding documents');

  // The same items are in the portal — email is only the notification layer.
  const client = makeClient();
  await client.post('/api/auth/login', { email: creds.username, password: 'JohnPass123' });
  const overview = await client.get('/api/client/overview');
  assert.ok(overview.data.files[0].needed.length > 0, 'portal shows the outstanding documents too');
});
