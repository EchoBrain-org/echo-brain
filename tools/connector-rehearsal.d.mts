export interface ConnectorRehearsalStatusV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-connector-rehearsal-status-v1';
  readonly status: 'prepared' | 'configuration_ready';
  readonly directory: string;
  readonly qualified: false;
  readonly missing_inputs?: readonly string[];
}

export interface ConnectorRehearsalConfigurationV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-connector-rehearsal-config-v1';
  readonly authority_url: string;
  readonly organization_name: string;
  readonly owner_name: string;
  readonly owner_email: string;
  readonly oidc: Readonly<{ config_file: string; client_secret_file: string | null }>;
  readonly nango: Readonly<{ secret_key_file: string; slack_integration_key: string; jira_integration_key: string }>;
  readonly jira: Readonly<{ cloud_id: string; project: string }>;
  readonly granola: Readonly<{ credential_file: string; owner_email_file: string }>;
  readonly openrouter: Readonly<{ credential_file: string }>;
}

export interface ConnectorRehearsalExecutionV1 {
  readonly directory: string;
  readonly paths: Readonly<{
    root: string;
    marker: string;
    config: string;
    state: string;
    person: string;
    private: string;
    receipts: string;
  }>;
  readonly configuration: ConnectorRehearsalConfigurationV1;
}

export function prepare(directory: string): ConnectorRehearsalStatusV1;
export function preflight(directory: string): ConnectorRehearsalStatusV1;
export function readExecutionConfiguration(directory: string): ConnectorRehearsalExecutionV1;
export function main(argv?: readonly string[]): Promise<number>;
