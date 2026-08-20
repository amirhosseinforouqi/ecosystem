# Deploying to production

This is the checklist for putting the platform in front of real client data.
Everything here is enforced by the application: with `NODE_ENV=production` the
server refuses to start if the security-relevant settings are missing, rather
than quietly running in a weaker mode.

The reference stack is **Vercel + Supabase PostgreSQL + Microsoft 365 +
SharePoint/OneDrive + Claude API + Sentry**, but nothing is tied to those
providers — any Node 22 host and any PostgreSQL 14+ database will do.

---

## 1. Database (Supabase or any PostgreSQL)

1. Create a PostgreSQL 14+ database. On Supabase: **New project**, then
   **Project Settings → Database → Connection string → URI**.
2. Use the **connection pooler** URI (port 6543) for a serverless deployment
   and the direct URI (port 5432) for a long-running server.
3. Set `DATABASE_URL`. TLS certificate verification is **on** by default; leave
   it that way. `PGSSLMODE=no-verify` exists for local sockets and self-signed
   setups only.
4. Apply the schema:

   ```bash
   DATABASE_URL=... ADMIN_EMAIL=you@yourbrokerage.com npm run migrate
   ```

   This is safe to re-run on every deploy. It also creates the first
   administrator when none exists, printing a one-time password.

### Least-privilege database role

Create a dedicated role for the application rather than using the owner:

```sql
CREATE ROLE mortgage_app LOGIN PASSWORD '<strong-random>';
GRANT CONNECT ON DATABASE <db> TO mortgage_app;
GRANT USAGE ON SCHEMA public TO mortgage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mortgage_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mortgage_app;

-- The audit trail is append-only. Removing UPDATE/DELETE means a compromised
-- application account cannot rewrite history, which is what makes the hash
-- chain in server/log.js worth having.
REVOKE UPDATE, DELETE ON audit_log FROM mortgage_app;
```

Run migrations as the owner; run the application as `mortgage_app`.

### Network access

Restrict the database to your platform's egress addresses. On Supabase this is
**Project Settings → Database → Network Restrictions**. Never leave a database
holding client financial documents open to `0.0.0.0/0`.

---

## 2. Document encryption keys (required)

Documents are encrypted at rest with AES-256-GCM envelope encryption. Without
keys the application refuses to accept an upload — it will not silently store
plaintext.

```bash
npm run keygen
```

Set the two values it prints:

- `DOCUMENT_ENCRYPTION_KEYS` — every key, e.g. `v1:<base64>,v2:<base64>`
- `DOCUMENT_ENCRYPTION_ACTIVE_KEY` — the key new documents are wrapped with

**Never remove an old key.** Documents wrapped with it become permanently
unreadable. To rotate:

```bash
npm run keygen -- --rotate          # append the new key, point ACTIVE_KEY at it
npm run encrypt:backfill -- --rewrap            # report what is still on the old key
npm run encrypt:backfill -- --rewrap --apply    # re-wrap it
```

Existing documents stay readable under their original key throughout, so the
re-wrap can run at any time. Only once it reports zero documents on the old key
may that key be retired.

The same command backfills anything that predates encryption
(`npm run encrypt:backfill -- --apply`), and `--orphans` lists blobs on disk
that no database row references. Orphans are only ever listed, never deleted —
check them against your backups and remove them by hand.

Store these in your platform's secret manager. They must never enter git.

---

## 3. Document storage

Uploaded documents are stored as encrypted blobs, and mirrored to
OneDrive/SharePoint when Microsoft Graph is configured. There are two backends.

**Local (default)** — a directory under `DATA_DIR`. Correct for a long-running
server with a persistent volume.

**Object store** — any S3-compatible bucket. **Required on Vercel and any other
serverless platform**, whose filesystem is empty again on the next request: a
document written locally there is simply gone. The application refuses to start
in that situation rather than losing a client's documents quietly.

```
STORAGE_BACKEND=s3
S3_ENDPOINT=https://<project>.supabase.co/storage/v1/s3
S3_REGION=<your project region, e.g. us-east-1>
S3_BUCKET=mortgage-documents
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=documents                 # optional
```

On Supabase: **Storage → New bucket**, keep it **private**, then **Project
Settings → Storage → S3 access keys → New access key**. The same variables work
unchanged against Cloudflare R2, MinIO or AWS S3 (set `S3_FORCE_PATH_STYLE=false`
for AWS's virtual-hosted style).

The bucket only ever holds ciphertext — documents are encrypted before they
leave the application — so bucket compromise alone does not disclose a client's
documents. Keep the bucket private regardless: public objects would still leak
which clients exist and how many documents each has.

If you genuinely have a persistent volume mounted at `DATA_DIR` on a platform
the application detects as serverless, `ALLOW_EPHEMERAL_STORAGE=1` overrides the
refusal. Do not set it to make an error go away.

---

## 4. Microsoft 365 (email) and OneDrive/SharePoint (filing)

No mailbox password is ever entered into or stored by this application. It uses
the OAuth 2.0 client-credentials flow against an app registration you control.

1. **Entra admin centre → App registrations → New registration.**
2. **Certificates & secrets → New client secret.** Copy the value once.
3. **API permissions → Microsoft Graph → Application permissions:**
   - `Mail.Send` — sending client email
   - `Files.ReadWrite.All` (OneDrive) or `Sites.ReadWrite.All` (SharePoint)
4. **Grant admin consent.**
5. Scope `Mail.Send` to a single mailbox with an application access policy, so
   the registration cannot send as anybody else:

   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> `
     -PolicyScopeGroupId broker@yourbrokerage.com `
     -AccessRight RestrictAccess -Description "Mortgage platform"
   ```

Then set:

```
EMAIL_TRANSPORT=graph
MS_TENANT_ID=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_MAILBOX=broker@yourbrokerage.com
ONEDRIVE_TARGET=user            # or "sharepoint"
SHAREPOINT_SITE_ID=...          # only when ONEDRIVE_TARGET=sharepoint
ONEDRIVE_ROOT=Mortgage Clients
```

Client secrets expire. Put the expiry date in a calendar — a lapsed secret
stops client email silently until someone notices.

### SMTP alternative

If you are not on Microsoft 365, set `EMAIL_TRANSPORT=smtp` with `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Use an app password, never
the account's own password.

`EMAIL_TRANSPORT=log` drops mail on the floor and is refused in production.

---

## 5. Malware scanning

Brokerage staff open whatever clients upload, so uploads are scanned before
their bytes can be served.

```
MALWARE_SCAN_MODE=clamd
CLAMAV_HOST=...
CLAMAV_PORT=3310
```

Any managed or self-hosted ClamAV daemon works. If you consciously accept the
risk of running without scanning, you must say so explicitly with
`MALWARE_SCAN_MODE=disabled`; the server will not start in production with the
setting merely absent or mistyped.

---

## 6. Claude document review (optional)

Off by default. Turning it on requires **three** independent things, so no
client document can reach Anthropic by accident:

1. Server: `AI_DOCUMENT_REVIEW_ENABLED=true`, `ANTHROPIC_API_KEY=...`, and
   `AI_PROCESSING_AGREEMENT_REF=<your DPA reference>`.
2. Brokerage: **Settings → AI review → Enabled**.
3. Client: consent recorded on that client's file.

With any one of them missing, the document is never sent and the review row
records `disabled` rather than sitting pending. Review output is encrypted at
rest with the same key scheme as documents, and is never serialized to a client.

Before enabling this, confirm your privacy obligations allow sending client
financial documents to a third-party processor, and record the agreement
reference in `AI_PROCESSING_AGREEMENT_REF`.

---

## 7. Application settings

```
NODE_ENV=production
APP_URL=https://portal.yourbrokerage.com   # exact public URL; builds email links
FORCE_SECURE_COOKIES=1                     # session cookies are HTTPS-only
TRUST_PROXY=1                              # number of proxies in front of the app
CRON_SECRET=<random>                       # authenticates the scheduled-jobs endpoint
SENTRY_DSN=...                             # optional error reporting
BREACH_CHECK_ENABLED=true                  # optional: reject known-breached passwords
```

`TRUST_PROXY` matters. With the default of `0`, `X-Forwarded-For` is ignored
entirely and rate limits and login lockouts key off the socket address. Set it
to the number of reverse proxies actually in front of the app (Vercel and most
managed platforms: `1`). Setting it higher than reality lets a caller spoof
their address and walk past the per-IP limits.

---

## 8. Vercel

`vercel.json` routes every request to `api/index.js`, which is the same
application handler `npm start` uses.

1. Import the repository in Vercel.
2. Add every environment variable above under **Settings → Environment
   Variables** (Production).
3. Add your custom domain under **Settings → Domains** and point DNS at it.
   Set `APP_URL` to match exactly.
4. Deploy, then run migrations once against the production database.

There are no timers in a serverless deployment, so the background work
(reminders, expiry, malware scans, AI review, OneDrive sync, maintenance) runs
from the cron entry in `vercel.json`, which calls `/api/cron/jobs` every 15
minutes. That endpoint answers 404 without the `CRON_SECRET`.

On a long-running host, `npm start` ticks the same passes in process and no
cron is needed.

---

## 9. Backups

Supabase takes its own backups; use them, and enable point-in-time recovery on
a paid plan. This platform also ships a portable backup that includes the
document blobs, which a database-only backup does not:

```bash
npm run backup                       # → ./backups/backup-<timestamp>/
npm run backup -- --out /mnt/backups
npm run backup -- --verify-only ./backups/backup-2026-08-20T…
npm run restore -- ./backups/backup-2026-08-20T… --confirm
```

`npm run backup` verifies what it has just written; it fails loudly rather than
reporting success on an unreadable archive. Client PII in the archive is
encrypted with your `DOCUMENT_ENCRYPTION_KEYS`, so **an archive is useless
without the keys** — back the keys up separately, somewhere you can still reach
if the hosting account is lost.

**Practise a restore before go-live, into a scratch database.** A backup nobody
has restored is not a backup. `tests/backup.test.js` runs exactly that drill in
CI: back up, wipe, restore, verify the documents still decrypt.

Retention: `BACKUP_RETENTION_DAYS` (default 30) and `BACKUP_KEEP_MIN`
(default 7).

### Record retention

Separately from backups, **Settings → Retention** can archive files
automatically: `archive_completed_after_days` and
`archive_inactive_after_days`. Both are off until you set them, and both
*archive* — nothing is ever deleted automatically, because deleting a mortgage
file on a timer would breach most brokerages' record-keeping obligations. Set
these to match your own legal advice.

---

## 10. Go-live checklist

Work through this against the real production URL, signed in as a real account:

- [ ] `GET /ready` returns `{"ok":true}` — the app can reach the database.
- [ ] `npm run migrate` has been run against the production database.
- [ ] The first administrator has changed the bootstrap password and enrolled
      in two-step verification, and the recovery codes are stored safely.
- [ ] `DOCUMENT_ENCRYPTION_KEYS` is set and backed up **outside** the hosting
      account.
- [ ] Create a test client. Confirm the welcome email actually arrives.
- [ ] Upload a document as that client. Confirm the stored blob is unreadable
      ciphertext and that the broker can still open it.
- [ ] On a serverless deployment, confirm the document is still retrievable
      after the function has gone cold (wait a few minutes, then open it).
- [ ] Sign in as a role without `documents.download` and confirm both preview
      and download are refused.
- [ ] Create a second test client and confirm neither can see the other's
      documents, at the API level and not only in the UI.
- [ ] `POST /api/cron/jobs` with the secret returns results; without it, 404.
- [ ] Take a backup, restore it into a scratch database, and open a document.
- [ ] Delete the test clients.
- [ ] Confirm the database is not reachable from the public internet.
- [ ] Record who holds the encryption keys, the Microsoft client secret and the
      database password, and when each expires.

---

## Environment variable reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `PGSSLMODE` | no | `disable` / `no-verify` for local or self-signed setups |
| `DOCUMENT_ENCRYPTION_KEYS` | yes | `v1:<base64>[,v2:<base64>]` |
| `DOCUMENT_ENCRYPTION_ACTIVE_KEY` | yes | Key id used for new documents |
| `NODE_ENV` | yes | `production` enables the startup safety checks |
| `APP_URL` | yes (prod) | Public https URL; used in every emailed link |
| `FORCE_SECURE_COOKIES` | yes (prod) | Must be `1` |
| `TRUST_PROXY` | recommended | Number of trusted reverse proxies (default `0`) |
| `PORT` | no | Default `3000` |
| `DATA_DIR` | no | Where encrypted documents are written with the local backend (default `./data`) |
| `STORAGE_BACKEND` | yes (serverless) | `local` or `s3` |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | for s3 | Object storage for documents |
| `S3_PREFIX` / `S3_FORCE_PATH_STYLE` | no | Key prefix (default `documents`); path-style addressing (default on) |
| `ALLOW_EPHEMERAL_STORAGE` | no | Override the serverless storage refusal — only with a real volume |
| `EMAIL_TRANSPORT` | yes (prod) | `graph`, `smtp`, `log`, `disabled` |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_MAILBOX` | for Graph | Microsoft 365 app registration |
| `ONEDRIVE_TARGET` / `SHAREPOINT_SITE_ID` / `ONEDRIVE_ROOT` | for filing | Where documents are mirrored |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | for SMTP | Non-Microsoft mail |
| `MALWARE_SCAN_MODE` | yes (prod) | `clamd` or explicitly `disabled` |
| `CLAMAV_HOST` / `CLAMAV_PORT` | for clamd | Scanner endpoint |
| `AI_DOCUMENT_REVIEW_ENABLED` | no | `true` to allow AI review at all |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | for AI review | Claude API |
| `AI_PROCESSING_AGREEMENT_REF` | for AI review | Your DPA reference, recorded in config |
| `CRON_SECRET` | yes (serverless) | Authenticates `/api/cron/jobs` |
| `SENTRY_DSN` | no | Error reporting (PII is scrubbed before sending) |
| `BREACH_CHECK_ENABLED` | no | `true` to check new passwords against HIBP |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first run | Bootstrap administrator; no default exists |
| `PG_POOL_MAX` / `PG_STATEMENT_TIMEOUT` | no | Connection pool tuning |
| `BACKUP_RETENTION_DAYS` / `BACKUP_KEEP_MIN` | no | Backup pruning |
| `DISABLE_SCHEDULER` | no | `1` to suppress in-process timers |

None of these belong in git. `.gitignore` excludes `.env` and
`.devcontainer/.env.local`; secrets live in your platform's secret manager.
