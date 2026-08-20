'use strict';

const { run, get, getSetting, setSetting } = require('./db');
const { now } = require('./util');

/** Every permission key known to the platform. */
const ALL_PERMISSIONS = [
  'clients.view',
  'clients.create',
  'clients.edit',
  'clients.archive',
  'documents.view',        // see the checklist and document metadata
  'documents.download',    // retrieve the actual file bytes (preview OR download)
  'documents.upload',
  'documents.review',
  'documents.request',
  'stage.change',
  'chat.send',
  'tasks.manage',
  'notes.manage',
  'emails.view',
  'reports.view',
  'audit.view',
  'settings.manage',
  'users.manage',
];

const DEFAULT_ROLE_PERMISSIONS = {
  admin: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS.filter((p) => p !== 'settings.manage'),
  broker: ALL_PERMISSIONS.filter((p) => !['settings.manage', 'users.manage', 'audit.view'].includes(p)),
  processor: [
    'clients.view',
    'documents.view',
    'documents.upload',
    'documents.review',
    'documents.request',
    'documents.download',
    'chat.send',
    'tasks.manage',
    'notes.manage',
    'emails.view',
  ],
  assistant: [
    'clients.view',
    'documents.view',
    'documents.upload',
    'chat.send',
    'tasks.manage',
    'notes.manage',
    'emails.view',
  ],
};

const DEFAULT_SETTINGS = {
  brokerage: {
    name: 'Your Brokerage',
    broker_name: 'Your Broker',
    phone: '',
    email: '',
    website: '',
    address: '',
    welcome_message: 'Your mortgage journey starts here.',
    primary_color: '#1f4fd8',
    logo_text: '',
  },
  client_steps: [
    { key: 'application', label: 'Application' },
    { key: 'documents', label: 'Documents' },
    { key: 'review', label: 'Review' },
    { key: 'submission', label: 'Submission' },
    { key: 'approval', label: 'Approval' },
    { key: 'closing', label: 'Closing' },
  ],
  reminders: {
    enabled: true,
    cadence_days: [2, 5, 7],
    max_reminders: 3,
    min_hours_between: 24,
  },
  automation: {
    task_on_all_docs_uploaded: true,
    task_on_client_message: false,
    notify_all_staff_if_unassigned: true,
  },
  uploads: {
    max_mb: 25,
    allowed_ext: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'],
  },
  security: {
    // Idle windows; the absolute lifetime below is never extended by activity.
    session_days_staff: 1,
    session_days_client: 7,
    session_absolute_hours_staff: 12,
    session_absolute_hours_client: 336,
    // Lockout is a last resort — rate limiting does the primary work, so the
    // threshold is high enough that it is not a practical way to lock a
    // broker out of their own account (audit finding H8).
    lockout_threshold: 8,
    lockout_minutes: 15,
    min_password_length_staff: 12,
    min_password_length_client: 10,
    mfa_required_roles: ['admin', 'manager', 'broker', 'processor'],
  },
  ai_review: {
    // Off until the brokerage turns it on AND the server is configured with a
    // processing agreement reference (audit finding C6).
    enabled: false,
    require_client_consent: true,
  },
  retention: {
    policy_note:
      'Configure retention according to your legal and regulatory obligations. Records are archived, never silently deleted.',
    archive_completed_after_days: null,
    archive_inactive_after_days: null,
  },
  notifications: {
    auto_send_welcome: true,
    email_broker_on_client_upload: false,
    email_broker_on_client_message: false,
  },
  role_permissions: DEFAULT_ROLE_PERMISSIONS,
};

const EMPLOYMENT_STATUSES = [
  ['employee', 'Employee'],
  ['self_employed', 'Self-Employed'],
  ['corporation_owner', 'Corporation Owner'],
  ['commissioned', 'Commissioned'],
  ['contract_worker', 'Contract Worker'],
  ['retired', 'Retired'],
  ['unemployed', 'Not Employed'],
  ['other', 'Other'],
];

const STAGES = [
  ['new_inquiry',        'New Inquiry',              'Getting started',                'We have received your information and will be in touch shortly.', 1, '#8b5cf6', 0, 0],
  ['initial_contact',    'Initial Contact',          'Getting started',                'Your broker is gathering the details of your application.', 1, '#8b5cf6', 0, 0],
  ['application_started','Application Started',      'Application in progress',        'Your application has been started. Watch for document requests.', 1, '#6366f1', 0, 0],
  ['docs_requested',     'Documents Requested',      'Documents needed',               'Please upload the requested documents so we can keep things moving.', 2, '#f59e0b', 1, 0],
  ['docs_received',      'Documents Received',       'Documents received',             'Thanks! We have your documents and will review them shortly.', 2, '#f59e0b', 0, 0],
  ['broker_review',      'Broker Review',            'Your application is being reviewed', 'Your broker is reviewing your application and documents.', 3, '#0ea5e9', 0, 0],
  ['ready_to_submit',    'Ready to Submit',          'Preparing your submission',      'Your application is being prepared for submission to the lender.', 3, '#0ea5e9', 0, 0],
  ['submitted',          'Submitted',                'Submitted to lender',            'Your application has been submitted. We will update you as soon as we hear back.', 4, '#14b8a6', 1, 0],
  ['lender_review',      'Lender Review',            'Lender is reviewing',            'The lender is reviewing your application.', 4, '#14b8a6', 0, 0],
  ['conditional_approval','Conditional Approval',    'Conditionally approved',         'Great news — your application is conditionally approved. A few items may still be needed.', 5, '#22c55e', 1, 1],
  ['conditions_outstanding','Conditions Outstanding','A few items are needed',         'A few conditions are outstanding. Your broker will let you know exactly what is needed.', 5, '#f97316', 0, 0],
  ['final_approval',     'Final Approval',           'Approved',                       'Congratulations — your mortgage is approved!', 5, '#16a34a', 1, 0],
  ['closing',            'Closing',                  'Closing',                        'Your file is with the lawyers for closing. Almost there!', 6, '#16a34a', 0, 0],
  ['funded',             'Funded',                   'Funded',                         'Your mortgage has funded. Congratulations!', 6, '#15803d', 1, 0],
  ['completed',          'Completed',                'Completed',                      'Your file is complete. Thank you for working with us!', 6, '#334155', 0, 1],
  ['cancelled',          'Cancelled / Not Proceeding','Not proceeding',                'This application is not proceeding. Contact your broker with any questions.', 1, '#64748b', 0, 1],
];

const APPLICATION_TYPES = [
  ['purchase', 'Purchase'],
  ['builder_purchase', 'Builder Purchase'],
  ['refinance', 'Refinance'],
  ['fthb', 'First-Time Home Buyer'],
  ['business_loan', 'Business Loan'],
];

const DOCUMENT_TYPES = [
  // key, name, category, description
  ['government_id', 'Government ID', 'identity', 'A valid government-issued photo ID (both sides if applicable).'],
  ['t4', 'T4', 'income', 'Your most recent T4 slip.'],
  ['pay_stub', 'Recent Pay Stub', 'income', 'A pay stub from within the last 30 days.'],
  ['employment_letter', 'Employment Letter', 'income', 'A letter from your employer confirming position, tenure and income.'],
  ['noa', 'Notice of Assessment', 'income', 'Your most recent CRA Notice of Assessment.'],
  ['t1_general', 'T1 General', 'income', 'Your most recent T1 General tax return.'],
  ['purchase_agreement', 'Purchase Agreement', 'property', 'The fully signed Agreement of Purchase and Sale.'],
  ['mls_listing', 'MLS Listing', 'property', 'The MLS listing for the property.'],
  ['down_payment_verification', 'Down Payment Verification', 'financial', '90-day history of the account(s) holding your down payment.'],
  ['gift_letter', 'Gift Letter', 'financial', 'A signed gift letter if part of your down payment is a gift.'],
  ['bank_statements', 'Bank Statements', 'financial', 'Recent bank statements.'],
  ['mortgage_statement', 'Existing Mortgage Statement', 'property', 'Your most recent mortgage statement.'],
  ['property_tax_bill', 'Property Tax Bill', 'property', 'Your most recent property tax bill.'],
  ['home_insurance', 'Home Insurance', 'property', 'Proof of home insurance.'],
  ['void_cheque', 'Void Cheque / PAD Form', 'financial', 'A void cheque or pre-authorized debit form.'],
  ['business_financials', 'Business Financial Statements', 'financial', 'Business financial statements for the last 2 years.'],
  ['articles_of_incorporation', 'Articles of Incorporation', 'financial', 'Articles of incorporation for your business.'],
  ['business_bank_statements', 'Business Bank Statements', 'financial', 'Business bank statements for the last 6 months.'],
];

/**
 * Rule conditions JSON:
 *   application_type_keys: [..]  — match any (empty/omitted = any type)
 *   employment_types: [..]       — applicant-level; items become per-applicant for matching applicants
 *   fthb: true                   — only when file is first-time home buyer
 * Items: [document_type_key, requirement, per_applicant, expires_days]
 */
const DOCUMENT_RULES = [
  {
    name: 'All applications — identification',
    conditions: {},
    items: [['government_id', 'required', 1, null]],
  },
  {
    name: 'Purchase — property & down payment',
    conditions: { application_type_keys: ['purchase', 'builder_purchase', 'fthb'] },
    items: [
      ['purchase_agreement', 'required', 0, null],
      ['down_payment_verification', 'required', 0, null],
      ['mls_listing', 'optional', 0, null],
    ],
  },
  {
    name: 'Employees — income documents',
    conditions: { employment_types: ['employee'] },
    items: [
      ['t4', 'required', 1, null],
      ['pay_stub', 'required', 1, 60],
      ['employment_letter', 'required', 1, 90],
      ['noa', 'required', 1, null],
    ],
  },
  {
    name: 'Self-employed — income documents',
    conditions: { employment_types: ['self_employed'] },
    items: [
      ['t1_general', 'required', 1, null],
      ['noa', 'required', 1, null],
      ['business_financials', 'required', 1, null],
      ['business_bank_statements', 'optional', 1, null],
    ],
  },
  {
    name: 'Refinance — property documents',
    conditions: { application_type_keys: ['refinance'] },
    items: [
      ['mortgage_statement', 'required', 0, null],
      ['property_tax_bill', 'required', 0, null],
      ['home_insurance', 'optional', 0, null],
    ],
  },
  {
    name: 'First-time home buyers',
    conditions: { fthb: true },
    items: [['gift_letter', 'optional', 0, null]],
  },
  {
    name: 'Business loans',
    conditions: { application_type_keys: ['business_loan'] },
    items: [
      ['articles_of_incorporation', 'required', 0, null],
      ['business_financials', 'required', 0, null],
      ['business_bank_statements', 'required', 0, null],
    ],
  },
];

const EMAIL_TEMPLATES = [
  {
    key: 'welcome',
    name: 'Welcome / account credentials',
    subject: 'Welcome to {{brokerage_name}}',
    body: `Hi {{client_first_name}},

Welcome to {{brokerage_name}}.

We have created your secure mortgage client portal. Use it to see exactly where your application stands, upload documents, and message {{broker_name}}.

You can access your account here:
{{portal_link}}

Username:
{{username}}

Temporary Password:
{{temporary_password}}

Please log in and change your temporary password after your first login.

If you have any questions, please contact {{broker_name}}.

Best,
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'password_reset',
    name: 'Password reset',
    subject: 'Reset your {{brokerage_name}} portal password',
    body: `Hi {{client_first_name}},

We received a request to reset your portal password. Use the link below to choose a new one:

{{portal_link}}

If you didn't request this, you can safely ignore this email.

{{brokerage_name}}`,
  },
  {
    key: 'stage_changed',
    name: 'Application stage update',
    subject: 'Update on your mortgage application',
    body: `Hi {{client_first_name}},

Good news — there's an update on your application.

Status: {{application_stage}}

Log in to your portal to see the details and any next steps:
{{portal_link}}

{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_requested',
    name: 'Document requested',
    subject: 'We need a document from you: {{document_name}}',
    body: `Hi {{client_first_name}},

To keep your application moving, please upload the following document:

{{document_name}}

You can upload it in a few taps from your phone:
{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_reminder',
    name: 'Document reminder',
    subject: 'Friendly reminder: {{document_name}} still needed',
    body: `Hi {{client_first_name}},

Just a friendly reminder that we're still waiting on:

{{document_name}}

Upload it here whenever you're ready:
{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_rejected',
    name: 'Document needs replacement',
    subject: 'One of your documents needs a replacement',
    body: `Hi {{client_first_name}},

We reviewed your {{document_name}} and need an updated copy.

Please log in to see the details and upload a replacement:
{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_approved',
    name: 'Document approved',
    subject: 'Your {{document_name}} has been approved',
    body: `Hi {{client_first_name}},

Your {{document_name}} has been reviewed and approved. Nothing else is needed for this item.

See your progress here:
{{portal_link}}

{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'new_message',
    name: 'New message notification',
    subject: 'New message from {{broker_name}}',
    body: `Hi {{client_first_name}},

You have a new message from {{broker_name}} in your client portal.

Read and reply here:
{{portal_link}}

{{brokerage_name}}`,
  },
  {
    key: 'generic_update',
    name: 'Important application update',
    subject: 'An update on your mortgage application',
    body: `Hi {{client_first_name}},

There's an update on your mortgage application. Please log in to your portal for the details:

{{portal_link}}

{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'documents_outstanding',
    name: 'Outstanding documents summary',
    subject: 'Documents Required for Your Mortgage Application',
    body: `Hi {{client_first_name}},

We still need the following documents:

{{document_list}}

Please log in to your client portal to upload them:

{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'staff_invite',
    name: 'Staff invitation',
    subject: 'Your {{brokerage_name}} account',
    body: `Hi {{client_first_name}},

An administrator has created a brokerage account for you at {{brokerage_name}}.

Use the link below to set your own password and finish setting up your account. The link works once and expires in 7 days.

{{portal_link}}

No password was set for you, so this link is the only way in. If you were not expecting this email, tell your administrator — do not use the link.

— {{brokerage_name}} platform`,
  },
  {
    key: 'staff_notification',
    name: 'Staff notification (internal)',
    subject: '{{notification_title}}',
    body: `{{notification_title}}

{{notification_body}}

Open the broker portal for details:
{{portal_link}}

— {{brokerage_name}} platform`,
  },
];

async function seedIfNeeded() {
  // Settings
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if ((await getSetting(key, undefined)) === undefined) await setSetting(key, value);
  }

  // Stages
  if (!(await get('SELECT id FROM stages LIMIT 1'))) {
    for (const [i, [key, name, clientLabel, clientMessage, step, color, sendEmail, isTerminal]] of STAGES.entries()) {
      await run(
        `INSERT INTO stages (key, name, client_label, client_message, client_step, color, sort, send_email, email_template_key, is_terminal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key, name, clientLabel, clientMessage, step, color, (i + 1) * 10, sendEmail, sendEmail ? 'stage_changed' : null, isTerminal
      );
    }
  }

  // Application types (services)
  if (!(await get('SELECT id FROM application_types LIMIT 1'))) {
    for (const [i, [key, name]] of APPLICATION_TYPES.entries()) {
      await run('INSERT INTO application_types (key, name, sort) VALUES (?, ?, ?)', key, name, (i + 1) * 10);
    }
  }

  // Employment statuses (configurable; seeded once, then admin-managed)
  if (!(await get('SELECT id FROM employment_statuses LIMIT 1'))) {
    for (const [i, [key, name]] of EMPLOYMENT_STATUSES.entries()) {
      await run('INSERT INTO employment_statuses (key, name, sort) VALUES (?, ?, ?)', key, name, (i + 1) * 10);
    }
  }

  // Document types
  if (!(await get('SELECT id FROM document_types LIMIT 1'))) {
    for (const [i, [key, name, category, description]] of DOCUMENT_TYPES.entries()) {
      await run(
        'INSERT INTO document_types (key, name, category, description, sort) VALUES (?, ?, ?, ?, ?)',
        key, name, category, description, (i + 1) * 10
      );
    }
  }

  // Document rules
  if (!(await get('SELECT id FROM document_rules LIMIT 1'))) {
    for (const rule of DOCUMENT_RULES) {
      const ruleRow = await get(
        'INSERT INTO document_rules (name, active, conditions, created_at, updated_at) VALUES (?, 1, ?, ?, ?) RETURNING id',
        rule.name, JSON.stringify(rule.conditions), now(), now()
      );
      const ruleId = ruleRow.id;
      for (const [docKey, requirement, perApplicant, expiresDays] of rule.items) {
        const doc = await get('SELECT id FROM document_types WHERE key = ?', docKey);
        if (!doc) continue;
        await run(
          'INSERT INTO document_rule_items (rule_id, document_type_id, requirement, per_applicant, expires_days) VALUES (?, ?, ?, ?, ?)',
          ruleId, doc.id, requirement, perApplicant, expiresDays
        );
      }
    }
  }

  // Email templates
  for (const t of EMAIL_TEMPLATES) {
    if (!(await get('SELECT key FROM email_templates WHERE key = ?', t.key))) {
      await run(
        'INSERT INTO email_templates (key, name, subject, body, active) VALUES (?, ?, ?, ?, 1)',
        t.key, t.name, t.subject, t.body
      );
    }
  }

  await bootstrapAdmin();
}

/**
 * Create the first administrator (audit finding C4).
 *
 * There is deliberately no default password. ADMIN_PASSWORD, when supplied,
 * must satisfy the staff password policy; otherwise a strong random one is
 * generated and printed once. Either way the account is flagged
 * must_change_password, so the bootstrap credential cannot become a standing
 * one, and MFA enrolment is then required on first sign-in.
 */
async function bootstrapAdmin() {
  if (await get("SELECT id FROM users WHERE role <> 'client' LIMIT 1")) return null;

  const { hashPassword, validatePasswordStrength, generateTemporaryPassword } = require('./auth');
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) {
    throw new Error(
      'No administrator exists and ADMIN_EMAIL is not set. Set ADMIN_EMAIL (and optionally ' +
      'ADMIN_PASSWORD) to create the first administrator — there is no default account.'
    );
  }

  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (password) {
    // A supplied bootstrap password is held to the same policy as any other
    // staff password — no weak value can enter the system this way.
    await validatePasswordStrength(password, { role: 'admin', user: { email } });
  } else {
    password = generateTemporaryPassword(6);
    generated = true;
  }

  await run(
    `INSERT INTO users (role, email, first_name, last_name, password_hash, status, must_change_password, created_at, updated_at)
     VALUES ('admin', ?, 'Admin', 'User', ?, 'active', 1, ?, ?)`,
    email, await hashPassword(password), now(), now()
  );

  if (generated) {
    console.log('--------------------------------------------------------------');
    console.log('  Created the first administrator account.');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);
    console.log('  This is shown once. You must change it at first sign-in,');
    console.log('  and then enrol in two-step verification.');
    console.log('--------------------------------------------------------------');
  }
  return { email, generated };
}

module.exports = {
  seedIfNeeded,
  bootstrapAdmin,
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_EMAIL_TEMPLATES: EMAIL_TEMPLATES,
};
