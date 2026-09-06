type Dependencies = {
  aws?: (args: string[]) => any;
  readSource?: (commit: string, path: string) => Buffer;
  runtime?: () => string;
  now?: () => number;
};
export function releaseAction(action: string): string;
export function stagingReleaseTarget(aws?: (args: string[]) => any): any;
export function validateReleaseRequest(request: any, readSource?: (commit: string, path: string) => Buffer): any;
export function releaseSsmParameters(request: any, readSource?: (commit: string, path: string) => Buffer): { commands: string[]; executionTimeout: string[] };
export function planStagingRelease(options: any, dependencies?: Dependencies): any;
export function executeStagingRelease(path: string, dependencies?: Dependencies, pollOnly?: boolean): any;
export function safeReleaseOutcome(raw: string, request: any, requestHash: string): any;
