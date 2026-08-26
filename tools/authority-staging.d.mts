import type {
  FetchLike,
  PutSecretValue,
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
    | "unprotected";
  operation_id: string;
  stack_name: string;
  hostname: string;
  readonly [field: string]: unknown;
}>;

export type LifecycleDependencies = Readonly<{
  execute?: boolean;
  initializeBlankDataVolume?: boolean;
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
    reconcile(
      input: StagingEdgeInput,
      dependencies?: Readonly<{
        fetchImpl?: FetchLike;
        putSecretValue?: PutSecretValue;
      }>,
    ): Promise<Readonly<{ state: string }>>;
    installToken(
      input: StagingEdgeInput,
      dependencies?: Readonly<{
        fetchImpl?: FetchLike;
        putSecretValue?: PutSecretValue;
      }>,
    ): Promise<Readonly<{ state: string }>>;
    status(
      input: StagingEdgeInput,
      dependencies?: Readonly<{
        fetchImpl?: FetchLike;
        putSecretValue?: PutSecretValue;
      }>,
    ): Promise<Readonly<{ state: string }>>;
  }>;
}>;

export function validateStagingLifecycleInput(
  input: unknown,
): StagingLifecycleInput;
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
