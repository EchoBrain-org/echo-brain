import { describe, expect, it } from "vitest";
import type { MeetingDocument } from "../../src/processing/core/index.js";
import { observeGranolaMeetingOwnerV1 } from "../../src/composition/granola-meeting-owner-observation.js";

function meetingWithExtensions(extensions: unknown): MeetingDocument {
  return {
    schema_version: 1,
    id: "meeting-1",
    provenance: {
      source: {
        kind: "meeting-source",
        adapter_id: "granola",
        instance_id: "granola-primary",
        version: "2.2.0",
      },
      external_id: "note-1",
      canonical_revision: "sha256:note-1",
      observed_at: "2026-08-28T00:00:00.000Z",
      normalizer_version: "2.2.0",
    },
    capture: { state: "complete", components: [] },
    participants: [],
    content: [],
    artifacts: [],
    extensions: extensions as MeetingDocument["extensions"],
  };
}

describe("Granola meeting-owner observation v1", () => {
  it("normalizes a direct organizer email and records its raw provider path", () => {
    const observation = observeGranolaMeetingOwnerV1(
      meetingWithExtensions({
        granola: {
          calendar_event: { organizer: "  OWNER@ECHOBrain.org  " },
        },
      }),
    );

    expect(observation).toEqual({
      provider: "granola",
      relationship: "calendar_organizer",
      subject: { kind: "email", value: "owner@echobrain.org" },
      assurance: "provider_calendar_organizer_email_observed",
      source_path: "meeting.extensions.granola.calendar_event.organizer",
    });
  });

  it("uses a direct email field from organiser only when organizer is absent", () => {
    const observation = observeGranolaMeetingOwnerV1(
      meetingWithExtensions({
        granola: {
          calendar_event: { organiser: { email: " OWNER@ECHOBrain.org " } },
        },
      }),
    );

    expect(observation).toEqual({
      provider: "granola",
      relationship: "calendar_organizer",
      subject: { kind: "email", value: "owner@echobrain.org" },
      assurance: "provider_calendar_organizer_email_observed",
      source_path: "meeting.extensions.granola.calendar_event.organiser",
    });
  });

  it("gives the primary organizer key precedence over organiser", () => {
    const observation = observeGranolaMeetingOwnerV1(
      meetingWithExtensions({
        granola: {
          calendar_event: {
            organizer: "primary@echobrain.org",
            organiser: "fallback@echobrain.org",
          },
        },
      }),
    );

    expect(observation?.subject.value).toBe("primary@echobrain.org");
    expect(observation?.source_path).toBe(
      "meeting.extensions.granola.calendar_event.organizer",
    );
  });

  it("does not infer an organizer email from a same-named attendee", () => {
    const meeting = meetingWithExtensions({
      granola: {
        calendar_event: { organizer: { name: "Avery Owner" } },
        attendees: [{ name: "Avery Owner", email: "attendee@echobrain.org" }],
      },
    });
    const withUntrustedNormalizedFields: MeetingDocument = {
      ...meeting,
      participants: [
        {
          id: "attendee-1",
          display_name: "Avery Owner",
          identities: [{ kind: "email", value: "attendee@echobrain.org" }],
        },
      ],
      context: { calendar: { organizer_participant_id: "attendee-1" } },
    };

    expect(observeGranolaMeetingOwnerV1(withUntrustedNormalizedFields)).toBe(
      undefined,
    );
  });

  it("fails closed for missing, malformed, inherited, accessor, and invalid primary values", () => {
    const inheritedOrganizer = Object.create({
      organizer: "inherited@echobrain.org",
    });
    const accessorOrganizer = Object.defineProperty({}, "organizer", {
      get: () => "getter@echobrain.org",
      enumerable: true,
    });
    const cases: readonly unknown[] = [
      undefined,
      { granola: {} },
      { granola: { calendar_event: [] } },
      { granola: { calendar_event: { organizer: [] } } },
      { granola: { calendar_event: { organizer: { email: "not an email" } } } },
      { granola: { calendar_event: inheritedOrganizer } },
      { granola: { calendar_event: accessorOrganizer } },
      {
        granola: {
          calendar_event: {
            organizer: { name: "No email" },
            organiser: "would-be-valid@echobrain.org",
          },
        },
      },
    ];

    for (const extensions of cases) {
      expect(observeGranolaMeetingOwnerV1(meetingWithExtensions(extensions))).toBe(
        undefined,
      );
    }
  });

  it("returns an immutable observation", () => {
    const observation = observeGranolaMeetingOwnerV1(
      meetingWithExtensions({
        granola: { calendar_event: { organizer: { email: "owner@echobrain.org" } } },
      }),
    );

    expect(observation).toBeDefined();
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation?.subject)).toBe(true);
  });
});
