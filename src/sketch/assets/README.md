# Human mannequin

`humanoid.json` is a derived mesh, skin weights and joint landmarks from the
MakeHuman core assets at commit `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`:

- `makehuman/data/3dobjs/base.obj` (only the body surface, without helper geometry)
- `makehuman/data/rigs/default.mhskel`
- `makehuman/data/rigs/default_weights.mhw`

Source: https://github.com/makehumancommunity/makehuman

These assets are CC0 1.0 Universal; the full license is in `LICENSE-CC0.txt` and
available in the editor's license dialog. No MakeHuman/MPFB generator source code
is embedded. The mesh has 13,380 vertices, 26,756 triangles, eleven skin bones,
and at most four normalized influences per vertex. Arms are baked into a relaxed
rest pose to preserve the editor's existing joint angle convention.

Regenerate with `node scripts/prepare-humanoid.mjs` from the repository root.
Downloads are cached under `output/humanoid-source/` (or the directory passed as
the first argument); they are not needed for ordinary builds or at runtime.
The runtime applies proportion changes to both the rest mesh and joint centers,
updates inverse bind matrices, and then reapplies the stored pose. Hands, feet
and face have no independent controls in this version.
