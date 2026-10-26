import type { PersonProjectActivityV1 } from "@echo-brain/organization-api";

/**
 * Project activity (Ask timeline v1, C2; ADR-0047): when something last
 * arrived in each of the signed-in person's active projects from someone else,
 * of what they can read, and no content. The bearer and the disconnect signal
 * stay in the HTTP boundary.
 */
export interface PersonProjectActivityHttpApplicationV1 {
  read(input: {
    readonly access_token: string;
    readonly signal?: AbortSignal;
  }): Promise<PersonProjectActivityV1>;
}
