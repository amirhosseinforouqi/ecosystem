'use strict';

/**
 * Document storage backends.
 *
 * The object-store path exists because a serverless platform's filesystem is
 * empty again on the next request, so "it worked locally" proves nothing.
 * These tests run the real client against a local server that speaks the S3
 * REST API and verifies AWS Signature V4 the way a real bucket does — a
 * request that would be rejected by S3 is rejected here too.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const helpers = require('./helpers');

const ACCESS_KEY = 'AKIATESTTESTTESTTEST';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const BUCKET = 'mortgage-documents';
const REGION = 'us-east-1';

const objects = new Map();      // key → Buffer
const requests = [];            // every request the client made
let s3;

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Recompute the signature exactly as S3 would, and reject a mismatch. */
function verifySignature(req, body) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if (!m) return { ok: false, reason: 'malformed Authorization header' };
  const [, accessKey, dateStamp, region, signedHeaders, signature] = m;
  if (accessKey !== ACCESS_KEY) return { ok: false, reason: 'unknown access key' };

  const url = new URL(req.url, `http://${req.headers.host}`);
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalHeaders = signedHeaders.split(';')
    .map((h) => `${h}:${String(req.headers[h] || '').trim()}\n`).join('');
  const payloadHash = req.headers['x-amz-content-sha256'];
  if (payloadHash !== sha256Hex(body)) return { ok: false, reason: 'payload hash mismatch' };

  const canonicalRequest = [
    req.method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  let key = hmac(`AWS4${SECRET_KEY}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, 's3');
  key = hmac(key, 'aws4_request');
  const expected = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return expected === signature ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

function startS3Mock() {
  s3 = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const check = verifySignature(req, body);
      requests.push({ method: req.method, url: req.url, signed: check.ok, reason: check.reason });
      if (!check.ok) {
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        return res.end(`<Error><Code>SignatureDoesNotMatch</Code><Message>${check.reason}</Message></Error>`);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const prefix = `/${BUCKET}/`;
      if (!url.pathname.startsWith(`/${BUCKET}`)) {
        res.writeHead(404); return res.end();
      }
      const key = decodeURIComponent(url.pathname.slice(prefix.length));

      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const wanted = url.searchParams.get('prefix') || '';
        const contents = [...objects.entries()]
          .filter(([k]) => k.startsWith(wanted))
          .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`)
          .join('');
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      if (req.method === 'PUT') {
        objects.set(key, body);
        res.writeHead(200, { ETag: `"${sha256Hex(body).slice(0, 32)}"` });
        return res.end();
      }
      if (req.method === 'GET') {
        const bytes = objects.get(key);
        if (!bytes) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
        res.writeHead(200, { 'Content-Length': bytes.length });
        return res.end(bytes);
      }
      if (req.method === 'HEAD') {
        const bytes = objects.get(key);
        if (!bytes) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Length': bytes.length });
        return res.end();
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((resolve) => s3.listen(0, '127.0.0.1', resolve));
}

let ctx;
let admin;
let client;
let fileId;
let versionId;

before(async () => {
  await startS3Mock();
  ctx = await helpers.startTestServer('storage', {
    STORAGE_BACKEND: 's3',
    S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`,
    S3_BUCKET: BUCKET,
    S3_REGION: REGION,
    S3_ACCESS_KEY_ID: ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: SECRET_KEY,
    S3_PREFIX: 'documents',
    S3_FORCE_PATH_STYLE: 'true',
  });
  admin = await helpers.signInAdmin(ctx.base);

  const created = await admin.post('/api/broker/clients', {
    client: { first_name: 'Omar', last_name: 'Haddad', email: 'omar@test.local', employment_type: 'employee' },
    application: { application_type_id: 1, purchase_price: 590000 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  fileId = created.data.file.id;
  const invite = created.data.invites[0];
  client = await helpers.signInFreshClient(ctx.base, invite.username, invite.temporary_password, 'Basalt-Meadow-Anchor-71');
});

after(async () => {
  if (s3) s3.close();
  if (ctx) await ctx.stop();
});

describe('object-store backend', () => {
  test('an upload lands in the bucket, not on local disk', async () => {
    const docs = await client.get(`/api/client/files/${fileId}/documents`);
    const target = docs.data.requests[0];
    const res = await client.upload(`/api/client/requests/${target.id}/upload`, helpers.PDF, 'id.pdf');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    versionId = res.data.request.current_version.id;

    assert.equal(objects.size, 1, 'exactly one object was written');
    const [key] = [...objects.keys()];
    assert.match(key, /^documents\/[0-9a-f]{32}\.pdf\.enc$/, 'stored under the configured prefix');

    const fs = require('node:fs');
    const path = require('node:path');
    const localDir = path.join(ctx.dataDir, 'uploads');
    const local = fs.existsSync(localDir) ? fs.readdirSync(localDir) : [];
    assert.deepEqual(local, [], 'nothing was written to the ephemeral filesystem');
  });

  test('every request to the store was correctly signed', () => {
    assert.ok(requests.length > 0);
    const bad = requests.filter((r) => !r.signed);
    assert.deepEqual(bad, [], 'a request S3 would reject is a request that fails in production');
  });

  test('what is stored is ciphertext, not the document', () => {
    const [bytes] = [...objects.values()];
    assert.ok(!bytes.includes(Buffer.from('%PDF')), 'the bucket never holds a readable client document');
    assert.notDeepEqual(bytes, helpers.PDF);
  });

  test('the document reads back byte-for-byte through the API', async () => {
    const res = await client.get(`/api/client/versions/${versionId}/file`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.bytes, helpers.PDF);
  });

  test('a missing object is a clean 404, not a crash', async () => {
    const db = require('../server/db');
    const version = await db.get('SELECT stored_name FROM document_versions WHERE id = ?', versionId);
    const key = `documents/${version.stored_name}`;
    const saved = objects.get(key);
    objects.delete(key);
    const res = await client.get(`/api/client/versions/${versionId}/file`);
    assert.equal(res.status, 404);
    objects.set(key, saved);
  });

  test('usage and listing come from the bucket', async () => {
    const storage = require('../server/storage');
    assert.equal(storage.backend(), 's3');
    assert.ok(await storage.usageBytes() > 0);
    const names = await storage.listStored();
    assert.equal(names.length, objects.size);
    assert.ok(names.every((n) => /\.enc$/.test(n)), 'names come back without the prefix');
  });

  test('backup and restore work against the object store too', async () => {
    const backup = require('../server/backup');
    const fsp = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'mortgage-s3-backup-'));

    const { manifest, dir } = await backup.createBackup(dest);
    assert.equal(manifest.documents, 1, 'the blob was pulled out of the bucket');
    assert.deepEqual(manifest.missing_documents, []);

    objects.clear();
    assert.equal((await client.get(`/api/client/versions/${versionId}/file`)).status, 404);

    await backup.restoreBackup(dir, { confirm: true });
    assert.equal(objects.size, 1, 'the blob was put back into the bucket');

    // Sessions live under the restored users, so everybody signs in again —
    // which is the correct outcome of a restore, not a failure of one.
    await helpers.clearRateLimits();
    const after = await helpers.signInFreshClient(
      ctx.base, client.email, client.password, client.password
    );
    const res = await after.get(`/api/client/versions/${versionId}/file`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.bytes, helpers.PDF);
    client = after;

    await fsp.rm(dest, { recursive: true, force: true });
  });

  test('a wrong secret key is rejected by the store, and surfaces as an error', async () => {
    const objectstore = require('../server/objectstore');
    const realSecret = process.env.S3_SECRET_ACCESS_KEY;
    process.env.S3_SECRET_ACCESS_KEY = 'not-the-right-secret-at-all';
    await assert.rejects(() => objectstore.putObject('probe.bin', Buffer.from('x')), /403|Signature/i);
    process.env.S3_SECRET_ACCESS_KEY = realSecret;
  });
});

describe('refusing an ephemeral filesystem', () => {
  test('the local backend will not start on a serverless platform', () => {
    const storage = require('../server/storage');
    const saved = { backend: process.env.STORAGE_BACKEND, vercel: process.env.VERCEL };
    process.env.STORAGE_BACKEND = 'local';
    process.env.VERCEL = '1';
    try {
      assert.throws(() => storage.assertBackendUsable(), /ephemeral/i);
    } finally {
      process.env.STORAGE_BACKEND = saved.backend;
      if (saved.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.vercel;
    }
  });

  test('the s3 backend refuses to start half-configured', () => {
    const storage = require('../server/storage');
    const saved = process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_SECRET_ACCESS_KEY;
    try {
      assert.throws(() => storage.assertBackendUsable(), /S3_SECRET_ACCESS_KEY/);
    } finally {
      process.env.S3_SECRET_ACCESS_KEY = saved;
    }
  });
});
