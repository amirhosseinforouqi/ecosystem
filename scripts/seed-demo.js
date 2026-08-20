'use strict';

/**
 * Seeds a demo dataset so the portals have something to show.
 *
 * Run:  npm run seed:demo
 * Then: npm start, and sign in with the accounts printed at the end.
 *
 * Demo data is never seeded into a production database, and this script
 * invents no administrator credentials — ADMIN_EMAIL/ADMIN_PASSWORD must come
 * from the environment (audit finding C4). Client portal passwords are
 * generated randomly and printed once.
 */

const demo = require('./demo-lib');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
demo.guardEnvironment('seed demo data');
process.env.EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT || 'disabled';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');

async function main() {
  const { server, base } = await demo.start();
  const admin = await demo.signInAdmin(base);
  const call = (method, url, body, raw, filename) =>
    admin.call(method, url, raw !== undefined ? { raw, filename } : { body });

  const meta = await call('GET', '/api/settings/meta');
  const typeByKey = (k) => meta.application_types.find((t) => t.key === k);
  const stageByKey = (k) => meta.stages.find((s) => s.key === k);
  const existing = await call('GET', '/api/broker/clients?status=all');
  if (existing.total > 0) {
    console.log('Database already has clients — demo seed skipped.');
    server.close();
    await require('../server/db').close();
    return;
  }

  console.log('Seeding demo data…');
  const clientPassword = process.env.DEMO_CLIENT_PASSWORD
    || `Portal-${require('../server/auth').generateTemporaryPassword()}`;
  /**
   * Take a freshly created portal account through its first sign-in: the
   * temporary password is single-use, exactly as it is for a real client.
   * Returns a client bound to that portal user.
   */
  const activate = async (invite) => {
    const portal = demo.makeClient(base);
    await portal.post('/api/auth/login', { email: invite.username, password: invite.temporary_password });
    await portal.post('/api/auth/change-password', {
      current_password: invite.temporary_password, new_password: clientPassword,
    });
    return portal;
  };

  // --- John Smith: mid-flight purchase with documents in every state -------
  const john = await call('POST', '/api/broker/clients', {
    client: {
      first_name: 'John', last_name: 'Smith', email: 'john.demo@example.com',
      phone: '416-555-0101', employment_type: 'employee', employer_name: 'Acme Manufacturing',
      job_title: 'Operations Manager', address: '25 King St W, Toronto, ON',
    },
    application: {
      application_type_id: typeByKey('purchase').id, purchase_price: 800000, down_payment: 160000,
      mortgage_amount: 640000, property_address: '18 Maplewood Ave, Toronto, ON',
      property_type: 'Detached', closing_date: new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10),
    },
  });
  const johnPortal = await activate(john.invites[0]);
  const johnDocs = await call('GET', `/api/broker/files/${john.file.id}/documents`);
  const johnReq = (n) => johnDocs.requests.find((r) => r.document_name === n);

  // Client uploads a few documents.
  const asJohn = (method, url, body, raw, filename) =>
    johnPortal.call(method, url, raw !== undefined ? { raw, filename } : { body });

  for (const n of ['T4', 'Recent Pay Stub', 'Employment Letter']) {
    await asJohn('POST', `/api/client/requests/${johnReq(n).id}/upload`, undefined, PDF, `${n.replace(/ /g, '_')}.pdf`);
  }
  await call('POST', `/api/broker/requests/${johnReq('T4').id}/review`, { action: 'approve', send_email: false });
  await call('POST', `/api/broker/requests/${johnReq('Recent Pay Stub').id}/review`, {
    action: 'request_replacement', client_note: 'Please upload your most recent pay stub — this one is from March.', send_email: false,
  });
  await asJohn('POST', `/api/client/files/${john.file.id}/messages`, { body: 'Hi! Just uploaded my documents. Do you need anything else from me?' });
  await call('POST', `/api/broker/files/${john.file.id}/stage`, { stage_id: stageByKey('docs_requested').id });
  await call('POST', `/api/broker/files/${john.file.id}/notes`, { body: 'Client prefers email. Waiting on updated pay stub — employer runs payroll on Fridays.', pinned: true });

  // --- Sarah & Michael Brown: refinance couple ----------------------------
  const sarah = await call('POST', '/api/broker/clients', {
    client: {
      first_name: 'Sarah', last_name: 'Brown', email: 'sarah.demo@example.com',
      phone: '905-555-0102', employment_type: 'self_employed', employer_name: 'Brown Design Studio',
    },
    application: {
      application_type_id: typeByKey('refinance').id, mortgage_amount: 450000,
      property_address: '9 Lakeshore Rd, Oakville, ON', property_type: 'Semi-detached',
    },
    co_applicants: [{
      role: 'spouse', first_name: 'Michael', last_name: 'Brown',
      email: 'michael.demo@example.com', employment_type: 'employee', employer_name: 'Halton School Board',
    }],
  });
  await activate(sarah.invites[0]);
  await call('POST', `/api/broker/files/${sarah.file.id}/stage`, { stage_id: stageByKey('application_started').id });
  const today = new Date().toISOString().slice(0, 10);
  await call('POST', '/api/broker/tasks', {
    file_id: sarah.file.id, title: 'Call Sarah about business financials', due_date: today, priority: 'high',
  });

  // --- David Lee: submitted, waiting on lender ----------------------------
  const david = await call('POST', '/api/broker/clients', {
    client: {
      first_name: 'David', last_name: 'Lee', email: 'david.demo@example.com',
      phone: '647-555-0103', employment_type: 'employee', employer_name: 'City of Toronto',
    },
    application: {
      application_type_id: typeByKey('fthb').id, purchase_price: 615000, down_payment: 61500,
      mortgage_amount: 553500, fthb: true, property_address: '77 College Park Dr, Unit 1204, Toronto, ON',
      property_type: 'Condo', closing_date: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
    },
    send_welcome: true,
  });
  await activate(david.invites[0]);
  const davidDocs = await call('GET', `/api/broker/files/${david.file.id}/documents`);
  for (const r of davidDocs.requests.filter((x) => x.requirement === 'required')) {
    await call('POST', `/api/broker/requests/${r.id}/upload`, undefined, PDF, `${r.document_name.replace(/ /g, '_')}.pdf`);
    await call('POST', `/api/broker/requests/${r.id}/review`, { action: 'approve', send_email: false });
  }
  await call('POST', `/api/broker/files/${david.file.id}/stage`, { stage_id: stageByKey('submitted').id });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await call('POST', '/api/broker/tasks', {
    file_id: david.file.id, title: 'Follow up with lender on David Lee submission', due_date: tomorrow,
  });

  console.log('----------------------------------------------------------');
  console.log('Demo data ready. Accounts:');
  console.log(`  Broker portal (/broker):  ${admin.email} / ${admin.password}`);
  console.log('    (plus the two-step code from the authenticator entry printed above)');
  console.log(`  Client portal (/portal):  john.demo@example.com / ${clientPassword}`);
  console.log(`                            sarah.demo@example.com / ${clientPassword}`);
  console.log(`                            david.demo@example.com / ${clientPassword}`);
  console.log('----------------------------------------------------------');
  server.close();
  await require('../server/db').close();
}

main().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await require('../server/db').close().catch(() => {});
  process.exit(1);
});
