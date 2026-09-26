/**
 * The Person email identity rules live in organization-api, next to the HTTP
 * DTOs that validate them. This subpath keeps the kernel's existing import
 * path for processing and provider code.
 */
export {
  isCanonicalPersonEmail,
  isExpectedPersonEmail,
} from "@echo-brain/organization-api";
