# Linux ARM64 feasibility decision — September 2026

## Decision

**Later (no-go), recorded September 12, 2026.** Issue
[#195](https://github.com/funsaized/herdr-mise/issues/195) contains no evidence
of two independently interested Herdr Mise users or one recurring deployment.
The demand gate therefore fails, and this spike adds no Linux ARM64 target or
other release-support code.

## Demand evidence

| Required evidence                                  | Evidence found                                                                   | Result          |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | --------------- |
| Two independent users, or one recurring deployment | The issue records no audited Mise-specific ARM64 demand and has no user reports. | Fail            |
| Linux distribution and glibc requirements          | No requesting user or deployment from which to establish them.                   | Not established |
| Herdr version and workflow requirements            | No requesting user or deployment from which to establish them.                   | Not established |

Herdr's upstream `herdr-linux-aarch64` artifact, cited in issue #195, establishes
technical plausibility but does not count as demand.

## Native trial

Not run. The approved sequence requires the demand gate to pass before spending
native ARM64 runner and release-maintenance time. Consequently there is no
honest native-host, archive, installer, plugin, socket, TUI, browser, duration,
or Linux x86_64 comparison result to record.

## Reconsideration gate

Reconsider Linux ARM64 only after issue #195 (or linked, sanitized evidence)
identifies either:

- two independent prospective users; or
- one recurring deployment.

For each report, record the distribution/version, `uname -m`, glibc version,
Herdr version, installation path, live-socket need, browser/TUI need, and
expected usage cadence. Then run the native `aarch64-unknown-linux-gnu` trial
from the approved plan on a sustainable glibc ARM64 runner and record its cost,
artifact SHA-256, commands, results, durations, maintenance steps, tap test, and
equivalent Linux x86_64 comparison here before changing the release contract.

## Evidence links

- [Issue #195: Validate demand and release feasibility for Linux ARM64](https://github.com/funsaized/herdr-mise/issues/195)
- [Installer at the audited source commit](https://github.com/funsaized/herdr-mise/blob/6a237423eb300becd3a902a7714b08e02acee5a0/install.sh)
- [Release workflow at the audited source commit](https://github.com/funsaized/herdr-mise/blob/6a237423eb300becd3a902a7714b08e02acee5a0/.github/workflows/release.yml)

No private identities, infrastructure names, or credentials are included.
