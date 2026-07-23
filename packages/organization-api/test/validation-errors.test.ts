import { describe, expect, it } from 'vitest';
import {
  isOrganizationApiValidationError,
  OrganizationApiValidationError,
  validateCompleteOrganizationEnrollmentRequest,
  validateOrganizationAuthorityDescriptorResponse,
} from '../src/index.js';

describe('organization API validation errors', () => {
  it('types a nested enrollment failure and preserves the inner cause', () => {
    let thrown: unknown;
    try {
      validateCompleteOrganizationEnrollmentRequest({
        enrollment_request: { not: 'a valid enrollment request' },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrganizationApiValidationError);
    expect(isOrganizationApiValidationError(thrown)).toBe(true);
    expect((thrown as OrganizationApiValidationError).message).toBe(
      'organization API: enrollment_request is invalid',
    );
    expect((thrown as OrganizationApiValidationError).cause).toBeInstanceOf(
      Error,
    );
  });

  it('preserves the inner cause for an inner-document failure', () => {
    let thrown: unknown;
    try {
      validateOrganizationAuthorityDescriptorResponse({
        authority_descriptor: { not: 'valid' },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrganizationApiValidationError);
    expect((thrown as OrganizationApiValidationError).cause).toBeInstanceOf(
      Error,
    );
  });

  it('does not classify an unrelated error as a validation error', () => {
    expect(isOrganizationApiValidationError(new Error('other'))).toBe(false);
  });
});
