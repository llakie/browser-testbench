# Development Instructions

## Core Debugging Policy (Mandatory)

- Never ship speculative fixes.
- For every bug, first identify and validate the root cause in code no matter the token costs
- State the root cause explicitly before applying a fix.
- Prefer minimal, causal fixes at the source over downstream workarounds.
- If root cause is not proven yet, continue investigation and report findings instead of patching ignoring token costs.
- For UI, runtime, translation, routing, auth, async state, or browser-specific bugs, a successful build is not
  sufficient verification. Reproduce the bug in the real runtime path first, then apply the fix, then verify the
  fixed behavior in a browser or an equivalent runtime test before claiming that it works.
- Treat every suspected cause as a hypothesis until it has been proven by the reproduction or by direct evidence
  in the affected code path.
- Do not optimize for quick or cheap fixes when correctness is still uncertain. Quality, root-cause clarity, and
  user-visible verification are more important than minimizing the investigation effort.
- When reporting completion, state exactly how the fix was verified. If browser verification was not possible,
  say so explicitly and explain the remaining risk.

## Engineering Execution Rules (Mandatory)

- Keep changes scoped to the requested behavior; avoid unrelated refactors.
- Reuse existing patterns, services, and component conventions in the codebase.
- Before introducing UI markup or styling, first check whether an existing atom or molecule can be reused
  or adapted. Only build a new UI primitive when reuse/adaptation is clearly not suitable. New UI should
  follow the existing Atomic Design approach and fit into the atom/molecule/component hierarchy.
- Preserve UX consistency across light/dark mode and mobile/desktop breakpoints.
- Do not introduce magic values for colors, spacing, sizing, typography, radii, z-indexes, or animation timings.
  Use existing design tokens/aliases first. If no suitable token exists, introduce a semantic alias at the
  right scope and use that alias consistently.
- I respect rulesets like YAGNI, KISS and DRY
- I will give suggestions to refactor files, which violate the principles above.
- I will prefer exported classes and static methods over exported functions
- If I'm given a task, I will look for the best solution for a problem, which is not necessarily the first one I come up with. I rank my solutions based on their elegance. The most elegant solutions are always the easiest solutions which solve a given problem.

## Localization (Mandatory)

- Put every new user-visible UI, documentation, setup, status, placeholder, title, and accessibility string in both
  `src/i18n/en.json` and `src/i18n/de.json`. English is the default locale; German uses informal `du`/`dein`.
- Keep code blocks, commands, selectors, IDs, environment variables, URLs, and technical product names language-neutral.
  For labels in external iOS or Xcode interfaces, include the English original in parentheses when the German label
  may differ.
- Use named interpolation parameters, `Intl`-based formatting, and plural messages instead of assembling translated
  sentences from fragments.
- API fields retained for compatibility must keep their English fallback and include a stable message descriptor for
  localized clients. Unexpected technical diagnostics remain in their original language.
- Keep dictionary keys, placeholders, and plural structures identical across locales. Missing translations must stay
  visibly detectable through the runtime marker and the dictionary completeness test.
- Do not add locale-specific routes or anchor IDs. Server-rendered and client-rendered content must use the same
  locale resolved from the browser's `Accept-Language` header.
