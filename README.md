# Auto Upgrade Skill for Deadlock (Build Auto-Level v0.1-dev)

Spends your ability points automatically, in the ability order of the hero build you have selected.

> **Based on [Build Auto-Level v1.0](https://gamebanana.com/mods/727925) by SkyAxe.**
> The auto-level core (reading the build's next step, the purchase methods and their safety rules) is SkyAxe's work.
> This fork adds the features listed below. Development build — not a release.

## What it does

- **Follows your build.** Deadlock marks the next ability your build wants (the "Recommended" badge); the mod
  buys that step as soon as you can afford it. No build selected, or a build without an ability order: it does nothing.
- **Respects manual changes.** Refund an upgrade (within the game's ~10 s refund window) and auto-level pauses,
  so the point is not spent on the same ability again. Spend that point wherever you like and it carries on by itself
  with the next new point. Upgrading a different ability by hand needs no pause.
- **Per-build on/off.**
  - `AL: ON / OFF` button after each build name in the build browser (B > Browse builds).
  - Put `[noAL]` in a build's name to switch it off permanently (the game saves the name with the build).
- **MOD page in the Esc menu.** Esc > `MOD` opens a page listing mods: Build Auto-Level's settings (on/off,
  quick controls, pause/resume, debug) and other mods that have their own page (HP COLORS). Built by script,
  so it works alongside mods that replace the Esc menu layout. Other mods can add a section (see below).
- **Quick controls** (off by default): `Max now` (spend every point now), `Undo` (sell back the latest upgrade
  inside the refund window), `Pause / Resume`. In Sandbox they sit in the test tools menu (hold Tab); in matches
  in a small bar that shows while the shop or scoreboard is open.

### Known limits

- Settings are saved through a small page on this repo's GitHub Pages site (`docs/store/`), loaded in a hidden
  HTML panel; values live in that page's localStorage inside the game's browser (same idea as HP COLORS).
  Needs internet and GitHub Pages enabled for the repo (Settings > Pages > main / docs). Without it they last for
  the current map only. `[noAL]` in a build name always works.
- Sandbox has unlimited points and the HUD never marks pips as affordable there, so normal auto-level does not run
  in Sandbox; use `Max now`.
- Hero name is not readable from the HUD, so there is no per-hero switch.

## Install

1. Copy `dist/pak21_dir.vpk` (build it first, see below) into `Deadlock/game/citadel/addons/`.
   Rename the number if `pak21` is taken.
2. `citadel/gameinfo.gi` must have `Game citadel/addons` in `SearchPaths` (mod managers usually add it).
3. Remove any other copy of Build Auto-Level from `addons`, otherwise both run.

## Build

No Source 2 workshop tools needed.

```bash
python -I tools/build.py
```

Writes `dist/pak21_dir.vpk`. A `.vjs_c` file keeps its JavaScript uncompressed in the DATA block, so `build.py`
splices `src/panorama/scripts/build_autolevel.js` into the original compiled script from v1.0 (`base/`), fixes the
block and file sizes, and packs a single-file VPK v2 together with v1.0's two layouts (unchanged: they only include
the script). Feeding it the original v1.0 JavaScript reproduces the original `.vjs_c` byte for byte.

## Test

A small mock of the Panorama API runs the script outside the game:

```bash
node tests/sim.js src/panorama/scripts/build_autolevel.js
```

It covers auto-level, refund pause/resume, Max now, Undo, the MOD page, build-row toggles and the Sandbox block.
It is a mock: anything that depends on the real game (class names, events) still needs an in-game check.

## Debugging in game

Esc > MOD > `Debug` writes the script's view of the HUD to the console. Filter it with:

```
con_filter_text BuildAutoLevel
con_filter_enable 1
```

## MOD page convention (for other mods)

| Panel | Role |
|---|---|
| `#ModHubMenuEntry` | the "MOD" entry, inserted before the Esc menu's Settings row |
| `#ModHubPanel` | the page, child of the Esc menu root; class `ModHubOpen` while shown |
| `#ModHubSections` | append your own `#ModHubSection_<Name>` with attribute `ModHubTitle` = name in the list |

Whichever mod loads first creates the entry and the page; the others only add a section.

## Roadmap

- Clean up code left from earlier UI experiments (Settings popup survey, tagged-only mode, delay).

## Layout

| Path | Contents |
|---|---|
| `src/panorama/scripts/build_autolevel.js` | the script — edit this |
| `base/` | v1.0's compiled layouts and compiled script (build templates), and v1.0's JavaScript for reference |
| `tools/build.py` | builds the VPK |
| `tests/sim.js` | Panorama mock and test cases |
