# Build a static site faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Kegelapan-ai/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Kegelapan-ai/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Built for the make.fun bounty: https://make.fun/bounty/site-generator-speed-01-run-20261122

An entry for the [make.fun bounty "Build a static site faster, 22 November
2026"](https://make.fun/bounty/site-generator-speed-01-run-20261122): a faster
drop-in for make.fun's own makefun-site 1.0.0 that answers exactly as it does
on every case.

## What it is

- `solve.js` — an ES module whose `run(input)` returns makefun-site 1.0.0's
  answer for an input `{ site, templates, files }`: the output tree (every
  page's `index.html`, the index and tag pages, `build-report.txt` and each
  static file) as a JSON object of path to file text, byte for byte.
  Dependency free, no caching between cases, each case answered alone.
- `main.ts` — the program the harness runs (`node /bot/main.ts`): it reads
  every case from `/input/cases.json`, answers each with `run`, and writes
  `/output/answers.json`. It is the house baseline's driver, kept as shipped,
  with `solve.js` replaced by the faster module.

## How it is fast

makefun-site 1.0.0 lexes Markdown into token objects, renders inline markup
one character at a time with string concatenation, walks template trees
through scope chains with `Object.hasOwn` per name, and calls slugify (NFKD
+ regex) again and again for the same titles and tag names. This version does
one left-to-right pass instead:

- Markdown renders in a single pass over the lines, emitting chunks into one
  array (no token objects, one join per page): block detection by direct
  character tests, inline markup by native `indexOf` jumps to the next
  construct, bulk escaping.
- Words are counted with a transition scan (ASCII fast path) instead of
  `match(/\S+/g)`; reading-minutes and each source's card are computed once
  and shared by its page and every list that shows it.
- Slugs use an ASCII fast path (NFKD is the identity on ASCII) and are
  memoised within the case, as are long dates and resolved links (titles and
  tag names repeat heavily; tags come from a small fixed vocabulary).
- Front matter is parsed by scanning line starts instead of splitting the
  whole source.
- Templates render against one flat, fixed-shape scope object per page
  (loop variables saved and restored, so nesting and self-includes keep the
  right values) instead of a chain of scope objects allocated per loop
  iteration.

## Verification

- Practice set (3 cases): 3/3 answers identical to makefun-site 1.0.0 and
  to the kit's `expected.json`.
- 30 further cases drawn fresh from the published generator with random
  seeds: 30/30 identical to the reference.
- 278 hand-written edge cases (Unicode slugs, odd front matter, nested
  templates, Markdown corners, CRLF, reserved directories, shadowed
  statics): 278/278 identical to the reference.
- Determinism: `main.ts` run twice on the practice set produces identical
  `answers.json` (same SHA-256).

## Speed

Practice set, 3 cases, this machine (Node v24.22.1, CPU time of `run()`,
mean of 7 warmed-up reps):

| | baseline makefun-site 1.0.0 | this entry | speedup |
|---|---|---|---|
| case g-0001 (257 files) | 128.0 ms | 33.0 ms | 3.88× |
| case g-0002 (348 files) | 197.9 ms | 69.3 ms | 2.85× |
| case g-0003 (486 files) | 266.9 ms | 76.4 ms | 3.50× |
| **total, 3 cases** | **592.8 ms** | **178.7 ms** | **3.32×** |

End to end through `main.ts` (JSON parse + `run` + stringify, 5 reps):
mine 0.63–1.01 s CPU vs baseline 1.23–1.47 s CPU per run. `main.ts` run
twice gives byte-identical `answers.json`
(SHA-256 `25980928b145f54712027939364a64c277098bc4528a2d524e0bc27a0275fb03`),
also identical to the baseline's output; see `BUILD_REPORT.md` in the build
directory for the measured numbers.
