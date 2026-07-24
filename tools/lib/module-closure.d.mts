export interface CeremonyClosureOptions {
  projectRoot: string;
  entryPoints: readonly string[];
  readSource?: (absolutePath: string) => string;
}

export interface CeremonyAttestationOptions extends CeremonyClosureOptions {
  attestedSourcePaths: readonly string[];
}

export function collectExecutedModuleClosure(
  options: CeremonyClosureOptions,
): string[];

export function diffCeremonyAttestation(options: CeremonyAttestationOptions): {
  closure: string[];
  missing: string[];
  extra: string[];
};

export function assertCeremonyAttestationClosure(
  options: CeremonyAttestationOptions,
): void;
