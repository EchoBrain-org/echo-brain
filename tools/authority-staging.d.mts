import type {
  FetchLike,
  PutSecretValue,
  StagingEdgeState,
  StagingEdgeInput,
} from "./authority-staging-edge.mjs";

export type StagingLifecycleInput = Readonly<{
  region: string;
  operationId: string;
  slotId: string;
  stack: Readonly<{
    name: string;
    parameters: Readonly<Record<string, string>>;
  }>;
  edge: Readonly<{
    accountId: string;
    zoneId: string;
    hostname: string;
  }>;
  /** Independently trusted `sha256:` pin for accepted Authority recovery. */
  authorityPinSha256?: string;
  hostSetup?: Readonly<{ path: string; key: string; sha256: string }>;
}>;

export type StackStatus =
  | Readonly<{ exists: false }>
  | Readonly<{
      exists: true;
      status: string;
      outputs: Readonly<Record<string, string>>;
      pendingCreate?: boolean;
      failedCreate?: boolean;
      terminationProtection: boolean;
    }>;

export type ChangeSetRequest = Readonly<{
  region: string;
  stackName: string;
  changeSetName: string;
  changeSetType: "CREATE" | "UPDATE";
  clientToken: string;
  /** Present only for slot-init, and bound into the reviewed description. */
  edgePlanBinding?: Readonly<{
    account_id: string;
    hostname: string;
    slot_id: string;
    zone_id: string;
  }>;
  onStackFailure?: "DO_NOTHING";
  templatePath: string;
  templateSha256: string;
  capabilities: readonly ["CAPABILITY_IAM"];
  parameters: Readonly<Record<string, string>>;
}>;

export type ChangeSetPlan =
  | Readonly<{
      kind: "no_changes";
      changeSetType: "CREATE" | "UPDATE";
      matchesExpected: boolean;
    }>
  | Readonly<{
      id: string;
      status: "CREATE_COMPLETE";
      kind: "change_set";
      changeSetType: "CREATE" | "UPDATE";
      matchesExpected: boolean;
      actions: readonly Readonly<{
        action: string;
        logicalId: string;
        resourceType: string;
        replacement?: boolean | "True" | "False" | "Conditional";
      }>[];
      artifact?: Readonly<{ key: string; version: string; sha256: string }>;
    }>;

export type CloudFormationAdapter = Readonly<{
  describeStack(
    input: Readonly<{ region: string; stackName: string }>,
  ): Promise<StackStatus>;
  createChangeSet(input: ChangeSetRequest): Promise<ChangeSetPlan>;
  describeChangeSet(input: ChangeSetRequest): Promise<ChangeSetPlan>;
  executeChangeSet(
    input: Readonly<{
      region: string;
      stackName: string;
      changeSetId: string;
      changeSetType: "CREATE" | "UPDATE";
      clientRequestToken: string;
    }>,
  ): Promise<void>;
  ensureTerminationProtection(
    input: Readonly<{ region: string; stackName: string }>,
  ): Promise<void>;
}>;

export type StagingLifecycleReceipt = Readonly<{
  schema_version: 1;
  kind: "echo-authority-staging-lifecycle-v1";
  action: "slot-init" | "up" | "down" | "status";
  state:
    | "planned"
    | "ready"
    | "executed"
    | "absent"
    | "incomplete"
    | "failed_create"
    | "update_rolled_back"
    | "unprotected"
    /** The persistent edge is configured, but the disposable host is absent. */
    | "host_down"
    /** The host exists but its public Authority descriptor does not validate. */
    | "authority_unready"
    /** A valid Authority is serving, but no independently trusted pin is set. */
    | "authority_unpinned"
    /** A valid Authority is serving, but it does not match the trusted pin. */
    | "authority_pin_mismatch"
    /** An executed authority-required probe failed; see failure_class. */
    | "failed";
  operation_id: string;
  stack_name: string;
  hostname: string;
  readonly [field: string]: unknown;
}>;

export type LifecycleDependencies = Readonly<{
  execute?: boolean;
  initializeBlankDataVolume?: boolean;
  /**
   * Fail an executed `up` when the public Authority descriptor never answers.
   * For a down/up cycle over a prepared data volume, where "still not serving"
   * is a real failure rather than a fresh slot awaiting onboarding.
   */
  requireAuthority?: boolean;
  /** Test seam: bounds the descriptor probe instead of its default window. */
  descriptorProbeAttempts?: number;
  /** Test seam: replaces the wait between descriptor probe attempts. */
  sleepImpl?: (milliseconds: number) => Promise<void>;
  cloudflareApiToken?: string;
  fetchImpl?: FetchLike;
  putSecretValue?: PutSecretValue;
  cloudFormation?: CloudFormationAdapter;
  s3?: Readonly<{
    uploadObject(
      input: Readonly<{
        region: string;
        bucket: string;
        key: string;
        path: string;
        sha256: string;
      }>,
    ): Promise<Readonly<{ version: string; sha256: string }>>;
    assertObject(
      input: Readonly<{
        region: string;
        bucket: string;
        key: string;
        version: string;
        sha256: string;
      }>,
    ): Promise<void>;
  }>;
  ssm?: Readonly<{
    quiesceHost(
      input: Readonly<{
        region: string;
        instanceId: string;
        mountPath: string;
      }>,
    ): Promise<
      Readonly<{
        composeStopped: boolean;
        dockerStopped: boolean;
        syncComplete: boolean;
        volumeUnmounted: boolean;
        volumeSafe: boolean;
      }>
    >;
    recoverHost(
      input: Readonly<{
        region: string;
        instanceId: string;
        mountPath: string;
      }>,
    ): Promise<
      Readonly<{
        volumeMounted: boolean;
        dockerStarted: boolean;
        existingContainersStarted: boolean;
      }>
    >;
  }>;
  edge?: Readonly<{
    installToken(
      input: StagingEdgeInput,
      dependencies?: Readonly<{
        fetchImpl?: FetchLike;
        putSecretValue?: PutSecretValue;
      }>,
    ): Promise<Readonly<{ state: StagingEdgeState }>>;
    status(
      input: StagingEdgeInput,
      dependencies?: Readonly<{
        fetchImpl?: FetchLike;
        putSecretValue?: PutSecretValue;
      }>,
    ): Promise<Readonly<{ state: StagingEdgeState }>>;
  }>;
}>;

export function validateStagingLifecycleInput(
  input: unknown,
): StagingLifecycleInput;
/** Internal CLI adapter with bounded-process test seams. */
export function awsJson(
  args: readonly string[],
  options?: Readonly<{
    stdin?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }>,
): Promise<unknown>;
export function runAuthorityStaging(
  action: "slot-init" | "up" | "down" | "status",
  input: unknown,
  dependencies?: LifecycleDependencies,
): Promise<StagingLifecycleReceipt>;
export function createAwsCliAdapters(): LifecycleDependencies;
export function main(
  argv?: readonly string[],
  dependencies?: LifecycleDependencies,
): Promise<StagingLifecycleReceipt>;
