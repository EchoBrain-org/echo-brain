import { describe, expect, it, vi } from 'vitest';

vi.mock('@echo-brain/organization-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@echo-brain/organization-api')>();
  return {
    ...actual,
    validateOrganizationAuthorityDescriptorResponse: () => {
      throw new TypeError('validator bug');
    },
  };
});

const { HttpOrganizationAuthorityClient, OrganizationAuthorityTransportError } =
  await import(
    '../../src/product/organization/client/http-organization-authority-client.js'
  );

describe('HTTP organization authority client validator faults', () => {
  it('propagates a non-validation validator throw instead of masking it', async () => {
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async () =>
        new Response(JSON.stringify({ authority_descriptor: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    let thrown: unknown;
    try {
      await client.readAuthorityDescriptor();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe('validator bug');
    expect(thrown).not.toBeInstanceOf(OrganizationAuthorityTransportError);
  });
});
