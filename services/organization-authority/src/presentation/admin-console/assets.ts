export const ADMIN_CONSOLE_STYLESHEET_PATH = '/admin/assets/admin.css';
export const ADMIN_CONSOLE_SCRIPT_PATH = '/admin/assets/admin.js';

export const ADMIN_CONSOLE_CSS = String.raw`
:root {
  color-scheme: light;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  background: #f4f6f8;
  color: #17212b;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  background: #f4f6f8;
}

a {
  color: #075985;
}

.shell {
  width: min(1180px, calc(100% - 2rem));
  margin: 0 auto;
  padding: 2rem 0 4rem;
}

.login-shell {
  width: min(480px, calc(100% - 2rem));
  margin: 8vh auto 0;
}

.topbar,
.section-heading,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.topbar {
  margin-bottom: 1.5rem;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 0.35rem;
  font-size: clamp(1.65rem, 4vw, 2.4rem);
}

h2 {
  font-size: 1.15rem;
}

.muted,
.hint {
  color: #52606d;
}

.hint {
  font-size: 0.875rem;
}

.panel {
  margin-bottom: 1.25rem;
  padding: 1.25rem;
  overflow: hidden;
  border: 1px solid #d8dee4;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 8px rgb(15 23 42 / 6%);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.metric {
  padding: 1rem;
  border: 1px solid #d8dee4;
  border-radius: 10px;
  background: #fff;
}

.metric strong {
  display: block;
  margin-top: 0.35rem;
  font-size: 1.55rem;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 0.8rem;
  align-items: end;
}

label {
  display: grid;
  gap: 0.35rem;
  font-size: 0.875rem;
  font-weight: 650;
}

input,
select,
button {
  min-height: 2.5rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid #aeb8c2;
  border-radius: 7px;
  font: inherit;
}

input,
select {
  width: 100%;
  background: #fff;
}

button {
  width: auto;
  cursor: pointer;
  border-color: #075985;
  background: #075985;
  color: #fff;
  font-weight: 700;
}

button.secondary {
  border-color: #65717c;
  background: #fff;
  color: #24313d;
}

button.danger {
  border-color: #b42318;
  background: #b42318;
}

button:disabled {
  cursor: wait;
  opacity: 0.65;
}

.inline-form {
  display: inline-flex;
  align-items: end;
  gap: 0.45rem;
  margin: 0.2rem 0.35rem 0.2rem 0;
}

.inline-form label {
  min-width: 8rem;
}

.table-wrap {
  width: 100%;
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

th,
td {
  padding: 0.7rem 0.55rem;
  vertical-align: top;
  border-bottom: 1px solid #e6e9ed;
  text-align: left;
}

th {
  color: #44515d;
  font-size: 0.78rem;
  letter-spacing: 0.025em;
  text-transform: uppercase;
}

code,
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

code {
  overflow-wrap: anywhere;
  font-size: 0.78rem;
}

pre {
  max-height: 26rem;
  margin: 0.75rem 0;
  padding: 1rem;
  overflow: auto;
  border-radius: 8px;
  background: #101820;
  color: #edf6ff;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.status {
  display: inline-block;
  padding: 0.18rem 0.45rem;
  border-radius: 999px;
  background: #e8edf2;
  font-size: 0.75rem;
  font-weight: 700;
}

.warning,
.error,
.success {
  padding: 0.8rem 0.9rem;
  border-radius: 8px;
}

.warning {
  border: 1px solid #e9b949;
  background: #fff8db;
}

.error {
  border: 1px solid #d92d20;
  background: #fff1f0;
  color: #7a271a;
}

.success {
  border: 1px solid #12b76a;
  background: #ecfdf3;
  color: #05603a;
}

[hidden] {
  display: none !important;
}

@media (max-width: 720px) {
  .topbar,
  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .inline-form {
    display: grid;
  }
}
`;

export const ADMIN_CONSOLE_JAVASCRIPT = String.raw`
(() => {
  'use strict';

  const ADM_ID = /^adm_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const DIGEST = /^sha256:[0-9a-f]{64}$/;
  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const invitationStates = new WeakMap();
  let lastInvitationText = '';

  function newCommandId() {
    return 'adm_' + crypto.randomUUID();
  }

  function bytesToBase64url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function bytesToHex(bytes) {
    let result = '';
    for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
    return result;
  }

  function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    const members = [];
    for (const key of Object.keys(value).sort()) {
      members.push(JSON.stringify(key) + ':' + canonicalJson(value[key]));
    }
    return '{' + members.join(',') + '}';
  }

  function csrfToken() {
    const meta = document.querySelector('meta[name="echo-admin-csrf"]');
    return meta instanceof HTMLMetaElement ? meta.content : '';
  }

  function status(message, isError) {
    const target = document.querySelector('[data-invitation-status]');
    if (!(target instanceof HTMLElement)) return;
    target.textContent = message;
    target.className = isError ? 'error' : 'success';
    target.hidden = false;
  }

  async function configuredEnrollmentAuthorityOrigin() {
    let response;
    try {
      response = await fetch('/admin/edge-config', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      throw new Error('The employee authority address is unavailable. Retry after the administrator edge is restored.');
    }
    let config;
    try {
      config = await response.json();
    } catch {
      throw new Error('The administrator edge returned an invalid employee authority address.');
    }
    if (!response.ok || typeof config !== 'object' || config === null ||
        Array.isArray(config) || Object.keys(config).join(',') !== 'authority_base_url' ||
        typeof config.authority_base_url !== 'string' ||
        config.authority_base_url.length === 0 ||
        config.authority_base_url.length > 2048) {
      throw new Error('The administrator edge returned an invalid employee authority address.');
    }
    let origin;
    try {
      const parsed = new URL(config.authority_base_url);
      if (parsed.protocol !== 'https:' || parsed.username !== '' ||
          parsed.password !== '' || parsed.pathname !== '/' ||
          parsed.search !== '' || parsed.hash !== '' ||
          parsed.origin !== config.authority_base_url) {
        throw new Error('invalid origin');
      }
      origin = parsed.origin;
    } catch {
      throw new Error('The administrator edge returned an invalid employee authority address.');
    }
    return origin;
  }

  async function invitationState(form) {
    const retained = invitationStates.get(form);
    if (retained !== undefined) return retained;

    const authorityBaseUrl = await configuredEnrollmentAuthorityOrigin();
    const lifetimeInput = form.elements.namedItem('lifetime_seconds');
    if (!(lifetimeInput instanceof HTMLInputElement)) {
      throw new Error('Invitation lifetime is unavailable.');
    }
    const lifetime = Number(lifetimeInput.value);
    if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 604800) {
      throw new Error('Invitation lifetime must be from 1 through 604800 seconds.');
    }

    const secretBytes = new Uint8Array(32);
    crypto.getRandomValues(secretBytes);
    const secret = bytesToBase64url(secretBytes);
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', secretBytes));
    const state = Object.freeze({
      authority_base_url: authorityBaseUrl,
      command_id: newCommandId(),
      enrollment_grant_base64url: secret,
      enrollment_grant_sha256: 'sha256:' + bytesToHex(digestBytes),
      lifetime_seconds: lifetime,
    });
    invitationStates.set(form, state);
    return state;
  }

  function asIssuedGrant(value, expectedDigest, lifetimeSeconds) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('The authority returned an invalid invitation result.');
    }
    const required = [
      'authority_id',
      'authority_pin_sha256',
      'organization_id',
      'principal_id',
      'membership_id',
      'enrollment_grant_sha256',
      'issued_at',
      'expires_at',
    ];
    for (const key of required) {
      if (typeof value[key] !== 'string' || value[key].length === 0) {
        throw new Error('The authority returned an incomplete invitation result.');
      }
    }
    if (!DIGEST.test(value.enrollment_grant_sha256) || value.enrollment_grant_sha256 !== expectedDigest) {
      throw new Error('The authority returned a mismatched invitation digest.');
    }
    if (!TIMESTAMP.test(value.issued_at) || !TIMESTAMP.test(value.expires_at) ||
        Date.parse(value.expires_at) - Date.parse(value.issued_at) !== lifetimeSeconds * 1000) {
      throw new Error('The authority returned a mismatched invitation lifetime.');
    }
    return {
      authority_id: value.authority_id,
      authority_pin_sha256: value.authority_pin_sha256,
      organization_id: value.organization_id,
      principal_id: value.principal_id,
      membership_id: value.membership_id,
      enrollment_grant_sha256: value.enrollment_grant_sha256,
      issued_at: value.issued_at,
      expires_at: value.expires_at,
    };
  }

  function showInvitation(state, issued) {
    const envelope = {
      schema_version: 1,
      kind: 'echo-organization-enrollment-invitation',
      status: 'issued',
      authority_base_url: state.authority_base_url,
      authority_id: issued.authority_id,
      authority_pin_sha256: issued.authority_pin_sha256,
      authority_pin_verification: 'independent_pin_required',
      organization_id: issued.organization_id,
      membership_id: issued.membership_id,
      command_id: state.command_id,
      enrollment_grant_sha256: state.enrollment_grant_sha256,
      enrollment_grant_base64url: state.enrollment_grant_base64url,
      lifetime_seconds: state.lifetime_seconds,
      issued,
    };
    lastInvitationText = canonicalJson(envelope) + '\n';
    const output = document.querySelector('[data-invitation-output]');
    const text = document.querySelector('[data-invitation-material]');
    if (output instanceof HTMLElement && text instanceof HTMLElement) {
      text.textContent = JSON.stringify(envelope, null, 2);
      output.hidden = false;
      output.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    status('Invitation registered. Copy or download it now; this page cannot recover the grant after reload.', false);
  }

  for (const form of document.querySelectorAll('form[data-command-form]')) {
    form.addEventListener('submit', () => {
      const input = form.querySelector('input[data-command-id]');
      if (input instanceof HTMLInputElement && !ADM_ID.test(input.value)) {
        input.value = newCommandId();
      }
    });
  }

  for (const form of document.querySelectorAll('form[data-invitation-form]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      if (button instanceof HTMLButtonElement) button.disabled = true;
      try {
        const state = await invitationState(form);
        let response;
        try {
          response = await fetch(form.action, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-Echo-Admin-CSRF': csrfToken(),
            },
            body: JSON.stringify({
              command_id: state.command_id,
              enrollment_grant_sha256: state.enrollment_grant_sha256,
              lifetime_seconds: state.lifetime_seconds,
            }),
          });
        } catch {
          throw new Error('The response was ambiguous. Retry to reuse the same command ID and one-time grant.');
        }
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error('The response was ambiguous. Retry to reuse the same command ID and one-time grant.');
        }
        if (!response.ok) {
          const message = result && result.error && typeof result.error.message === 'string'
            ? result.error.message
            : 'The invitation was not accepted.';
          if (response.status >= 500) {
            throw new Error('The response was ambiguous. Retry to reuse the same command ID and one-time grant.');
          }
          throw new Error(message + ' Retry will reuse the same command ID and one-time grant.');
        }
        const issued = asIssuedGrant(
          result.invitation,
          state.enrollment_grant_sha256,
          state.lifetime_seconds,
        );
        showInvitation(state, issued);
        invitationStates.delete(form);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invitation registration failed.';
        status(message, true);
      } finally {
        if (button instanceof HTMLButtonElement) button.disabled = false;
      }
    });
  }

  const copyButton = document.querySelector('[data-copy-invitation]');
  if (copyButton instanceof HTMLButtonElement) {
    copyButton.addEventListener('click', async () => {
      if (lastInvitationText.length === 0) return;
      try {
        await navigator.clipboard.writeText(lastInvitationText);
        status('Invitation copied. Deliver the authority PIN through a separate secure channel.', false);
      } catch {
        status('Clipboard access failed. Select and copy the invitation material manually.', true);
      }
    });
  }

  const downloadButton = document.querySelector('[data-download-invitation]');
  if (downloadButton instanceof HTMLButtonElement) {
    downloadButton.addEventListener('click', () => {
      if (lastInvitationText.length === 0) return;
      const objectUrl = URL.createObjectURL(new Blob([lastInvitationText], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'echo-organization-invitation.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    });
  }
})();
`;
