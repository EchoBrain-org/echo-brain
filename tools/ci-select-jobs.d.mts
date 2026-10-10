export type CiJobOutput =
  | 'check'
  | 'docs'
  | 'person_client_package'
  | 'desktop_app'
  | 'authority_recovery_infrastructure';

export type CiJobSelection = {
  mode: 'full' | 'pull-request' | 'verified-main';
  reason: string;
  jobs: Record<CiJobOutput, boolean>;
};

export type GitRunner = (args: readonly string[]) => { status: number | null; stdout: string };
export type GithubApi = (path: string) => Promise<any>;

export const REQUIRED_CHECK: 'CI required checks';
export const TESTED_TREE: 'CI tested tree';
export const JOB_INPUTS: Readonly<Record<'desktop_app' | 'person_client_package', readonly string[]>>;
export const JOB_OUTPUTS: readonly CiJobOutput[];

export function gitIn(cwd: string): GitRunner;
export function githubApi(apiUrl: string, token: string): GithubApi;
export function selectPullRequestJobs(input: Readonly<{
  event: any;
  sha: string;
  repository: string;
  git: GitRunner;
  api: GithubApi;
  sleep: (ms: number) => Promise<void>;
}>): Promise<CiJobSelection>;
export function verifyMainPush(input: Readonly<{
  event: any;
  sha: string;
  repository: string;
  api: GithubApi;
  sleep: (ms: number) => Promise<void>;
}>): Promise<CiJobSelection>;
export function selectJobs(input: Readonly<{
  eventName: string;
  event: any;
  sha: string;
  repository: string;
  git: GitRunner;
  api: GithubApi;
  sleep?: (ms: number) => Promise<void>;
}>): Promise<CiJobSelection>;
