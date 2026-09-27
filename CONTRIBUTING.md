# Contributing

Thanks for taking a look. This project talks to a moving target — Aseprite's Lua
API is not fully documented and differs between builds — so the most valuable
contributions are usually **bug reports with the exact Aseprite behaviour**, and
compatibility fixes.

## Getting set up

You need Node.js 18+ and an Aseprite 1.3+ installation. There is nothing to
install: the project has zero runtime dependencies.

```bash
git clone https://github.com/baichuan4167-lang/aseprite-mcp.git
cd aseprite-mcp

# static checks - no Aseprite needed
node test/syntax-check.js
node test/protocol.js

# the full suite - needs a real Aseprite
node test/smoke.js
```

If Aseprite is not in a standard location, set `ASEPRITE_PATH` to the binary.

## Before opening a pull request

- `node test/syntax-check.js` and `node test/protocol.js` must pass. These run
  in CI on every push.
- `node test/smoke.js` must pass if you touched anything under `src/`. It makes
  85 assertions against a real Aseprite.
- If you changed behaviour, add or update an assertion in `test/smoke.js`, and
  add an entry to `CHANGELOG.md`.

## The one rule that matters most

**A test that only checks file size or PNG header dimensions is not a test.**
This project shipped a bug where a scaled sprite sheet had the correct canvas
size and metadata while the artwork inside stayed at 1x scale — every
dimension-based check passed. Content assertions need the actual pixels, which
is why `test/png.js` exists. Use it.

## Working on the Lua library

`src/lua/aseprite_lib.lua` is the whole drawing engine and runs inside Aseprite's
embedded Lua, which is a restricted dialect:

- No bitwise operators. `test/` code is plain Node and unaffected, but anything
  inside the library must do shifts and masks arithmetically.
- JSON numbers decode as **floats** and Aseprite's bindings require integers, so
  every coordinate must pass through `int()`.
- `json.decode` returns **userdata**, not a table. Test with `istable()`, never
  `type(x) == "table"`. Likewise, a JSON array containing `null` decodes with a
  hole, and both `#` and `ipairs` stop at the first `nil` — that is why pixel
  data is transferred as dense character rows rather than sparse arrays.
- Save the file as **UTF-8 without a BOM**. A BOM is an immediate syntax error,
  and `test/syntax-check.js` guards against it.

Before adding a workaround, reproduce the raw Aseprite behaviour in a standalone
script so the reason is recorded. Every such workaround in the library is
documented at its call site; please keep that up.

## Reporting an Aseprite incompatibility

Please include:

1. Your exact Aseprite version (`aseprite --version`).
2. The tool call you made, and the full error text.
3. Whether the same call works in the Aseprite GUI.

## Scope

This server deliberately does **not** bundle, patch or redistribute Aseprite —
it drives an installed copy through the documented command-line interface. Please
keep it that way. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the
same reason behind the palette credits.
