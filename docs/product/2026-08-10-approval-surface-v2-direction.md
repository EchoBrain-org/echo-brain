# Approval surface v2: statements at the gate

**Status:** Direction, founder session 2026-08-10; not scheduled. Instantiates
the [organization permission architecture](2026-08-09-organization-permission-architecture.md)
when built; the closed
[append/derive design](2026-08-07-org-decision-record-append-derive-design.md)
is unaffected — its contract already reserves every field this direction
populates.

## The idea

The approval gate grows from a button into a small workbench: the one place a
human converses with the machine's draft before it becomes truth. Three
affordances, all the same gesture — *things a human states at the gate*:

1. **Intent** — mark `restricted` / `reconsider_after` (populates the existing
   envelope `intent` slot; activates the permission architecture's dated
   policy via the intent-provenance marker).
2. **Declared links** — "this replaces X" / "this belongs to X" (populates the
   existing `links.supersedes` / `links.parent`; the PEP model — rung-1
   supersession with no model involved). The surface suggests candidates by
   subject similarity; the human ratifies.
3. **Edit before approve** — the chosen correction model, over
   reject-and-refine round-trips. Rationale: most packages are *mostly right*
   (one wrong owner, one number off), and binary approve/reject handles
   mostly-right worst — the human types the correction into a rejection
   reason anyway, so apply it directly under the signing authority instead of
   round-tripping it through an LLM redraft. A human finisher at the gate
   also lowers the quality bar extraction must clear (draft-quality suffices).

## Edit-before-approve rules (Abridge precedent)

The industry analogue is Abridge: the clinician edits the AI draft, then
signs, and the signed artifact is the edited one. Editing before attestation
strengthens rung 1 — the human moves from reviewer to author. Three rules
keep it honest:

- **Edits are visible as edits.** The machine draft's digest travels in the
  envelope, so human-authored-where-edited is a checkable fact.
- **Quotes are immutable.** Claims may be rewritten; a mis-attached quote may
  be removed; the words said may never be altered; every claim still requires
  non-empty evidence — an edit that strips all evidence invalidates the item
  rather than shipping it naked.
- **The signature covers the final bytes** — as the rail already guarantees.
  The gate approves bytes, never vibes; editing changes who authored some of
  them, and records that honestly.

## Friction guarantee

One-tap approval remains the default path for the clean case; intent, links,
and edit are the exception path behind it. The wedge's zero-friction property
is preserved.

## Sequencing

Retrieve ships first (needs none of this). Surface v2 follows as its own
designed feature, bundled with the identity bridge and request/approve flow
where the permission architecture already groups them. Slack reactions cannot
carry these affordances; the surface question (modal, web view, CLI) is part
of the future design, not prejudged here.
