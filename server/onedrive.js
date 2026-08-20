'use strict';

/**
 * OneDrive document storage via Microsoft Graph (the configured mailbox
 * user's OneDrive for Business drive).
 *
 * Uploaded client documents are mirrored to OneDrive in the background so
 * the original lives in the brokerage's Microsoft storage; the local copy
 * under DATA_DIR stays as the working copy the app serves for preview,
 * download and AI review. The database stores only metadata plus the
 * OneDrive item id / path.
 *
 * Folder structure per client file:
 *   {ONEDRIVE_ROOT}/{Client Name} - {FileNumber}/
 *     Identity/ Income/ Assets/ Property/ Mortgage/ Other/ AI Review/
 *
 * The folder name embeds the unique application file number, never just the
 * client's name.
 */

const fs = require('node:fs');
const path = require('node:path');
const { run, get, DATA_DIR } = require('./db');
const { now, fullName } = require('./util');
const graph = require('./msgraph');

const SUBFOLDERS = ['Identity', 'Income', 'Assets', 'Property', 'Mortgage', 'Other', 'AI Review'];

const CATEGORY_FOLDER = {
  identity: 'Identity',
  income: 'Income',
  financial: 'Assets',
  property: 'Property',
  other: 'Other',
};

function rootFolder() {
  return process.env.ONEDRIVE_ROOT || 'Mortgage Clients';
}

function isEnabled() {
  return graph.isConfigured();
}

function drivePath() {
  return `/users/${encodeURIComponent(graph.config().mailbox)}/drive`;
}

/** Graph path segment for an item under the drive root, by human path. */
function itemByPath(humanPath) {
  const encoded = humanPath.split('/').map(encodeURIComponent).join('/');
  return `${drivePath()}/root:/${encoded}`;
}

function sanitizeName(name) {
  // OneDrive-invalid characters: " * : < > ? / \ |
  return String(name).replace(/["*:<>?/\\|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function ensureFolder(humanPath) {
  // Create-by-path: PATCH-like semantics via children endpoint on the parent.
  const parts = humanPath.split('/');
  const name = parts.pop();
  const parent = parts.join('/');
  const endpoint = parent
    ? `${itemByPath(parent)}:/children`
    : `${drivePath()}/root/children`;
  try {
    const item = await graph.graphRequest('POST', endpoint, {
      body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
    });
    return item;
  } catch (err) {
    if (/nameAlreadyExists|already exists/i.test(err.message)) {
      return graph.graphRequest('GET', itemByPath(humanPath));
    }
    throw err;
  }
}

/** Create the full client folder tree; returns { id, path }. */
async function ensureClientFolder(file) {
  const primary = get(
    "SELECT * FROM applicants WHERE file_id = ? ORDER BY CASE WHEN role = 'primary' THEN 0 ELSE 1 END, id LIMIT 1",
    file.id
  );
  const clientName = sanitizeName(primary ? fullName(primary) : 'Client');
  const folderName = `${clientName} - ${file.file_number}`;
  const base = `${rootFolder()}/${folderName}`;

  await ensureFolder(rootFolder());
  const baseItem = await ensureFolder(base);
  for (const sub of SUBFOLDERS) {
    await ensureFolder(`${base}/${sub}`);
  }
  return { id: baseItem.id, path: base };
}

/** Upload one stored file into the client's category subfolder. */
async function uploadVersionToOneDrive(version, request, file) {
  if (!file.onedrive_folder_path) {
    throw new Error('The client OneDrive folder has not been created yet.');
  }
  const docType = get('SELECT * FROM document_types WHERE id = ?', request.document_type_id);
  const folder = CATEGORY_FOLDER[docType ? docType.category : 'other'] || 'Other';
  const localPath = path.join(DATA_DIR, 'uploads', path.basename(version.stored_name));
  const content = fs.readFileSync(localPath);
  const ext = path.extname(version.original_name || version.stored_name) || path.extname(version.stored_name);
  const fileName = sanitizeName(
    `${docType ? docType.name : 'Document'} v${version.version} - ${version.original_name || version.stored_name}`
  ).replace(/\.+$/, '') || `document-v${version.version}${ext}`;
  const humanPath = `${file.onedrive_folder_path}/${folder}/${fileName}`;

  // Simple upload (< 4MB per Graph docs uses PUT :/content; larger files use
  // an upload session).
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

/** Write an AI review JSON summary into the client's "AI Review" folder. */
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
// Background sync passes (invoked by the scheduler; each is idempotent).

const MAX_ATTEMPTS = 5;

function queueFolderCreation(fileId) {
  if (!isEnabled()) return;
  run("UPDATE client_files SET onedrive_status = 'pending' WHERE id = ? AND onedrive_folder_id IS NULL", fileId);
}

function queueVersionSync(versionId) {
  if (!isEnabled()) return;
  run("UPDATE document_versions SET onedrive_status = 'pending' WHERE id = ? AND onedrive_item_id IS NULL", versionId);
}

async function processOneDriveSync() {
  if (!isEnabled()) return;
  const { all } = require('./db');
  const { activity } = require('./log');

  // 1) Client folders
  for (const file of all(
    `SELECT * FROM client_files WHERE onedrive_status = 'pending' AND onedrive_attempts < ? LIMIT 5`, MAX_ATTEMPTS
  )) {
    try {
      const folder = await ensureClientFolder(file);
      run(
        "UPDATE client_files SET onedrive_folder_id = ?, onedrive_folder_path = ?, onedrive_status = 'done', onedrive_error = NULL WHERE id = ?",
        folder.id, folder.path, file.id
      );
      activity(file.id, null, 'onedrive_folder_created', `OneDrive folder created: ${folder.path}`);
    } catch (err) {
      run(
        "UPDATE client_files SET onedrive_attempts = onedrive_attempts + 1, onedrive_error = ?, onedrive_status = CASE WHEN onedrive_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?",
        String(err.message).slice(0, 500), MAX_ATTEMPTS, file.id
      );
      console.error('[onedrive] folder creation failed for file', file.id, err.message);
    }
  }

  // 2) Document versions (only once the client folder exists)
  for (const row of all(
    `SELECT v.*, r.document_type_id, r.file_id AS req_file_id, r.id AS req_id
       FROM document_versions v JOIN document_requests r ON r.id = v.request_id
      WHERE v.onedrive_status = 'pending' AND v.onedrive_attempts < ? LIMIT 10`, MAX_ATTEMPTS
  )) {
    const file = get('SELECT * FROM client_files WHERE id = ?', row.req_file_id);
    if (!file) continue;
    if (!file.onedrive_folder_path) {
      queueFolderCreation(file.id);
      continue; // folder first; version stays pending for the next pass
    }
    try {
      const request = { document_type_id: row.document_type_id };
      const uploaded = await uploadVersionToOneDrive(row, request, file);
      run(
        "UPDATE document_versions SET onedrive_item_id = ?, onedrive_path = ?, onedrive_status = 'done', onedrive_error = NULL WHERE id = ?",
        uploaded.id, uploaded.path, row.id
      );
      activity(file.id, null, 'onedrive_synced', `Document copied to OneDrive: ${uploaded.path}`);
    } catch (err) {
      run(
        "UPDATE document_versions SET onedrive_attempts = onedrive_attempts + 1, onedrive_error = ?, onedrive_status = CASE WHEN onedrive_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?",
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
