'use strict';

/**
 * Guided Add-Client wizard and the three-layer document model:
 *   catalog → global rules → per-client checklist.
 *
 * The load-bearing property proved here is that editing one client's
 * checklist never changes the global defaults or any other client's list.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mortgage-checklist-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-test-1234';
process.env.EMAIL_TRANSPORT = 'disabled';

const { server } = require('../server/index');
let base;

function makeClient() {
  let cookie = null;
  return {
    async call(method, url, body) {
      const headers = { 'X-Requested-With': 'fetch' };
      if (cookie) headers.Cookie = cookie;
      let payload;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers, body: payload });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      return { status: res.status, data };
    },
    get(u) { return this.call('GET', u); },
    post(u, b) { return this.call('POST', u, b); },
    patch(u, b) { return this.call('PATCH', u, b); },
    del(u) { return this.call('DELETE', u); },
  };
}

const admin = makeClient();
let meta;

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  await admin.post('/api/auth/login', { email: 'admin@test.local', password: 'admin-test-1234' });
  meta = (await admin.get('/api/settings/meta')).data;
});

after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const typeByKey = (k) => meta.application_types.find((t) => t.key === k);

async function createClient({ first, last, email, typeKey, employment, checklist, fthb }) {
  const res = await admin.post('/api/broker/clients', {
    client: { first_name: first, last_name: last, email, employment_type: employment },
    application: { application_type_id: typeByKey(typeKey).id, fthb: !!fthb },
    checklist,
    ignore_duplicates: true,
  });
  assert.strictEqual(res.status, 200, `client ${first} created: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function checklistNames(fileId) {
  const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
  return docs.data.requests.map((r) => r.document_name);
}

// ---------------------------------------------------------------------------

test('employment statuses are configurable data, not hard-coded', async () => {
  assert.ok(meta.employment_statuses.length >= 5, 'seeded employment statuses');
  const keys = meta.employment_statuses.map((s) => s.key);
  for (const expected of ['employee', 'self_employed', 'corporation_owner', 'commissioned', 'contract_worker', 'retired']) {
    assert.ok(keys.includes(expected), `employment status ${expected} available`);
  }

  // Admin can add, rename, disable and reorder.
  const added = await admin.post('/api/settings/employment-statuses', { name: 'Gig Worker', key: 'gig_worker' });
  assert.strictEqual(added.status, 200);
  assert.strictEqual((await admin.patch(`/api/settings/employment-statuses/${added.data.id}`, { name: 'Gig / Platform Worker' })).status, 200);
  assert.strictEqual((await admin.patch(`/api/settings/employment-statuses/${added.data.id}`, { active: false })).status, 200);
  const after = (await admin.get('/api/settings/meta')).data.employment_statuses;
  const gig = after.find((s) => s.key === 'gig_worker');
  assert.strictEqual(gig.name, 'Gig / Platform Worker');
  assert.strictEqual(gig.active, 0);

  const ids = after.slice(0, 3).map((s) => s.id).reverse();
  assert.strictEqual((await admin.post('/api/settings/employment-statuses/reorder', { ids })).status, 200);
});

test('wizard step 3: service + employment produces the right default checklist', async () => {
  const cases = [
    ['purchase', 'employee', ['Government ID', 'T4', 'Recent Pay Stub', 'Employment Letter', 'Notice of Assessment', 'Purchase Agreement', 'Down Payment Verification']],
    ['purchase', 'self_employed', ['Government ID', 'T1 General', 'Notice of Assessment', 'Business Financial Statements', 'Purchase Agreement']],
    ['refinance', 'employee', ['Government ID', 'T4', 'Existing Mortgage Statement', 'Property Tax Bill']],
    ['builder_purchase', 'employee', ['Government ID', 'T4', 'Purchase Agreement']],
    ['business_loan', 'self_employed', ['Government ID', 'Articles of Incorporation', 'Business Financial Statements']],
  ];

  for (const [typeKey, employment, expected] of cases) {
    const res = await admin.get(
      `/api/broker/checklist-preview?application_type_id=${typeByKey(typeKey).id}&employment_type=${employment}`
    );
    assert.strictEqual(res.status, 200);
    const names = res.data.documents.map((d) => d.document_name);
    for (const doc of expected) {
      assert.ok(names.includes(doc), `${typeKey} + ${employment} → expected "${doc}", got: ${names.join(', ')}`);
    }
  }

  // A preview never writes anything.
  const before = (await admin.get('/api/settings/rules')).data.rules.length;
  await admin.get(`/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`);
  assert.strictEqual((await admin.get('/api/settings/rules')).data.rules.length, before, 'preview did not modify rules');
});

test('first-time-buyer condition combines with service + employment', async () => {
  const plain = await admin.get(
    `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`
  );
  const fthb = await admin.get(
    `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee&fthb=1`
  );
  const plainNames = plain.data.documents.map((d) => d.document_name);
  const fthbNames = fthb.data.documents.map((d) => d.document_name);
  assert.ok(!plainNames.includes('Gift Letter'));
  assert.ok(fthbNames.includes('Gift Letter'), 'FTHB rule adds its documents on top');
});

test('broker customizations at creation apply to this client only', async () => {
  // Preview the defaults, then drop Employment Letter and add Bank Statements.
  const preview = await admin.get(
    `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`
  );
  const bankStatements = meta.document_types.find((d) => d.name === 'Bank Statements');
  const customized = preview.data.documents
    .filter((d) => d.document_name !== 'Employment Letter')
    .map((d) => ({ document_type_id: d.document_type_id, requirement: d.requirement }))
    .concat([{ document_type_id: bankStatements.id, requirement: 'required', instructions: 'Last 12 months, please.' }]);

  const john = await createClient({
    first: 'John', last: 'Smith', email: 'john.custom@test.local',
    typeKey: 'purchase', employment: 'employee', checklist: customized,
  });

  const johnDocs = await checklistNames(john.file.id);
  assert.ok(!johnDocs.includes('Employment Letter'), 'removed document is absent for John');
  assert.ok(johnDocs.includes('Bank Statements'), 'added document is present for John');
  assert.ok(johnDocs.includes('T4'), 'untouched defaults survive');

  // The instruction the broker typed reached the client's checklist.
  const docs = await admin.get(`/api/broker/files/${john.file.id}/documents`);
  const bank = docs.data.requests.find((r) => r.document_name === 'Bank Statements');
  assert.strictEqual(bank.client_message, 'Last 12 months, please.');

  // A second client with the SAME service + employment still gets the full
  // default list — the global rule was never modified.
  const sarah = await createClient({
    first: 'Sarah', last: 'Jones', email: 'sarah.default@test.local',
    typeKey: 'purchase', employment: 'employee',
  });
  const sarahDocs = await checklistNames(sarah.file.id);
  assert.ok(sarahDocs.includes('Employment Letter'), "Sarah still gets the global default John opted out of");
  assert.ok(!sarahDocs.includes('Bank Statements'), "Sarah does not inherit John's custom addition");
});

test('removing a document post-creation sticks across rule re-sync', async () => {
  const client = await createClient({
    first: 'Dana', last: 'Lee', email: 'dana@test.local',
    typeKey: 'purchase', employment: 'employee',
  });
  const fileId = client.file.id;

  const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
  const t4 = docs.data.requests.find((r) => r.document_name === 'T4');
  assert.ok(t4);
  assert.strictEqual((await admin.del(`/api/broker/requests/${t4.id}`)).status, 200);
  assert.ok(!(await checklistNames(fileId)).includes('T4'), 'T4 removed');

  // Any edit re-runs the rule engine — the removal must survive it.
  assert.strictEqual((await admin.patch(`/api/broker/files/${fileId}`, { purchase_price: 900000 })).status, 200);
  assert.ok(!(await checklistNames(fileId)).includes('T4'), 'T4 stays removed after re-sync');

  // It is listed as an exclusion, and can be restored deliberately.
  const exclusions = await admin.get(`/api/broker/files/${fileId}/checklist/exclusions`);
  assert.ok(exclusions.data.exclusions.some((e) => e.document_name === 'T4'), 'removal is recorded');

  const restore = await admin.post(`/api/broker/files/${fileId}/checklist/restore`, {
    document_type_id: t4.document_type_id,
  });
  assert.strictEqual(restore.status, 200);
  assert.ok((await checklistNames(fileId)).includes('T4'), 'restored on request');

  // And a brand-new client is unaffected throughout.
  const other = await createClient({
    first: 'Evan', last: 'Ng', email: 'evan@test.local',
    typeKey: 'purchase', employment: 'employee',
  });
  assert.ok((await checklistNames(other.file.id)).includes('T4'), 'global default unchanged');
});

test('the client only ever sees their own final checklist', async () => {
  const preview = await admin.get(
    `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`
  );
  const trimmed = preview.data.documents
    .filter((d) => !['Employment Letter', 'MLS Listing'].includes(d.document_name))
    .map((d) => ({ document_type_id: d.document_type_id, requirement: d.requirement }));

  const created = await createClient({
    first: 'Priya', last: 'Shah', email: 'priya@test.local',
    typeKey: 'purchase', employment: 'employee', checklist: trimmed,
  });
  const creds = created.invites.find((i) => i.temporary_password);

  const client = makeClient();
  await client.post('/api/auth/login', { email: creds.username, password: creds.temporary_password });
  await client.post('/api/auth/change-password', {
    current_password: creds.temporary_password, new_password: 'PriyaPass123',
  });
  const docs = await client.get(`/api/client/files/${created.file.id}/documents`);
  const names = docs.data.requests.map((r) => r.document_name);
  assert.ok(!names.includes('Employment Letter'), 'client does not see the removed document');
  assert.ok(names.includes('T4'), 'client sees what remains');
});

test('document catalog is admin-managed and searchable', async () => {
  const created = await admin.post('/api/settings/document-types', {
    name: 'Two Pieces of ID', category: 'identity',
    description: 'Health cards are not accepted.',
    default_requirement: 'required',
  });
  assert.strictEqual(created.status, 200);

  const search = await admin.get('/api/settings/document-types/search?q=bank');
  assert.strictEqual(search.status, 200);
  assert.ok(search.data.document_types.length > 0);
  assert.ok(
    search.data.document_types.every((d) => /bank/i.test(d.name) || /bank/i.test(d.category || '')),
    'search filters by name/category'
  );

  const updated = await admin.patch(`/api/settings/document-types/${created.data.id}`, {
    description: 'Two pieces of government-issued ID. Health cards are not accepted.',
  });
  assert.strictEqual(updated.status, 200);
  const all = (await admin.get('/api/settings/meta')).data.document_types;
  const twoId = all.find((d) => d.id === created.data.id);
  assert.match(twoId.description, /Health cards are not accepted/);
});

test('welcome template is editable, previewable and resettable', async () => {
  const templates = await admin.get('/api/settings/templates');
  const welcome = templates.data.templates.find((t) => t.key === 'welcome');
  assert.ok(welcome.body.includes('{{username}}'), 'default carries the username placeholder');
  assert.ok(welcome.body.includes('{{temporary_password}}'), 'default carries the temporary password placeholder');

  const preview = await admin.post('/api/settings/templates/preview', {
    subject: 'Welcome to {{brokerage_name}}',
    body: 'Hi {{client_first_name}}, your username is {{username}} and password {{temporary_password}}. File {{application_number}}, service {{service_type}}.',
  });
  assert.strictEqual(preview.status, 200);
  assert.ok(!preview.data.preview.body.includes('{{'), 'all placeholders resolved in preview');
  assert.match(preview.data.preview.body, /MTG-\d{4}-\d{5}/, 'application number sample rendered');

  const edited = await admin.patch('/api/settings/templates/welcome', {
    subject: 'Custom subject for {{client_first_name}}',
    body: 'Custom body {{username}} / {{temporary_password}}',
  });
  assert.strictEqual(edited.status, 200);

  const reset = await admin.post('/api/settings/templates/welcome/reset', {});
  assert.strictEqual(reset.status, 200);
  assert.strictEqual(reset.data.template.body, welcome.body, 'reset restores the shipped default');
  assert.strictEqual(reset.data.template.subject, welcome.subject);
});

test('auto-send can be turned off without breaking account creation', async () => {
  await admin.post('/api/settings/config/notifications', {}); // ensure key exists
  const put = await admin.call('PUT', '/api/settings/config/notifications', {
    value: { auto_send_welcome: false },
  });
  assert.strictEqual(put.status, 200);

  const created = await createClient({
    first: 'Quiet', last: 'Client', email: 'quiet@test.local',
    typeKey: 'purchase', employment: 'employee',
  });
  const invite = created.invites.find((i) => i.temporary_password);
  assert.ok(invite, 'credentials still generated');
  assert.strictEqual(invite.emailed, false, 'no email sent when auto-send is off');

  const emails = await admin.get(`/api/broker/files/${created.file.id}/emails`);
  assert.ok(!emails.data.emails.some((e) => e.template_key === 'welcome'), 'no welcome email recorded');

  // The client can still sign in with the generated temporary password.
  const client = makeClient();
  const login = await client.post('/api/auth/login', {
    email: invite.username, password: invite.temporary_password,
  });
  assert.strictEqual(login.status, 200);

  await admin.call('PUT', '/api/settings/config/notifications', { value: { auto_send_welcome: true } });
});
