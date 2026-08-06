# Codecov (optional)

CI uploads Ch07 `lcov.info` with flag `ch07`. 

For private repos or to make the Codecov badge reliable, add a repo secret: 

- `CODECOV_TOKEN` from https://app.codecov.io/gh/Rurutia1027/LLM-Gateway-Zero-to-Master

Public repos can often upload without a token; the workflow sets `fail_ci_if_error: false` so a missing Codecov account does not block the ≥70% c8 gate.
The primary README badage does **not** depend on Codecov -- it uses `chapter07/coverage-badge.json` via shields.io endpoint. 