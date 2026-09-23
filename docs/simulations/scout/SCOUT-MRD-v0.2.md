# SCOUT: Market Requirements Document

Document ID: SCOUT-MRD  
Version: 0.2  
Owner: Human PM  
Status: Proposed kickoff brief, pending PM and team review

Version 0.2 pairs with the condensed PRD v0.2; market needs, scope and planning targets are unchanged.

## Product idea

SCOUT is a small AI-assisted courier robot for an engineering workspace. A person places a small item in its tray, requests a destination, confirms the task, and SCOUT carries it to a known station. A screen and speaker make its intentions and progress understandable.

Example: “SCOUT, take this prototype to QA.”

This is a fictional product for a cross-team workplace simulation. The customer needs below are hypotheses for the exercise, not findings from TDK interviews or verified market research. The current phase produces engineering documents and review decisions. Physical robot operation is a separate future activity.

## Intended users and problem

Our initial users are a PM, hardware engineers and QA engineers working in one indoor lab. They need to hand off small, ordinary items such as a sealed prototype enclosure, adapter or printed test packet between known work areas.

The hypothesis is that some handoffs interrupt focused work even though they require little judgment. SCOUT should make those handoffs predictable and make it obvious when a delivery needs human help. Whether it saves time or effort would require later user validation.

## Customer needs

| ID | Need | Why it matters |
| --- | --- | --- |
| MRD-01 | Move a small item from the PM desk to the hardware bench or QA station. | Gives the first product one concrete job. |
| MRD-02 | Let a person request and confirm a delivery using speech or the device screen. | Makes the interaction understandable without a separate phone application. |
| MRD-03 | Show the intended destination, current progress and whether help is needed. | People should be able to understand what SCOUT is doing. |
| MRD-04 | Make loading, arrival and item collection explicit. | Reaching a location does not prove that a person received the item. |
| MRD-05 | Handle uncertainty and interruption visibly, preserving human control. | An ambiguous command or interrupted task should not silently become a successful delivery. |
| MRD-06 | Recover to an understandable state after delivery, cancellation or intervention. | A user needs to know whether SCOUT is available for the next task. |
| MRD-07 | Keep a concise record of each delivery and its outcome. | The team needs evidence to diagnose failures and assess usefulness. |

## First product scope

One robot operates in a controlled, mapped indoor test area on one floor. It has a carrying tray, screen, speaker, microphone, physical emergency-stop control and touchscreen task controls.

There are three predefined stations:

- `HOME`: the PM desk, where loading and new deliveries begin.
- `HW_BENCH`: the hardware bench, a delivery destination.
- `QA_STATION`: the QA station, a delivery destination.

People load and unload items. A mission goes from HOME to one destination, waits for collection, and returns to HOME. Only one mission is active at a time. Voice interaction initially uses English. Manual charging is acceptable for this version.

Future possibilities such as arbitrary destinations, additional floors, robot arms, automatic charging or a fleet are outside this first scope.

## Proposed planning targets

These are PM proposals for feasibility review, not measured capabilities or approved hardware limits. Teams should explain any tradeoff that warrants changing them.

| Target | Initial proposal |
| --- | --- |
| Payload envelope | Up to 1 kg, within a 200 × 150 × 100 mm box. |
| Operating surface | Dry, level, hard indoor floor within the agreed map. |
| Outbound route | Up to 20 m from HOME to either destination. |
| Outbound travel time | At most 120 seconds on an unobstructed route, measured after movement begins. |
| Early evaluation | Correct destinations, explicit handoff, understandable interruptions and consistent mission records. |

Component costs, battery endurance, travel speed and supported clearances need engineering proposals. There is no established commercial price or validated business case yet.

## First milestone and PM authority

Phase 1 ends with a reviewed hardware concept, software architecture, QA verification plan and joint hardware–software interface draft. Important product requirements must be allocated to an owner or explicitly raised as unresolved. Dependencies and blocking decisions must be visible.

The PM decides scope, priorities, target changes and whether to proceed. Engineering teams propose the implementation and identify feasibility limits. QA identifies how claims could be verified and where acceptance criteria are missing.

The companion `SCOUT-PRD-v0.2.md` translates these needs into proposed product behavior. If the two documents disagree, raise the conflict for PM resolution rather than silently choosing one.
