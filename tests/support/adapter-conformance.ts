import { describe, expect, it } from 'vitest';
import type {
  Adapter,
  AdapterConfig,
  AdapterKind,
} from '../../src/core/index.js';

export interface AdapterConformanceOptions<T extends Adapter> {
  name: string;
  kind: AdapterKind;
  create: () => T;
  validConfig: AdapterConfig;
  invalidConfig: AdapterConfig;
}

/**
 * Shared lifecycle contract for every adapter implementation. Capability
 * suites build on this helper with source-, processor-, or delivery-specific
 * fixtures.
 */
export function adapterConformance<T extends Adapter>(
  options: AdapterConformanceOptions<T>,
): void {
  describe(`${options.name} adapter conformance`, () => {
    it('declares a stable identity for the expected capability', () => {
      const first = options.create().identity;
      const second = options.create().identity;
      expect(first).toEqual(second);
      expect(first.kind).toBe(options.kind);
      expect(first.adapter_id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(first.instance_id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(first.version).not.toBe('');
    });

    it('validates configuration without throwing or exposing credentials', () => {
      const adapter = options.create();
      expect(adapter.validateConfig(options.validConfig)).toMatchObject({
        ok: true,
        errors: [],
      });
      const invalid = adapter.validateConfig(options.invalidConfig);
      expect(invalid.ok).toBe(false);
      expect(JSON.stringify(invalid)).not.toContain(
        options.invalidConfig.credential_ref,
      );
    });

    it('reports health through the common status envelope', async () => {
      const report = await options.create().healthCheck();
      expect(['healthy', 'degraded', 'unavailable', 'unauthorized']).toContain(
        report.status,
      );
      expect(Number.isNaN(new Date(report.checked_at).getTime())).toBe(false);
    });
  });
}
