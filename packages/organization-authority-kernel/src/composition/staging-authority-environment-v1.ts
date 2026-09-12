/**
 * The sole Authority origin admitted to staging-only composition features.
 * This is intentionally provider-neutral so generic runtime code can enforce
 * the boundary without importing a delivery-provider implementation.
 */
export const STAGING_AUTHORITY_ORIGIN_V1 =
  "https://authority-staging.echobrain.org" as const;
