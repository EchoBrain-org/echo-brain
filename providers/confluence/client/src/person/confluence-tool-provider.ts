import {
  PersonToolOutcomeErrorV1,
  type PersonToolProviderV1,
  type PersonToolVerbContextV1,
} from "@echo-brain/organization-api";
import { ConfluencePersonClientV1 } from "./confluence-person-client.js";

const POLL_MS = 2_000;
const MAX_POLLS = 900;

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  provider_rejected: "Confluence did not accept this connection. Try again.",
  provider_unavailable: "Confluence is unavailable right now. Try again.",
  account_mismatch: "That Confluence account does not match your previously connected Confluence account. Try again with that account.",
};

async function quietly(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // The original browser, timeout, or status outcome remains actionable.
  }
}

function attemptId(context: PersonToolVerbContextV1): string {
  const value = context.values["attempt-id"];
  if (typeof value !== "string") throw new Error("--attempt-id is required");
  return value;
}

async function openConnectPage(
  context: PersonToolVerbContextV1,
  client: ConfluencePersonClientV1,
): Promise<void> {
  const begun = await client.connect();
  let opened = false;
  try {
    opened = await context.open_browser(begun.connect_link);
  } catch {
    opened = false;
  }
  if (!opened) {
    await quietly(() => client.cancel(begun.attempt));
    throw new PersonToolOutcomeErrorV1(
      "browser_unavailable",
      "Confluence connection page could not be opened.",
    );
  }
  context.print({
    ok: true,
    phase: "waiting",
    attempt: begun.attempt,
    expires_at: begun.expires_at,
  });
  if (context.values["no-wait"] === true) return;
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await context.sleep(POLL_MS);
    const status = await client.status(begun.attempt);
    if (status.status === "pending") continue;
    if (status.status === "complete") {
      context.print({
        ok: true,
        phase: "connected",
        attempt: status.attempt,
        expires_at: status.expires_at,
      });
      return;
    }
    if (status.status === "failed") {
      const reason = status.failure_reason!;
      throw new PersonToolOutcomeErrorV1(
        reason,
        FAILURE_MESSAGES[reason] ?? "Confluence could not be connected. Try again.",
      );
    }
    if (status.status === "expired") {
      throw new PersonToolOutcomeErrorV1(
        "expired",
        "The Confluence connection attempt expired. Try again.",
      );
    }
    throw new PersonToolOutcomeErrorV1(
      "cancelled",
      "The Confluence connection attempt was cancelled.",
    );
  }
  await quietly(() => client.cancel(begun.attempt));
  throw new PersonToolOutcomeErrorV1(
    "timed_out",
    "The Confluence connection attempt took too long. Try again.",
  );
}

export function createConfluencePersonToolProviderV1(): PersonToolProviderV1 {
  const verbs: PersonToolProviderV1["verbs"] = {
    project: {
      description: 'Lists, reads or changes an ECHO project’s Confluence spaces. Leads set --space-ids (comma-separated stable space IDs) or --clear with --mapping-revision and --mapping-request.',
      options: { 'echo-project': { type: 'string' }, 'space-ids': { type: 'string' }, 'list': { type: 'boolean' }, 'spaces': { type: 'boolean' }, 'space-cursor': { type: 'string' }, 'clear': { type: 'boolean' }, 'mapping-revision': { type: 'string' }, 'mapping-request': { type: 'string' } },
      run: async context => {
        const values = context.values;
        const client = new ConfluencePersonClientV1(context.host);
        if (values.list === true || values.spaces === true) {
          if (values.list === true && values.spaces === true) throw new Error('Choose --list or --spaces');
          if (values['echo-project'] !== undefined || values['space-ids'] !== undefined || values.clear === true || values['mapping-revision'] !== undefined || values['mapping-request'] !== undefined) throw new Error('Listing cannot be combined with a mapping option');
          if (values.spaces === true) { const cursor = values['space-cursor']; if (cursor !== undefined && typeof cursor !== 'string') throw new Error('--cursor is invalid'); context.print({ ok: true, result: await client.spaces({ schema_version: 1, ...(cursor === undefined ? {} : { cursor }) }) }); } else context.print({ ok: true, result: await client.projectList() });
          return;
        }
        const project_id = values['echo-project'];
        if (typeof project_id !== 'string') throw new Error('--echo-project is required');
        const raw = values['space-ids'];
        const parsed = typeof raw === 'string' ? raw.split(',').map(value => value.trim()).filter(Boolean) : undefined;
        const write = parsed !== undefined || values.clear === true;
        if (values.clear === true && parsed !== undefined) throw new Error('Choose --space-ids or --clear');
        if (!write && (values['mapping-revision'] !== undefined || values['mapping-request'] !== undefined)) throw new Error('A mapping change is required');
        if (write && (typeof values['mapping-revision'] !== 'string' || typeof values['mapping-request'] !== 'string')) throw new Error('--mapping-revision and --mapping-request are required');
        context.print({ ok: true, result: write ? await client.projectSet({ schema_version: 1, project_id,
          request_id: values['mapping-request'] as string, expected_revision: values['mapping-revision'] === 'none' ? null : values['mapping-revision'] as string,
          space_ids: values.clear === true ? null : parsed!,
        }) : await client.projectRead(project_id) });
      },
    },
    connect: {
      description: "Opens Confluence consent and waits up to 30 minutes. Use --no-wait to check the attempt later.",
      options: { "no-wait": { type: "boolean" } },
      run: (context) => openConnectPage(context, new ConfluencePersonClientV1(context.host)),
    },
    status: {
      description: "Reads a Confluence connection attempt started with --no-wait.",
      options: { "attempt-id": { type: "string" } },
      requires: ["attempt-id"],
      run: async (context) => {
        context.print({
          ok: true,
          result: await new ConfluencePersonClientV1(context.host).status(attemptId(context)),
        });
      },
    },
    cancel: {
      description: "Cancels a pending Confluence connection attempt.",
      options: { "attempt-id": { type: "string" } },
      requires: ["attempt-id"],
      run: async (context) => {
        context.print({
          ok: true,
          result: await new ConfluencePersonClientV1(context.host).cancel(attemptId(context)),
        });
      },
    },
    disconnect: {
      description: "Disconnects your Confluence account.",
      options: {},
      run: async (context) => {
        context.print({
          ok: true,
          result: await new ConfluencePersonClientV1(context.host).disconnect(),
        });
      },
    },
  };
  return Object.freeze({ tool_id: "confluence", verbs: Object.freeze(verbs) });
}
