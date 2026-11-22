# Manual runs offer a live view and a run intervention

Status: accepted. Supersedes the "no human path" part of [ADR 0039](0039-solver-only-verification.md); the rest of ADR 0039 stands.

A manual browser run was a black box: the person saw only sanitized run events, and an unexpected dialog or page failed the run with no way to fix it. A person may now watch a manual run's browser page in a Run live view and, when the workflow cannot classify the page, take it over in a Run intervention, fix it (for example, close a dialog), and hand it back. This is not a return to the Assist verification stage: CAPTCHA and OTP verification still complete only through the solver route, and no workflow stage waits for a person to verify.

## Decisions

- **Live view.** An App dialog on the running source's Automation card shows a CDP screencast of the headless page and the current step name. One view is open at a time. It is read-only: no pointer or key input reaches the page until the person takes over. No new browser is packaged (ADR 0033).
- **Manual runs only.** Scheduled runs still never wait for a person (ADR 0082); an unclassifiable page ends them with a User-action Failure.
- **Entering an intervention.** A manual run pauses automatically when the workflow meets a page or dialog it cannot classify, and the person may press Take over at any time. A dialog classified as ending the sign-in (ADR 0101), such as a locked account, still fails the run. Take over is unavailable while a verification stage is open (`waiting_for_human`, "verifying"); the person can only watch.
- **Handing back.** The person presses Hand back. The workflow re-checks the page from its current step and runs classification again; it does not restart the run. A run may pause at most three more times.
- **Ending.** A paused run holds its source's browser and stays active. It ends with a User-action Failure after 5 minutes without a person, or at once when the person presses Give up, which behaves as a cancel. Only one intervention is active at a time; other sources needing one wait paused, and each one's 5 minutes starts when its turn comes.
- **Privacy.** Frames and the person's input are session-memory only and never reach run events, logs, screenshots on disk, or analytics (the rule of ADR 0003). Persisted records keep only metadata: when viewing, taking over, handing back, and the outcome began and ended.
- **Diagnostics.** A failed or paused run's events record the step it stopped at and the kind of page (unclassified dialog, or the URL's host and path without query). No image is stored; after the run ends only these text diagnostics remain.

## Considered options

- **A real headed Chrome window.** Rejected. Production packages only the headless shell (ADR 0033), so this would add a full Chromium to the installer.
- **Restore the old Assist viewer.** Rejected. It mixed verification with remote control and made a person a second completion path for verification, which ADR 0039 removed.
- **Pause scheduled runs too.** Rejected. A daily unattended run that waits for a person blocks the queue.

## Consequences

- The five viewer IPC channels ADR 0039 removed are not restored. New channels are scoped to live view and intervention and refuse input while the run is not paused by an intervention.
- The workflow's page classification gains an "unclassified" outcome that requests an intervention for manual runs, instead of failing.
- The `Session takeover` term keeps its sign-in meaning. The new concept is named Run intervention to avoid confusion.
