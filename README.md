# eve-tokyo

Compaction drift benchmark for [eve](https://github.com/vercel/eve) agents.

Long agent runs compact more than once, and each compaction rewrites the last
checkpoint. eve-tokyo measures what survives: it replays real sessions, compacts
them repeatedly, and scores which exact details (file paths, error strings,
commands, decisions) are still recoverable after each round, alongside context
reduction, cost and latency.

Status: work in progress. No results yet.
