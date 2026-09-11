export interface SetupEvent {
  readonly ok: boolean;
  readonly phase: string;
  readonly reason?: string;
  readonly display_name?: string;
  readonly authority?: string;
  readonly message?: string;
}
export interface CommandOptions {
  readonly timeoutMs?: number;
  readonly onLine?: (line: string) => boolean | void;
}
export function execute(command: string, args: string[], options?: CommandOptions): Promise<{ code: number; stdout: string }>;
export function withPrivateInvitation(path: string, operation: (privatePath: string) => Promise<{ code: number; stdout: string }>): Promise<{ code: number; stdout: string }>;
export function runOnboardingAction(action: string, invitation?: string, options?: {
  readonly kitRoot?: string;
  readonly home?: string;
  readonly run?: typeof execute;
  readonly withInvitation?: typeof withPrivateInvitation;
  readonly emit?: (event: SetupEvent) => void;
}): Promise<SetupEvent>;
