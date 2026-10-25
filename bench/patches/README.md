# Strategy patches

One folder per eve commit the bench has been pinned to (`bench/setup.sh`, `EVE_SHA`). Each
`*.patch` in the folder for the current pin becomes a strategy: a sibling copy of eve's real
`engine.ts` / `prompt.ts` with that one patch applied. The first line of a patch, `label: <name>`,
names the strategy in the results. `DEFAULT_LABEL` names eve's unpatched engine at that commit.

- `0fd4240/` (eve 0.79.0, 2026-10-13): the published results. `fix-4771` adds the idempotence
  guard, `head-tail` adds that and a 60/40 head + tail cap, `head-tail+anchors` adds an
  identifier index on top.
- `a3654ef/` (#4771 and #4773 merged, 2026-10-15): no patches. eve's own engine now contains
  both fixes and runs as `eve-4773`.
