# Mortgage Client Platform

A simple, secure mortgage client management platform for a brokerage — a digital
mortgage assistant, not a heavyweight CRM. It manages every client from first
contact through funding while giving clients an extremely clear, mobile-first
experience.

**The core loop:** enter client information once → the client file, portal
account and document checklist are created automatically → the client uploads
documents from their phone → the broker reviews, communicates and moves the
file through stages → the platform reminds the right person when something
needs attention.

Going live with real client data? Read **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**
— it is the authoritative checklist, and the application enforces most of it at
startup.

## Demo it in GitHub Codespaces

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/amirhosseinforouqi/ecosystem/tree/claude/mortgage-client-platform-xsxg4g)

Click the badge (or **Code** → **Codespaces** → **Create codespace on branch**).
The container brings up PostgreSQL 16 alongside the app, generates a set of
secrets for that container only, applies the schema and seeds three sample
clients in different stages.

**There is no default password anywhere.** The generated administrator
credentials are written to `.devcontainer/.env.local` (git-ignored), and the
demo seeder prints the client portal password once:

```bash
cat .devcontainer/.env.local          # ADMIN_EMAIL / ADMIN_PASSWORD
```

### Signing in without a phone

Administrators must complete two-step verification — that control is not
disabled for the demo. But you do not need an authenticator app to try it:

```bash
npm run code        # prints the current 6-digit code
```

The code is derived from the secret already in the database, so this only works
for someone who can already run commands on the server, and it refuses to run
with `NODE_ENV=production`. Real staff use an authenticator app; the setup
screen shows a key to type in, and the seeder prints an `otpauth://` link you
can open on your phone.

**Just want a quick look?** The client portal has no second step. Sign in as
`john.demo@example.com` with the password the seeder printed.

If the preview doesn't open automatically, check the **PORTS** tab at the
bottom of the editor and click the globe icon next to port 3000.

**Seeing `HTTP ERROR 401` on the `*.app.github.dev` URL?** That is GitHub's
port-forwarding proxy, not this application — the forwarded port is Private and
the browser is not signed in to that codespace. In the **PORTS** tab,
right-click port 3000 → **Port Visibility** → **Public**. (New codespaces set
this automatically; older ones need it once.)

**Anything else not working?** One command diagnoses the whole setup and names
the next thing to run:

```bash
npm run doctor
```

It checks the secrets file, every required variable, the database connection,
the schema, the administrator account and whether the port is actually being
served — then prints the first thing that is wrong and the command that fixes
it. `HTTP ERROR 502` means nothing is listening; `npm run doctor` will say why,
and `bash .devcontainer/start.sh` starts it.

**Want a blank slate** — to walk someone through the "create a client" flow from
an empty dashboard?

```bash
npm run reset:broker-only -- --confirm   # keeps configuration and staff, removes every client
pkill -f "node server/index.js"
bash .devcontainer/start.sh
```

Run `npm run seed:demo` any time to bring the three sample clients back.

## Quick start (local)

Requires **Node.js 22+** and a **PostgreSQL 14+** database. There is exactly one
runtime dependency (`pg`).

```bash
# 1. A database
createdb mortgage
export DATABASE_URL=postgres://localhost:5432/mortgage

# 2. Document encryption keys — uploads are refused without them
npm run keygen        # prints DOCUMENT_ENCRYPTION_KEYS and DOCUMENT_ENCRYPTION_ACTIVE_KEY
export DOCUMENT_ENCRYPTION_KEYS=... DOCUMENT_ENCRYPTION_ACTIVE_KEY=v1

# 3. Schema + the first administrator (a password is generated and printed once)
export ADMIN_EMAIL=you@yourbrokerage.com
npm run migrate

# 4. Run it
npm start
```

- **Broker portal:** `http://localhost:3000/broker`
- **Client portal:** `http://localhost:3000/portal`

Other commands:

```bash
npm test                          # the full test suite (needs TEST_DATABASE_URL)
npm run seed:demo                 # three demo clients to explore with
npm run reset:broker-only -- --confirm
npm run backup                    # database rows + encrypted documents
npm run restore -- <dir> --confirm
npm run jobs                      # run the background passes once
npm run doctor                    # diagnose a setup that isn't working
npm run code                      # current two-step code, no phone needed
```

`npm test` creates and drops its own databases; point `TEST_DATABASE_URL` at a
server it may do that on, e.g.
`TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test`.

## Connect Microsoft 365 (Outlook email + OneDrive/SharePoint storage)

Client email and document filing run on **one** Microsoft Entra app registration
using OAuth client credentials. Your mailbox password is never entered into or
stored by this application.

1. **App registrations → New registration.** Copy the **Application (client) ID**
   and **Directory (tenant) ID**.
2. **Certificates & secrets → New client secret.** Copy the value immediately —
   it is shown only once.
3. **API permissions → Microsoft Graph → Application permissions:** `Mail.Send`
   and `Files.ReadWrite.All` (OneDrive) or `Sites.ReadWrite.All` (SharePoint).
   Then **Grant admin consent**.

```bash
EMAIL_TRANSPORT=graph
MS_TENANT_ID=<tenant id>
MS_CLIENT_ID=<client id>
MS_CLIENT_SECRET=<secret value>
MS_MAILBOX=broker@yourbrokerage.com
ONEDRIVE_TARGET=user                  # or "sharepoint" with SHAREPOINT_SITE_ID
ONEDRIVE_ROOT="Mortgage Clients"
```

`Mail.Send` grants send rights for *every* mailbox in the tenant; narrow it to
one with an [application access policy](https://learn.microsoft.com/graph/auth-limit-mailbox-access).
Settings → Integrations shows live connection status.

### SMTP instead

Prefer a plain mailbox? `EMAIL_TRANSPORT=smtp` with `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS` (an **app password**, never your login password),
`SMTP_FROM`. Gmail: `smtp.gmail.com:587`. Outlook: `smtp.office365.com:587`.

Test it without touching any data:

```bash
npm run test:email -- you@example.com
```

Delivery uses a small zero-dependency SMTP client built on Node's own
`net`/`tls` (`server/smtp.js`), covered by tests against a real STARTTLS
conversation rather than a stub.

## Connect Claude document review (optional, off by default)

Uploaded documents can be reviewed in the background by Claude using the
reusable skill at `skills/document-review/SKILL.md` — that file *is* the system
prompt, so review behaviour changes by editing it, not the code.

Turning this on requires **three** independent things, so no client document can
reach Anthropic by accident:

1. Server: `AI_DOCUMENT_REVIEW_ENABLED=true`, `ANTHROPIC_API_KEY`, and
   `AI_PROCESSING_AGREEMENT_REF` (your data-processing agreement reference).
2. Brokerage: Settings → AI review → enabled.
3. Client: consent recorded on that client's file.

With any one missing, nothing is sent and the review is recorded as `disabled`.
Reviews never block an upload, retry on failure, and are stored encrypted. The
output is **internal to the brokerage** — it never reaches the client portal or
any client email, and it never approves or rejects anything. The broker makes
every decision.

## The two experiences

**Broker portal** (`/broker`) — an *action dashboard*, not a client list:
documents awaiting review, files waiting on client documents, unread client
messages, follow-ups due today and overdue, and a ranked "Needs your attention"
list where every item is one click from the relevant file. Plus clients with
search/filters/bulk actions, a guided client creation wizard with duplicate
protection, full client files (overview, documents, chat, tasks, private notes,
activity timeline, email history), tasks, reports, notifications and settings.

**Client portal** (`/portal`) — mobile-first and deliberately minimal. A client
sees within seconds: where their mortgage stands (visual 6-step progress
tracker with friendly wording), a single clear **next step**, exactly which
documents are needed (with the broker's reason when a replacement is requested),
and a chat button to their broker. Uploads support drag-and-drop, multi-file and
phone camera capture (PDF/JPG/PNG/HEIC/WEBP); filenames are auto-matched to
checklist items and the broker can always reclassify.

## Key mechanics

- **Guided client creation** — a four-step wizard: pick the service, pick the
  employment status, review the checklist the rules generated (add/remove/edit
  any item for this client), then enter details. Creating the client also
  creates the portal account, generates a secure temporary password, creates the
  OneDrive folder tree and sends the welcome email — automatically.
- **Temporary password flow** — the client signs in with the credentials from
  their welcome email and *must* set their own password before any portal data
  is reachable. Passwords are only ever stored as scrypt hashes; changing the
  password replaces the hash, so the temporary one stops working immediately.
  The stored copy of the welcome email has the temporary password redacted.
- **Three separate document layers** — **catalog** (every document kind, its
  category and client-facing instructions) → **rules** (service + employment ⇒
  defaults) → **client checklist** (what one client actually owes). Editing one
  client's checklist records a per-file exclusion, so re-running the rules never
  re-adds it *and* every other client keeps the full default. Removed items are
  restorable per client.
- **Document requirement engine** — combinable IF/THEN rules, e.g. *IF
  application type is Purchase AND applicant is an employee THEN require T4, pay
  stub (valid 60 days), employment letter, NOA — per applicant*. Checklists
  re-sync automatically when application type, FTHB status or applicants change.
- **Upload pipeline** — validate → encrypt → store → return success to the
  client → (background) malware scan → Claude review → original copied to
  OneDrive under the client's file number → broker notified. Every stage is
  retryable; an outage never loses a document.
- **Multi-applicant files** — co-borrowers, spouses, guarantors; each with their
  own employment info, per-applicant documents and optional portal access. By
  default each applicant sees only their own documents plus the file-level ones;
  a broker can deliberately mark applicants as sharing.
- **Document review with version history** — approve / reject / request
  replacement with a required client-facing reason; replaced documents keep every
  version and review outcome permanently. Optional validity windows flag approved
  documents that expire.
- **Configurable stages** — add/rename/reorder/disable, set colours,
  client-facing wording, progress-tracker step, and per-stage automation (email
  the client, create a task). Stage history is preserved.
- **Automatic reminders** — configurable cadence, maximum count and minimum
  spacing; reminders stop the moment a document arrives. Manual and bulk
  reminders respect the same anti-spam limits.
- **Email as a notification layer** — every message a client receives by email
  also exists in the portal (the portal is the source of truth). Templates are
  editable with placeholders and live preview; every send is recorded per file.
- **Tasks & notes** — manual and automatic tasks, due dates, priorities,
  assignment; pinned private notes clients can never see.
- **Activity & audit** — a human-readable per-file timeline, plus an append-only
  audit log whose rows are hash-chained, so tampering is detectable
  (`GET /api/broker/audit/verify`).
- **Digital consents** — the brokerage uploads its own consent wording; the exact
  version each client accepted is snapshotted with date, time and identity.

## Security

- **Passwords** — scrypt hashing, never plaintext. Minimum lengths are
  configurable (12 for staff, 10 for clients by default), common and personal
  passwords are rejected, and optional Have I Been Pwned checking uses
  k-anonymity so the password never leaves the server.
- **Two-step verification** — TOTP, mandatory for staff roles (administrators can
  never be exempted), with single-use recovery codes and replay protection. The
  password step alone issues no session.
- **Sessions** — database-backed, in HttpOnly SameSite cookies, `Secure` in
  production, with both an idle timeout and a non-extending absolute lifetime.
  A role change or account disable drops every existing session immediately.
- **Rate limiting** — database-backed, so the limits hold across serverless
  instances and restarts, on sign-in, password reset, MFA verification, uploads
  and the API as a whole. `X-Forwarded-For` is ignored unless `TRUST_PROXY` says
  a proxy is actually there.
- **Documents encrypted at rest** — AES-256-GCM envelope encryption with
  rotatable keys. Without keys the application refuses uploads rather than
  silently storing plaintext. Backups carry the same encryption, and so does
  the object store when documents live in a bucket.
- **Malware scanning** — uploads are scanned (ClamAV) and their bytes are not
  served until they are clean. Production refuses to start without either a
  scanner or an explicit, documented decision to run without one.
- **Server-side authorization everywhere** — role-based permissions for staff
  with an editable matrix; client access derived exclusively from applicant↔file
  links. A client changing ids in URLs or API calls gets 404s. Opening a document
  inline requires the same permission as downloading it.
- **Transport & browser hardening** — HSTS, strict CSP, `frame-ancestors 'none'`,
  nosniff, CSRF protection via a required custom header plus an Origin check, and
  a sandboxed CSP on served documents.
- **Errors** — friendly client-facing messages; diagnostics stay server-side and
  go to Sentry with PII scrubbed.
- **Retention** — files are archived, never silently deleted; the retention
  policy is configurable to match the brokerage's own obligations.

## Architecture

```
server/
  app.js          the HTTP application: security headers, ctx, routing, errors
  index.js        long-running server: port binding, scheduler, graceful shutdown
  router.js       tiny method+pattern router
  db.js           PostgreSQL data layer (pg), transactions, migrations
  schema.sql      the whole schema, idempotent
  seed.js         default stages/types/rules/templates/permissions
  auth.js         passwords, temporary credentials, sessions, RBAC, isolation
  mfa.js          TOTP second factor and recovery codes
  ratelimit.js    database-backed rate limiting
  crypto-store.js AES-256-GCM envelope encryption for documents and results
  scan.js         ClamAV malware scanning
  checklist.js    document requirement engine + per-client customization
  nextstep.js     client "next step" + broker attention computation
  jobs.js         background passes (reminders, expiry, scan, AI, OneDrive)
  backup.js       portable backup and restore
  emails.js       template rendering + pluggable transport
  smtp.js         zero-dependency SMTP client
  msgraph.js      Microsoft Graph client (OAuth client credentials)
  onedrive.js     OneDrive/SharePoint folder tree + background document sync
  ai-review.js    Claude document review pipeline (gated, queued, retryable)
  storage.js      encrypted document storage (local volume or object store)
  objectstore.js  S3-compatible client (SigV4), for serverless deployments
  log.js          activity timeline + hash-chained audit log
  sentry.js       error reporting with PII scrubbing
  serialize.js    API shapes, strictly separate client and broker views
  routes/         auth / broker / client / settings / ops APIs
api/index.js      Vercel entry point (same handler as npm start)
skills/
  document-review/SKILL.md   the Claude review skill (= system prompt)
public/           two vanilla-JS SPAs (broker/, portal/) + shared design system
tests/            security / workflow / checklist / backup / integrations / smtp
scripts/          migrate, keygen, backup, restore, jobs, demo seed, reset
docs/DEPLOYMENT.md  production deployment and go-live checklist
```

Deliberate choices:

- **PostgreSQL**, so the same engine runs locally, in the demo container and in
  production, and so managed backup and point-in-time recovery are available.
- **One runtime dependency** (`pg`). Everything else — SMTP, TOTP, Graph, the
  Anthropic API, malware scanning, encryption — is built on Node's standard
  library, which keeps the supply-chain surface close to zero.
- **No frontend framework** — fast loads, no build step, small attack surface,
  and the whole codebase is readable in an afternoon.
- **Deployment-shape agnostic** — `server/app.js` is a plain request handler, so
  the identical code runs behind `npm start` and behind Vercel's Node runtime.

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
```

Every suite runs against the real HTTP API with its own database, never against
internal functions, because the API is the boundary a client or an attacker
actually reaches.

- `security.test.js` — unauthenticated access, client-to-client isolation,
  applicant-to-applicant isolation, role permissions and the preview/download
  gate, encryption at rest and tamper detection, credentials, MFA, rate
  limiting, CSRF, response hardening, audit-chain verification.
- `workflow.test.js` — the ten acceptance scenarios from the product spec,
  end to end.
- `checklist.test.js` — the three document layers, and that one client's edits
  never change another client's defaults.
- `backup.test.js` — a real disaster drill: back up, wipe the database and the
  document store, restore, confirm documents still decrypt.
- `integrations.test.js` — Microsoft Graph and the Anthropic API against local
  servers speaking the real protocols, plus the three AI consent gates.
- `storage.test.js` — the object-store backend against a local server that
  verifies AWS Signature V4 the way a real bucket does, including backup and
  restore, and the refusal to run on an ephemeral filesystem.
- `smtp.test.js` — a real STARTTLS + AUTH LOGIN + DATA conversation.

## Operational notes

- **Health:** `GET /health` (liveness, no dependencies) and `GET /ready`
  (proves the database is reachable).
- **Background work:** a long-running server ticks the passes in process. A
  serverless deployment has no timers, so `vercel.json` points a cron at
  `/api/cron/jobs`, authenticated with `CRON_SECRET`.
- **Backups:** `npm run backup` captures database rows *and* the encrypted
  document blobs, and verifies what it wrote. Practise a restore before go-live
  — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **HTTPS:** required in production. Set `FORCE_SECURE_COOKIES=1` and
  `TRUST_PROXY` to the number of proxies in front of the app.
