import { describe, expect, it } from 'vitest';
import {
  isOrganizationProtocolValidationError,
  OrganizationProtocolValidationError,
} from '@echo-brain/organization-protocol';
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
      OrganizationProtocolValidationError,
    );
    expect(
      isOrganizationProtocolValidationError(
        (thrown as OrganizationApiValidationError).cause,
      ),
    ).toBe(true);
  });

  it('propagates an unexpected fault from the nested protocol validator', () => {
    const fault = new TypeError('nested protocol validator fault');
    const enrollmentRequest = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(enrollmentRequest, 'schema_version', {
      enumerable: true,
      get() {
        throw fault;
      },
    });

    let thrown: unknown;
    try {
      validateCompleteOrganizationEnrollmentRequest({
        enrollment_request: enrollmentRequest,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(fault);
    expect(isOrganizationApiValidationError(thrown)).toBe(false);
    expect(isOrganizationProtocolValidationError(thrown)).toBe(false);
  });

  it('types a real malformed nested authority descriptor', () => {
    let thrown: unknown;
    try {
      validateOrganizationAuthorityDescriptorResponse({
        authority_descriptor: { malformed: true },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrganizationApiValidationError);
    expect((thrown as OrganizationApiValidationError).cause).toBeInstanceOf(
      OrganizationProtocolValidationError,
    );
  });

  it('types an excessively nested protocol document instead of overflowing', () => {
    let nested: unknown = 0;
    for (let depth = 0; depth < 256; depth += 1) {
      nested = [nested];
    }

    let thrown: unknown;
    try {
      validateCompleteOrganizationEnrollmentRequest({
        enrollment_request: nested,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OrganizationApiValidationError);
    expect((thrown as OrganizationApiValidationError).cause).toBeInstanceOf(
      OrganizationProtocolValidationError,
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
