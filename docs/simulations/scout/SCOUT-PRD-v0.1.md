# SCOUT: Product Requirements Document

Document ID: SCOUT-PRD  
Version: 0.1  
Parent: SCOUT-MRD v0.1  
Owner: Human PM  
Status: Proposed requirements for Phase 1 review

## Purpose and interpretation

Define the behavior of one courier robot delivering an item from HOME to HW_BENCH or QA_STATION, then returning to HOME. This is a synthetic product brief. Requirements and numeric targets are proposed for review, not demonstrated capabilities.

During Phase 1, teams review the requirements and prepare plans after the PM authorizes drafting. Later simulation evidence can establish software behavior under specified inputs; it cannot establish real obstacle detection, payload handling or emergency-stop performance.

Use the requirement IDs below in reviews and drafts. Preserve their meaning when proposing a decomposition. Label additional engineering choices as proposals and trace them to their source requirement. A changed requirement needs a recorded PM decision and a new document revision.

## Nominal user journey

1. SCOUT is available at HOME. A person places an item in the tray.
2. The person requests HW_BENCH or QA_STATION by voice or touchscreen.
3. SCOUT displays the destination. The person explicitly confirms that destination and that the item is loaded before motion begins.
4. SCOUT travels to the confirmed destination and reports its progress.
5. It announces arrival and waits for someone to collect the item and confirm collection on the touchscreen.
6. It returns to HOME and becomes available again.

Delivery status and robot availability are separate: collecting the item completes the handoff, while returning HOME completes the full mission.

## Proposed requirements

| ID | Product behavior | MRD source |
| --- | --- | --- |
| PRD-01 | Support exactly HOME, HW_BENCH and QA_STATION in the initial map. New delivery missions begin at HOME and target one of the other two stations. | MRD-01 |
| PRD-02 | Carry the proposed payload envelope of up to 1 kg and 200 × 150 × 100 mm, loaded and unloaded by people. Hardware must assess feasibility and propose loading and retention constraints. | MRD-01, MRD-04 |
| PRD-03 | Accept a destination request by English voice input or touchscreen. Display the interpreted destination and require explicit destination and load confirmation before starting movement. | MRD-02, MRD-04 |
| PRD-04 | An unknown, ambiguous or unsupported delivery request must not initiate movement. Explain what needs clarification; never guess a destination or treat a general AI response as a movement command. During an active mission, handle new delivery requests under PRD-05. Stop and cancel controls remain governed by their own requirements. | MRD-02, MRD-05 |
| PRD-05 | Allow only one active mission. A new request during an active mission must not silently replace or queue another delivery; report that the robot is busy. | MRD-03, MRD-06 |
| PRD-06 | Show the confirmed destination and current task status on the screen. Report arrival and conditions requiring help through the screen and speaker. | MRD-03 |
| PRD-07 | On an unobstructed mapped route of up to 20 m, target arrival within 120 seconds after outbound motion begins. Operator loading, confirmation, item collection and the return leg are excluded from this travel-time target. | MRD-01 |
| PRD-08 | When an obstruction prevents progress, stop and show a blocked condition. Continuing requires both an affirmative clearance signal from the navigation system and explicit human authorization. Detection coverage and stopping limits require engineering proposals. | MRD-05 |
| PRD-09 | At the selected destination, announce arrival and wait for touchscreen confirmation of item collection. Arrival alone must not be recorded as a completed handoff. | MRD-04 |
| PRD-10 | After confirmed collection, return to HOME. Report available only after confirmed arrival at HOME and satisfaction of the proposed readiness checks. A return failure must preserve the fact that the item was already collected. | MRD-06, MRD-07 |
| PRD-11 | Provide a touchscreen cancel action for an active mission. Cancellation must prevent continued execution of the canceled task, preserve its history and present the next required human action. Handling an item still on the tray and any subsequent recovery movement require a reviewed proposal. | MRD-05, MRD-06 |
| PRD-12 | Provide a physical emergency-stop control with priority over voice, touchscreen and AI commands. It must inhibit motion through a hardware control path independent of the AI service. Releasing it must not automatically restart motion. The stopping behavior, reset procedure and evidence needed for physical verification require engineering review. | MRD-05 |
| PRD-13 | If localization confidence becomes inadequate or a required movement-control connection is lost, stop the task and report that intervention is needed. Teams must define the relevant signals, thresholds, communication paths and recovery checks. Loss of an optional cloud voice service must not remove local stop or touchscreen controls. | MRD-05, MRD-06 |
| PRD-14 | Check that sufficient battery reserve is available before starting a mission. If reserve becomes insufficient during a mission, enter an explicitly defined low-battery handling state and report it. Hardware and Software must propose reserve thresholds, behavior and recovery; no unconditional return-home behavior is assumed. | MRD-05, MRD-06 |
| PRD-15 | Record a unique mission identifier, requested and confirmed destination, relevant state changes, human confirmations and final outcome. Distinguish delivery collected, canceled, interrupted and return incomplete. Repeated input or event delivery must not create duplicate movement tasks or duplicate completion records. | MRD-07 |
| PRD-16 | Keep displayed status and recorded events consistent. Reconnection, recovery or restarting the software must not silently resume a task or turn an incomplete task into a successful one. Teams must propose how state is recovered and revalidated. | MRD-03, MRD-05, MRD-07 |

## Shared lifecycle to refine together

Use these business stages in the initial discussion:

`Available at HOME → Awaiting confirmation → Outbound → Awaiting collection → Returning → Available at HOME`

Blocked, canceled, emergency-stopped, low-battery and intervention-needed conditions also need explicit treatment. This outline is not a complete technical state machine. Software proposes the transition model; Hardware supplies observable signals and command constraints; QA reviews transitions and evidence.

The hardware–software interface draft should cover:

- Supported commands and their acknowledgments, failure responses and priorities.
- Station identifiers and arrival evidence.
- Motion, obstacle, localization, battery and emergency-stop state.
- Units, value ranges, update frequency, timestamps and freshness rules.
- Event and mission identifiers, duplicate handling and reconnection behavior.
- Which team produces and consumes each signal.

Protocol, processor, sensor selection and AI model are engineering proposals, not prescribed choices in this brief.

## Open decisions for the first review

The documents intentionally expose normal early product questions. Teams may identify additional gaps; there is no hidden preferred technical design.

| ID | Decision needed | Initial contributors |
| --- | --- | --- |
| OPEN-01 | Minimum route width, turning clearance, speed limits, obstacle coverage and stopping performance. | Hardware + Software + QA |
| OPEN-02 | What evidence establishes arrival at a station, and how precise must it be? | Hardware + Software + QA |
| OPEN-03 | Battery endurance target, reserve calculation and low-battery behavior. | Hardware + Software; PM decides the product tradeoff |
| OPEN-04 | Treatment of voice requests during ambient conversation, repeated confirmations and simultaneous controls. | Software + QA; PM confirms the interaction |
| OPEN-05 | Cancellation, intervention and restart procedures, including custody of an undelivered item. | All teams; PM confirms the user flow |
| OPEN-06 | Local versus remote processing, communication dependencies and event-record retention. | Software + Hardware; PM reviews user implications |
| OPEN-07 | Feasible cost envelope and prototype schedule. | Hardware + Software + QA propose ranges and dependencies; PM decides |

Tag each issue as either “PM decision needed before drafting” or “can remain open in the draft.” Do not present an unsupported assumption as an agreed requirement.

## Proposed later verification scenarios

QA should refine these into a verification plan after the PM authorizes drafting. They are planned scenarios, not tests already run or a completed acceptance standard.

| Scenario | Observable result |
| --- | --- |
| Normal delivery to each destination | Confirmed destination matches arrival; explicit collection precedes handoff completion; return and availability are recorded separately. |
| Ambiguous or unknown destination while available | No movement; a clarification request or unsupported-request response is visible. |
| New delivery request during an active mission | Busy response; no silent destination change or queued mission. Stop and cancel controls retain their specified behavior. |
| Repeated request or confirmation | One mission and one set of completion records. |
| Blocked route and clearance | Blocked state is reported; movement stays inhibited until required clearance and human authorization. |
| Destination reached, nobody collects | Awaiting-collection state persists; no false handoff completion. |
| Cancel before collection | Canceled task is preserved; item handling and recovery follow the reviewed procedure. |
| Emergency-stop activation and release | In simulation, state and command behavior match the design. Physical stopping performance requires separate hardware evidence. |
| Lost required control connection or localization | Intervention-needed behavior, preserved mission state and explicit recovery checks. |
| Insufficient battery before or during travel | Behavior matches the reviewed battery policy; no fabricated successful outcome. |
| Return failure after collection | Delivery remains collected; mission return is incomplete; robot is not falsely shown as available at HOME. |
| Travel-time trial | Time is measured from outbound motion start to confirmed destination arrival under the declared route, payload and obstruction conditions. |

## Phase 1 deliverables and checkpoint

First, each role provides a requirements review and pauses for the PM. After authorization, prepare:

1. Hardware Concept and Constraints, owned by Hardware.
2. Software Architecture and Dependencies, owned by Software.
3. Acceptance and Verification Plan, owned by QA.
4. One joint Hardware–Software Interface Draft, co-owned by Hardware and Software and reviewed by QA.

Every draft names its source document versions, relevant requirement IDs, assumptions, cross-team dependencies and unresolved decisions. After cross-review, the PM records accepted proposals, requested revisions and blockers. Draft completion alone does not authorize implementation or establish physical readiness.
