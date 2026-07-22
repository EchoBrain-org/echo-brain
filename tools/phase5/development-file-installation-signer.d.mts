import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "../../src/product/federation/foundation/installation-signer.js";

export class Phase5DevelopmentFileInstallationSigner implements InstallationSigner {
  constructor(options: {
    directory: string;
    federation: typeof import("@echo-brain/federation-protocol");
  });
  generate(installationId: string): Promise<InstallationKeyDescriptor>;
  inspect(installationId: string): Promise<InstallationKeyDescriptor | null>;
  sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: `sha256:${string}`,
  ): Promise<Buffer>;
}
