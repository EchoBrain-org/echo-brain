import { isAbsolute, resolve } from "node:path";
import { STAGING_AUTHORITY_ORIGIN_V1 } from "@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1";

/**
 * A file-backed corpus is a staging rehearsal source only. Keep this check
 * beside the normal composition so an accidental production selector fails
 * before any source bundle or worker opens.
 */
export function assertStagingSyntheticMeetingSourceSelectionV1(input: {
  readonly authority_url: string;
  readonly meetings_directory: string;
}): string {
  if (input.authority_url !== STAGING_AUTHORITY_ORIGIN_V1) {
    throw new Error("staging synthetic meeting source is allowed only on the staging Authority");
  }
  if (
    !isAbsolute(input.meetings_directory) ||
    resolve(input.meetings_directory) !== input.meetings_directory ||
    input.meetings_directory === resolve("/")
  ) {
    throw new Error("staging synthetic meetings directory must be an absolute canonical path");
  }
  return input.meetings_directory;
}
