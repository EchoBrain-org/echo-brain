// Frozen synthetic approved-record text and executed plan from the September 9 rollout reproduction.
// No oracle or model answer is supplied to retrieval. Provenance/identities are local fixtures.
export const rolloutCoverageFixture = {
  "queries": [
    "Can we promise Echo that all 28 locations will be live on September 16? What can we safely commit to, what must happen first, and what work remains by when?",
    "Echo September 16 live date commitment requirements",
    "28 locations operational prerequisites and remaining work schedule",
    "safe commitments deadlines dependencies for Echo launch"
  ],
  "records": [
    {
      "title": "Implementation capacity triage",
      "items": [
        {
          "kind": "decision",
          "text": "September 16 is designated as a conditional onboarding window for the initial 10 Echo locations, not a full 28-location launch date."
        },
        {
          "kind": "decision",
          "text": "Expansion beyond the initial 10 locations will only be reviewed after four-week adoption evidence exists."
        },
        {
          "kind": "decision",
          "text": "A go/no-go readiness review will be held on September 12 before the onboarding window is confirmed."
        },
        {
          "kind": "action",
          "text": "Rewrite the customer note to state the window is held for the initial cohort subject to the signed data agreement and implementation-readiness checks, and send revised wording to the account team by September 3."
        },
        {
          "kind": "action",
          "text": "Reserve the implementation pod for the first 10-location group through September 16 and send capacity assumptions by September 4."
        },
        {
          "kind": "action",
          "text": "Lock the location list by September 4 so implementation staff assignments and kickoff materials can be prepared."
        },
        {
          "kind": "action",
          "text": "Reset Echo's expectations and keep the executive sponsor focused on the first cohort, using the revised customer wording rather than the draft from this morning."
        },
        {
          "kind": "action",
          "text": "Run the go/no-go review on September 12 covering data-handling status, the location list, and implementation readiness before confirming the onboarding window."
        },
        {
          "kind": "rationale",
          "text": "Calling September 16 a 'full launch' or 'target full launch' risks the phrase being repeated without its qualifications, misleading the customer about open production gates."
        },
        {
          "kind": "rationale",
          "text": "Implementation capacity cannot support 28 simultaneous locations without pulling resources from accounts already in flight; staffing is only sufficient for the initial 10-location cohort."
        },
        {
          "kind": "rationale",
          "text": "There is no operating plan at the 28-location scale yet, so a commitment or scheduled announcement at that scale would be premature."
        },
        {
          "kind": "rationale",
          "text": "Staffing plan changes cannot be quietly absorbed; if the site list changes after September 4 the staffing plan must be explicitly revisited."
        }
      ]
    },
    {
      "title": "Data handling review",
      "items": [
        {
          "kind": "decision",
          "text": "Production access for Echo will not begin until the revised data-processing addendum is signed and the named Echo security contact is verified by Omar; the existing agreement is not sufficient."
        },
        {
          "kind": "decision",
          "text": "Implementation planning and scheduling work may proceed while the addendum is in signature, provided production access is not enabled."
        },
        {
          "kind": "action",
          "text": "Send the revised data-processing addendum to Leah, copying Zhen, by September 5."
        },
        {
          "kind": "action",
          "text": "Send Priya's confirmed escalation contact details (preferred address and phone number) to the same thread as the addendum."
        },
        {
          "kind": "action",
          "text": "Verify the named Echo security contact (Priya's details and escalation route) by September 8."
        },
        {
          "kind": "action",
          "text": "Record the production access boundary and the prerequisite owners in the rollout tracker."
        },
        {
          "kind": "rationale",
          "text": "The existing agreement does not cover the usage data collected by the dashboard, and its incident-notification terms differ from what is required for production use."
        },
        {
          "kind": "rationale",
          "text": "A named escalation contact is required because a shared mailbox is insufficient; someone must be accountable for receiving and routing time-sensitive incident notices."
        }
      ]
    },
    {
      "title": "Revenue signal calibration",
      "items": [
        {
          "kind": "decision",
          "text": "Scope the Echo rollout as a formal evaluation with a first cohort of 10 locations; expand only after at least 8 of those 10 have completed four consecutive weekly workflows without manual correction by the implementation team."
        },
        {
          "kind": "action",
          "text": "Confirm which 10 locations are in the first cohort with Echo, bring the confirmed list back by September 4, and not position the other 18 locations as committed scope."
        },
        {
          "kind": "action",
          "text": "Publish an adoption dashboard by September 11 showing the weekly workflow completion rate by location, the consecutive-week count, and every manual correction so the threshold is auditable; add a short annotation field readable by Customer Success to distinguish training blockers from workflow failures, keeping the underlying measure unchanged."
        },
        {
          "kind": "action",
          "text": "Use evaluation language (not launch language) in the next customer conversation and refrain from representing uncommitted locations as in-scope."
        },
        {
          "kind": "rationale",
          "text": "Initial logins may reflect training or curiosity rather than sustained operational use; a rushed expansion would convert an unproven pattern into a broader operating commitment, so the first cohort is the mechanism to learn whether the product holds up in real weekly use before extending scope."
        }
      ]
    }
  ]
} as const;

// Synthetic fourth-record pressure for #169, not a replay of unobserved live ranks.
export const independentRecordCoverageFixture = {
  queries: [
    rolloutCoverageFixture.queries[0],
    "promise Echo 28 locations live September 16",
    "commit safely Echo locations live September",
    "work remains locations live September 16",
  ],
  records: [
    ...rolloutCoverageFixture.records,
    {
      title: "Private commercial evaluation",
      items: [
        { kind: "decision", text: "Approve an evaluation rate for the initial 10 Echo locations through September 16; no commitment to all 28 locations is approved." },
        { kind: "decision", text: "Decline the commercial exception for all 28 Echo locations to be live on September 16." },
        { kind: "decision", text: "Do not promise a rollout discount for Echo; the evaluation rate applies to the first 10 locations only." },
        { kind: "action", text: "Draft the order form for 10 locations and a 30-day evaluation term before the September 16 window." },
        { kind: "action", text: "Reset Echo expectations using the revised customer wording before confirming when locations can go live." },
        { kind: "action", text: "Route the evaluation order form for commercial review before sending it to the customer." },
        { kind: "rationale", text: "Expansion requires another commercial approval after evaluation; standard pricing otherwise resumes." },
      ],
    },
  ],
} as const;
