import type { request } from 'node:https';
export function publicationFetch(input: string | URL, options?: RequestInit, requestHttps?: typeof request): Promise<Response>;
export function publicationFailure(error: unknown, replacement: boolean): { code: string; recovery: string };
