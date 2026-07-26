import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareOrganizationInvitation,
  recordOrganizationInvitationIssued,
  type PrepareOrganizationInvitationOptions,
} from '../src/adapters/files/private-organization-invitation.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
} as const;

const PIN =
  'sha256:b237acdd2200b3d2f3816778a40994d872b44345ab4c1cc4ad370630b0f03db2' as const;
const FIXED_UUID = '10000000-0000-4000-8000-000000000001';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function invitationDirectory(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-private-invitation-')),
  );
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function options(
  directory: string,
  overrides: Partial<PrepareOrganizationInvitationOptions> = {},
): PrepareOrganizationInvitationOptions {
  return {
    output_path: join(directory, 'employee.invitation.json'),
    authority_base_url: 'https://authority.example.com',
    authority_id: IDS.authority,
    authority_pin_sha256: PIN,
    organization_id: IDS.organization,
    membership_id: IDS.membership,
    lifetime_seconds: 3600,
    random_bytes: (size) => Buffer.alloc(size, 11),
    random_uuid: () => FIXED_UUID,
    ...overrides,
  };
}

describe('private organization invitation adapter', () => {
  it('atomically publishes a canonical 0600 pending envelope and reuses its durable intent', () => {
    const directory = invitationDirectory();
    const first = prepareOrganizationInvitation(options(directory));
    const raw = readFileSync(first.output_path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(lstatSync(first.output_path).mode & 0o777).toBe(0o600);
    expect(raw.endsWith('\n')).toBe(true);
    expect(parsed).toMatchObject({
      status: 'pending_registration',
      authority_base_url: 'https://authority.example.com',
      authority_pin_verification: 'independent_pin_required',
      command_id: `adm_${FIXED_UUID}`,
      enrollment_grant_base64url: Buffer.alloc(32, 11).toString('base64url'),
      issued: null,
    });
    expect(readdirSync(directory)).toEqual(['employee.invitation.json']);

    const retried = prepareOrganizationInvitation(
      options(directory, {
        random_bytes: () => {
          throw new Error('durable intent generated a replacement secret');
        },
        random_uuid: () => {
          throw new Error('durable intent generated a replacement command');
        },
      }),
    );
    expect(retried.envelope).toEqual(first.envelope);

    const recorded = recordOrganizationInvitationIssued(retried, {
      authority_id: IDS.authority,
      authority_pin_sha256: PIN,
      organization_id: IDS.organization,
      principal_id: IDS.principal,
      membership_id: IDS.membership,
      enrollment_grant_sha256: retried.envelope.enrollment_grant_sha256,
      issued_at: '2026-07-22T00:00:00.000Z',
      expires_at: '2026-07-22T01:00:00.000Z',
    });
    expect(recorded.status).toBe('issued');
    expect(recorded.enrollment_grant_base64url).toBe(
      first.envelope.enrollment_grant_base64url,
    );
    expect(lstatSync(first.output_path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['employee.invitation.json']);
  });

  it('never clobbers a pre-existing target that is not the matching durable intent', () => {
    const directory = invitationDirectory();
    const invitationOptions = options(directory);
    const original = '{"belongs_to":"someone_else"}\n';
    writeFileSync(invitationOptions.output_path, original, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(invitationOptions.output_path, 0o600);

    expect(() => prepareOrganizationInvitation(invitationOptions)).toThrow();
    expect(readFileSync(invitationOptions.output_path, 'utf8')).toBe(original);
  });

  it.each([
    'http://authority.example.com',
    'https://authority.example.com/path',
    'https://user@authority.example.com',
    'https://authority.example.com?query=yes',
    'https://authority.example.com:443',
    'https://2130706433',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://999.999.999.999',
  ])('rejects a noncanonical or insecure public authority URL %s', (url) => {
    const directory = invitationDirectory();
    expect(() =>
      prepareOrganizationInvitation(
        options(directory, { authority_base_url: url }),
      ),
    ).toThrow('authority base URL');
  });

  it.each([
    'https://authority.example.com',
    'https://authority.example.com:8443',
    'http://127.0.0.1:39479',
    'http://[::1]:39479',
  ])('accepts a bare HTTPS or development-loopback origin %s', (url) => {
    const directory = invitationDirectory();
    expect(() =>
      prepareOrganizationInvitation(
        options(directory, { authority_base_url: url }),
      ),
    ).not.toThrow();
  });
});
