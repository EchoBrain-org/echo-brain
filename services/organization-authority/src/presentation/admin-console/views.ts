import type {
  OrganizationAdminOverviewV1,
  OrganizationAuditPageV1,
  OrganizationEnrollmentGrantPageV1,
  OrganizationInstallationPageV1,
  OrganizationMembershipPageV1,
} from '@echo-brain/organization-api';
import {
  ADMIN_CONSOLE_SCRIPT_PATH,
  ADMIN_CONSOLE_STYLESHEET_PATH,
} from './assets.js';
import type { OrganizationIntegrationsOverview } from '../organization-integrations-http-application.js';

export interface AdminConsoleDashboardView {
  readonly overview: OrganizationAdminOverviewV1;
  readonly memberships: OrganizationMembershipPageV1;
  readonly installations: OrganizationInstallationPageV1;
  readonly enrollment_grants: OrganizationEnrollmentGrantPageV1;
  readonly audit: OrganizationAuditPageV1;
  readonly integrations?: OrganizationIntegrationsOverview;
  readonly csrf_token: string;
}

export function escapeAdminConsoleHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(title: string, body: string, csrfToken?: string): string {
  const csrfMeta =
    csrfToken === undefined
      ? ''
      : `<meta name="echo-admin-csrf" content="${escapeAdminConsoleHtml(csrfToken)}">`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${csrfMeta}
  <title>${escapeAdminConsoleHtml(title)} · ECHO Organization</title>
  <link rel="stylesheet" href="${ADMIN_CONSOLE_STYLESHEET_PATH}">
  <script src="${ADMIN_CONSOLE_SCRIPT_PATH}" defer></script>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderAdminConsoleLogin(message?: string): string {
  const alert =
    message === undefined
      ? ''
      : `<p class="error" role="alert">${escapeAdminConsoleHtml(message)}</p>`;
  return layout(
    'Administrator login',
    `<main class="login-shell">
  <section class="panel">
    <h1>Organization authority</h1>
    <p class="muted">Enter the authority administrator credential. It is verified once and is never placed in browser storage or a session cookie.</p>
    ${alert}
    <form method="post" action="/admin/login">
      <label>Administrator credential
        <input name="credential" type="password" autocomplete="off" spellcheck="false" required maxlength="4096">
      </label>
      <p class="actions"><button type="submit">Sign in</button></p>
    </form>
  </section>
</main>`,
  );
}

export function renderAdminConsoleError(
  title: string,
  message: string,
): string {
  return layout(
    title,
    `<main class="login-shell">
  <section class="panel">
    <h1>${escapeAdminConsoleHtml(title)}</h1>
    <p class="error" role="alert">${escapeAdminConsoleHtml(message)}</p>
    <p><a href="/admin">Return to the organization console</a></p>
  </section>
</main>`,
  );
}

function metric(label: string, value: number): string {
  return `<div class="metric"><span class="muted">${escapeAdminConsoleHtml(label)}</span><strong>${escapeAdminConsoleHtml(value)}</strong></div>`;
}

function emptyRow(columns: number, message: string): string {
  return `<tr><td colspan="${columns}" class="muted">${escapeAdminConsoleHtml(message)}</td></tr>`;
}

function csrfInput(token: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeAdminConsoleHtml(token)}">`;
}

function membershipRows(
  page: OrganizationMembershipPageV1,
  csrfToken: string,
): string {
  if (page.items.length === 0) return emptyRow(6, 'No members yet.');
  return page.items
    .map((member) => {
      const membershipPath = encodeURIComponent(member.membership_id);
      const actions =
        member.status === 'active'
          ? `<form class="inline-form" data-invitation-form action="/admin/memberships/${membershipPath}/enrollment-grants" method="post">
      <label>Invitation lifetime
        <input name="lifetime_seconds" type="number" min="1" max="604800" value="86400" required>
      </label>
      <button type="submit">Create invitation</button>
    </form>
    <form class="inline-form" action="/admin/memberships/${membershipPath}/revocations" method="post">
      ${csrfInput(csrfToken)}
      <input name="reason" type="hidden" value="revoked by organization administrator">
      <button class="danger" type="submit">Revoke member</button>
    </form>`
          : '<span class="muted">No actions</span>';
      return `<tr>
  <td>${escapeAdminConsoleHtml(member.display_name)}</td>
  <td>${escapeAdminConsoleHtml(member.membership_type)}</td>
  <td><span class="status">${escapeAdminConsoleHtml(member.status)}</span></td>
  <td><code>${escapeAdminConsoleHtml(member.membership_id)}</code></td>
  <td>${escapeAdminConsoleHtml(member.provisioned_at)}</td>
  <td>${actions}</td>
</tr>`;
    })
    .join('');
}

function installationRows(
  page: OrganizationInstallationPageV1,
  csrfToken: string,
): string {
  if (page.items.length === 0) return emptyRow(6, 'No installations yet.');
  return page.items
    .map((installation) => {
      const installationPath = encodeURIComponent(installation.installation_id);
      const action =
        installation.status === 'active'
          ? `<form class="inline-form" action="/admin/installations/${installationPath}/revocations" method="post">
      ${csrfInput(csrfToken)}
      <input name="reason" type="hidden" value="revoked by organization administrator">
      <button class="danger" type="submit">Revoke install</button>
    </form>`
          : '<span class="muted">No actions</span>';
      return `<tr>
  <td><code>${escapeAdminConsoleHtml(installation.installation_id)}</code></td>
  <td><code>${escapeAdminConsoleHtml(installation.membership_id)}</code></td>
  <td><span class="status">${escapeAdminConsoleHtml(installation.status)}</span></td>
  <td>${escapeAdminConsoleHtml(installation.current_access_sequence)}</td>
  <td>${escapeAdminConsoleHtml(installation.enrolled_at)}</td>
  <td>${action}</td>
</tr>`;
    })
    .join('');
}

function enrollmentGrantRows(page: OrganizationEnrollmentGrantPageV1): string {
  if (page.items.length === 0) return emptyRow(5, 'No invitation grants yet.');
  return page.items
    .map(
      (grant) => `<tr>
  <td><code>${escapeAdminConsoleHtml(grant.enrollment_grant_sha256)}</code></td>
  <td><code>${escapeAdminConsoleHtml(grant.membership_id)}</code></td>
  <td><span class="status">${escapeAdminConsoleHtml(grant.status)}</span></td>
  <td>${escapeAdminConsoleHtml(grant.issued_at)}</td>
  <td>${escapeAdminConsoleHtml(grant.expires_at)}</td>
</tr>`,
    )
    .join('');
}

function jsonDetail(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unavailable]';
  }
}

function auditRows(page: OrganizationAuditPageV1): string {
  if (page.items.length === 0) return emptyRow(5, 'No audit entries yet.');
  return page.items
    .map(
      (entry) => `<tr>
  <td>${escapeAdminConsoleHtml(entry.audit_sequence)}</td>
  <td>${escapeAdminConsoleHtml(entry.occurred_at)}</td>
  <td>${escapeAdminConsoleHtml(entry.actor_kind)}</td>
  <td>${escapeAdminConsoleHtml(entry.action)}<br><code>${escapeAdminConsoleHtml(entry.subject_id)}</code></td>
  <td><code>${escapeAdminConsoleHtml(jsonDetail(entry.detail))}</code></td>
</tr>`,
    )
    .join('');
}

interface ActiveSlackOrganizationTool {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly bot_user_id: string;
  readonly channel_id: string;
  readonly granted_scopes: readonly string[];
  readonly activated_at: string;
}

const SLACK_ORGANIZATION_TOOL_PROFILE = 'slack-organization-tool-v1';
const REQUIRED_SLACK_ORGANIZATION_TOOL_SCOPES = [
  'channels:history',
  'channels:read',
  'chat:write',
  'reactions:read',
  'users:read',
] as const;
const PUBLIC_SLACK_CHANNEL_ID = /^C[A-Z0-9]{2,127}$/;

function recordString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  const candidate = jsonValue(value);
  return candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate)
    ? (candidate as Readonly<Record<string, unknown>>)
    : null;
}

function jsonStringArray(value: unknown): readonly string[] | null {
  const candidate = jsonValue(value);
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.some(
      (item) => typeof item !== 'string' || item.length === 0,
    )
  ) {
    return null;
  }
  return candidate as readonly string[];
}

function activeSlackOrganizationTool(
  overview: OrganizationIntegrationsOverview | undefined,
): ActiveSlackOrganizationTool | null {
  if (overview === undefined) return null;
  for (const connection of overview.tool_connections) {
    if (
      recordString(connection, 'provider') !== 'slack' ||
      recordString(connection, 'owner_kind') !== 'organization' ||
      recordString(connection, 'status') !== 'active'
    ) {
      continue;
    }
    const configuration = jsonRecord(
      connection['public_configuration_json'],
    );
    const scopes = jsonStringArray(connection['granted_scopes_json']);
    const connectionId = recordString(connection, 'connection_id');
    const workspaceId = recordString(connection, 'provider_tenant_id');
    const botUserId = recordString(connection, 'provider_subject_id');
    const activatedAt = recordString(connection, 'activated_at');
    const channelId =
      configuration === null
        ? null
        : recordString(configuration, 'channel_id');
    const configuredBotUserId =
      configuration === null
        ? null
        : recordString(configuration, 'slack_bot_user_id');
    if (
      connectionId !== null &&
      workspaceId !== null &&
      botUserId !== null &&
      channelId !== null &&
      scopes !== null &&
      activatedAt !== null &&
      configuration?.['schema_version'] === 1 &&
      configuration['organization_tool_profile'] ===
        SLACK_ORGANIZATION_TOOL_PROFILE &&
      PUBLIC_SLACK_CHANNEL_ID.test(channelId) &&
      configuredBotUserId === botUserId &&
      REQUIRED_SLACK_ORGANIZATION_TOOL_SCOPES.every((scope) =>
        scopes.includes(scope),
      )
    ) {
      return {
        connection_id: connectionId,
        workspace_id: workspaceId,
        bot_user_id: botUserId,
        channel_id: channelId,
        granted_scopes: scopes,
        activated_at: activatedAt,
      };
    }
  }
  return null;
}

function slackOrganizationToolSection(data: AdminConsoleDashboardView): string {
  if (data.integrations === undefined) {
    return `<section class="panel">
  <div class="section-heading"><h2>Organization tools</h2><span class="status">unavailable</span></div>
  <p class="muted">Organization tool onboarding is unavailable in this Authority runtime.</p>
</section>`;
  }

  const active = activeSlackOrganizationTool(data.integrations);
  if (active !== null) {
    return `<section class="panel">
  <div class="section-heading"><h2>Organization tools</h2><span class="status">Slack active</span></div>
  <p class="muted">The organization Slack connection passed provider verification.</p>
  <dl class="tool-summary">
    <div><dt>Workspace</dt><dd><code>${escapeAdminConsoleHtml(active.workspace_id)}</code></dd></div>
    <div><dt>Bot user</dt><dd><code>${escapeAdminConsoleHtml(active.bot_user_id)}</code></dd></div>
    <div><dt>Authorized channel</dt><dd><code>${escapeAdminConsoleHtml(active.channel_id)}</code></dd></div>
    <div><dt>Granted scopes</dt><dd>${escapeAdminConsoleHtml(active.granted_scopes.join(', '))}</dd></div>
    <div><dt>Activated</dt><dd>${escapeAdminConsoleHtml(active.activated_at)}</dd></div>
    <div><dt>Connection</dt><dd><code>${escapeAdminConsoleHtml(active.connection_id)}</code></dd></div>
  </dl>
</section>`;
  }

  const owners = data.memberships.items.filter(
    (membership) =>
      membership.status === 'active' && membership.membership_type === 'owner',
  );
  if (owners.length === 0) {
    return `<section class="panel">
  <div class="section-heading"><h2>Organization tools</h2><span class="status">Slack inactive</span></div>
  <p class="warning">An active organization owner is required before Slack can be activated.</p>
</section>`;
  }
  const ownerOptions = owners
    .map(
      (owner) =>
        `<option value="${escapeAdminConsoleHtml(owner.membership_id)}">${escapeAdminConsoleHtml(owner.display_name)}</option>`,
    )
    .join('');
  return `<section class="panel">
  <div class="section-heading"><h2>Organization tools</h2><span class="status">Slack inactive</span></div>
  <p class="muted">Slack becomes active only after the Authority verifies the bot, workspace, required scopes, and selected channel.</p>
  <form class="form-grid" data-command-form method="post" action="/admin/integrations/slack">
    ${csrfInput(data.csrf_token)}
    <input data-command-id name="command_id" type="hidden" value="">
    <label>Acting organization owner
      <select name="administrator_membership_id" required>${ownerOptions}</select>
    </label>
    <label>Slack bot token
      <input name="slack_bot_token" type="password" autocomplete="off" spellcheck="false" maxlength="16384" required>
    </label>
    <label>Authorized public Slack channel ID
      <input name="channel_id" autocomplete="off" spellcheck="false" pattern="C[A-Z0-9]{2,}" maxlength="128" placeholder="C0123456789" required>
    </label>
    <button type="submit">Verify and activate Slack</button>
  </form>
  <p class="hint">The raw bot token is kept in the Authority's private secret store, not in SQLite or browser storage.</p>
  <noscript><p class="warning">JavaScript is required to generate the one-time administrator command ID for Slack activation.</p></noscript>
</section>`;
}

export function renderAdminConsoleDashboard(
  data: AdminConsoleDashboardView,
): string {
  const { overview, csrf_token: csrfToken } = data;
  const counts = overview.counts;
  const metrics = [
    metric('Active members', counts.active_memberships),
    metric('Revoked members', counts.revoked_memberships),
    metric('Active installations', counts.active_installations),
    metric('Pending invitations', counts.pending_enrollment_grants),
    metric('Audit entries', counts.audit_entries),
  ].join('');

  return layout(
    overview.organization_display_name,
    `<main class="shell">
  <header class="topbar">
    <div>
      <h1>${escapeAdminConsoleHtml(overview.organization_display_name)}</h1>
      <p class="muted"><code>${escapeAdminConsoleHtml(overview.organization_id)}</code> · authority <code>${escapeAdminConsoleHtml(overview.authority_id)}</code></p>
    </div>
    <form method="post" action="/admin/logout">
      ${csrfInput(csrfToken)}
      <button class="secondary" type="submit">Sign out</button>
    </form>
  </header>

  <section class="grid" aria-label="Organization overview">${metrics}</section>

  ${slackOrganizationToolSection(data)}

  <section class="panel">
    <div class="section-heading"><h2>Add a member</h2><span class="hint">A command ID prevents duplicate creation during this submission.</span></div>
    <form class="form-grid" data-command-form method="post" action="/admin/memberships">
      ${csrfInput(csrfToken)}
      <input data-command-id name="command_id" type="hidden" value="">
      <label>Display name
        <input name="display_name" maxlength="200" required>
      </label>
      <label>Membership type
        <select name="membership_type"><option value="employee">Employee</option><option value="owner">Owner</option></select>
      </label>
      <button type="submit">Add member</button>
    </form>
    <noscript><p class="warning">JavaScript is required to generate administrator command IDs and one-time invitation material.</p></noscript>
  </section>

  <section class="panel">
    <div class="section-heading"><h2>Members</h2><span class="hint">First ${data.memberships.items.length} records</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Membership ID</th><th>Provisioned</th><th>Actions</th></tr></thead>
      <tbody>${membershipRows(data.memberships, csrfToken)}</tbody>
    </table></div>
  </section>

  <section class="panel" data-invitation-output hidden>
    <h2>One-time invitation envelope</h2>
    <p class="warning"><strong>This is the complete transport envelope and its grant cannot be recovered after reload.</strong> Copy or download it now. The embedded authority PIN digest is informational; independently verify the authority PIN through a separate trusted channel.</p>
    <pre data-invitation-material></pre>
    <p class="actions">
      <button type="button" data-copy-invitation>Copy</button>
      <button class="secondary" type="button" data-download-invitation>Download JSON</button>
    </p>
  </section>
  <p data-invitation-status aria-live="polite" hidden></p>

  <section class="panel">
    <div class="section-heading"><h2>Installations</h2><span class="hint">First ${data.installations.items.length} records</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Installation ID</th><th>Member</th><th>Status</th><th>Sequence</th><th>Enrolled</th><th>Actions</th></tr></thead>
      <tbody>${installationRows(data.installations, csrfToken)}</tbody>
    </table></div>
  </section>

  <section class="panel">
    <div class="section-heading"><h2>Invitation grants</h2><span class="hint">Digest only · first ${data.enrollment_grants.items.length} records</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Grant digest</th><th>Member</th><th>Status</th><th>Issued</th><th>Expires</th></tr></thead>
      <tbody>${enrollmentGrantRows(data.enrollment_grants)}</tbody>
    </table></div>
  </section>

  <section class="panel">
    <div class="section-heading"><h2>Recent audit</h2><span class="hint">First ${data.audit.items.length} records</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Sequence</th><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${auditRows(data.audit)}</tbody>
    </table></div>
  </section>

  <footer class="muted">
    <p>Authority PIN digest: <code>${escapeAdminConsoleHtml(overview.authority_pin_sha256)}</code></p>
    <p>Last observed ${escapeAdminConsoleHtml(overview.last_observed_at)}</p>
  </footer>
</main>`,
    csrfToken,
  );
}
