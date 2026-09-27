# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-27

First public release.

### Added

- Zero-dependency MCP server (JSON-RPC over stdio) that drives Aseprite in
  headless batch mode, with the `.aseprite` file on disk as the source of truth.
- **43 tools** covering documents, layers, frames and tags, drawing, palettes,
  canvas transforms, previews, and import/export.
- Drawing primitives implemented directly against pixel data, because this
  Aseprite build provides none: Bresenham lines, rectangles, ellipses,
  polygons, Catmull-Rom splines, flood fill, banded gradients, ordered Bayer
  dithering (2×2 / 4×4 / 8×8), repeating patterns, and a built-in 5×7 bitmap font.
- Compact character-grid input for `aseprite_pixels`, which both saves tokens and
  avoids a real Lua data hazard (see below).
- `aseprite_frames_from_grids` to draw an entire animation in a single call.
- `aseprite_draw_across_frames` to repeat primitives over several frames with a
  per-frame offset — the cheap way to animate motion.
- `aseprite_view` and `aseprite_onion_preview`, which hand the artwork back to
  the agent as a PNG so it can actually look at what it drew.
- Exports: PNG, animated GIF, per-frame sequences, and sprite sheets with JSON
  metadata (frame rects, durations, tags, layers) for game engines.
- A dependency-free PNG encoder and a minimal PNG decoder used by the tests.
- 85 end-to-end assertions (`test/smoke.js`) run against a real Aseprite
  installation over the real stdio protocol, plus focused probes for the
  trickiest Aseprite behaviours.

### Notes on Aseprite compatibility

Verified against Aseprite 1.3.18.3 (dev build). Several behaviours differ from
the published Lua API documentation; each is worked around and documented at the
call site in `src/lua/aseprite_lib.lua`:

- `json.decode` returns userdata rather than a table, so `type(x) == "table"`
  fails and arrays with `nil` holes truncate under `#`/`ipairs`.
- `Image:drawImage(src, Rectangle(...), x, y)` clears the destination; only the
  coordinate forms copy reliably.
- `Sprite:newFrame(n)` takes a **duration in seconds**, not an index, and there
  is no `reorderFrame` / `DuplicateFrame` / `Crop` / `MergeDown` / `DrawText`
  command — frame insertion, duplication and reordering rebuild the timeline.
- `app.command.CanvasSize` does not resize the canvas, and `Sprite:resize`
  destroys cel contents, so canvas operations rebuild cels.
- `ExportSpriteSheet` silently ignores its `scale` parameter.
- Layer order is set through the writable `Layer.stackIndex`.
- In indexed colour mode `getPixel` returns a palette index, not an RGBA word.
- A `.lua` file with a UTF-8 BOM is an immediate syntax error.
