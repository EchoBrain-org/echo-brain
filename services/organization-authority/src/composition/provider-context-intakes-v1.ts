import type { MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import { createGranolaContextSourceV1 } from '@echo-brain/provider-granola/context/granola-context-source-v1';
import { createJiraContextSourceV1, type JiraContextSourceOptionsV1 } from '@echo-brain/provider-jira/jira-context-source-v1';
import {
  createContextSourceIntakeV1, type ContextSourceIntakeOptionsV1, type ContextSourceIntakeV1,
} from './context-source-intake-v1.js';

type AuthorityBinding = Pick<ContextSourceIntakeOptionsV1, 'organization_id' | 'authority' | 'require_read_current'>;

/** Opt-in integration profile. Reuses the one configured Granola source. */
export function createGranolaContextIntakeV1(input: AuthorityBinding & {
  readonly source: MeetingSourceAdapter;
  readonly source_instance_id: string;
  readonly retention: ContextSourceIntakeOptionsV1['retention'];
  readonly now?: () => string;
}): ContextSourceIntakeV1 {
  if (input.source.identity.kind !== 'meeting-source' || input.source.identity.adapter_id !== 'granola' ||
      input.source.identity.instance_id !== input.source_instance_id) throw new Error('Granola context source differs from its configured binding');
  const source = createGranolaContextSourceV1({ source: input.source, ...(input.now === undefined ? {} : { now: input.now }) });
  return createContextSourceIntakeV1({
    source,
    identity: { kind: 'source', adapter_id: 'granola-context-capture', instance_id: input.source_instance_id, version: '1.0.0' },
    organization_id: input.organization_id,
    authority: input.authority,
    require_read_current: input.require_read_current,
    retention: input.retention,
  });
}

/** Jira defaults to request-only; retained captures require an explicit pointer-only Authority binding. */
export function createJiraContextIntakeV1(input: AuthorityBinding &
  Pick<JiraContextSourceOptionsV1, 'transport' | 'project' | 'representation' | 'now'> & {
    readonly source_instance_id: string;
    readonly retention?: ContextSourceIntakeOptionsV1['retention'];
  }): ContextSourceIntakeV1 {
  if (input.transport.binding.organization_id !== input.organization_id) throw new Error('Jira context source differs from its configured organization');
  const retention: ContextSourceIntakeOptionsV1['retention'] = input.retention ?? { disposition: 'request_only' };
  if (retention.disposition === 'retained' && input.representation !== 'pointer') throw new Error('Jira retained context requires pointer representation');
  const identity = Object.freeze({ kind: 'source' as const, adapter_id: 'jira-context-capture', instance_id: input.source_instance_id, version: '1.0.0' });
  const source = createJiraContextSourceV1({
    transport: input.transport, project: input.project, instance_id: input.source_instance_id,
    representation: input.representation, ...(input.now === undefined ? {} : { now: input.now }),
  });
  return createContextSourceIntakeV1({
    source, identity, organization_id: input.organization_id, authority: input.authority,
    require_read_current: input.require_read_current, retention,
  });
}
