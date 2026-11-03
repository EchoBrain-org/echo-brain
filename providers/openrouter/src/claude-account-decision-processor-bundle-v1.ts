import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';
import type { ClaudeAccountProfileV1 } from './claude-research/account-profile.js';
import { createClaudeAccountDecisionProcessorV1 } from './llm/claude-account-decision-processor.js';
import { assertClaudeAccountDecisionProcessorRuntimeCommitmentsV1, claudeAccountDecisionProcessorConfigurationSha256V1,
  claudeAccountDecisionProcessorCredentialReferenceV1, claudeAccountDecisionProcessorCredentialReferenceSha256V1,
  CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1, fixedClaudeAccountDecisionProcessorConfigV1 } from './claude-account-decision-processor-config-v1.js';

/** Native authentication stays inside Claude; source admissions bind only its selected non-secret profile. */
export function createClaudeAccountDecisionProcessorBundleV1(input: {
  readonly account: ClaudeAccountProfileV1;
  readonly limit?: <T>(signal: AbortSignal | undefined, op: () => Promise<T>) => Promise<T>;
}): DecisionProcessorBundleV1 {
  const account = Object.freeze({ home_directory: input.account.home_directory, executable_path: input.account.executable_path });
  const reference = claudeAccountDecisionProcessorCredentialReferenceV1(account);
  const checkedInstances = new Set<string>();
  return Object.freeze({
    processor_adapter_id: 'llm',
    current_commitments(instance_id: string) {
      return Object.freeze({ adapter_id: 'llm', instance_id, version: CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
        configuration_sha256: claudeAccountDecisionProcessorConfigurationSha256V1(),
        credential_reference_sha256: claudeAccountDecisionProcessorCredentialReferenceSha256V1(reference) });
    },
    assert_admission_commitments(commitments) {
      assertClaudeAccountDecisionProcessorRuntimeCommitmentsV1({ ...commitments.processor, credential_reference: reference });
      checkedInstances.add(commitments.processor.instance_id);
    },
    create_processor(admission) {
      if (!checkedInstances.has(admission.processor.instance_id)) throw new Error('Claude account decision-processor admission commitments were not checked');
      if (admission.processor.adapter_id !== 'llm' || admission.processor.version !== CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1 ||
          admission.processor.configuration_sha256 !== claudeAccountDecisionProcessorConfigurationSha256V1()) {
        throw new Error('Claude account decision-processor differs from the admitted processor');
      }
      const config = fixedClaudeAccountDecisionProcessorConfigV1(admission.processor.instance_id, reference);
      const processor = createClaudeAccountDecisionProcessorV1(config, { account, ...(input.limit === undefined ? {} : { limit: input.limit }) });
      if (!processor.validateConfig(config).ok || processor.identity.version !== admission.processor.version) {
        throw new Error('Claude account decision-processor configuration is invalid');
      }
      return processor;
    },
  } satisfies DecisionProcessorBundleV1);
}
