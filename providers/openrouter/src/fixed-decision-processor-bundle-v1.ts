import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type { AdapterConfig } from "@echo-brain/organization-processing/core/contracts/adapter";
import type { DecisionProcessorAdapter } from "@echo-brain/organization-processing/core/ports/adapters";
import type { DecisionProcessorBundleV1 } from "@echo-brain/organization-processing/ports/decision-processor-bundle-v1";

/** One payer's fixed decision processor: what its source admissions commit to, and how it builds that processor. */
export interface FixedDecisionProcessorPayerV1 {
  /** Names the payer in every refusal. */
  readonly label: string;
  /** One refusal for an invalid configuration or a built identity that differs (Claude account's wording); else each is its own. */
  readonly invalid_processor?: string;
  readonly version: string;
  readonly configuration_sha256: Sha256Digest;
  readonly credential_reference_sha256: Sha256Digest;
  readonly config: (instance_id: string) => AdapterConfig;
  /** Builds the admitted processor. Only this may read the payer's credential, after every commitment check. */
  readonly processor: (config: AdapterConfig) => DecisionProcessorAdapter;
}

/** Hashes a non-secret credential reference of one kind, never the credential bytes behind it. */
export function credentialReferenceSha256V1(kind: string, reference: string): Sha256Digest {
  return canonicalSha256({ schema_version: 1, kind, reference });
}

/**
 * The decision-processor bundle both payers use. A source admission's processor commitments must equal the payer's
 * fixed ones before anything reads a credential, and only an instance whose commitments were checked gets a processor:
 * the admitted adapter, version and configuration, validated, with exactly the admitted identity.
 */
export function createFixedDecisionProcessorBundleV1(payer: FixedDecisionProcessorPayerV1): DecisionProcessorBundleV1 {
  const checkedInstances = new Set<string>();
  return Object.freeze({
    processor_adapter_id: "llm",
    current_commitments(instance_id: string) {
      return Object.freeze({ adapter_id: "llm", instance_id, version: payer.version, configuration_sha256: payer.configuration_sha256,
        credential_reference_sha256: payer.credential_reference_sha256 });
    },
    assert_admission_commitments({ processor }) {
      if (processor.adapter_id !== "llm" || processor.version !== payer.version || processor.configuration_sha256 !== payer.configuration_sha256 ||
          processor.credential_reference_sha256 !== payer.credential_reference_sha256) {
        throw new Error(`${payer.label} processor configuration differs from the admitted processor commitment`);
      }
      checkedInstances.add(processor.instance_id);
    },
    create_processor({ processor: admitted }) {
      if (!checkedInstances.has(admitted.instance_id)) throw new Error(`${payer.label} decision-processor admission commitments were not checked`);
      const differs = () => new Error(`${payer.label} decision-processor differs from the admitted processor`);
      if (admitted.adapter_id !== "llm" || admitted.version !== payer.version || admitted.configuration_sha256 !== payer.configuration_sha256) throw differs();
      const config = payer.config(admitted.instance_id);
      const processor = payer.processor(config);
      const validation = processor.validateConfig(config);
      if (!validation.ok) throw new Error(payer.invalid_processor ?? `${payer.label} decision-processor configuration is invalid: ${validation.errors.join("; ")}`);
      const { identity } = processor;
      if (identity.adapter_id !== admitted.adapter_id || identity.instance_id !== admitted.instance_id || identity.version !== admitted.version) throw payer.invalid_processor === undefined ? differs() : new Error(payer.invalid_processor);
      return processor;
    },
  } satisfies DecisionProcessorBundleV1);
}
