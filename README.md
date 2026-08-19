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

## Quick start

Requires **Node.js 22.5+**. There are **zero runtime dependencies** — nothing
to install.

```bash
npm start                 # start the platform on http://localhost:3000
npm run seed:demo         # optional: seed demo clients to explore with
npm test                  # run the end-to-end scenario tests
```

On first start an admin account is created and printed to the console
(or set `ADMIN_EMAIL` / `ADMIN_PASSWORD` beforehand). Then:

- **Broker portal:** `http://localhost:3000/broker`
- **Client portal:** `http://localhost:3000/portal`

Configuration is via environment variables: `PORT`, `DATA_DIR` (database +
uploads location, default `./data`), `APP_URL` (public URL used in email
links), `EMAIL_TRANSPORT` (`log` | `disabled`), `FORCE_SECURE_COOKIES=1`
(behind HTTPS termination that doesn't set `x-forwarded-proto`).

## The two experiences

**Broker portal** (`/broker`) — an *action dashboard*, not a client list:
documents awaiting review, files waiting on client documents, unread client
messages, follow-ups due today and overdue, and a ranked "Needs your
attention" list where every item is one click from the relevant file. Plus
clients with search/filters/saved views and bulk actions, a fast one-page
client creation form with duplicate protection, full client files (overview,
documents, chat, tasks, private notes, activity timeline, email history),
tasks, lightweight reports, notifications, and a settings area.

**Client portal** (`/portal`) — mobile-first and deliberately minimal. A
client sees within seconds: where their mortgage stands (visual 6-step
progress tracker with friendly wording), a single clear **next step**, exactly
which documents are needed (with the broker's reason when a replacement is
requested), and a chat button to their broker. Uploads support drag-and-drop,
multi-file, and phone camera capture (PDF/JPG/PNG/HEIC/WEBP); filenames are
auto-matched to checklist items and the broker can always reclassify.

## Key mechanics

- **Document requirement engine** — brokers configure combinable IF/THEN
  rules (Settings → Document rules), e.g. *IF application type is Purchase
  AND applicant is an employee THEN require T4, pay stub (valid 60 days),
  employment letter, NOA — per applicant*. Checklists are generated and
  re-synced automatically when application type, FTHB status, or applicants
  change. No manual checklist building, no coding.
- **Multi-applicant files** — co-borrowers, spouses, guarantors; each with
  their own employment info, per-applicant documents, and optional portal
  access. Every document is labelled with the applicant it belongs to.
- **Document review with version history** — approve / reject / request
  replacement with a required client-facing reason; replaced documents keep
  every version and review outcome permanently. Optional validity windows
  flag approved documents that expire.
- **Configurable stages** — add/rename/reorder/disable stages, set colors,
  client-facing wording, progress-tracker step, and per-stage automation
  (email the client, create a task). Stage history is preserved.
- **Automatic reminders** — configurable cadence (e.g. 2/5/7 days), max
  count, and minimum spacing; reminders stop the moment a document arrives.
  Manual and bulk reminders respect the same anti-spam limits.
- **Email as a notification layer** — every message a client receives by
  email also exists in the portal (the portal is the source of truth).
  Templates are editable with placeholders and live preview; every send is
  recorded in a per-file email history. Delivery is a pluggable transport
  (outbox pattern) ready for a real SMTP/Gmail/Microsoft 365 integration.
- **Tasks & notes** — manual and automatic tasks (e.g. "Review the client's
  document package" when everything is in), due dates, priorities,
  assignment; pinned private notes that clients can never see.
- **Activity & audit** — a human-readable per-file timeline, plus an
  append-only audit log (logins, uploads, downloads, approvals, stage and
  permission changes...) with no edit/delete endpoints.
- **Digital consents** — the brokerage uploads its own consent/disclosure
  wording; the exact version each client accepted is snapshotted with
  date, time and identity. (No legal wording is invented by the platform.)

## Security

- scrypt password hashing (never plaintext), strong-password enforcement
- DB-backed sessions in HttpOnly SameSite cookies; `Secure` behind HTTPS
- Login rate limiting per IP + temporary account lockout after repeated failures
- Single-use, expiring activation and password-reset tokens (stored hashed)
- **Server-side authorization everywhere**: role-based permissions for staff
  (admin/manager/broker/processor/assistant, editable permission matrix), and
  client access derived exclusively from applicant↔file links — a client
  changing IDs in URLs/API calls gets 404s (verified by automated tests)
- CSRF protection (custom header requirement), strict CSP, no-sniff/frame headers
- Uploads: size limits, extension allowlist, magic-byte content validation;
  files stored outside the web root with random names and streamed only
  through permission-checked endpoints; downloads are audit-logged
- Friendly client-facing error messages; diagnostics stay server-side
- Files are archived (completed/cancelled/archived states), never silently
  deleted; retention policy is configurable to match the brokerage's own
  legal obligations

## Architecture

```
server/
  index.js        HTTP server, static files, security headers, routing
  router.js       tiny method+pattern router
  db.js           SQLite (node:sqlite), schema, helpers
  seed.js         default stages/types/rules/templates/permissions
  auth.js         passwords, sessions, lockout, RBAC, client isolation
  checklist.js    document requirement engine
  nextstep.js     client "next step" + broker attention computation
  reminders.js    background scheduler (reminders, expiry, overdue tasks)
  emails.js       template rendering + pluggable outbox transport
  notify.js       in-portal notifications
  storage.js      document storage abstraction (local driver)
  log.js          activity timeline + append-only audit log
  serialize.js    API shapes incl. friendly client-facing statuses
  routes/         auth / broker / client / settings APIs
public/           two vanilla-JS SPAs (broker/, portal/) + shared design system
tests/            end-to-end tests for the 10 core UX scenarios
scripts/          demo data seeder
```

Deliberate choices, per the product's phased plan:

- **SQLite + local file storage** keep operations simple for a single
  brokerage; `storage.js` and `emails.js` are the seams where cloud document
  storage (Drive/OneDrive/SharePoint) and mailbox integrations
  (Gmail/Outlook) plug in without touching callers.
- **No frameworks** — fast loads, no build step, tiny attack surface, and
  the whole codebase is readable in an afternoon.
- **Future-ready, not future-built**: appointments, e-signature providers,
  SMS, lender submission systems and AI-assisted classification all have
  natural extension points (see `emails.js`, `storage.js`, consent records,
  and the request/version model) but are intentionally not in Phase 1.

## Tests

`npm test` runs end-to-end API tests for the ten acceptance scenarios from
the product spec — client creation with automatic checklist and welcome
email, activation/first login, uploads with content sniffing, review and
rejection with client-visible reasons, replacement with preserved version
history, chat with notifications, stage changes with configured emails,
follow-up tasks — plus dedicated security tests: cross-client isolation at
the API level (Scenario 10), account lockout, CSRF, duplicate protection,
and role permission enforcement.

## Operational notes

- **Backups:** the whole state is `DATA_DIR` (SQLite DB + `uploads/`).
  Snapshot that directory on a schedule; SQLite's WAL mode keeps copies
  consistent via `sqlite3 .backup` or filesystem snapshots.
- **Health:** `GET /health` for monitoring; errors are logged server-side.
- **HTTPS:** run behind a TLS-terminating proxy; `Secure` cookies switch on
  automatically via `x-forwarded-proto`.
