'use strict';

/**
 * Microsoft OneDrive / SharePoint document storage via Microsoft Graph.
 *
 * Uploaded documents are mirrored to the brokerage's own Microsoft storage in
 * the background; the encrypted local copy remains the working copy the app
 * serves. The database stores only metadata plus the Graph item id and path.
 *
 * Two drive targets are supported, selected by ONEDRIVE_TARGET:
 *   user       — the configured mailbox user's OneDrive for Business (default)
 *   sharepoint — a SharePoint document library (set SHAREPOINT_SITE_ID and,
 *                optionally, SHAREPOINT_DRIVE_ID)
 *
 * Folder structure per client file:
 *   {ONEDRIVE_ROOT}/{Client Name} - {FileNumber}/
 *     Identity/ Income/ Assets/ Property/ Mortgage/ Other/ AI Review/
 */

const { run, get, all } = require('./db');
const { now, fullName, parseJsonSafe } = require('./util');
const graph = require('./msgraph');

const SUBFOLDERS = ['Identity', 'Income', 'Assets', 'Property', 'Mortgage', 'Other', 'AI Review'];

const CATEGORY_FOLDER = {
  identity: 'Identity',
  credit: 'Other',
  income: 'Income',
  financial: 'Assets',
  property: 'Property',
  corporate: 'Other',
  other: 'Other',
};

const MAX_ATTEMPTS = 5;

function rootFolder() {
  return process.env.ONEDRIVE_ROOT || 'Mortgage Clients';
}

function isEnabled() {
  return graph.isConfigured();
}

/** Graph path prefix for the configured drive (OneDrive or SharePoint). */
function drivePath() {
  const target = (process.env.ONEDRIVE_TARGET || 'user').toLowerCase();
  if (target === 'sharepoint') {
    const site = process.env.SHAREPOINT_SITE_ID;
    if (!site) throw new Error('ONEDRIVE_TARGET=sharepoint requires SHAREPOINT_SITE_ID.');
    const driveId = process.env.SHAREPOINT_DRIVE_ID;
    return driveId
      ? `/drives/${encodeURIComponent(driveId)}`
      : `/sites/${encodeURIComponent(site)}/drive`;
  }
  return `/users/${encodeURIComponent(graph.config().mailbox)}/drive`;
}

function itemByPath(humanPath) {
  const encoded = humanPath.split('/').map(encodeURIComponent).join('/');
  return `${drivePath()}/root:/${encoded}`;
}

function sanitizeName(name) {
  return String(name).replace(/["*:<>?/\\|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function ensureFolder(humanPath) {
  const parts = humanPath.split('/');
  const name = parts.pop();
  const parent = parts.join('/');
  const endpoint = parent ? `${itemByPath(parent)}:/children` : `${drivePath()}/root/children`;
  try {
    return await graph.graphRequest('POST', endpoint, {
      body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
    });
  } catch (err) {
    if (/nameAlreadyExists|already exists/i.test(err.message)) {
      return graph.graphRequest('GET', itemByPath(humanPath));
    }
    throw err;
  }
}

/** Create the full client folder tree; returns { id, path }. */
async function ensureClientFolder(file) {
  const primary = await get(
    "SELECT * FROM applicants WHERE file_id = ? ORDER BY CASE WHEN role = 'primary' THEN 0 ELSE 1 END, id LIMIT 1",
    file.id
  );
  const clientName = sanitizeName(primary ? fullName(primary) : 'Client');
  const base = `${rootFolder()}/${clientName} - ${file.file_number}`;

  await ensureFolder(rootFolder());
  const baseItem = await ensureFolder(base);
  for (const sub of SUBFOLDERS) await ensureFolder(`${base}/${sub}`);
  return { id: baseItem.id, path: base };
}

/**
 * Upload one stored document. The local copy is encrypted at rest, so it is
 * decrypted in memory here and re-protected by Microsoft 365's own
 * encryption at rest on the far side.
 */
async function uploadVersionToOneDrive(version, request, file) {
  if (!file.onedrive_folder_path) {
    throw new Error('The client OneDrive folder has not been created yet.');
  }
  const storage = require('./storage');
  const docType = await get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
  const folder = CATEGORY_FOLDER[docType ? docType.category : 'other'] || 'Other';
  const content = await storage.readStored(version.stored_name, parseJsonSafe(version.enc_envelope, null));

  const fileName = sanitizeName(
    `${docType ? docType.name : 'Document'} v${version.version} - ${version.original_name || version.stored_name}`
  ).replace(/\.+$/, '') || `document-v${version.version}`;
  const humanPath = `${file.onedrive_folder_path}/${folder}/${fileName}`;

  let item;
  if (content.length < 4 * 1024 * 1024) {
    item = await graph.graphRequest('PUT', `${itemByPath(humanPath)}:/content`, {
      body: content,
      contentType: version.mime || 'application/octet-stream',
    });
  } else {
    const session = await graph.graphRequest('POST', `${itemByPath(humanPath)}:/createUploadSession`, {
      body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
    });
    item = await uploadInChunks(session.uploadUrl, content);
  }
  return { id: item.id, path: humanPath, webUrl: item.webUrl };
}

async function uploadInChunks(uploadUrl, content) {
  const CHUNK = 5 * 1024 * 1024;
  let item = null;
  for (let offset = 0; offset < content.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, content.length);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - offset),
        'Content-Range': `bytes ${offset}-${end - 1}/${content.length}`,
      },
      body: content.subarray(offset, end),
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(`OneDrive chunk upload failed: HTTP ${res.status}`);
    }
    if (res.status === 200 || res.status === 201) item = await res.json();
  }
  if (!item) throw new Error('OneDrive upload session never returned the created item.');
  return item;
}

async function uploadAiReviewToOneDrive(file, docTypeName, versionNumber, resultJson) {
  if (!file.onedrive_folder_path) return null;
  const fileName = sanitizeName(`${docTypeName} v${versionNumber} - AI Review.json`);
  const humanPath = `${file.onedrive_folder_path}/AI Review/${fileName}`;
  const item = await graph.graphRequest('PUT', `${itemByPath(humanPath)}:/content`, {
    body: Buffer.from(JSON.stringify(resultJson, null, 2), 'utf8'),
    contentType: 'application/json',
  });
  return { id: item.id, path: humanPath };
}

// ---------------------------------------------------------------------------
// Background sync

async function queueFolderCreation(fileId) {
  if (!isEnabled()) return;
  await run("UPDATE client_files SET onedrive_status = 'pending' WHERE id = ? AND onedrive_folder_id IS NULL", fileId);
}

async function queueVersionSync(versionId) {
  if (!isEnabled()) return;
  await run("UPDATE document_versions SET onedrive_status = 'pending' WHERE id = ? AND onedrive_item_id IS NULL", versionId);
}

async function processOneDriveSync() {
  if (!isEnabled()) return;
  const { activity } = require('./log');

  for (const file of await all(
    `SELECT * FROM client_files WHERE onedrive_status = 'pending' AND onedrive_attempts < ? LIMIT 5`, MAX_ATTEMPTS
  )) {
    try {
      const folder = await ensureClientFolder(file);
      await run(
        "UPDATE client_files SET onedrive_folder_id = ?, onedrive_folder_path = ?, onedrive_status = 'done', onedrive_error = NULL WHERE id = ?",
        folder.id, folder.path, file.id
      );
      await activity(file.id, null, 'onedrive_folder_created', `OneDrive folder created: ${folder.path}`);
    } catch (err) {
      await run(
        `UPDATE client_files SET onedrive_attempts = onedrive_attempts + 1, onedrive_error = ?,
           onedrive_status = CASE WHEN onedrive_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
         WHERE id = ?`,
        String(err.message).slice(0, 500), MAX_ATTEMPTS, file.id
      );
      console.error('[onedrive] folder creation failed for file', file.id, err.message);
    }
  }

  for (const row of await all(
    `SELECT v.*, r.document_type_id, r.file_id AS req_file_id
       FROM document_versions v JOIN document_requests r ON r.id = v.request_id
      WHERE v.onedrive_status = 'pending' AND v.onedrive_attempts < ? LIMIT 10`, MAX_ATTEMPTS
  )) {
    const file = await get('SELECT * FROM client_files WHERE id = ?', row.req_file_id);
    if (!file) continue;
    if (!file.onedrive_folder_path) {
      await queueFolderCreation(file.id);
      continue;
    }
    try {
      const uploaded = await uploadVersionToOneDrive(row, { document_type_id: row.document_type_id }, file);
      await run(
        "UPDATE document_versions SET onedrive_item_id = ?, onedrive_path = ?, onedrive_status = 'done', onedrive_error = NULL WHERE id = ?",
        uploaded.id, uploaded.path, row.id
      );
      await activity(file.id, null, 'onedrive_synced', `Document copied to OneDrive: ${uploaded.path}`);
    } catch (err) {
      await run(
        `UPDATE document_versions SET onedrive_attempts = onedrive_attempts + 1, onedrive_error = ?,
           onedrive_status = CASE WHEN onedrive_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
         WHERE id = ?`,
        String(err.message).slice(0, 500), MAX_ATTEMPTS, row.id
      );
      console.error('[onedrive] version sync failed for version', row.id, err.message);
    }
  }
}

module.exports = {
  isEnabled,
  ensureClientFolder,
  uploadVersionToOneDrive,
  uploadAiReviewToOneDrive,
  queueFolderCreation,
  queueVersionSync,
  processOneDriveSync,
  SUBFOLDERS,
};
