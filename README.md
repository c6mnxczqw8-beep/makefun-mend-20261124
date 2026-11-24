[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/c6mnxczqw8-beep/makefun-mend-20261124/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/c6mnxczqw8-beep/makefun-mend-20261124/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
# mend

One patch tool for every AI edit format: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON editor calls.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` in the root of a file tree. It detects the format automatically, matches old lines exactly or with drifted trailing/leading whitespace (tiers 0–2, tier 0 only under `--strict`), applies every edit atomically — every file changes or nothing does — and prints one `A`/`D`/`M`/`R` line per changed path plus an `ok:` summary. See `SPEC.md` for the full specification it implements.
