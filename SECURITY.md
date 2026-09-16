# Security Policy

## Supported versions

Security fixes are provided for the latest published version of Browser Testbench.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/llakie/browser-testbench/security/advisories/new) and include:

- the affected version and operating system;
- reproduction steps or a minimal proof of concept;
- the expected and observed impact;
- any suggested mitigation, if available.

You should receive an initial response within seven days. Confirmed vulnerabilities will be coordinated privately until a fix and disclosure plan are available.

## Scope

Browser Testbench starts local browser and device automation processes and can execute browser-side JavaScript. Keep the service bound to its default loopback address unless remote access is required. A bearer token is mandatory when binding to a non-loopback address. Never expose an unauthenticated Testbench instance to an untrusted network.
