import { isCanonicalPersonEmail } from "../domain/person-session-rules.js";
import type { MeetingDocument } from "../processing/core/contracts/meeting.js";

type GranolaCalendarOrganizerSourcePath =
  | "meeting.extensions.granola.calendar_event.organizer"
  | "meeting.extensions.granola.calendar_event.organiser";

export interface GranolaMeetingOwnerObservationV1 {
  readonly provider: "granola";
  readonly relationship: "calendar_organizer";
  readonly subject: Readonly<{ readonly kind: "email"; readonly value: string }>;
  readonly assurance: "provider_calendar_organizer_email_observed";
  readonly source_path: GranolaCalendarOrganizerSourcePath;
}

interface OwnDataProperty {
  readonly present: boolean;
  readonly value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Read a JSON-shaped field without accepting inherited values or invoking a
 * getter. Provider metadata is untrusted, so only an own data property counts
 * as a provider observation.
 */
function ownDataProperty(value: object, key: string): OwnDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? { present: true, value: descriptor.value }
    : { present: false, value: undefined };
}

function canonicalEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isCanonicalPersonEmail(normalized) ? normalized : undefined;
}

function calendarEvent(meeting: MeetingDocument): Record<string, unknown> | undefined {
  const extensions = meeting.extensions;
  if (!isPlainObject(extensions)) return undefined;
  const granola = ownDataProperty(extensions, "granola");
  if (!granola.present || !isPlainObject(granola.value)) return undefined;
  const calendarEvent = ownDataProperty(granola.value, "calendar_event");
  return calendarEvent.present && isPlainObject(calendarEvent.value)
    ? calendarEvent.value
    : undefined;
}

function organizerEmail(value: unknown): string | undefined {
  if (typeof value === "string") return canonicalEmail(value);
  if (!isPlainObject(value)) return undefined;
  const email = ownDataProperty(value, "email");
  return email.present ? canonicalEmail(email.value) : undefined;
}

/**
 * Observes only Granola's raw calendar organizer email. This intentionally
 * ignores normalized participant/context fields, attendee data, names, ids,
 * and transcript material: none of those prove the meeting owner.
 */
export function observeGranolaMeetingOwnerV1(
  meeting: MeetingDocument,
): GranolaMeetingOwnerObservationV1 | undefined {
  const event = calendarEvent(meeting);
  if (event === undefined) return undefined;

  const organizer = ownDataProperty(event, "organizer");
  const source = organizer.present
    ? {
        value: organizer.value,
        path: "meeting.extensions.granola.calendar_event.organizer" as const,
      }
    : (() => {
        const organiser = ownDataProperty(event, "organiser");
        return organiser.present
          ? {
              value: organiser.value,
              path: "meeting.extensions.granola.calendar_event.organiser" as const,
            }
          : undefined;
      })();
  if (source === undefined) return undefined;

  const email = organizerEmail(source.value);
  if (email === undefined) return undefined;

  return Object.freeze({
    provider: "granola" as const,
    relationship: "calendar_organizer" as const,
    subject: Object.freeze({ kind: "email" as const, value: email }),
    assurance: "provider_calendar_organizer_email_observed" as const,
    source_path: source.path,
  });
}
