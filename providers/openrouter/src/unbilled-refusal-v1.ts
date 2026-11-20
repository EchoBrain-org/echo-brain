/**
 * The statuses the providers document as a refusal made before any generation: rate-limited (429), and overloaded or
 * unavailable (503 from OpenRouter, 529 from Anthropic). Only these, or a request that was never delivered, are known
 * unbilled. Any other 5xx, a gateway 504 included, can arrive after the model ran, so its billing is unknown.
 */
export const UNBILLED_REFUSAL_STATUSES_V1: ReadonlySet<number> = new Set([429, 503, 529]);
