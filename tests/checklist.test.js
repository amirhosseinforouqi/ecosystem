'use strict';

/**
 * The document requirement engine, and the strict separation between its
 * three layers:
 *
 *   catalog  → document_types      (what kinds of document exist)
 *   rules    → document_rules      (the brokerage's global defaults)
 *   client   → document_requests   (one client's actual checklist)
 *
 * The property that matters most, and that these tests pin down: editing one
 * client's checklist never changes the defaults for anybody else.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');

let ctx;
let admin;
let meta;

const typeByKey = (key) => meta.application_types.find((t) => t.key === key);

async function createClient({ first, last, email, typeKey, employment, checklist, fthb = false }) {
  const res = await admin.post('/api/broker/clients', {
    client: { first_name: first, last_name: last, email, employment_type: employment },
    application: { application_type_id: typeByKey(typeKey).id, fthb },
    checklist,
    ignore_duplicates: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

async function checklistNames(fileId) {
  const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
  return docs.data.requests.map((r) => r.document_name);
}

before(async () => {
  ctx = await helpers.startTestServer('checklist');
  admin = await helpers.signInAdmin(ctx.base);
  meta = (await admin.get('/api/settings/meta')).data;
});

after(async () => { if (ctx) await ctx.stop(); });

// ---------------------------------------------------------------------------

describe('configuration is data, not code', () => {
  test('employment statuses are seeded and editable', async () => {
    const keys = meta.employment_statuses.map((s) => s.key);
    for (const expected of ['employee', 'self_employed', 'corporation_owner', 'commissioned', 'contract_worker', 'retired']) {
      assert.ok(keys.includes(expected), `employment status ${expected} available`);
    }

    const added = await admin.post('/api/settings/employment-statuses', { name: 'Gig Worker', key: 'gig_worker' });
    assert.equal(added.status, 200);
    assert.equal((await admin.patch(`/api/settings/employment-statuses/${added.data.id}`, { name: 'Gig / Platform Worker' })).status, 200);
    assert.equal((await admin.patch(`/api/settings/employment-statuses/${added.data.id}`, { active: false })).status, 200);

    const after = (await admin.get('/api/settings/meta')).data.employment_statuses;
    const gig = after.find((s) => s.key === 'gig_worker');
    assert.equal(gig.name, 'Gig / Platform Worker');
    assert.equal(gig.active, 0);

    const ids = after.slice(0, 3).map((s) => s.id).reverse();
    assert.equal((await admin.post('/api/settings/employment-statuses/reorder', { ids })).status, 200);
    const reordered = (await admin.get('/api/settings/meta')).data.employment_statuses;
    assert.deepEqual(reordered.slice(0, 3).map((s) => s.id), ids);
  });

  test('the document catalog is admin-managed and searchable', async () => {
    const created = await admin.post('/api/settings/document-types', {
      name: 'Two Pieces of ID', category: 'identity',
      description: 'Health cards are not accepted.',
      default_requirement: 'required',
    });
    assert.equal(created.status, 200);

    const search = await admin.get('/api/settings/document-types/search?q=bank');
    assert.equal(search.status, 200);
    assert.ok(search.data.document_types.length > 0);
    assert.ok(
      search.data.document_types.every((d) => /bank/i.test(d.name) || /bank/i.test(d.category || '')),
      'search filters by name or category, in SQL'
    );

    const updated = await admin.patch(`/api/settings/document-types/${created.data.id}`, {
      description: 'Two pieces of government-issued ID. Health cards are not accepted.',
    });
    assert.equal(updated.status, 200);
    const all = (await admin.get('/api/settings/meta')).data.document_types;
    assert.match(all.find((d) => d.id === created.data.id).description, /Health cards are not accepted/);
  });

  test('the frontend is never the source of truth for the document list', async () => {
    // Everything the wizard offers comes from the API.
    const catalog = await admin.get('/api/settings/document-types/search');
    assert.ok(catalog.data.document_types.length > 5);
    const preview = await admin.get(
      `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`
    );
    assert.ok(preview.data.documents.length > 0);
    for (const doc of preview.data.documents) {
      assert.equal(typeof doc.document_type_id, 'number');
      assert.equal(typeof doc.document_name, 'string');
    }
  });
});

describe('the rule engine (layer 2)', () => {
  test('service + employment produces the right default checklist', async () => {
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
      assert.equal(res.status, 200);
      const names = res.data.documents.map((d) => d.document_name);
      for (const doc of expected) {
        assert.ok(names.includes(doc), `${typeKey} + ${employment} → expected "${doc}", got: ${names.join(', ')}`);
      }
    }
  });

  test('previewing writes nothing', async () => {
    const rulesBefore = (await admin.get('/api/settings/rules')).data.rules.length;
    const requestsBefore = await require('../server/db').get('SELECT COUNT(*)::int AS n FROM document_requests');
    await admin.get(`/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`);
    const rulesAfter = (await admin.get('/api/settings/rules')).data.rules.length;
    const requestsAfter = await require('../server/db').get('SELECT COUNT(*)::int AS n FROM document_requests');
    assert.equal(rulesAfter, rulesBefore);
    assert.equal(requestsAfter.n, requestsBefore.n);
  });

  test('the first-time-buyer condition combines with service and employment', async () => {
    const plain = await admin.get(
      `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`
    );
    const fthb = await admin.get(
      `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee&fthb=1`
    );
    assert.ok(!plain.data.documents.map((d) => d.document_name).includes('Gift Letter'));
    assert.ok(fthb.data.documents.map((d) => d.document_name).includes('Gift Letter'));
  });

  test('a brokerage can edit its own rules', async () => {
    const rules = (await admin.get('/api/settings/rules')).data.rules;
    const target = rules.find((r) => r.items.length > 0);
    const created = await admin.post('/api/settings/rules', {
      name: 'Test rule — commissioned income',
      conditions: { employment_types: ['other'] },
      items: [{ document_type_id: target.items[0].document_type_id, requirement: 'optional' }],
    });
    assert.equal(created.status, 200);
    const after = (await admin.get('/api/settings/rules')).data.rules;
    assert.ok(after.some((r) => r.id === created.data.id));
    assert.equal((await admin.del(`/api/settings/rules/${created.data.id}`)).status, 200);
  });
});

describe('one client\'s checklist is theirs alone (layer 3)', () => {
  test('customizations made in the wizard apply to that client only', async () => {
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
    assert.ok(!johnDocs.includes('Employment Letter'), 'the removed document is absent for John');
    assert.ok(johnDocs.includes('Bank Statements'), 'the added document is present for John');
    assert.ok(johnDocs.includes('T4'), 'untouched defaults survive');

    const docs = await admin.get(`/api/broker/files/${john.file.id}/documents`);
    assert.equal(
      docs.data.requests.find((r) => r.document_name === 'Bank Statements').client_message,
      'Last 12 months, please.'
    );

    const sarah = await createClient({
      first: 'Sarah', last: 'Jones', email: 'sarah.default@test.local',
      typeKey: 'purchase', employment: 'employee',
    });
    const sarahDocs = await checklistNames(sarah.file.id);
    assert.ok(sarahDocs.includes('Employment Letter'), 'Sarah still gets the global default John opted out of');
    assert.ok(!sarahDocs.includes('Bank Statements'), 'Sarah does not inherit John\'s custom addition');
  });

  test('the global rules themselves are never touched by a client edit', async () => {
    const preview = await admin.get(
      `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`
    );
    assert.ok(
      preview.data.documents.map((d) => d.document_name).includes('Employment Letter'),
      'the brokerage default is unchanged after a per-client removal'
    );
  });

  test('removing a document after creation survives a rule re-sync', async () => {
    const client = await createClient({
      first: 'Dana', last: 'Lee', email: 'dana@test.local',
      typeKey: 'purchase', employment: 'employee',
    });
    const fileId = client.file.id;

    const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
    const t4 = docs.data.requests.find((r) => r.document_name === 'T4');
    assert.ok(t4);
    assert.equal((await admin.del(`/api/broker/requests/${t4.id}`)).status, 200);
    assert.ok(!(await checklistNames(fileId)).includes('T4'), 'T4 removed');

    // Any edit re-runs the rule engine — the removal must survive it.
    assert.equal((await admin.patch(`/api/broker/files/${fileId}`, { purchase_price: 900000 })).status, 200);
    assert.ok(!(await checklistNames(fileId)).includes('T4'), 'T4 stays removed after re-sync');

    const exclusions = await admin.get(`/api/broker/files/${fileId}/checklist/exclusions`);
    assert.ok(exclusions.data.exclusions.some((e) => e.document_name === 'T4'), 'the removal is recorded and visible');

    const restore = await admin.post(`/api/broker/files/${fileId}/checklist/restore`, {
      document_type_id: t4.document_type_id,
    });
    assert.equal(restore.status, 200);
    assert.ok((await checklistNames(fileId)).includes('T4'), 'and can be restored deliberately');

    const other = await createClient({
      first: 'Evan', last: 'Ng', email: 'evan@test.local',
      typeKey: 'purchase', employment: 'employee',
    });
    assert.ok((await checklistNames(other.file.id)).includes('T4'), 'the global default was unaffected throughout');
  });

  test('a document with uploads is waived rather than deleted', async () => {
    const created = await createClient({
      first: 'Wanda', last: 'Ives', email: 'wanda@test.local',
      typeKey: 'purchase', employment: 'employee',
    });
    const invite = created.invites.find((i) => i.temporary_password);
    const client = await helpers.signInFreshClient(
      ctx.base, invite.username, invite.temporary_password, 'Kestrel-Marble-Anchor-44'
    );
    const docs = await client.get(`/api/client/files/${created.file.id}/documents`);
    const target = docs.data.requests[0];
    await client.upload(`/api/client/requests/${target.id}/upload`, helpers.PDF, 'doc.pdf');

    const removed = await admin.del(`/api/broker/requests/${target.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.data.waived, true, 'history is preserved instead of destroyed');

    const brokerDocs = await admin.get(`/api/broker/files/${created.file.id}/documents`);
    const waived = brokerDocs.data.requests.find((r) => r.id === target.id);
    assert.equal(waived.status, 'waived');
    assert.equal(waived.versions.length, 1, 'the uploaded version is still on file');

    const clientDocs = await client.get(`/api/client/files/${created.file.id}/documents`);
    assert.ok(
      !clientDocs.data.requests.some((r) => r.id === target.id),
      'a waived item is not shown to the client as something to do'
    );
  });

  test('the client sees exactly their own final checklist', async () => {
    const preview = await admin.get(
      `/api/broker/checklist-preview?application_type_id=${typeByKey('purchase').id}&employment_type=employee`
    );
    const trimmed = preview.data.documents
      .filter((d) => !['Employment Letter', 'MLS Listing'].includes(d.document_name))
      .map((d) => ({ document_type_id: d.document_type_id, requirement: d.requirement }));

    const created = await createClient({
      first: 'Priya', last: 'Shah', email: 'priya.checklist@test.local',
      typeKey: 'purchase', employment: 'employee', checklist: trimmed,
    });
    const invite = created.invites.find((i) => i.temporary_password);
    const client = await helpers.signInFreshClient(
      ctx.base, invite.username, invite.temporary_password, 'Foxglove-Anchor-Ridge-19'
    );
    const names = (await client.get(`/api/client/files/${created.file.id}/documents`)).data.requests
      .map((r) => r.document_name);
    assert.ok(!names.includes('Employment Letter'), 'the client does not see the removed document');
    assert.ok(names.includes('T4'), 'the client sees what remains');
  });
});

describe('email templates', () => {
  test('the welcome template is editable, previewable and resettable', async () => {
    const templates = await admin.get('/api/settings/templates');
    const welcome = templates.data.templates.find((t) => t.key === 'welcome');
    assert.ok(welcome.body.includes('{{username}}'));
    assert.ok(welcome.body.includes('{{temporary_password}}'));

    const preview = await admin.post('/api/settings/templates/preview', {
      subject: 'Welcome to {{brokerage_name}}',
      body: 'Hi {{client_first_name}}, your username is {{username}} and password {{temporary_password}}. File {{application_number}}, service {{service_type}}.',
    });
    assert.equal(preview.status, 200);
    assert.ok(!preview.data.preview.body.includes('{{'), 'all placeholders resolve in the preview');
    assert.match(preview.data.preview.body, /MTG-\d{4}-\d{5}/);

    assert.equal((await admin.patch('/api/settings/templates/welcome', {
      subject: 'Custom subject for {{client_first_name}}',
      body: 'Custom body {{username}} / {{temporary_password}}',
    })).status, 200);

    const reset = await admin.post('/api/settings/templates/welcome/reset', {});
    assert.equal(reset.status, 200);
    assert.equal(reset.data.template.body, welcome.body, 'reset restores the shipped default');
    assert.equal(reset.data.template.subject, welcome.subject);
  });

  test('auto-send can be turned off without breaking account creation', async () => {
    const put = await admin.put('/api/settings/config/notifications', { value: { auto_send_welcome: false } });
    assert.equal(put.status, 200);

    const created = await createClient({
      first: 'Quiet', last: 'Client', email: 'quiet@test.local',
      typeKey: 'purchase', employment: 'employee',
    });
    const invite = created.invites.find((i) => i.temporary_password);
    assert.ok(invite, 'credentials are still generated');
    assert.equal(invite.emailed, false, 'no email is sent when auto-send is off');

    const emails = await admin.get(`/api/broker/files/${created.file.id}/emails`);
    assert.ok(!emails.data.emails.some((e) => e.template_key === 'welcome'));

    const client = helpers.makeClient(ctx.base);
    const login = await client.post('/api/auth/login', {
      email: invite.username, password: invite.temporary_password,
    });
    assert.equal(login.status, 200, 'the broker can still read the credentials out to the client');

    await admin.put('/api/settings/config/notifications', { value: { auto_send_welcome: true } });
  });
});

describe('settings validation (audit finding M11)', () => {
  test('a misspelled permission key is rejected, not silently stored', async () => {
    const res = await admin.put('/api/settings/config/role_permissions', {
      value: { broker: ['clients.view', 'documents.downlod'] },
    });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /documents\.downlod/);
  });

  test('an unknown role is rejected', async () => {
    const res = await admin.put('/api/settings/config/role_permissions', {
      value: { superuser: ['clients.view'] },
    });
    assert.equal(res.status, 400);
  });

  test('the administrator role cannot be stripped of settings access', async () => {
    const res = await admin.put('/api/settings/config/role_permissions', {
      value: { admin: ['clients.view'] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'admin_lockout');
  });

  test('out-of-range security values are rejected', async () => {
    assert.equal((await admin.put('/api/settings/config/security', { value: { lockout_threshold: 0 } })).status, 400);
    assert.equal((await admin.put('/api/settings/config/security', { value: { session_days_staff: 3650 } })).status, 400);
    assert.equal((await admin.put('/api/settings/config/security', { value: { min_password_length_staff: 4 } })).status, 400);
  });

  test('an unknown settings key is not writable at all', async () => {
    const res = await admin.put('/api/settings/config/anything_goes', { value: { x: 1 } });
    assert.equal(res.status, 404);
  });

  test('a valid change is stored and returned', async () => {
    const res = await admin.put('/api/settings/config/security', { value: { lockout_threshold: 6 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.value.lockout_threshold, 6);
    const read = await admin.get('/api/settings/config/security');
    assert.equal(read.data.value.lockout_threshold, 6);
  });
});
