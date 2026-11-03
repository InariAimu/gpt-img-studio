
# Engineering Policy

## Project Mode: Exploratory

This project prioritizes rapid iteration, working
prototypes, and user-visible functionality.

## Execution

- Implement the smallest useful solution first.
- Prefer direct code changes over lengthy planning.
- Keep changes local and reversible when possible.
- Treat experiments as disposable until accepted.
- Do not expand the task into unrelated improvements.
- Do not create plans, reports, or documentation
  unless they provide lasting value.

## Verification

- Default to lightweight, targeted verification.
- For visual changes, prefer running the UI and
  inspecting the actual behavior.
- For ordinary features, verify the main success path.
- Add regression tests when they protect important
  behavior, not merely to mirror implementation.
- Do not repeatedly run full test suites without a
  concrete reason.
- Do not add mocks, test infrastructure, or audit
  machinery solely to validate trivial changes.
- Once acceptance criteria are met, stop.

## Risk Escalation

Increase verification for:
- Destructive or irreversible operations.
- User data, original files, or persistent storage.
- Credentials, security boundaries, or privacy.
- Significant changes to shared architecture.

## Completion

- Report what changed.
- Report what was actually verified.
- State relevant known limitations.
- Do not perform extra work merely to produce a
  more comprehensive completion report.
