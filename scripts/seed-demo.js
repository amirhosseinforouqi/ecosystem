'use strict';

/**
 * Seeds a demo dataset so the portals have something to show.
 * Run:  npm run seed:demo
 * Then: npm start  and sign in as the printed accounts.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
process.env.EMAIL_TRANSPORT = 'disabled';

const { server } = require('../server/index');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  let cookie = null;

  async function call(method, url, body, raw, filename) {
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data.message}`);
    return data;
  }

  const login = await call('POST', '/api/auth/login', {
    email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
  }).catch(() => null);
  if (!login) {
    console.error('Could not sign in as admin. If this is not a fresh database, set ADMIN_EMAIL/ADMIN_PASSWORD.');
    process.exit(1);
  }

  const meta = await call('GET', '/api/settings/meta');
  const typeByKey = (k) => meta.application_types.find((t) => t.key === k);
  const stageByKey = (k) => meta.stages.find((s) => s.key === k);
  const existing = await call('GET', '/api/broker/clients?status=all');
  if (existing.total > 0) {
    console.log('Database already has clients — demo seed skipped.');
    server.close();
    return;
  }

  console.log('Seeding demo data…');
  const clientPassword = 'Demo1234pass';
  const activate = async (link) => {
    const token = new URL(link).searchParams.get('token');
    const saved = cookie;
    cookie = null;
    await call('POST', '/api/auth/activate', { token, password: clientPassword });
    const clientCookie = cookie;
    cookie = saved;
    return clientCookie;
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
  const johnCookie = await activate(john.invites[0].activation_link);
  const johnDocs = await call('GET', `/api/broker/files/${john.file.id}/documents`);
  const johnReq = (n) => johnDocs.requests.find((r) => r.document_name === n);

  // Client uploads a few documents.
  const asJohn = async (method, url, body, raw, filename) => {
    const saved = cookie;
    cookie = johnCookie;
    const out = await call(method, url, body, raw, filename);
    cookie = saved;
    return out;
  };
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
  await activate(sarah.invites[0].activation_link);
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
  await activate(david.invites[0].activation_link);
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
  console.log(`  Broker portal (/broker):  ${process.env.ADMIN_EMAIL} / ${process.env.ADMIN_PASSWORD}`);
  console.log(`  Client portal (/portal):  john.demo@example.com / ${clientPassword}`);
  console.log(`                            sarah.demo@example.com / ${clientPassword}`);
  console.log(`                            david.demo@example.com / ${clientPassword}`);
  console.log('----------------------------------------------------------');
  server.close();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
