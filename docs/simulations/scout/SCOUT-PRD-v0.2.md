# SCOUT: Product Requirements Document

Document ID: SCOUT-PRD  
Version: 0.2  
Parent: SCOUT-MRD v0.2  
Owner: Human PM  
Status: Proposed requirements for Phase 1 review

## Interpretation

This fictional brief proposes behavior and targets, not proven capabilities. Version 0.2 condenses v0.1 for ECHO; scope and IDs are unchanged.

Phase 1: review, then plans after PM authorization. Simulation demonstrates software behavior under declared inputs, not physical obstacle detection, payload handling or emergency stopping. Cite IDs; label engineering proposals. Requirement changes need a recorded PM decision and revision.

## Proposed requirements

|ID|Behavior|MRD source|
|---|---|---|
|PRD-01|Three mapped stations: HOME, HW_BENCH, QA_STATION. Missions start HOME and deliver to either other station.|MRD-01|
|PRD-02|Proposed payload: up to 1 kg, 200 × 150 × 100 mm. People load/unload. Hardware reviews feasibility and proposes loading/retention constraints.|MRD-01, MRD-04|
|PRD-03|Accept English voice or touchscreen destination requests. Display the interpreted destination; require explicit destination and load confirmation before motion.|MRD-02, MRD-04|
|PRD-04|Unknown, ambiguous or unsupported delivery requests cause no motion; explain needed clarification. Never guess destinations or execute general AI responses as movement commands. Active requests follow PRD-05; stop/cancel keep their own rules.|MRD-02, MRD-05|
|PRD-05|One active mission. New delivery requests receive a busy response; no silent replacement or queuing.|MRD-03, MRD-06|
|PRD-06|Screen shows confirmed destination and task status. Screen and speaker report arrival and conditions needing help.|MRD-03|
|PRD-07|Target arrival within 120 seconds of outbound motion starting on an unobstructed mapped route up to 20 m. Exclude loading, confirmation, collection and return time.|MRD-01|
|PRD-08|Stop/report blocked if obstructed. Continuing requires affirmative navigation-system clearance AND explicit human authorization. Propose detection coverage and stopping limits.|MRD-05|
|PRD-09|Announce arrival; wait for touchscreen confirmation of collection. Arrival alone never completes the handoff.|MRD-04|
|PRD-10|After confirmed collection, return HOME. Availability requires confirmed HOME arrival and proposed readiness checks. Return failure preserves completed collection.|MRD-06, MRD-07|
|PRD-11|Touchscreen cancel prevents further task execution, preserves history and shows the next human action. Item custody/recovery movement need a reviewed proposal.|MRD-05, MRD-06|
|PRD-12|Physical emergency stop overrides voice, touchscreen and AI through a hardware motion-inhibit path independent of AI. Release never auto-restarts motion. Review stopping behavior, reset and physical verification evidence.|MRD-05|
|PRD-13|Stop/report intervention for inadequate localization or lost required movement-control connection. Define signals, thresholds, communication paths and recovery checks. Optional cloud voice loss cannot remove local stop/touchscreen controls.|MRD-05, MRD-06|
|PRD-14|Check battery reserve before starting; insufficient reserve mid-mission enters a defined, reported low-battery state. Hardware/Software propose thresholds, behavior and recovery; no unconditional return HOME.|MRD-05, MRD-06|
|PRD-15|Record unique mission ID, requested/confirmed destination, state changes, human confirmations and final outcome. Distinguish collected, canceled, interrupted and return incomplete. Repeated inputs/events cannot duplicate movement tasks or completion records.|MRD-07|
|PRD-16|Display and records stay consistent. Reconnection, recovery or software restart cannot silently resume tasks or convert incomplete tasks to success. Propose state recovery and revalidation.|MRD-03, MRD-05, MRD-07|

## Lifecycle and interface

`Available at HOME → Awaiting confirmation → Outbound → Awaiting collection → Returning → Available at HOME`

Collection completes handoff; return HOME completes the mission. Define blocked, canceled, emergency-stopped, low-battery and intervention-needed conditions. This is not a full state machine: Software proposes transitions, Hardware supplies signals/command constraints, QA reviews evidence.

Joint interface: commands, acknowledgments, failures/priorities; station IDs/arrival evidence; motion, obstacle, localization, battery, emergency-stop signals; units, ranges, update frequency, timestamps/freshness; event/mission IDs, duplicates/reconnection; signal producers/consumers. Protocol, processor, sensors and AI model remain proposals.

## Open decisions

No hidden preferred design. Raise other gaps. Tag issues “PM decision needed before drafting” or “can remain open in the draft”; assumptions are not agreed requirements.

|ID|Decision|Contributors|
|---|---|---|
|OPEN-01|Route width, turning clearance, speed, obstacle coverage, stopping performance.|Hardware + Software + QA|
|OPEN-02|Arrival evidence and required precision.|Hardware + Software + QA|
|OPEN-03|Battery endurance, reserve calculation and low-battery behavior.|Hardware + Software; PM decides tradeoff|
|OPEN-04|Ambient voice, repeated confirmations, simultaneous controls.|Software + QA; PM confirms interaction|
|OPEN-05|Cancel, intervention, restart and undelivered-item custody.|All teams; PM confirms flow|
|OPEN-06|Local/remote processing, communication dependencies, record retention.|Software + Hardware; PM reviews implications|
|OPEN-07|Feasible cost envelope and prototype schedule.|All teams propose ranges/dependencies; PM decides|

## Later verification scenarios

QA refines these after authorization: planned scenarios, not executed tests or a complete acceptance standard.

|Scenario|Expected evidence|
|---|---|
|Delivery to each destination|Destination matches arrival; collection precedes handoff; return/availability separate.|
|Unknown/ambiguous destination while available|No movement; visible clarification or unsupported response.|
|Request during active mission|Busy; no silent change/queue; retain stop/cancel behavior.|
|Repeated request/confirmation|One mission and one set of completion records.|
|Blockage and clearance|Report blocked; inhibit motion until navigation clearance AND human authorization.|
|Arrival without collection|Remains awaiting collection; no false handoff.|
|Cancel before collection|Preserve cancellation; reviewed item-custody/recovery procedure.|
|Emergency stop and release|Simulated states/commands match design; hardware evidence needed for physical stopping.|
|Lost required connection/localization|Intervention, preserved state, explicit recovery checks.|
|Low battery before/during travel|Reviewed policy; no fabricated success.|
|Return failure after collection|Collection preserved; return incomplete; no false HOME availability.|
|Travel time|Outbound start to confirmed arrival; declare route, payload, obstructions.|

## Phase 1 checkpoints

Each role returns a requirements review and pauses for PM decisions. After PM authorization, draft:

1. Hardware Concept and Constraints (Hardware).
2. Software Architecture and Dependencies (Software).
3. Acceptance and Verification Plan (QA).
4. Joint Hardware–Software Interface Draft (QA reviews).

Drafts name source versions, IDs, assumptions, dependencies and open decisions. After cross-review, PM records accepted proposals, revisions and blockers. Draft completion does not authorize implementation or establish physical readiness.
