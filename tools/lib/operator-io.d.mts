/**
 * The local AWS CLI boundary: fixed to echo-prod and stripped of inherited
 * credential, endpoint, proxy, and CA override variables.
 */
export function sanitizedAwsEnvironment(
  sourceEnvironment?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;

/** Explicit arguments used for every local AWS CLI process. */
export function awsCliArguments(args: readonly string[]): readonly string[];
