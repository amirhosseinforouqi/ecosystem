'use strict';

/**
 * Minimal S3-compatible object storage client.
 *
 * Serverless platforms give every invocation a fresh, empty filesystem, so a
 * document written to local disk on one request is simply gone on the next.
 * With `STORAGE_BACKEND=s3` the encrypted blobs live in an object store
 * instead — Supabase Storage, Cloudflare R2, MinIO, or S3 itself.
 *
 * Implemented directly against the REST API with AWS Signature V4, so this
 * adds no dependency. Only the five operations the application actually needs
 * are here: put, get, head, delete and list.
 *
 * Documents are already encrypted before they reach this layer; the object
 * store never sees plaintext, which is what makes a third-party bucket an
 * acceptable place to keep them.
 */

const crypto = require('node:crypto');

const SERVICE = 's3';

function config() {
  return {
    endpoint: (process.env.S3_ENDPOINT || '').replace(/\/$/, ''),
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    prefix: (process.env.S3_PREFIX || 'documents').replace(/^\/+|\/+$/g, ''),
    // Supabase, MinIO and R2 all address buckets as a path segment rather
    // than a subdomain.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  };
}

function isConfigured() {
  const c = config();
  return !!(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new Error(
      'STORAGE_BACKEND=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.'
    );
  }
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Percent-encode a path segment per SigV4 rules (slashes preserved by caller). */
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function objectPath(key) {
  const c = config();
  const full = [c.prefix, key].filter(Boolean).join('/');
  const encoded = full.split('/').map(uriEncode).join('/');
  return c.forcePathStyle ? `/${uriEncode(c.bucket)}/${encoded}` : `/${encoded}`;
}

/**
 * Sign and send one request. `body` is a Buffer (possibly empty); responses
 * are buffered, which is appropriate for documents that are already capped at
 * a few tens of megabytes.
 */
async function send(method, canonicalPath, { body = Buffer.alloc(0), query = {}, headers = {} } = {}) {
  assertConfigured();
  const c = config();
  const url = new URL(c.endpoint + canonicalPath);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const signed = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };
  const signedHeaderNames = Object.keys(signed).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${String(signed[k]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${c.region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');

  let key = hmac(`AWS4${c.secretAccessKey}`, dateStamp);
  key = hmac(key, c.region);
  key = hmac(key, SERVICE);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: { ...signed, Authorization: authorization },
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes };
}

async function putObject(key, bytes, contentType = 'application/octet-stream') {
  const res = await send('PUT', objectPath(key), {
    body: bytes,
    headers: { 'content-type': contentType, 'content-length': String(bytes.length) },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Object store rejected the upload (${res.status}): ${res.bytes.toString('utf8').slice(0, 200)}`);
  }
  return { key, size: bytes.length };
}

async function getObject(key) {
  const res = await send('GET', objectPath(key));
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Object store read failed (${res.status}): ${res.bytes.toString('utf8').slice(0, 200)}`);
  }
  return res.bytes;
}

async function headObject(key) {
  const res = await send('HEAD', objectPath(key));
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new Error(`Object store head failed (${res.status}).`);
  return { size: Number(res.headers.get('content-length') || 0) };
}

async function deleteObject(key) {
  const res = await send('DELETE', objectPath(key));
  // A delete of something already gone is a success, not an error.
  return res.status === 204 || res.status === 200 || res.status === 404;
}

/** List every object under the prefix. Follows continuation tokens. */
async function listObjects() {
  const c = config();
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix: c.prefix ? `${c.prefix}/` : '' };
    if (token) query['continuation-token'] = token;
    const res = await send('GET', c.forcePathStyle ? `/${uriEncode(c.bucket)}` : '/', { query });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Object store list failed (${res.status}).`);
    }
    const xml = res.bytes.toString('utf8');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = (m[1].match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
      const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      if (key) out.push({ key: c.prefix ? key.slice(c.prefix.length + 1) : key, size });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated ? (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] : null;
  } while (token);
  return out;
}

module.exports = {
  isConfigured, assertConfigured, config,
  putObject, getObject, headObject, deleteObject, listObjects,
};
