# Usage ping and Error report name the platform

Status: accepted

Amends [ADR 0078](0078-opt-in-anonymous-daily-usage-ping.md) and [ADR 0081](0081-error-reports-sent-by-hand.md).

Both payloads were written for one Supported platform: `osVersion` was the macOS version and `arch` was always `"arm64"`. On Ubuntu, `process.getSystemVersion()` returns the kernel version, and the architecture is x64, so the same fields would be wrong.

**A Linux App sends the next schema of each payload, which adds one field, `platform: "linux"`, and the real `arch`. Its `osVersion` is the distribution's `VERSION_ID` from `/etc/os-release`, such as `24.04`, not the kernel version. A macOS App keeps sending the current schema byte for byte, with no `platform` field.** The usage ping moves from schema 2 to schema 3 on Linux, and the Error report from schema 1 to schema 2.

The new field names a Supported platform, which a few thousand installs share; it identifies no one, so the privacy terms of ADR 0078 and ADR 0081 are unchanged.

## Consequences

- The receiver must accept usage ping schema 3 and Error report schema 2 before a Linux release ships with `OCTOPUSBEAK_USAGE_PING_URL` set. A source checkout has no ping URL and sends nothing, so Ubuntu source runs need no receiver change.
- Leaving the macOS payload as it is means the receiver change cannot break the macOS releases already installed.
