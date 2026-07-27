import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestCertificate {
  readonly certificate_path: string;
  readonly private_key_path: string;
  readonly certificate: Buffer;
  readonly private_key: Buffer;
}

export interface TestPki {
  readonly directory: string;
  readonly ca_certificate_path: string;
  readonly ca_certificate: Buffer;
  readonly server: TestCertificate;
  readonly admin_one: TestCertificate;
  readonly admin_two: TestCertificate;
  readonly untrusted_admin: TestCertificate;
  cleanup(): void;
}

export interface TestServerPurposeCertificates {
  readonly ca_server: TestCertificate;
  readonly client_auth_only: TestCertificate;
}

function openssl(arguments_: readonly string[], directory: string): void {
  execFileSync('openssl', arguments_, {
    cwd: directory,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function assertTrustedCertificateChain(
  caCertificate: Buffer,
  issuedCertificates: readonly TestCertificate[],
): void {
  const ca = new X509Certificate(caCertificate);
  if (!ca.ca) {
    throw new Error('administrator edge test CA is not a valid CA certificate');
  }
  for (const issuedCertificate of issuedCertificates) {
    const certificate = new X509Certificate(issuedCertificate.certificate);
    if (!certificate.checkIssued(ca) || !certificate.verify(ca.publicKey)) {
      throw new Error(
        'administrator edge test certificate was not issued by the test CA',
      );
    }
  }
}

function issueCertificate(input: {
  readonly directory: string;
  readonly name: string;
  readonly common_name: string;
  readonly serial: number;
  readonly extensions: string;
}): TestCertificate {
  const key = `${input.name}.key.pem`;
  const request = `${input.name}.csr.pem`;
  const certificate = `${input.name}.cert.pem`;
  const extensionFile = `${input.name}.ext`;
  writeFileSync(join(input.directory, extensionFile), input.extensions, {
    encoding: 'utf8',
    mode: 0o600,
  });
  openssl(
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      `/CN=${input.common_name}`,
      '-keyout',
      key,
      '-out',
      request,
    ],
    input.directory,
  );
  openssl(
    [
      'x509',
      '-req',
      '-sha256',
      '-days',
      '2',
      '-in',
      request,
      '-CA',
      'ca.cert.pem',
      '-CAkey',
      'ca.key.pem',
      '-set_serial',
      String(input.serial),
      '-extfile',
      extensionFile,
      '-out',
      certificate,
    ],
    input.directory,
  );
  const certificatePath = realpathSync(join(input.directory, certificate));
  const privateKeyPath = realpathSync(join(input.directory, key));
  chmodSync(certificatePath, 0o600);
  chmodSync(privateKeyPath, 0o600);
  return {
    certificate_path: certificatePath,
    private_key_path: privateKeyPath,
    certificate: readFileSync(certificatePath),
    private_key: readFileSync(privateKeyPath),
  };
}

export function createTestServerPurposeCertificates(
  pki: Pick<TestPki, 'directory' | 'ca_certificate'>,
  serverHostname = 'admin.edge.test',
): TestServerPurposeCertificates {
  const caServer = issueCertificate({
    directory: pki.directory,
    name: 'ca-server',
    common_name: serverHostname,
    serial: 1101,
    extensions: [
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      'keyUsage=critical,keyCertSign,cRLSign',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${serverHostname}`,
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid:always',
      '',
    ].join('\n'),
  });
  const clientAuthOnly = issueCertificate({
    directory: pki.directory,
    name: 'client-auth-only',
    common_name: serverHostname,
    serial: 1102,
    extensions: [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=clientAuth',
      `subjectAltName=DNS:${serverHostname}`,
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid:always',
      '',
    ].join('\n'),
  });
  assertTrustedCertificateChain(pki.ca_certificate, [caServer, clientAuthOnly]);
  return {
    ca_server: caServer,
    client_auth_only: clientAuthOnly,
  };
}

export function createTestPki(serverHostname = 'admin.edge.test'): TestPki {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-admin-edge-pki-')),
  );
  chmodSync(directory, 0o700);
  try {
    writeFileSync(
      join(directory, 'ca.cnf'),
      [
        '[req]',
        'distinguished_name=ca_distinguished_name',
        'x509_extensions=ca_extensions',
        'prompt=no',
        '',
        '[ca_distinguished_name]',
        'CN=ECHO Admin Edge Test CA',
        '',
        '[ca_extensions]',
        'basicConstraints=critical,CA:TRUE',
        'keyUsage=critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid:always',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '2',
        '-config',
        'ca.cnf',
        '-extensions',
        'ca_extensions',
        '-keyout',
        'ca.key.pem',
        '-out',
        'ca.cert.pem',
      ],
      directory,
    );
    const caCertificatePath = realpathSync(join(directory, 'ca.cert.pem'));
    chmodSync(caCertificatePath, 0o600);
    chmodSync(realpathSync(join(directory, 'ca.key.pem')), 0o600);
    const server = issueCertificate({
      directory,
      name: 'server',
      common_name: serverHostname,
      serial: 1001,
      extensions: [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=DNS:${serverHostname}`,
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid:always',
        '',
      ].join('\n'),
    });
    const adminOne = issueCertificate({
      directory,
      name: 'admin-one',
      common_name: 'admin-one',
      serial: 1002,
      extensions: [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=clientAuth',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid:always',
        '',
      ].join('\n'),
    });
    const adminTwo = issueCertificate({
      directory,
      name: 'admin-two',
      common_name: 'admin-two',
      serial: 1003,
      extensions: [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=clientAuth',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid:always',
        '',
      ].join('\n'),
    });
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '2',
        '-subj',
        '/CN=untrusted-admin',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'keyUsage=critical,digitalSignature',
        '-addext',
        'extendedKeyUsage=clientAuth',
        '-keyout',
        'untrusted-admin.key.pem',
        '-out',
        'untrusted-admin.cert.pem',
      ],
      directory,
    );
    const untrustedAdminCertificatePath = realpathSync(
      join(directory, 'untrusted-admin.cert.pem'),
    );
    const untrustedAdminKeyPath = realpathSync(
      join(directory, 'untrusted-admin.key.pem'),
    );
    chmodSync(untrustedAdminCertificatePath, 0o600);
    chmodSync(untrustedAdminKeyPath, 0o600);
    const caCertificate = readFileSync(caCertificatePath);
    assertTrustedCertificateChain(caCertificate, [server, adminOne, adminTwo]);
    return {
      directory,
      ca_certificate_path: caCertificatePath,
      ca_certificate: caCertificate,
      server,
      admin_one: adminOne,
      admin_two: adminTwo,
      untrusted_admin: {
        certificate_path: untrustedAdminCertificatePath,
        private_key_path: untrustedAdminKeyPath,
        certificate: readFileSync(untrustedAdminCertificatePath),
        private_key: readFileSync(untrustedAdminKeyPath),
      },
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
