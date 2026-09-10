# Lean employee onboarding V1

Status: source implemented; no new employee release or live qualification.

## Outcome

An owner approves each employee's work email using the existing invitation
operation. The employee downloads one approved macOS archive, opens ECHO Setup.app,
chooses the private invitation, completes Google sign-in, and reaches Ask ECHO.
No terminal, package manager, repository, or provider credentials are needed.

The shared download is built once for the organization's accepted release.
Invitations remain separate, private, employee-bound files. Invitation links,
domain-based automatic admission, an administrator portal, and automatic
updates are later work.

## First implementation

- Add a graphical `.zip` output to the existing Person onboarding kit builder.
  The zip contains one ECHO Setup.app setup application with the complete verified
  offline kit embedded in its resources. The existing `.tar.gz` output remains
  available for the operator lane.
- Reuse the current installer for app/client verification and atomic pair
  replacement. Add an explicit install-only operation for the graphical flow.
- Keep the setup application's process identity separate from the installed
  Ask ECHO overlay, so replacing an old overlay cannot terminate setup.
- Put installation, invitation handling, login, and readiness behind a bounded
  local bridge. Only safe phases and presentation fields reach the setup UI;
  command output, records, grants, and authorization URLs are never displayed
  as diagnostics.
- Check the existing local session after installation. An employee may continue
  as that person; a real permission-aware request must succeed before ready.
  Choosing another account requires explicit logout confirmation.
- New-person setup copies the selected invitation to a bounded private temporary
  file, then uses the existing `person start` Google handoff, readiness check,
  and failed-start recovery. The temporary copy is removed after success,
  failure, or a graceful cancellation.
- Open the installed ECHO application after successful setup. Keep manual
  reinstall/update and session preservation.

## Distribution boundary

The graphical archive must bind its source to the same clean committed checkout
and accepted-release tuple as its embedded kit. No invitation or session is
included. Keep one versioned artifact and checksum; release selection and
delivery remain explicit. Do not add a moving latest-channel service.

The owner confirmed that ECHO has no Apple Developer Program / Developer ID
access. Developer ID signing and notarization are deferred. Ad hoc artifacts
are private cohort/test artifacts and are not described as notarized or ready for public self-service.
No account credentials are required for source implementation or offline proof.

## Acceptance

1. A new employee can complete the graphical path without a terminal.
2. Tampered or mismatched kit inputs fail before installation or browser login.
3. Existing sessions survive installation; local signed-in status alone cannot
   produce ready. A failed/revoked read does not launch Ask ECHO.
4. Invitation cancellation and login failure produce actionable safe UI states.
   A retry does not require exposing a grant or manually editing local files.
5. Setup never starts Authority workers or changes runtime observability,
   organization admission, record visibility, or source processing.
6. Focused bridge/packaging tests, native Swift compilation, and `npm run check`
   pass. The retained demo graders and core evaluation commands remain intact.
7. A real second-employee clean-Mac rehearsal and Apple distribution verification
   remain separate from source and artifact proof; record them only when run.

## Verification boundary

The local full check passed 1,574 tests, including interrupted sign-in recovery.
Both new-person and existing-session paths require an Authority read before
ready. Native compilation passes with warnings treated as errors. These are
source checks; a second-employee login and clean-Mac distribution rehearsal
remain pending. The visual walkthrough is also pending because the local
Computer Use client and server reported a version mismatch.

## Source anchors

- [Employee lifecycle](2026-08-22-organization-onboarding-and-employee-rollout-v1.md)
- [Release and kit procedure](../../deploy/release/README.md)
- [Person client architecture](../architecture/person-client-architecture.md)
- [Identity and onboarding](../architecture/identity-and-onboarding.md)
