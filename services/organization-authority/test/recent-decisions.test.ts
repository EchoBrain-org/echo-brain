import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_RECENT_DECISIONS_ITEMS,
  MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES,
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
} from '@echo-brain/organization-api';
import {
  fixedRecentDecisionsErrorBytes,
  MAX_ORGANIZATION_RECENT_DECISIONS_POINTERS,
  OrganizationRecentDecisionsError,
  prepareAllowedRecentDecisionsResponse,
} from '../src/application/recent-decisions.js';
import type { OrganizationRecentDecisionsProjectedRecord } from '../src/application/recent-decisions.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function record(
  position: number,
  atoms = 1,
  text = `Decision at ${position}`,
): OrganizationRecentDecisionsProjectedRecord {
  const recordHash = digest(((position % 9) + 1).toString());
  return {
    log_position: position,
    record_hash: recordHash,
    atoms: Array.from({ length: atoms }, (_, index) => ({
      atom_id: `sha256:${(position * 100 + index)
        .toString(16)
        .padStart(64, '0')}`,
      record_hash: recordHash,
      kind: (index % 3 === 0
        ? 'decision'
        : index % 3 === 1
          ? 'action'
          : 'rationale') as 'decision' | 'action' | 'rationale',
      text,
    })),
  };
}

describe('permission-pilot recent decisions projection', () => {
  it('copies only the closed DTO and emits canonical empty and populated bytes', () => {
    const empty = prepareAllowedRecentDecisionsResponse([]);
    expect(empty.status_code).toBe(200);
    expect(JSON.parse(empty.body.toString('utf8'))).toEqual({
      items: [],
      policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
      schema_version: 1,
      witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
    });
    expect(empty.item_references).toEqual([]);

    const internalSource = {
      ...record(2),
      internal_cursor: 72,
      atoms: [
        {
          ...record(2).atoms[0]!,
          subject: 'must not escape',
        },
      ],
    } as unknown as OrganizationRecentDecisionsProjectedRecord;
    const populated = prepareAllowedRecentDecisionsResponse([internalSource]);
    expect(JSON.parse(populated.body.toString('utf8')).items).toEqual([
      {
        atom_id: record(2).atoms[0]!.atom_id,
        kind: 'decision',
        record_hash: record(2).record_hash,
        text: 'Decision at 2',
      },
    ]);
    expect(populated.body.toString('utf8')).not.toContain('internal_cursor');
    expect(populated.body.toString('utf8')).not.toContain('subject');
  });

  it('takes the longest whole-item prefix under ten items and 60 KiB', () => {
    const countBound = prepareAllowedRecentDecisionsResponse([record(2, 12)]);
    const countBody = JSON.parse(countBound.body.toString('utf8')) as {
      items: unknown[];
    };
    expect(countBody.items).toHaveLength(
      MAX_ORGANIZATION_RECENT_DECISIONS_ITEMS,
    );

    const byteBound = prepareAllowedRecentDecisionsResponse([
      record(3, 2, 'x'.repeat(31 * 1024)),
    ]);
    const byteBody = JSON.parse(byteBound.body.toString('utf8')) as {
      items: unknown[];
    };
    expect(byteBody.items).toHaveLength(1);
    expect(byteBound.body.length).toBeLessThanOrEqual(
      MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES,
    );
  });

  it('fails closed when one item cannot fit or source bounds drift', () => {
    expect(() =>
      prepareAllowedRecentDecisionsResponse([
        record(
          1,
          1,
          'x'.repeat(MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES),
        ),
      ]),
    ).toThrow(OrganizationRecentDecisionsError);
    expect(() =>
      prepareAllowedRecentDecisionsResponse(
        Array.from(
          { length: MAX_ORGANIZATION_RECENT_DECISIONS_POINTERS + 1 },
          (_, index) => record(100 - index),
        ),
      ),
    ).toThrow(/pointer budget/);
    expect(() =>
      prepareAllowedRecentDecisionsResponse([record(1), record(2)]),
    ).toThrow(/descending log order/);
    expect(() =>
      prepareAllowedRecentDecisionsResponse([
        {
          ...record(1),
          atoms: [
            {
              ...record(1).atoms[0]!,
              record_hash: digest('f'),
            },
          ],
        },
      ]),
    ).toThrow(/another record/);
  });

  it('freezes the exact metadata-free route errors', () => {
    expect(fixedRecentDecisionsErrorBytes(400)).toEqual(
      Buffer.from(
        '{"error":{"code":"invalid_request","message":"request is invalid"}}',
      ),
    );
    expect(fixedRecentDecisionsErrorBytes(401)).toEqual(
      Buffer.from(
        '{"error":{"code":"unauthorized","message":"authorization failed"}}',
      ),
    );
    expect(fixedRecentDecisionsErrorBytes(404)).toEqual(
      Buffer.from(
        '{"error":{"code":"not_found","message":"resource was not found"}}',
      ),
    );
    expect(fixedRecentDecisionsErrorBytes(503)).toEqual(
      Buffer.from(
        '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}',
      ),
    );
  });
});
