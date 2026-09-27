# Third-party notices

`aseprite-mcp` itself is MIT licensed (see [LICENSE](LICENSE)). It bundles a
small amount of material created by other people, listed here.

## Aseprite

This server drives [Aseprite](https://www.aseprite.org/) but does **not**
bundle, redistribute or modify it. Aseprite is a separate commercial product by
Igara Studio S.A.; you need your own licensed copy to use this server. The
project also contains no Aseprite source code — it talks to the installed
application through the documented `--script` and batch command-line interface.

## Bundled colour palettes

`src/lua/aseprite_lib.lua` (the `BUILTIN_PALETTES` table) hard-codes several
well-known pixel-art palettes so that `aseprite_load_palette` works offline.

These palettes are the common currency of the pixel-art community and most of
them also ship with Aseprite itself. **However, several do not carry an explicit
open-source licence**, and a palette is a creative work. They are included here
for convenience; if you intend to use one commercially, confirm the terms with
its author.

| Preset | Colours | Origin | Notes |
| --- | --- | --- | --- |
| `pico8` | 16 | [PICO-8](https://www.lexaloffle.com/pico-8.php) by Lexaloffle | PICO-8 itself is commercial software; widely reproduced as a de-facto standard. |
| `gameboy` | 4 | Nintendo Game Boy hardware | Hardware colour values, not creative work. |
| `nes` | 16 | Nintendo Entertainment System hardware | Hardware palette approximation. |
| `db16` | 16 | DawnBringer's 16-colour palette | Long published for free reuse in the pixel-art community. |
| `db32` | 32 | DawnBringer's 32-colour palette | As above. |
| `sweetie16` | 16 | ["Sweetie 16"](https://lospec.com/palette-list/sweetie-16) by [GrafxKid](http://grafxkid.tumblr.com/palettes) | Attribution expected; licence not stated. |
| `endesga32` | 32 | ["Endesga 32"](https://lospec.com/palette-list/endesga-32) by [ENDESGA](https://twitter.com/ENDESGA), made for NYKRA | Attribution expected; licence not stated. |

`aseprite_load_palette` also accepts `file:`, so you can point it at any `.gpl`
or `.ase` palette you have the rights to instead of using the built-ins.

If you are a palette author and would like your palette removed or its credit
changed, please open an issue and it will be handled promptly.

## Bundled bitmap font

The 5×7 pixel font in `src/lua/aseprite_lib.lua` (the `FONT` table) was hand-authored
for this project and is covered by the project's MIT licence.
