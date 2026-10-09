import { describe, expect, it } from 'vitest';
import {
  captureLocalActorRefV1, captureSourceRefV1, parseCaptureSourceRefV1,
  type CaptureSourceRefPartsV1,
} from '../../src/core/contracts/capture-source-ref-v1.js';

const actor = { tool: 'example', tenant: 'tenant-1', kind: 'actor', id: 'person-1' };
const localActor = { tool: 'example', tenant: 'tenant-1', source_id: `source:${'a'.repeat(64)}`, local_id: 'speaker-1' };

describe('provider-neutral capture source references', () => {
  it('round-trips opaque components without delimiter ambiguity', () => {
    const parts = { ...actor, tenant: 'space:org/one', id: "user:%:雪 🙂!'()*" };
    const ref = captureSourceRefV1(parts);
    expect(ref).toBe('example:space%3Aorg%2Fone:actor:user%3A%25%3A%E9%9B%AA%20%F0%9F%99%82%21%27%28%29%2A');
    expect(parseCaptureSourceRefV1(ref)).toEqual(parts);
    expect(captureSourceRefV1({ ...actor, tenant: 'a:b', id: 'c' })).not.toBe(captureSourceRefV1({ ...actor, tenant: 'a', id: 'b:c' }));
  });
  it('keeps stable upstream actors separate across tools and tenants', () => {
    expect(captureSourceRefV1(actor)).toBe(captureSourceRefV1({ ...actor }));
    expect(new Set([
      captureSourceRefV1(actor), captureSourceRefV1({ ...actor, tenant: 'tenant-2' }),
      captureSourceRefV1({ ...actor, tool: 'other' }), captureSourceRefV1({ ...actor, kind: 'container' }),
    ]).size).toBe(4);
  });
  it('keeps unresolved actors stable inside one source and separate across sources', () => {
    const ref = captureLocalActorRefV1(localActor);
    expect(ref).toBe(captureLocalActorRefV1({ ...localActor }));
    expect(parseCaptureSourceRefV1(ref)).toMatchObject({ tool: 'example', tenant: 'tenant-1', kind: 'local-actor' });
    const id = parseCaptureSourceRefV1(ref).id;
    expect(id).toMatch(/^[a-f0-9]{64}\.[a-f0-9]{64}$/);
    expect(`source:${id.split('.')[0]}`).toBe(localActor.source_id);
    for (const change of [{ source_id: `source:${'b'.repeat(64)}` }, { local_id: 'speaker-2' }, { tenant: 'tenant-2' }]) {
      expect(captureLocalActorRefV1({ ...localActor, ...change })).not.toBe(ref);
    }
    const otherSource = captureLocalActorRefV1({ ...localActor, source_id: `source:${'b'.repeat(64)}` });
    expect(parseCaptureSourceRefV1(otherSource).id.split('.')[1]).toBe(id.split('.')[1]);
  });
  it.each([
    '', 'example:tenant:actor', 'example:tenant:actor:user:extra', 'Example:tenant:actor:user',
    'example:tenant:Actor:user', 'example:tenant:actor:%', 'example:tenant:actor:%FF',
    'example:tenant:actor:%3a', 'example:t%65nant:actor:user', 'example:tenant:actor:raw space',
    'example:tenant:actor:raw!', 'example:tenant:actor:雪', 'example:tenant:actor:%00',
    'example:tenant:actor:%0A', 'example:tenant:actor:%E2%80%A8', 'example::actor:user',
    'example:tenant:actor:', 'example:tenant:actor:%20', 'example:tenant:actor:%ED%A0%80',
    'example:tenant:actor:' + 'x'.repeat(257), 'x'.repeat(2049),
  ])('rejects malformed or noncanonical reference %j', ref => {
    expect(() => parseCaptureSourceRefV1(ref)).toThrow();
  });
  it.each(['', ' ', '\u0000', 'line\nbreak', '\u2028', '\ud800', 'x'.repeat(257), '雪'.repeat(86)])('rejects invalid opaque component %j', value => {
    expect(() => captureSourceRefV1({ ...actor, tenant: value })).toThrow();
    expect(() => captureSourceRefV1({ ...actor, id: value })).toThrow();
    expect(() => captureLocalActorRefV1({ ...localActor, local_id: value })).toThrow();
  });
  it.each(['', 'Example', 'has_underscore', 'has:colon', 'has space', '-prefix', 'x'.repeat(65)])('rejects invalid token %j', value => {
    expect(() => captureSourceRefV1({ ...actor, tool: value })).toThrow();
    expect(() => captureSourceRefV1({ ...actor, kind: value })).toThrow();
  });
  it('enforces UTF-8 component bounds', () => {
    const maximum = { ...actor, tool: 't'.repeat(64), kind: 'k'.repeat(64), tenant: 'é'.repeat(128), id: ':'.repeat(256) };
    expect(parseCaptureSourceRefV1(captureSourceRefV1(maximum))).toEqual(maximum);
    expect(() => captureLocalActorRefV1({ ...localActor, local_id: 'é'.repeat(128) })).not.toThrow();
  });
  it.each([
    '', ' ', '\u0000', '\ud800', 'meeting-1', 'a'.repeat(64), `source:${'A'.repeat(64)}`,
    `source:${'g'.repeat(64)}`, `source:${'a'.repeat(63)}`, `source:${'a'.repeat(65)}`, `source:${'a'.repeat(64)}\n`,
  ])('rejects malformed local actor source ID %j', source_id => {
    expect(() => captureLocalActorRefV1({ ...localActor, source_id })).toThrow(/source ID/);
  });
  it('rejects prototypes, unknown fields and accessors before accessing or hashing them', () => {
    let invoked = false;
    const withGetter = { ...localActor };
    Object.defineProperty(withGetter, 'local_id', { enumerable: true, get() { invoked = true; return 'hidden'; } });
    expect(() => captureLocalActorRefV1(withGetter)).toThrow(/non-data/);
    const sourceGetter = { ...localActor };
    Object.defineProperty(sourceGetter, 'source_id', { enumerable: true, get() { invoked = true; return localActor.source_id; } });
    expect(() => captureLocalActorRefV1(sourceGetter)).toThrow(/non-data/);
    const refGetter = { ...actor };
    Object.defineProperty(refGetter, 'id', { enumerable: true, get() { invoked = true; return 'hidden'; } });
    expect(() => captureSourceRefV1(refGetter)).toThrow(/non-data/);
    expect(invoked).toBe(false);
    expect(() => captureSourceRefV1(Object.assign(Object.create({}), actor) as CaptureSourceRefPartsV1)).toThrow(/plain/);
    expect(() => captureLocalActorRefV1(Object.assign(Object.create({}), localActor))).toThrow(/plain/);
    expect(() => captureSourceRefV1({ ...actor, extra: 'unrecognized' } as CaptureSourceRefPartsV1)).toThrow(/unknown field/);
    for (const value of [null, {}, ['example:tenant:actor:user'], new String('example:tenant:actor:user')]) {
      expect(() => parseCaptureSourceRefV1(value)).toThrow();
    }
  });
});
