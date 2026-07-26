export interface ProductLockPackageMetadata {
  name?: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  bundleDependencies?: readonly string[];
  bin?: unknown;
  engines?: Record<string, string>;
  os?: readonly string[];
  cpu?: readonly string[];
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
  [key: string]: unknown;
}

export interface ProductPackageTemplate {
  name?: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  bundleDependencies: string[];
  bin?: unknown;
  engines?: Record<string, string>;
  [key: string]: unknown;
}

export interface RootNpmLock {
  lockfileVersion?: number;
  packages: Record<string, ProductLockPackageMetadata>;
  [key: string]: unknown;
}

export interface ProductShrinkwrap {
  name?: string;
  version?: string;
  lockfileVersion: 3;
  requires: true;
  packages: Record<string, ProductLockPackageMetadata>;
}

export const PRODUCT_BUNDLED_WORKSPACE_PACKAGES: readonly string[];

export function productShrinkwrap(
  template: ProductPackageTemplate,
  rootLock: RootNpmLock,
): ProductShrinkwrap;
