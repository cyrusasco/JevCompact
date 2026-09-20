# NOTICE

JevCompact — lossless session compaction, optimized for Chinese.

This product bundles code derived from third parties:

## fast-jev-compaction (MIT)
- Project: https://github.com/tamaratran/fast-jev-compaction
- Author: tamaratran
- License: MIT (text preserved in `lib/dist/LICENSE.upstream`)
- Used in: `lib/dist/` — the Jev (TypeSafe System One) client and the
  keep/drop compaction algorithm (`compactMessages`, `collectToolCalls`
  numbering semantics, `reductionRatio`).

## TypeSafe Jev API
- The classifier calls are made against the TypeSafe System One API
  (`https://api.typesafe.ai/v1/systemone`) and require your own API key.
- No affiliation or endorsement by TypeSafe is implied.

## Benchmark corpus
- The benchmark sessions in `docs/EVIDENCE.md` were conducted on private
  archived sessions of the project author's own machine; no third-party
  content is distributed with this repository.

All trademarks are the property of their respective owners.
