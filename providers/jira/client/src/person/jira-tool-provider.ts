import {
  PersonToolOutcomeErrorV1,
  type PersonToolProviderV1,
  type PersonToolVerbContextV1,
} from "@echo-brain/organization-api";
import { JiraPersonClientV1 } from "./jira-person-client.js";

const POLL_MS = 2_000;
const MAX_POLLS = 900;

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  provider_rejected: "Jira did not accept this connection. Try again.",
  provider_unavailable: "Jira is unavailable right now. Try again.",
  account_mismatch: "That Jira account does not match your previously connected Jira account. Try again with that account.",
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
  client: JiraPersonClientV1,
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
      "Jira connection page could not be opened.",
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
        FAILURE_MESSAGES[reason] ?? "Jira could not be connected. Try again.",
      );
    }
    if (status.status === "expired") {
      throw new PersonToolOutcomeErrorV1(
        "expired",
        "The Jira connection attempt expired. Try again.",
      );
    }
    throw new PersonToolOutcomeErrorV1(
      "cancelled",
      "The Jira connection attempt was cancelled.",
    );
  }
  await quietly(() => client.cancel(begun.attempt));
  throw new PersonToolOutcomeErrorV1(
    "timed_out",
    "The Jira connection attempt took too long. Try again.",
  );
}

export function createJiraPersonToolProviderV1(): PersonToolProviderV1 {
  const verbs: PersonToolProviderV1["verbs"] = {
    connect: {
      description: "Opens Jira consent and waits up to 30 minutes. Use --no-wait to check the attempt later.",
      options: { "no-wait": { type: "boolean" } },
      run: (context) => openConnectPage(context, new JiraPersonClientV1(context.host)),
    },
    status: {
      description: "Reads a Jira connection attempt started with --no-wait.",
      options: { "attempt-id": { type: "string" } },
      requires: ["attempt-id"],
      run: async (context) => {
        context.print({
          ok: true,
          result: await new JiraPersonClientV1(context.host).status(attemptId(context)),
        });
      },
    },
    cancel: {
      description: "Cancels a pending Jira connection attempt.",
      options: { "attempt-id": { type: "string" } },
      requires: ["attempt-id"],
      run: async (context) => {
        context.print({
          ok: true,
          result: await new JiraPersonClientV1(context.host).cancel(attemptId(context)),
        });
      },
    },
    disconnect: {
      description: "Disconnects your Jira account.",
      options: {},
      run: async (context) => {
        context.print({
          ok: true,
          result: await new JiraPersonClientV1(context.host).disconnect(),
        });
      },
    },
  };
  return Object.freeze({ tool_id: "jira", verbs: Object.freeze(verbs) });
}
