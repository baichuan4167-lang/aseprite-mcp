--[[----------------------------------------------------------------------------
  aseprite_lib.lua — the drawing engine that runs inside Aseprite.

  Invoked as:  aseprite -b --script aseprite_lib.lua

  Protocol
  --------
  Input :  a JSON file path stored in the environment variable ASPRITE_CMD
           { "cmd": "<operation>", "doc": "<path.aseprite>", "args": { ... } }
  Output:  a JSON file path in ASPRITE_OUT, written as
           { "ok": true, "data": {...} }  or  { "ok": false, "error": "..." }

  Everything is written into a single process, so globals are safe to use.

  API notes learned from this Aseprite build (1.3.18.3-dev):
    * Image:getPixel returns a *number*, not a Color object.
      Read channels with app.pixelColor.rgbaR/G/B/A or grayaV/grayaA.
    * There is no Image:drawLine / drawRect / drawEllipse -> implemented here.
    * There is no Sprite:select()/deselect() -> selections are not scriptable,
      so region ops are implemented directly against pixel data.
    * app.command.Fill reads the tool's own foreground colour and ignores a
      color parameter, so flood fill is implemented here too.
    * Command ids are PascalCase verb+noun with no underscores (Clear, Flip,
      SetLoopSection, ExportSpriteSheet, ...).
------------------------------------------------------------------------------]]

local RESULT = { ok = true, data = {} }

----------------------------------------------------------------------------
-- tiny utilities
----------------------------------------------------------------------------

local function warn(s)
  io.stderr:write("[aseprite-mcp] " .. tostring(s) .. "\n")
end

local function die(msg, ...)
  error(string.format(tostring(msg), ...), 0)
end

--- True for a Lua table OR the userdata object this build's json.decode returns.
--
-- Aseprite 1.3.18.3-dev's `json.decode` hands back userdata objects that behave
-- like tables (they support indexing and `pairs`) but fail `type(x) == "table"`.
-- Anything that arrived from JSON must be tested with this predicate.
local function istable(t)
  local ty = type(t)
  return ty == "table" or ty == "userdata"
end

local function isarr(t)
  return istable(t) and #t > 0
end

local function round(n)
  return math.floor((tonumber(n) or 0) + 0.5)
end

--- Coerce a JSON number back to an integer. json.decode turns every number
--- into a float, and Aseprite's Lua binding rejects floats where it wants ints.
local function int(n, default)
  if n == nil then
    if default == nil then die("integer argument required") end
    return default
  end
  return math.floor(tonumber(n))
end

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

local function pathjoin(a, b)
  return app.fs.joinPath(a, b)
end

----------------------------------------------------------------------------
-- colour parsing
----------------------------------------------------------------------------

local NAMED = {
  transparent = "00000000", none = "00000000",
  black = "000000ff", white = "ffffffff",
  red = "ff0000ff", green = "00ff00ff", blue = "0000ffff",
  yellow = "ffff00ff", cyan = "00ffffff", magenta = "ff00ffff",
  orange = "ff8000ff", purple = "8000ffff", pink = "ff80c0ff",
  gray = "808080ff", grey = "808080ff", brown = "8b4513ff",
}

local function hex2(s)
  return tonumber(s, 16) or 0
end

--- Accepts "#rgb" "#rgba" "#rrggbb" "#rrggbbaa" "#rrggbb@aa",
--- a named colour, 0-255 grey, {r,g,b[,a]}, {r=..,g=..,b=..,a=..},
--- or {v=..,a=..} for grayscale sprites.
--- @return r,g,b,a  (0-255)
local function parseColor(c, defaultAlpha)
  local a = defaultAlpha == nil and 255 or defaultAlpha
  if c == nil then return 0, 0, 0, 0 end

  if type(c) == "number" then
    return round(c), round(c), round(c), a
  end

  if type(c) == "string" then
    local s = c:gsub("%s", "")
    local named = NAMED[s:lower()]
    if named then s = named end
    local at = s:find("@")
    if at then
      a = hex2(s:sub(at + 1))
      s = s:sub(1, at - 1)
    end
    s = s:gsub("^#", "")
    if #s == 3 then
      local r, g, b = s:sub(1, 1), s:sub(2, 2), s:sub(3, 3)
      return hex2(r .. r), hex2(g .. g), hex2(b .. b), a
    elseif #s == 4 then
      local r, g, b, al = s:sub(1, 1), s:sub(2, 2), s:sub(3, 3), s:sub(4, 4)
      return hex2(r .. r), hex2(g .. g), hex2(b .. b), hex2(al .. al)
    elseif #s == 6 then
      return hex2(s:sub(1, 2)), hex2(s:sub(3, 4)), hex2(s:sub(5, 6)), a
    elseif #s == 8 then
      return hex2(s:sub(1, 2)), hex2(s:sub(3, 4)), hex2(s:sub(5, 6)), hex2(s:sub(7, 8))
    end
    die("unrecognized colour string: %s", c)
  end

  if istable(c) then
    if c.r ~= nil or c.g ~= nil or c.b ~= nil then
      return round(c.r or 0), round(c.g or 0), round(c.b or 0),
        c.a ~= nil and round(c.a) or a
    end
    if c.v ~= nil then
      return round(c.v), round(c.v), round(c.v), c.a ~= nil and round(c.a) or a
    end
    if isarr(c) then
      if #c == 1 then
        local v = round(c[1]); return v, v, v, a
      end
      return round(c[1] or 0), round(c[2] or 0), round(c[3] or 0),
        c[4] ~= nil and round(c[4]) or a
    end
  end
  die("unrecognized colour value: %s", tostring(c))
end

--- Pack r,g,b,a into the raw pixel value the current sprite's colour mode wants.
--- Colour mode is resolved lazily from the active sprite, unless `mode` is given.
local function packColor(r, g, b, a, mode)
  mode = mode or (app.activeSprite and app.activeSprite.colorMode) or ColorMode.RGB
  if mode == ColorMode.GRAYSCALE then
    local v = clamp(round(0.299 * r + 0.587 * g + 0.114 * b), 0, 255)
    return app.pixelColor.graya(v, clamp(round(a), 0, 255))
  elseif mode == ColorMode.INDEXED then
    -- Nearest palette entry; the sprite's own palette is the authority.
    local spr = app.activeSprite
    if not spr or not spr.palettes[1] then return 0 end
    local pal = spr.palettes[1]
    local best, bestd = 0, math.huge
    for i = 0, #pal - 1 do
      local pc = pal:getColor(i)
      local dr, dg, db = pc.red - r, pc.green - g, pc.blue - b
      local d = dr * dr + dg * dg + db * db
      if d < bestd then bestd, best = d, i end
    end
    return best
  end
  return app.pixelColor.rgba(clamp(round(r), 0, 255), clamp(round(g), 0, 255),
    clamp(round(b), 0, 255), clamp(round(a), 0, 255))
end

--- Unpack a raw pixel value into r,g,b,a (0-255), honouring the sprite mode.
--
-- Indexed images store the PALETTE INDEX, not an RGBA word, so running the
-- rgba* accessors over them is meaningless. The index is resolved through the
-- active sprite's palette instead. Indexed pixels are never transparent in
-- Aseprite, so alpha is reported as 255.
local function unpackColor(px, mode, spr)
  mode = mode or (app.activeSprite and app.activeSprite.colorMode) or ColorMode.RGB
  if mode == ColorMode.GRAYSCALE then
    local v = app.pixelColor.grayaV(px)
    local a = app.pixelColor.grayaA(px)
    return v, v, v, a
  end
  if mode == ColorMode.INDEXED then
    local owner = spr or app.activeSprite
    local pal = owner and owner.palettes and owner.palettes[1]
    if pal and px >= 0 and px < #pal then
      local c = pal:getColor(px)
      return c.red, c.green, c.blue, 255
    end
    return 0, 0, 0, 255
  end
  return app.pixelColor.rgbaR(px), app.pixelColor.rgbaG(px),
    app.pixelColor.rgbaB(px), app.pixelColor.rgbaA(px)
end

--- Alpha of a raw pixel, valid for every colour mode.
local function pixelAlpha(px, mode)
  if mode == ColorMode.INDEXED then return 255 end
  if mode == ColorMode.GRAYSCALE then return app.pixelColor.grayaA(px) end
  return app.pixelColor.rgbaA(px)
end

local function toHex(px, mode, spr)
  local r, g, b, a = unpackColor(px, mode, spr)
  if a >= 255 then
    return string.format("#%02x%02x%02x", r, g, b)
  end
  return string.format("#%02x%02x%02x%02x", r, g, b, a)
end

----------------------------------------------------------------------------
-- image helpers
----------------------------------------------------------------------------

local function px(img, x, y, color)
  if x < 0 or y < 0 or x >= img.width or y >= img.height then return end
  img:putPixel(x, y, color)
end

--- Blend `color` over the existing pixel at x,y with source-over alpha.
--- Only meaningful for RGB/grayscale; indexed pixels hold palette indices.
local function pxBlend(img, x, y, color, mode)
  if mode == ColorMode.INDEXED then img:putPixel(x, y, color); return end
  if x < 0 or y < 0 or x >= img.width or y >= img.height then return end
  local sr, sg, sb, sa = unpackColor(color, mode)
  if sa >= 255 then img:putPixel(x, y, color); return end
  if sa <= 0 then return end
  local dr, dg, db, da = unpackColor(img:getPixel(x, y), mode)
  local af = sa / 255
  local nr = round(sr * af + dr * (1 - af))
  local ng = round(sg * af + dg * (1 - af))
  local nb = round(sb * af + db * (1 - af))
  local na = round(sa + da * (1 - af))
  img:putPixel(x, y, packColor(nr, ng, nb, na, mode))
end

--- Resolve the Image to draw into. Creates the cel when it does not exist yet.
local function celImage(spr, layerName, frameIdx)
  local layer
  if layerName ~= nil then
    layer = spr.layers[layerName]
    -- layers[] also matches by display name; fall back to a linear scan
    if not layer then
      for _, l in ipairs(spr.layers) do
        if l.name == layerName then layer = l break end
      end
    end
    if not layer then die("layer not found: %s", tostring(layerName)) end
  else
    layer = app.activeLayer or spr.layers[1]
  end
  local frame = spr.frames[clamp(frameIdx or 1, 1, #spr.frames)]
  local cel = layer:cel(frame)
  if not cel then
    cel = spr:newCel(layer, frame)
  end
  if not cel.image then die("could not create an image for layer/cel") end
  return cel.image
end

--- Copy all of `src` onto `dst` at (dx, dy).
--
-- Do NOT use the Rectangle overload of Aseprite's Image:drawImage on this
-- build: `drawImage(src, Rectangle(...), x, y)` silently clears the
-- destination to fully transparent instead of copying. The coordinate forms
-- (`drawImage(src, x, y)` and `drawImage(src, Point(x, y))`) both work, so
-- every copy in this file goes through this helper.
local function blit(dst, src, dx, dy)
  dst:drawImage(src, int(dx or 0), int(dy or 0))
end

--- Copy a rectangular region of `src` onto `dst` at (dx, dy).
--- Performs the crop with a manual pixel loop because the source-rectangle
--- overload is unusable (see `blit`).
local function blitRegion(dst, src, sx, sy, w, h, dx, dy)
  sx, sy, w, h, dx, dy = int(sx), int(sy), int(w), int(h), int(dx or 0), int(dy or 0)
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      local px0, py0 = sx + x, sy + y
      local dx0, dy0 = dx + x, dy + y
      if px0 >= 0 and py0 >= 0 and px0 < src.width and py0 < src.height
        and dx0 >= 0 and dy0 >= 0 and dx0 < dst.width and dy0 < dst.height then
        dst:putPixel(dx0, dy0, src:getPixel(px0, py0))
      end
    end
  end
end

local function imageOfCel(cel)
  return cel and cel.image or nil
end

--- Composite every visible layer of `frame` onto a fresh transparent image.
local function compositeFrame(spr, frame)
  local out = Image(spr.width, spr.height, spr.colorMode)
  for _, l in ipairs(spr.layers) do
    if l.isVisible and not l.isGroup then
      local img = imageOfCel(l:cel(frame))
      if img then blit(out, img, 0, 0) end
    end
  end
  return out
end

----------------------------------------------------------------------------
-- rasterisation primitives
----------------------------------------------------------------------------

local function line(img, x0, y0, x1, y1, color, mode)
  x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
  local dx, dy = math.abs(x1 - x0), math.abs(y1 - y0)
  local sx = x0 < x1 and 1 or -1
  local sy = y0 < y1 and 1 or -1
  local err = dx - dy
  local guard = 0
  local maxSteps = dx + dy + 4
  while true do
    px(img, x0, y0, color)
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 > -dy then err = err - dy; x0 = x0 + sx end
    if e2 < dx then err = err + dx; y0 = y0 + sy end
    guard = guard + 1
    if guard > maxSteps then break end
  end
end

local function rect(img, x, y, w, h, color, filled)
  x, y, w, h = int(x), int(y), int(w), int(h)
  if w <= 0 or h <= 0 then return end
  if filled then
    for yy = y, y + h - 1 do
      for xx = x, x + w - 1 do px(img, xx, yy, color) end
    end
  else
    for xx = x, x + w - 1 do
      px(img, xx, y, color); px(img, xx, y + h - 1, color)
    end
    for yy = y, y + h - 1 do
      px(img, x, yy, color); px(img, x + w - 1, yy, color)
    end
  end
end

--- Midpoint ellipse. cx,cy may be fractional (pixel centres).
local function ellipse(img, cx, cy, rx, ry, color, filled)
  if rx <= 0 or ry <= 0 then return end
  local function edge(x, y)
    px(img, x, y, color)
    if filled then
      for xx = x, x + 2 * rx - 1 do px(img, xx, y, color) end
    end
  end
  if filled then
    -- scanline fill using the analytic ellipse
    for dy = -ry, ry - 1 do
      local t = 1 - (dy + 0.5) * (dy + 0.5) / (ry * ry)
      if t >= 0 then
        local span = math.sqrt(t) * rx
        local x0 = round(cx - span)
        local x1 = round(cx + span) - 1
        for xx = x0, x1 do px(img, xx, round(cy) + dy, color) end
      end
    end
    return
  end
  -- outline: sample the parametric form densely enough for any radius
  local steps = math.max(16, round(2 * math.pi * math.max(rx, ry) * 1.4))
  local seen = {}
  for i = 0, steps do
    local a = 2 * math.pi * i / steps
    local x = round(cx + rx * math.cos(a))
    local y = round(cy + ry * math.sin(a))
    local k = x .. "," .. y
    if not seen[k] then seen[k] = true; px(img, x, y, color) end
  end
  -- fill horizontal gaps for very flat/wide ellipses
  for y = round(cy - ry), round(cy + ry) do
    local t = 1 - (y + 0.5 - cy) * (y + 0.5 - cy) / (ry * ry)
    if t >= 0 then
      local span = math.sqrt(t) * rx
      local xa = round(cx - span)
      local xb = round(cx + span)
      if xb - xa <= 2 then
        for xx = xa, xb do px(img, xx, y, color) end
      else
        px(img, xa, y, color); px(img, xb, y, color)
      end
    end
  end
end

--- Scanline flood fill from a seed pixel.
--
-- Pixels are compared in the sprite's own colour space. With tolerance 0 the
-- raw pixel value is compared, which is exact for every colour mode including
-- indexed. A non-zero tolerance compares unpacked channels instead.
local function floodFill(img, x, y, color, mode, tolerance, srcMode)
  x, y = int(x), int(y)
  if x < 0 or y < 0 or x >= img.width or y >= img.height then return 0 end
  tolerance = tolerance or 0
  local smode = srcMode or mode
  local target = img:getPixel(x, y)

  local match
  if tolerance <= 0 then
    match = function(p) return p == target end
  else
    local tr, tg, tb, ta = unpackColor(target, smode)
    match = function(p)
      local r, g, b, a = unpackColor(p, smode)
      return math.abs(r - tr) <= tolerance and math.abs(g - tg) <= tolerance
        and math.abs(b - tb) <= tolerance and math.abs(a - ta) <= tolerance
    end
  end

  local stack = { { x, y } }
  local seen = {}
  local n = 0
  while #stack > 0 do
    local pt = table.remove(stack)
    local cx0, cy0 = pt[1], pt[2]
    if cx0 >= 0 and cy0 >= 0 and cx0 < img.width and cy0 < img.height then
      local k = cy0 * img.width + cx0
      if not seen[k] then
        seen[k] = true
        if match(img:getPixel(cx0, cy0)) then
          img:putPixel(cx0, cy0, color)
          n = n + 1
          stack[#stack + 1] = { cx0 + 1, cy0 }
          stack[#stack + 1] = { cx0 - 1, cy0 }
          stack[#stack + 1] = { cx0, cy0 + 1 }
          stack[#stack + 1] = { cx0, cy0 - 1 }
        end
      end
    end
  end
  return n
end

--- Sparse (wang) line: every pixel between two points, densely.
local function pathPixels(pts)
  local out = {}
  for _, p in ipairs(pts) do out[#out + 1] = { int(p[1]), int(p[2]) } end
  return out
end

local function spline(img, points, color, mode)
  local pts = {}
  for _, p in ipairs(points) do pts[#pts + 1] = { int(p[1]), int(p[2]) } end
  if #pts < 2 then
    if pts[1] then px(img, pts[1][1], pts[1][2], color) end
    return
  end
  -- Catmull-Rom through the control points
  local ext = { pts[1] }
  for _, p in ipairs(pts) do ext[#ext + 1] = p end
  ext[#ext + 1] = pts[#pts]
  for i = 2, #ext - 2 do
    local p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
    local dist = math.sqrt((p2[1] - p1[1]) ^ 2 + (p2[2] - p1[2]) ^ 2)
    local steps = math.max(4, round(dist * 2))
    local prev
    for s = 0, steps do
      local t = s / steps
      local t2, t3 = t * t, t * t * t
      local x = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t
        + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
        + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      local y = 0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t
        + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2
        + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3)
      local cx, cy = round(x), round(y)
      if prev then line(img, prev[1], prev[2], cx, cy, color, mode) end
      prev = { cx, cy }
    end
  end
end

local function polygon(img, points, color, mode, filled)
  local pts = {}
  for _, p in ipairs(points) do pts[#pts + 1] = { int(p[1]), int(p[2]) } end
  if #pts < 2 then return end
  if not filled then
    for i = 1, #pts do
      local a, b = pts[i], pts[i % #pts + 1]
      line(img, a[1], a[2], b[1], b[2], color, mode)
    end
    return
  end
  -- even-odd scanline fill
  local miny, maxy = math.huge, -math.huge
  for _, p in ipairs(pts) do
    if p[2] < miny then miny = p[2] end
    if p[2] > maxy then maxy = p[2] end
  end
  for y = miny, maxy do
    local xs = {}
    for i = 1, #pts do
      local a, b = pts[i], pts[i % #pts + 1]
      local y1, y2 = a[2], b[2]
      if (y1 <= y and y2 > y) or (y2 <= y and y1 > y) then
        local t = (y - y1) / (y2 - y1)
        xs[#xs + 1] = a[1] + t * (b[1] - a[1])
      end
    end
    table.sort(xs)
    for i = 1, #xs - 1, 2 do
      local x0, x1 = round(xs[i]), round(xs[i + 1]) - 1
      for xx = x0, x1 do px(img, xx, y, color) end
    end
  end
end

--- Linear gradient across a rectangle, in 1..n bands.
local function gradient(img, x, y, w, h, c1, c2, bands, direction, mode)
  x, y, w, h = int(x), int(y), int(w), int(h)
  bands = math.max(2, int(bands or 16))
  if w <= 0 or h <= 0 then return end
  local r1, g1, b1, a1 = parseColor(c1)
  local r2, g2, b2, a2 = parseColor(c2)
  local horiz = (direction == "horizontal")
  local span = horiz and w or h
  for i = 0, bands - 1 do
    local t = (bands == 1) and 0 or (i / (bands - 1))
    local r = round(r1 + (r2 - r1) * t)
    local g = round(g1 + (g2 - g1) * t)
    local b = round(b1 + (b2 - b1) * t)
    local a = round(a1 + (a2 - a1) * t)
    local col = packColor(r, g, b, a, mode)
    local lo = math.floor(i * span / bands)
    local hi = math.floor((i + 1) * span / bands)
    if hi > lo then
      if horiz then
        rect(img, x + lo, y, hi - lo, h, col, true)
      else
        rect(img, x, y + lo, w, hi - lo, col, true)
      end
    end
  end
end

--- Ordered Bayer dithering matrices.
-- Indices run [row+1][col+1]; values are the standard 2x2 / 4x4 / 8x8
-- thresholds, divided by 4 / 16 / 64 when used.
local BAYER2 = { { 0, 2 }, { 3, 1 } }
local BAYER4 = {
  { 0, 8, 2, 10 },
  { 12, 4, 14, 6 },
  { 3, 11, 1, 9 },
  { 15, 7, 13, 5 },
}
local BAYER8 = {
  { 0, 32, 8, 40, 2, 34, 10, 42 },
  { 48, 16, 56, 24, 50, 18, 58, 26 },
  { 12, 44, 4, 36, 14, 46, 6, 38 },
  { 60, 28, 52, 20, 62, 30, 54, 22 },
  { 3, 35, 11, 43, 1, 33, 9, 41 },
  { 51, 19, 59, 27, 49, 17, 57, 25 },
  { 15, 47, 7, 39, 13, 45, 5, 37 },
  { 63, 31, 55, 23, 61, 29, 53, 21 },
}

local function ditherPattern(name)
  if name == "bayer2" then return BAYER2, 4 end
  if name == "bayer8" then return BAYER8, 64 end
  return BAYER4, 16
end

local function dither(img, x, y, w, h, c1, c2, matrixName, ratio, mode)
  x, y, w, h = int(x), int(y), int(w), int(h)
  local m, div = ditherPattern(matrixName)
  local size = #m
  local r1, g1, b1, a1 = parseColor(c1)
  local r2, g2, b2, a2 = parseColor(c2)
  local col1 = packColor(r1, g1, b1, a1, mode)
  local col2 = packColor(r2, g2, b2, a2, mode)
  ratio = ratio == nil and 0.5 or tonumber(ratio)
  for yy = y, y + h - 1 do
    for xx = x, x + w - 1 do
      local t = m[(yy - y) % size + 1][(xx - x) % size + 1] / div
      if t < ratio then px(img, xx, yy, col2) else px(img, xx, yy, col1) end
    end
  end
end

--- Repeat a rectangular tile of pixels across a region.
local function patternFill(img, x, y, w, h, tile, mode)
  x, y, w, h = int(x), int(y), int(w), int(h)
  local th = #tile
  if th == 0 then return end
  local tw = #tile[1]
  local packed = {}
  for ty = 1, th do
    packed[ty] = {}
    for tx = 1, tw do
      local v = tile[ty][tx]
      if v == nil or v == "." or v == "" then
        packed[ty][tx] = nil -- leave untouched
      else
        local r, g, b, a = parseColor(v)
        packed[ty][tx] = packColor(r, g, b, a, mode)
      end
    end
  end
  for yy = y, y + h - 1 do
    for xx = x, x + w - 1 do
      local c = packed[(yy - y) % th + 1][(xx - x) % tw + 1]
      if c ~= nil then px(img, xx, yy, c) end
    end
  end
end

--- Average the colours of a rectangle (used by the palette-from-image tool).
local function averageRegion(img, x, y, w, h, mode)
  x, y, w, h = int(x), int(y), int(w), int(h)
  local sr, sg, sb, sa, n = 0, 0, 0, 0, 0
  for yy = y, y + h - 1 do
    for xx = x, x + w - 1 do
      if xx >= 0 and yy >= 0 and xx < img.width and yy < img.height then
        local r, g, b, a = unpackColor(img:getPixel(xx, yy), mode)
        if a > 0 then
          sr, sg, sb, sa, n = sr + r, sg + g, sb + b, sa + a, n + 1
        end
      end
    end
  end
  if n == 0 then return 0, 0, 0, 0 end
  return round(sr / n), round(sg / n), round(sb / n), round(sa / n)
end

----------------------------------------------------------------------------
-- embedded 5x7 bitmap font (printable ASCII 32..126)
-- '#' = ink, '.' = empty. 5 px wide, 7 px tall, 1 px tracking.
----------------------------------------------------------------------------

local FONT = {
  [" "] = "..... ..... ..... ..... ..... ..... .....",
  ["!"] = "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..",
  ['"'] = ".#.#. .#.#. ..... ..... ..... ..... .....",
  ["#"] = ".#.#. ##### .#.#. ##### .#.#. ..... .....",
  ["$"] = "..#.. .#### #.#.. .###. ..#.# ####. ..#..",
  ["%"] = "##... ##..# ...#. ..#.. .#... #..## ...##",
  ["&"] = ".##.. #..#. #.#.. .#... #.#.# #..#. .##.#",
  ["'"] = "..#.. ..#.. ..... ..... ..... ..... .....",
  ["("] = "...#. ..#.. .#... .#... .#... ..#.. ...#.",
  [")"] = ".#... ..#.. ...#. ...#. ...#. ..#.. .#...",
  ["*"] = "..... #.#.# .###. ##### .###. #.#.# .....",
  ["+"] = "..... ..#.. ..#.. ##### ..#.. ..#.. .....",
  [","] = "..... ..... ..... ..... ..##. ..#.. .#...",
  ["-"] = "..... ..... ..... ##### ..... ..... .....",
  ["."] = "..... ..... ..... ..... ..... ..##. ..##.",
  ["/"] = "....# ...#. ..#.. ..#.. .#... #.... .....",
  ["0"] = ".###. #...# #..## #.#.# ##..# #...# .###.",
  ["1"] = "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
  ["2"] = ".###. #...# ....# ..##. .#... #.... #####",
  ["3"] = "##### ...#. ..##. ....# ....# #...# .###.",
  ["4"] = "...#. ..##. .#.#. #..#. ##### ...#. ...#.",
  ["5"] = "##### #.... ####. ....# ....# #...# .###.",
  ["6"] = "..##. .#... #.... ####. #...# #...# .###.",
  ["7"] = "##### ....# ...#. ..#.. .#... .#... .#...",
  ["8"] = ".###. #...# #...# .###. #...# #...# .###.",
  ["9"] = ".###. #...# #...# .#### ....# ...#. .##..",
  [":"] = "..... ..##. ..##. ..... ..##. ..##. .....",
  [";"] = "..... ..##. ..##. ..... ..##. ..#.. .#...",
  ["<"] = "...#. ..#.. .#... #.... .#... ..#.. ...#.",
  ["="] = "..... ..... ##### ..... ##### ..... .....",
  [">"] = ".#... ..#.. ...#. ....# ...#. ..#.. .#...",
  ["?"] = ".###. #...# ....# ..##. ..#.. ..... ..#..",
  ["@"] = ".###. #...# #.### #.#.# #.### #.... .###.",
  ["A"] = ".###. #...# #...# ##### #...# #...# #...#",
  ["B"] = "####. #...# #...# ####. #...# #...# ####.",
  ["C"] = ".###. #...# #.... #.... #.... #...# .###.",
  ["D"] = "####. #...# #...# #...# #...# #...# ####.",
  ["E"] = "##### #.... #.... ####. #.... #.... #####",
  ["F"] = "##### #.... #.... ####. #.... #.... #....",
  ["G"] = ".###. #...# #.... #.### #...# #...# .###.",
  ["H"] = "#...# #...# #...# ##### #...# #...# #...#",
  ["I"] = ".###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
  ["J"] = "..### ...#. ...#. ...#. ...#. #..#. .##..",
  ["K"] = "#...# #..#. #.#.. ##... #.#.. #..#. #...#",
  ["L"] = "#.... #.... #.... #.... #.... #.... #####",
  ["M"] = "#...# ##.## #.#.# #.#.# #...# #...# #...#",
  ["N"] = "#...# ##..# #.#.# #.#.# #..## #...# #...#",
  ["O"] = ".###. #...# #...# #...# #...# #...# .###.",
  ["P"] = "####. #...# #...# ####. #.... #.... #....",
  ["Q"] = ".###. #...# #...# #...# #.#.# #..#. .##.#",
  ["R"] = "####. #...# #...# ####. #.#.. #..#. #...#",
  ["S"] = ".#### #.... #.... .###. ....# ....# ####.",
  ["T"] = "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  ["U"] = "#...# #...# #...# #...# #...# #...# .###.",
  ["V"] = "#...# #...# #...# #...# #...# .#.#. ..#..",
  ["W"] = "#...# #...# #...# #.#.# #.#.# ##.## #...#",
  ["X"] = "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
  ["Y"] = "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
  ["Z"] = "##### ....# ...#. ..#.. .#... #.... #####",
  ["["] = ".###. .#... .#... .#... .#... .#... .###.",
  ["\\"] = "#.... .#... ..#.. ..#.. ...#. ....# .....",
  ["]"] = ".###. ...#. ...#. ...#. ...#. ...#. .###.",
  ["^"] = "..#.. .#.#. #...# ..... ..... ..... .....",
  ["_"] = "..... ..... ..... ..... ..... ..... #####",
  ["`"] = ".#... ..#.. ..... ..... ..... ..... .....",
  ["a"] = "..... ..... .###. ....# .#### #...# .####",
  ["b"] = "#.... #.... ####. #...# #...# #...# ####.",
  ["c"] = "..... ..... .###. #.... #.... #.... .###.",
  ["d"] = "....# ....# .#### #...# #...# #...# .####",
  ["e"] = "..... ..... .###. #...# ##### #.... .###.",
  ["f"] = "..##. .#..# .#... ####. .#... .#... .#...",
  ["g"] = "..... .#### #...# #...# .#### ....# .###.",
  ["h"] = "#.... #.... ####. #...# #...# #...# #...#",
  ["i"] = "..#.. ..... .##.. ..#.. ..#.. ..#.. .###.",
  ["j"] = "...#. ..... ..##. ...#. ...#. #..#. .##..",
  ["k"] = "#.... #.... #..#. #.#.. ##... #.#.. #..#.",
  ["l"] = ".##.. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
  ["m"] = "..... ..... ##.#. #.#.# #.#.# #.#.# #.#.#",
  ["n"] = "..... ..... ####. #...# #...# #...# #...#",
  ["o"] = "..... ..... .###. #...# #...# #...# .###.",
  ["p"] = "..... ####. #...# #...# ####. #.... #....",
  ["q"] = "..... .#### #...# #...# .#### ....# ....#",
  ["r"] = "..... ..... #.##. ##..# #.... #.... #....",
  ["s"] = "..... ..... .#### #.... .###. ....# ####.",
  ["t"] = ".#... .#... ####. .#... .#... .#..# ..##.",
  ["u"] = "..... ..... #...# #...# #...# #..## .##.#",
  ["v"] = "..... ..... #...# #...# #...# .#.#. ..#..",
  ["w"] = "..... ..... #...# #.#.# #.#.# #.#.# .#.#.",
  ["x"] = "..... ..... #...# .#.#. ..#.. .#.#. #...#",
  ["y"] = "..... #...# #...# #...# .#### ....# .###.",
  ["z"] = "..... ..... ##### ...#. ..#.. .#... #####",
  ["{"] = "...## ..#.. ..#.. .##.. ..#.. ..#.. ...##",
  ["|"] = "..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  ["}"] = "##... ..#.. ..#.. ..##. ..#.. ..#.. ##...",
  ["~"] = "..... ..... .#..# #.#.# #..#. ..... .....",
}

local GLYPH_W, GLYPH_H, TRACK = 5, 7, 1
local FONT_ROWS = {}
do
  for ch, enc in pairs(FONT) do
    local rows = {}
    local i = 0
    for row in enc:gmatch("[^ ]+") do
      i = i + 1
      local bits = {}
      for c = 1, GLYPH_W do
        bits[c] = row:sub(c, c) == "#"
      end
      rows[i] = bits
    end
    FONT_ROWS[ch] = rows
  end
end

local function textWidth(s, scale, tracking)
  scale = scale or 1
  tracking = tracking == nil and TRACK or tracking
  if #s == 0 then return 0 end
  return (#s * (GLYPH_W + tracking) - tracking) * scale
end

local function drawText(img, s, x, y, color, mode, scale, spacing)
  scale = math.max(1, int(scale or 1))
  spacing = spacing == nil and TRACK or int(spacing)
  x, y = int(x), int(y)
  local cx = x
  for ci = 1, #s do
    local ch = s:sub(ci, ci)
    local rows = FONT_ROWS[ch] or FONT_ROWS["?"]
    for gy = 1, GLYPH_H do
      local bits = rows[gy]
      for gx = 1, GLYPH_W do
        if bits[gx] then
          for sy = 0, scale - 1 do
            for sx = 0, scale - 1 do
              px(img, cx + (gx - 1) * scale + sx, y + (gy - 1) * scale + sy, color)
            end
          end
        end
      end
    end
    cx = cx + (GLYPH_W + spacing) * scale
  end
  return cx
end

----------------------------------------------------------------------------
-- base64 (for returning raw pixel data to the caller)
----------------------------------------------------------------------------

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function base64(data)
  local out = {}
  local n = #data
  local i = 1
  while i <= n do
    local b1 = data:byte(i) or 0
    local b2 = data:byte(i + 1)
    local b3 = data:byte(i + 2)
    local c1 = math.floor(b1 / 4)
    local c2 = (b1 % 4) * 16 + (b2 and math.floor(b2 / 16) or 0)
    local c3 = b2 and ((b2 % 16) * 4 + (b3 and math.floor(b3 / 64) or 0)) or nil
    local c4 = b3 and (b3 % 64) or nil
    out[#out + 1] = B64:sub(c1 + 1, c1 + 1)
    out[#out + 1] = B64:sub(c2 + 1, c2 + 1)
    out[#out + 1] = c3 and B64:sub(c3 + 1, c3 + 1) or "="
    out[#out + 1] = c4 and B64:sub(c4 + 1, c4 + 1) or "="
    i = i + 3
  end
  return table.concat(out)
end

local function encodeRaw(img, mode)
  local chunks = {}
  for y = 0, img.height - 1 do
    for x = 0, img.width - 1 do
      local r, g, b, a = unpackColor(img:getPixel(x, y), mode)
      chunks[#chunks + 1] = string.char(r, g, b, a)
    end
  end
  return base64(table.concat(chunks))
end

----------------------------------------------------------------------------
-- sprite / document helpers
----------------------------------------------------------------------------

local function openDoc(path, createIfMissing)
  if not path or path == "" then die("no document path given") end
  local f = io.open(path, "rb")
  if f then
    f:close()
    local spr = app.open(path)
    if not spr then die("Aseprite could not open %s", path) end
    app.activeSprite = spr
    return spr
  end
  if createIfMissing then die("document does not exist: %s", path) end
  die("document does not exist: %s", path)
end

local function saveDoc(spr, path)
  if not path then die("no save path given") end
  spr:saveAs(path)
  return path
end

local function frameIndex(spr, v)
  return clamp(int(v or 1, 1), 1, #spr.frames)
end

local function layerByName(spr, name)
  if name == nil then return app.activeLayer or spr.layers[1] end
  local l = spr.layers[name]
  if not l then
    for _, cand in ipairs(spr.layers) do
      if cand.name == name then l = cand break end
    end
  end
  return l
end

local function colorModeName(spr)
  local m = spr.colorMode
  if m == ColorMode.RGB then return "rgb" end
  if m == ColorMode.GRAYSCALE then return "grayscale" end
  if m == ColorMode.INDEXED then return "indexed" end
  return tostring(m)
end

local function spriteInfo(spr, docPath)
  local frames = {}
  for i, fr in ipairs(spr.frames) do
    local cels = 0
    for _, l in ipairs(spr.layers) do
      if not l.isGroup and l:cel(fr) then cels = cels + 1 end
    end
    frames[i] = {
      index = i - 1,
      durationMs = round(fr.duration * 1000),
      cels = cels,
    }
  end
  local layers = {}
  for i, l in ipairs(spr.layers) do
    layers[i] = {
      index = i - 1,
      name = l.name,
      opacity = l.opacity,
      visible = l.isVisible,
      blendMode = tostring(l.blendMode),
      isGroup = l.isGroup,
      isBackground = l.isBackground,
    }
  end
  local tags = {}
  for i, t in ipairs(spr.tags) do
    tags[i] = {
      name = t.name,
      from = t.fromFrame.frameNumber - 1,
      to = t.toFrame.frameNumber - 1,
      direction = tostring(t.aniDir),
      repeats = t.repeats,
    }
  end
  local pal = spr.palettes[1]
  return {
    path = docPath,
    width = spr.width,
    height = spr.height,
    colorMode = colorModeName(spr),
    frameCount = #spr.frames,
    layerCount = #spr.layers,
    paletteSize = pal and #pal or 0,
    frames = frames,
    layers = layers,
    tags = tags,
    gridBounds = spr.gridBounds and {
      x = spr.gridBounds.x, y = spr.gridBounds.y,
      w = spr.gridBounds.width, h = spr.gridBounds.height,
    } or nil,
  }
end

----------------------------------------------------------------------------
-- command implementations
----------------------------------------------------------------------------
-- Every handler receives (doc, args) and returns a table merged into `data`.

local OPS = {}

local function drawTarget(spr, args)
  local layer = args.layer
  local frame = frameIndex(spr, args.frame)
  local img = celImage(spr, layer, frame)
  if not img then die("could not resolve a drawing target") end
  return img, layer, frame
end

--- Regions: {x,y,w,h} or {from={x,y},to={x,y}} or omitted (whole cel).
local function regionOf(args, img)
  local r = args.region or args
  if r == nil then return 0, 0, img.width, img.height end
  local x, y, w, h
  if r.from and r.to then
    local x0, y0 = int(r.from[1] or r.from.x), int(r.from[2] or r.from.y)
    local x1, y1 = int(r.to[1] or r.to.x), int(r.to[2] or r.to.y)
    x, y = math.min(x0, x1), math.min(y0, y1)
    w, h = math.abs(x1 - x0) + 1, math.abs(y1 - y0) + 1
  else
    x, y = int(r.x or 0), int(r.y or 0)
    w = int(r.w or r.width or img.width)
    h = int(r.h or r.height or img.height)
  end
  return x, y, w, h
end

--============================================================== sprite ====

function OPS.sprite_create(doc, args)
  local w = int(args.width, 32)
  local h = int(args.height, 32)
  if w < 1 or h < 1 then die("width and height must be >= 1") end
  local modeName = (args.colorMode or "rgb"):lower()
  local mode = ColorMode.RGB
  if modeName == "indexed" then mode = ColorMode.INDEXED
  elseif modeName == "grayscale" or modeName == "grey" then mode = ColorMode.GRAYSCALE end

  local spr = Sprite(w, h, mode)
  spr.filename = doc
  app.activeSprite = spr

  -- Sprite() already ships with one layer, so rename it rather than adding a
  -- second one; an empty duplicate layer is never what the caller wants.
  local layer = spr.layers[1]
  layer.name = args.layerName or "Layer 1"

  if mode == ColorMode.INDEXED then
    local n = int(args.paletteSize or 32)
    local pal = Palette(math.max(2, n))
    local defaults = {
      "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00",
      "#00ffff", "#ff00ff",
    }
    for i = 0, #pal - 1 do
      local hexv = args.palette and args.palette[(i % #(args.palette)) + 1] or defaults[(i % #defaults) + 1]
      local r, g, b = parseColor(hexv)
      pal:setColor(i, Color{ r = r, g = g, b = b, a = 255 })
    end
    if args.palette then
      pal:resize(#args.palette)
      for i, hexv in ipairs(args.palette) do
        local r, g, b = parseColor(hexv)
        pal:setColor(i - 1, Color{ r = r, g = g, b = b, a = 255 })
      end
    end
    spr:setPalette(pal)
  end

  local extra = int(args.frames or 1)
  for _ = 2, extra do spr:newFrame() end

  -- transparent background unless explicitly asked otherwise
  if args.background and args.background ~= "transparent" then
    local r, g, b, a = parseColor(args.background)
    local col = packColor(r, g, b, a, mode)
    for i = 1, #spr.frames do
      local img = celImage(spr, layer.name, i)
      img:clear(col)
    end
  end

  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

function OPS.sprite_info(doc, args)
  local spr = openDoc(doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

--- Rebuild the document on a differently sized canvas.
--
-- Aseprite's own resize is unusable here: `app.command.CanvasSize` does not
-- actually change the canvas, and `Sprite:resize` does resize but destroys cel
-- contents. So the sprite is rebuilt cel by cel. (offX, offY) is the position
-- the ORIGINAL canvas maps to in the new one - (0,0) grows at the top-left,
-- (-2,-2) crops 2 px off the top-left, positive values crop from the right.
--- Create an empty sprite that matches `spr` in colour mode, layers and tags.
--- Canvas size defaults to the source sprite's but can be overridden, which is
--- what the canvas resize/crop path needs. Cels are deliberately left out; the
--- caller fills them in.
local function emptyClone(spr, width, height)
  local new = Sprite(width or spr.width, height or spr.height, spr.colorMode)

  -- Sprite() ships with one layer; reuse it for the first and add the rest.
  local names = {}
  for i, layer in ipairs(spr.layers) do
    names[i] = layer.name
    if i == 1 then
      new.layers[1].name = layer.name
      new.layers[1].opacity = layer.opacity
      new.layers[1].isVisible = layer.isVisible
      new.layers[1].blendMode = layer.blendMode
    else
      local added = new:newLayer()
      added.name = layer.name
      added.opacity = layer.opacity
      added.isVisible = layer.isVisible
      added.blendMode = layer.blendMode
    end
  end

  if spr.palettes[1] then
    local pal = Palette(math.max(2, #spr.palettes[1]))
    for i = 0, #spr.palettes[1] - 1 do
      pal:setColor(i, spr.palettes[1]:getColor(i))
    end
    new:setPalette(pal)
  end

  new.gridBounds = spr.gridBounds
  return new
end
local function recanvas(spr, newW, newH, offX, offY)
  local new = emptyClone(spr, newW, newH)
  local copyW, copyH = math.min(spr.width, newW), math.min(spr.height, newH)

  while #new.frames < #spr.frames do new:newFrame() end
  while #new.frames > #spr.frames do new:deleteFrame(new.frames[#new.frames]) end

  for fi = 1, #spr.frames do
    new.frames[fi].duration = spr.frames[fi].duration
    for li = 1, #spr.layers do
      local cel = spr.layers[li]:cel(spr.frames[fi])
      if cel and cel.image then
        -- normalise the cel onto a full-canvas image first, so that a cel
        -- placed at a non-zero position still lands in the right place
        local full = Image(spr.width, spr.height, spr.colorMode)
        blit(full, cel.image, cel.position.x, cel.position.y)
        local moved = Image(newW, newH, spr.colorMode)
        for y = 0, copyH - 1 do
          for x = 0, copyW - 1 do
            local sx, sy = x + offX, y + offY
            if sx >= 0 and sy >= 0 and sx < spr.width and sy < spr.height then
              moved:putPixel(x, y, full:getPixel(sx, sy))
            end
          end
        end
        new:newCel(new.layers[li], new.frames[fi], moved, Point(0, 0))
      end
    end
  end

  -- keep tags pointing at the same frame positions
  for _, tag in ipairs(spr.tags) do
    local fromIdx, toIdx
    for oi = 1, #spr.frames do
      if spr.frames[oi] == tag.fromFrame then fromIdx = oi end
      if spr.frames[oi] == tag.toFrame then toIdx = oi end
    end
    if fromIdx and toIdx and new.frames[fromIdx] and new.frames[toIdx] then
      local nt = new:newTag(new.frames[fromIdx])
      nt.name = tag.name
      nt.fromFrame = new.frames[fromIdx]
      nt.toFrame = new.frames[toIdx]
      nt.aniDir = tag.aniDir
      nt.repeats = tag.repeats
    end
  end

  return new
end


function OPS.sprite_resize_canvas(doc, args)
  local spr = openDoc(doc)
  local w, h = int(args.width, spr.width), int(args.height, spr.height)
  local ax = args.anchor or "top-left"
  local offX, offY = 0, 0
  if ax == "center" then
    offX, offY = math.floor((w - spr.width) / 2), math.floor((h - spr.height) / 2)
  elseif ax == "bottom-right" then
    offX, offY = w - spr.width, h - spr.height
  elseif ax == "bottom-left" then
    offX, offY = 0, h - spr.height
  elseif ax == "top-right" then
    offX, offY = w - spr.width, 0
  end

  local new = recanvas(spr, w, h, offX, offY)
  saveDoc(new, doc)
  local info = spriteInfo(new, doc)
  new:close()
  spr:close()
  return { sprite = info }
end

function OPS.sprite_crop(doc, args)
  local spr = openDoc(doc)
  local x, y = int(args.x, 0), int(args.y, 0)
  local w, h = int(args.width, spr.width), int(args.height, spr.height)
  if w < 1 or h < 1 then die("crop width and height must be >= 1") end
  local new = recanvas(spr, w, h, -x, -y)
  saveDoc(new, doc)
  local info = spriteInfo(new, doc)
  new:close()
  spr:close()
  return { sprite = info }
end

function OPS.sprite_resize(doc, args)
  local spr = openDoc(doc)
  local w, h = int(args.width, spr.width), int(args.height, spr.height)
  if w < 1 or h < 1 then die("width and height must be >= 1") end
  local new = recanvas(spr, w, h, 0, 0)
  saveDoc(new, doc)
  local info = spriteInfo(new, doc)
  new:close()
  spr:close()
  return { sprite = info }
end

function OPS.sprite_flatten(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  app.command.FlattenLayers()
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

--================================================================ layer ====

--- Move a layer to a given 1-based position in the stack.
--
-- Sprite:reorderLayer and every MoveLayer command are absent from this build,
-- but Layer.stackIndex is writable and acts as the layer's FINAL position,
-- with Aseprite shuffling the others to make room.
local function placeLayer(layer, position)
  layer.stackIndex = clamp(int(position), 1, 1000)
end

function OPS.layer_add(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local l = spr:newLayer()
  l.name = args.name or ("Layer " .. (#spr.layers + 1))
  if args.opacity ~= nil then l.opacity = clamp(int(args.opacity), 0, 255) end
  if args.blendMode then
    local bm = BlendMode[(args.blendMode:upper()):gsub("_", "")]
    if bm then l.blendMode = bm end
  end
  if args.below then
    local target = layerByName(spr, args.below)
    if not target then die("layer not found: %s", tostring(args.below)) end
    placeLayer(l, target.stackIndex)
  elseif args.above then
    local target = layerByName(spr, args.above)
    if not target then die("layer not found: %s", tostring(args.above)) end
    placeLayer(l, target.stackIndex + 1)
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

function OPS.layer_remove(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local l = layerByName(spr, args.name)
  if not l then die("layer not found: %s", tostring(args.name)) end
  if #spr.layers <= 1 then die("cannot remove the only layer") end
  spr:deleteLayer(l)
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

function OPS.layer_set(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local l = layerByName(spr, args.name)
  if not l then die("layer not found: %s", tostring(args.name)) end
  if args.opacity ~= nil then l.opacity = clamp(int(args.opacity), 0, 255) end
  if args.visible ~= nil then l.isVisible = args.visible and true or false end
  if args.newName then l.name = args.newName end
  if args.blendMode then
    local bm = BlendMode[(args.blendMode:upper()):gsub("_", "")]
    if bm then l.blendMode = bm end
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

--- Merge a layer into the one beneath it.
--
-- There is no MergeDown command in this build, and Aseprite's cross-mode
-- image drawing is unreliable in batch mode, so the merge is done by hand:
-- for each frame the upper cel's pixels are composited over the lower cel's.
function OPS.layer_merge_down(doc, args)
  local spr = openDoc(doc)
  local mode = spr.colorMode
  local name = args.name
  local idx
  for i, l in ipairs(spr.layers) do
    if name == nil then
      idx = #spr.layers
    elseif l.name == name then
      idx = i
    end
  end
  if not idx then die("layer not found: %s", tostring(name)) end
  if idx <= 1 then die("nothing below to merge into") end

  local upper = spr.layers[idx]
  local lower = spr.layers[idx - 1]
  local merged = 0

  for fi = 1, #spr.frames do
    local frame = spr.frames[fi]
    local ucel = upper:cel(frame)
    if ucel and ucel.image then
      local uimg = Image(ucel.image.width, ucel.image.height, mode)
      blit(uimg, ucel.image, 0, 0)
      local lcel = lower:cel(frame)
      local target
      local targetPos
      if lcel and lcel.image then
        target = lcel.image
        targetPos = lcel.position
      else
        target = Image(spr.width, spr.height, mode)
        targetPos = Point(0, 0)
        spr:newCel(lower, frame, target, targetPos)
      end
      -- map the upper cel's placement onto the target cel's placement
      local offX = ucel.position.x - targetPos.x
      local offY = ucel.position.y - targetPos.y
      for y = 0, uimg.height - 1 do
        for x = 0, uimg.width - 1 do
          local p = uimg:getPixel(x, y)
          if pixelAlpha(p, mode) > 0 then
            px(target, x + offX, y + offY, p)
          end
        end
      end
      merged = merged + 1
    end
  end

  local lowerName = lower.name
  spr:deleteLayer(upper)
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, mergedFrames = merged, mergedInto = lowerName }
end

--================================================================ frame ====
--
-- This Aseprite build's frame API is append-only:
--   * `Sprite:newFrame(duration)` takes a DURATION in seconds, not an index.
--   * `Sprite:reorderFrame` does not exist.
--   * There is no DuplicateFrame / InsertFrame command (verified by probing
--     app.command).
-- So any operation that changes the ORDER or COUNT of frames in the middle of
-- the timeline is implemented by building a fresh sprite whose frames are
-- emitted in the requested order, then replacing the document with it.


--- Copy one cel (image + placement) from `src` frame/layer onto `dstFrame`.
local function copyCel(src, srcFrame, layerIndex, dst, dstFrame, dstLayer)
  local cel = src.layers[layerIndex]:cel(srcFrame)
  if not cel or not cel.image then return false end
  local image = Image(cel.image.width, cel.image.height, dst.colorMode)
  blit(image, cel.image, 0, 0)
  dst:newCel(dstLayer, dstFrame, image, cel.position)
  return true
end

--- Rebuild the document so its frames are exactly `plan`.
--- `plan[i]` is either a source frame index, or {source = n, duration = seconds}.
--- `source = nil`/false inserts a new empty frame.
--- Tags are mapped onto the new frame ordering. Returns the new sprite.
local function rebuildTimeline(spr, plan)
  local new = emptyClone(spr)

  while #new.frames < #plan do new:newFrame() end
  while #new.frames > #plan do new:deleteFrame(new.frames[#new.frames]) end

  -- where each original frame ended up in the new timeline (1-based positions)
  local newPosOfOld = {}
  for i = 1, #plan do
    local entry = plan[i]
    local sourceIdx = istable(entry) and entry.source or entry
    local duration = istable(entry) and entry.duration or nil
    local dstFrame = new.frames[i]
    if duration then
      dstFrame.duration = duration
    elseif sourceIdx then
      dstFrame.duration = spr.frames[sourceIdx].duration
    end
    if sourceIdx then
      newPosOfOld[sourceIdx] = i
      for li = 1, #spr.layers do
        copyCel(spr, spr.frames[sourceIdx], li, new, dstFrame, new.layers[li])
      end
    end
  end

  for _, tag in ipairs(spr.tags) do
    local fromOld = tag.fromFrame.frameNumber
    local toOld = tag.toFrame.frameNumber
    -- frameNumber is a session serial, so resolve tag ends by identity
    for oi = 1, #spr.frames do
      if spr.frames[oi] == tag.fromFrame then fromOld = oi end
      if spr.frames[oi] == tag.toFrame then toOld = oi end
    end
    local newFrom = newPosOfOld[fromOld]
    local newTo = newPosOfOld[toOld]
    if newFrom and newTo then
      if newTo < newFrom then newFrom, newTo = newTo, newFrom end
      local nt = new:newTag(new.frames[newFrom])
      nt.name = tag.name
      nt.fromFrame = new.frames[newFrom]
      nt.toFrame = new.frames[newTo]
      nt.aniDir = tag.aniDir
      nt.repeats = tag.repeats
    end
  end

  return new
end

--- Replace the document on disk with `new` (which was built from it).
local function commitRebuild(old, new, doc)
  saveDoc(new, doc)
  local info = spriteInfo(new, doc)
  new:close()
  old:close()
  return info
end

function OPS.frame_add(doc, args)
  local spr = openDoc(doc)
  local count = math.max(1, int(args.count or 1))
  local mode = args.mode or "after"
  local ref = frameIndex(spr, args.index)
  local dur = args.durationMs and tonumber(args.durationMs) / 1000 or nil

  local insertAt
  if mode == "before" then
    insertAt = ref
  elseif mode == "end" then
    insertAt = #spr.frames + 1
  else
    insertAt = ref + 1
  end
  insertAt = clamp(insertAt, 1, #spr.frames + 1)

  local plan = {}
  for i = 1, insertAt - 1 do plan[#plan + 1] = i end
  local created = {}
  for i = 1, count do
    plan[#plan + 1] = { source = nil, duration = dur or 0.1 }
    created[#created + 1] = insertAt + i - 2
  end
  for i = insertAt, #spr.frames do plan[#plan + 1] = i end

  local new = rebuildTimeline(spr, plan)
  local info = commitRebuild(spr, new, doc)
  return { sprite = info, addedFrames = created }
end

function OPS.frame_remove(doc, args)
  local spr = openDoc(doc)
  local idx = frameIndex(spr, args.index)
  if #spr.frames <= 1 then die("cannot remove the only frame") end

  local plan = {}
  for i = 1, #spr.frames do
    if i ~= idx then plan[#plan + 1] = i end
  end
  local new = rebuildTimeline(spr, plan)
  local info = commitRebuild(spr, new, doc)
  return { sprite = info, removedFrame = idx - 1 }
end

function OPS.frame_set_duration(doc, args)
  local spr = openDoc(doc)
  local dur = tonumber(args.durationMs or args.duration or 100) / 1000
  local applied = {}
  local from, to
  if args.from ~= nil or args.to ~= nil then
    from, to = frameIndex(spr, args.from), frameIndex(spr, args.to)
  else
    from, to = 1, #spr.frames
  end
  for i = from, to do
    spr.frames[i].duration = dur
    applied[#applied + 1] = i - 1
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, durationMs = round(dur * 1000), frames = applied }
end

function OPS.frame_move(doc, args)
  local spr = openDoc(doc)
  local from = frameIndex(spr, args.from)
  local to = frameIndex(spr, args.to)
  if from == to then
    local info = spriteInfo(spr, doc)
    spr:close()
    return { sprite = info, moved = false }
  end

  local order = {}
  for i = 1, #spr.frames do order[#order + 1] = i end
  local moved = table.remove(order, from)
  table.insert(order, to, moved)

  local new = rebuildTimeline(spr, order)
  local info = commitRebuild(spr, new, doc)
  return { sprite = info, moved = true, from = from - 1, to = to - 1 }
end

function OPS.frame_duplicate(doc, args)
  local spr = openDoc(doc)
  local idx = frameIndex(spr, args.index)
  local dur = args.durationMs and tonumber(args.durationMs) / 1000 or nil

  local plan = {}
  for i = 1, #spr.frames do
    plan[#plan + 1] = i
    if i == idx then
      plan[#plan + 1] = { source = i, duration = dur }
    end
  end

  local new = rebuildTimeline(spr, plan)
  local info = commitRebuild(spr, new, doc)
  return { sprite = info, duplicated = true, copiedFrom = idx - 1, copiedTo = idx }
end

--================================================================== tag ====

local ANI_DIR = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, pingpong = AniDir.PING_PONG, ping_pong = AniDir.PING_PONG }

function OPS.tag_set(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local name = args.name or die("tag name required")
  local from = frameIndex(spr, args.from)
  local to = frameIndex(spr, args.to or args.from)
  if to < from then from, to = to, from end
  local tag
  for _, t in ipairs(spr.tags) do if t.name == name then tag = t break end end
  if not tag then
    tag = spr:newTag(spr.frames[from])
    tag.name = name
  end
  tag.fromFrame = spr.frames[from]
  tag.toFrame = spr.frames[to]
  if args.direction then
    tag.aniDir = ANI_DIR[(args.direction):lower()] or tag.aniDir
  end
  if args.frameRepeats ~= nil then tag.repeats = int(args.frameRepeats) end
  if args.color then
    local r, g, b = parseColor(args.color)
    tag.color = Color{ r = r, g = g, b = b, a = 255 }
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, tag = name }
end

function OPS.tag_remove(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local found = false
  for i = #spr.tags, 1, -1 do
    if spr.tags[i].name == args.name then spr:deleteTag(spr.tags[i]); found = true end
  end
  if not found then die("tag not found: %s", tostring(args.name)) end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

function OPS.loop_set(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local from = frameIndex(spr, args.from)
  local to = frameIndex(spr, args.to or args.from)
  if to < from then from, to = to, from end
  -- This build has no Sprite.loopSection property; the command is the only route.
  app.activeFrame = spr.frames[from]
  app.command.SetLoopSection{ ui = false, fromFrame = spr.frames[from], toFrame = spr.frames[to] }
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, loopSection = { from = from - 1, to = to - 1 } }
end

--================================================================ palette ==

function OPS.palette_set(doc, args)
  local spr = openDoc(doc)
  local colors = args.colors or die("colors array required")
  local size = int(args.size or #colors)
  local pal = Palette(math.max(2, size))
  for i, c in ipairs(colors) do
    if i - 1 < size then
      local r, g, b, a = parseColor(c)
      pal:setColor(i - 1, Color{ r = r, g = g, b = b, a = a })
    end
  end
  -- fill any remaining entries by cycling
  if #colors > 0 then
    for i = #colors, size - 1 do
      local r, g, b, a = parseColor(colors[(i % #colors) + 1])
      pal:setColor(i, Color{ r = r, g = g, b = b, a = a })
    end
  end
  spr:setPalette(pal)
  if args.remap == "nearest" and spr.colorMode == ColorMode.INDEXED then
    app.activeSprite = spr
    app.command.RemapColors()
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

--- A small set of built-in palettes that ship with Aseprite.
local BUILTIN_PALETTES = {
  pico8 = { "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f",
    "#c2c3c7", "#fff1e8", "#ff004d", "#ffa300", "#ffec27", "#00e436",
    "#29adff", "#83769c", "#ff77a8", "#ffccaa" },
  gameboy = { "#0f380f", "#306230", "#8bac0f", "#9bbc0f" },
  nes = { "#7c7c7c", "#0000fc", "#0000bc", "#4428bc", "#940084", "#a80020",
    "#a81000", "#881400", "#503000", "#007800", "#006800", "#005800",
    "#004058", "#000000", "#bcbcbc", "#0078f8" },
  db16 = { "#140c1c", "#442434", "#30346d", "#4e4a4e", "#854c30", "#346524",
    "#d04648", "#757161", "#597dce", "#d27d2c", "#8595a1", "#6daa2c",
    "#d2aa99", "#6dc2ca", "#dad45e", "#deeed6" },
  db32 = { "#000000", "#222034", "#45283c", "#663931", "#8f563b", "#df7126",
    "#d9a066", "#eec39a", "#fbf236", "#99e550", "#6abe30", "#37946e",
    "#4b692f", "#524b24", "#323c39", "#3f3f74", "#306082", "#5b6ee1",
    "#639bff", "#5fcde4", "#cbdbfc", "#ffffff", "#9badb7", "#847e87",
    "#696a6a", "#595652", "#76428a", "#ac3232", "#d95763", "#d77bba",
    "#8f974a", "#8a6f30" },
  sweetie16 = { "#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75",
    "#a7f070", "#38b764", "#257179", "#29366f", "#3b5dc9", "#41a6f6",
    "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57" },
  endesga32 = { "#be4a2f", "#d77643", "#ead4aa", "#e4a672", "#b86f50",
    "#733e39", "#3e2731", "#a22633", "#e43b44", "#f77622", "#feae34",
    "#fee761", "#63c74d", "#3e8948", "#265c42", "#193c3e", "#124e89",
    "#0099db", "#2ce8f5", "#ffffff", "#c0cbdc", "#8b9bb4", "#5a6988",
    "#3a4466", "#262b44", "#181425", "#ff0044", "#68386c", "#b55088",
    "#f6757a", "#e8b796", "#c28569" },
}

function OPS.palette_load(doc, args)
  local spr = openDoc(doc)
  local colors, size
  local builtin = args.preset and BUILTIN_PALETTES[(args.preset):lower()]
  if builtin then
    colors, size = builtin, #builtin
  elseif args.file then
    -- Aseprite can read .gpl/.ase/.png palettes
    local ok, pal = pcall(function() return app.open(args.file) end)
    if ok and pal and pal.palettes and pal.palettes[1] then
      local p = pal.palettes[1]
      colors = {}
      for i = 0, #p - 1 do
        local c = p:getColor(i)
        colors[#colors + 1] = string.format("#%02x%02x%02x", c.red, c.green, c.blue)
      end
      size = #colors
      pcall(function() pal:close() end)
    else
      die("could not read palette file: %s", tostring(args.file))
    end
  else
    die("provide either preset or file")
  end
  local pal = Palette(math.max(2, size))
  for i, c in ipairs(colors) do
    local r, g, b = parseColor(c)
    pal:setColor(i - 1, Color{ r = r, g = g, b = b, a = 255 })
  end
  spr:setPalette(pal)
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, colors = colors }
end

function OPS.palette_get(doc, args)
  local spr = openDoc(doc)
  local pal = spr.palettes[1]
  local colors = {}
  if pal then
    for i = 0, #pal - 1 do
      local c = pal:getColor(i)
      colors[#colors + 1] = string.format("#%02x%02x%02x", c.red, c.green, c.blue)
    end
  end
  spr:close()
  return { colors = colors, size = #colors }
end

--- k-means++ over a list of {r,g,b} samples, returning `k` centroids.
--- Seeding skips colours that are already within a hair of an existing
--- centroid, so the result does not waste slots on duplicates.
local function quantizeKMeans(samples, k)
  local stride = math.max(1, math.floor(#samples / 20000))
  local pts = {}
  for i = 1, #samples, stride do pts[#pts + 1] = samples[i] end
  if #pts == 0 then pts = samples end

  local centroids = { pts[1] }
  while #centroids < k do
    local best, bestd = nil, -1
    for _, p in ipairs(pts) do
      local d = math.huge
      for _, c in ipairs(centroids) do
        local dd = (p[1] - c[1]) ^ 2 + (p[2] - c[2]) ^ 2 + (p[3] - c[3]) ^ 2
        if dd < d then d = dd end
      end
      if d > bestd then bestd, best = d, p end
    end
    if not best or bestd <= 0 then break end
    centroids[#centroids + 1] = best
  end

  local n = #centroids
  for iter = 1, 12 do
    local sums = {}
    for i = 1, n do sums[i] = { 0, 0, 0, 0 } end
    for _, p in ipairs(pts) do
      local bi, bd = 1, math.huge
      for i = 1, n do
        local c = centroids[i]
        local dd = (p[1] - c[1]) ^ 2 + (p[2] - c[2]) ^ 2 + (p[3] - c[3]) ^ 2
        if dd < bd then bd, bi = dd, i end
      end
      local s = sums[bi]
      s[1] = s[1] + p[1]; s[2] = s[2] + p[2]; s[3] = s[3] + p[3]; s[4] = s[4] + 1
    end
    local moved = false
    for i = 1, n do
      local s = sums[i]
      if s[4] > 0 then
        local nr, ng, nb = s[1] / s[4], s[2] / s[4], s[3] / s[4]
        if math.abs(nr - centroids[i][1]) > 1 or math.abs(ng - centroids[i][2]) > 1
          or math.abs(nb - centroids[i][3]) > 1 then moved = true end
        centroids[i] = { nr, ng, nb }
      end
    end
    if not moved and iter > 2 then break end
  end
  return centroids
end

--- Reduce a sprite's palette to `count` colours by k-means over its pixels.
--
-- Only fully opaque pixels vote, and only fully opaque pixels are repainted.
-- A layer at reduced opacity (a soft shadow, a tint) is already a blend of the
-- artwork's colours, so letting it into the sample set drags the centroids and
-- visibly corrupts the piece. Its colour is left alone.
function OPS.palette_quantize(doc, args)
  local spr = openDoc(doc)
  local k = math.max(2, int(args.count or 16))
  local mode = spr.colorMode

  -- gather samples from fully opaque pixels only
  local samples = {}
  for fi = 1, #spr.frames do
    for _, l in ipairs(spr.layers) do
      if l.isVisible and not l.isGroup then
        local img = imageOfCel(l:cel(spr.frames[fi]))
        if img then
          for y = 0, img.height - 1, 1 do
            for x = 0, img.width - 1, 1 do
              local r, g, b, a = unpackColor(img:getPixel(x, y), mode)
              if a >= 250 then samples[#samples + 1] = { r, g, b } end
            end
          end
        end
      end
    end
  end
  if #samples == 0 then
    spr:close()
    die("sprite has no opaque pixels to quantize")
  end

  -- Collect the exact colours first. k-means is an approximation, so running
  -- it on artwork that already has <= k colours would collapse similar colours
  -- and pad the palette with duplicates; keeping the exact set is strictly
  -- better and is the common case for pixel art.
  local distinct = {}
  local seen = {}
  for _, p in ipairs(samples) do
    local key = p[1] * 65536 + p[2] * 256 + p[3]
    if not seen[key] then
      seen[key] = true
      distinct[#distinct + 1] = { p[1], p[2], p[3] }
    end
  end

  local centroids
  if #distinct <= k then
    centroids = distinct
  else
    centroids = quantizeKMeans(samples, k)
  end

  -- sort by luminance for a tidy ramp
  table.sort(centroids, function(a, b)
    return (0.299 * a[1] + 0.587 * a[2] + 0.114 * a[3])
      < (0.299 * b[1] + 0.587 * b[2] + 0.114 * b[3])
  end)

  local colors = {}
  local pal = Palette(math.max(2, k))
  for i, c in ipairs(centroids) do
    local r, g, b = round(c[1]), round(c[2]), round(c[3])
    colors[#colors + 1] = string.format("#%02x%02x%02x", r, g, b)
    pal:setColor(i - 1, Color{ r = r, g = g, b = b, a = 255 })
  end
  spr:setPalette(pal)

  if args.remap ~= false then
    -- snap fully opaque pixels to the nearest new palette colour; leave any
    -- partially transparent pixel (and therefore its alpha) untouched
    for fi = 1, #spr.frames do
      for _, l in ipairs(spr.layers) do
        local img = imageOfCel(l:cel(spr.frames[fi]))
        if img then
          for y = 0, img.height - 1 do
            for x = 0, img.width - 1 do
              local r, g, b, a = unpackColor(img:getPixel(x, y), mode)
              if a >= 250 then
                local bi, bd = 1, math.huge
                for i, c in ipairs(centroids) do
                  local dd = (r - c[1]) ^ 2 + (g - c[2]) ^ 2 + (b - c[3]) ^ 2
                  if dd < bd then bd, bi = dd, i end
                end
                img:putPixel(x, y, packColor(centroids[bi][1], centroids[bi][2], centroids[bi][3], a, mode))
              end
            end
          end
        end
      end
    end
  end

  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, colors = colors }
end

--=================================================================== draw ==

--- Shared executor for a list of drawing primitives.
--- Primitives may carry their own `layer` / `frame`, so one call can build a
--- whole sprite across frames.
local function executeOps(spr, args)
  local ops = args.ops or {}
  if not istable(ops) then die("ops must be an array of drawing operations") end
  local counts = {}
  local lastImg, lastMode

  for oi, op in ipairs(ops) do
    local kind = op.op or op.type
    if not kind then die("ops[%d] is missing an 'op' field", oi) end
    local img, layer, frame = drawTarget(spr, {
      layer = op.layer or args.layer,
      frame = op.frame or args.frame,
    })
    lastImg = img
    local mode = spr.colorMode

    -- Resolve the colour once per primitive.
    local col
    if op.color ~= nil or op.colors ~= nil then
      local r, g, b, a = parseColor(op.color or op.colors)
      col = packColor(r, g, b, a, mode)
    end

    if kind == "pixel" or kind == "pixels" then
      local list = op.pixels or op.points or {}
      if op.x ~= nil and op.y ~= nil then list = { { op.x, op.y } } end
      for _, p in ipairs(list) do
        local x, y = (p.x ~= nil) and int(p.x) or int(p[1]), (p.y ~= nil) and int(p.y) or int(p[2])
        px(img, x, y, col)
      end
      counts.pixels = (counts.pixels or 0) + #list

    elseif kind == "line" then
      line(img, op.x1 or op.from[1], op.y1 or op.from[2],
        op.x2 or op.to[1], op.y2 or op.to[2], col, mode)
      counts.lines = (counts.lines or 0) + 1

    elseif kind == "rect" or kind == "rectangle" then
      local filled = op.filled ~= false and (op.filled == true or op.fill ~= false)
      if op.filled == nil then filled = (op.fill ~= false) end
      rect(img, op.x, op.y, op.w or op.width, op.h or op.height, col, filled)
      counts.rects = (counts.rects or 0) + 1

    elseif kind == "ellipse" or kind == "circle" then
      local rx = op.rx or op.radius or op.r
      local ry = op.ry or op.radius or op.r or rx
      ellipse(img, (op.cx or op.x) , (op.cy or op.y), rx, ry, col, op.filled == true)
      counts.ellipses = (counts.ellipses or 0) + 1

    elseif kind == "polygon" then
      polygon(img, op.points or {}, col, mode, op.filled == true)
      counts.polygons = (counts.polygons or 0) + 1

    elseif kind == "spline" or kind == "curve" then
      spline(img, op.points or {}, col, mode)
      counts.splines = (counts.splines or 0) + 1

    elseif kind == "fill" then
      local n = floodFill(img, op.x, op.y, col, mode, int(op.tolerance or 0), mode)
      counts.fillPixels = (counts.fillPixels or 0) + n

    elseif kind == "clear" then
      local x, y, w, h = regionOf(op, img)
      local c = col or packColor(0, 0, 0, 0, mode)
      for yy = y, y + h - 1 do
        for xx = x, x + w - 1 do px(img, xx, yy, c) end
      end
      counts.cleared = (counts.cleared or 0) + 1

    elseif kind == "gradient" then
      gradient(img, op.x, op.y, op.w or op.width, op.h or op.height,
        op.from or (op.colors and op.colors[1]), op.to or (op.colors and op.colors[2]),
        op.bands, op.direction, mode)
      counts.gradients = (counts.gradients or 0) + 1

    elseif kind == "dither" then
      dither(img, op.x, op.y, op.w or op.width, op.h or op.height,
        (op.colors and op.colors[1]) or op.colorA,
        (op.colors and op.colors[2]) or op.colorB,
        op.matrix, op.ratio, mode)
      counts.dithers = (counts.dithers or 0) + 1

    elseif kind == "pattern" then
      patternFill(img, op.x, op.y, op.w or op.width, op.h or op.height, op.tile or {}, mode)
      counts.patterns = (counts.patterns or 0) + 1

    elseif kind == "text" then
      local r, g, b, a = parseColor(op.color or "#ffffff")
      drawText(img, op.text or "", op.x, op.y, packColor(r, g, b, a, mode), mode,
        op.scale or 1, op.spacing)
      counts.texts = (counts.texts or 0) + 1

    elseif kind == "mirror" then
      -- reflect a region horizontally in place (used for symmetric characters)
      local x, y, w, h = regionOf(op, img)
      local tmp = Image(w, h, mode)
      blitRegion(tmp, img, x, y, w, h, 0, 0)
      tmp:flip(Rectangle(0, 0, w, h))
      blitRegion(img, tmp, 0, 0, w, h, x, y)
      counts.mirrors = (counts.mirrors or 0) + 1

    else
      die("unknown op '%s' at index %d", tostring(kind), oi)
    end
  end

  return counts, lastImg
end

function OPS.draw(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local counts = executeOps(spr, args)
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, ops = counts }
end

function OPS.pixels(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local frame = frameIndex(spr, args.frame)
  local img = celImage(spr, args.layer, frame)
  local mode = spr.colorMode
  local grid = args.pixels or die("pixels grid required")

  -- A grid may be given per-layer, per-frame, or as a flat list of points.
  local written = 0
  local function put(x, y, v)
    if v == nil or v == "." or v == "" or v == null then return end
    local r, g, b, a = parseColor(v)
    px(img, int(x), int(y), packColor(r, g, b, a, mode))
    written = written + 1
  end

  if args.format == "points" or (grid[1] and type(grid[1]) == "table" and grid[1].x ~= nil) then
    for _, p in ipairs(grid) do
      if p.x ~= nil then put(p.x, p.y, p.color or p.value) end
    end
  else
    local ox, oy = int(args.x or 0), int(args.y or 0)
    for rowIdx, row in ipairs(grid) do
      if istable(row) then
        for colIdx, v in ipairs(row) do
          put(ox + colIdx - 1, oy + rowIdx - 1, v)
        end
      elseif type(row) == "string" then
        -- "RRGGBB.RRGGBB....." style strings are handled by `runs`
        local colIdx = 0
        for token in row:gmatch("[^,]+") do
          put(ox + colIdx, oy + rowIdx - 1, token)
          colIdx = colIdx + 1
        end
      end
    end
  end

  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, pixelsWritten = written }
end

--- Fill a region from a palette-mapped index grid ("0 1 2 3" per row, "." = skip).
function OPS.fill_region(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local mode = spr.colorMode
  local written = 0
  local x0, y0 = int(args.x or 0), int(args.y or 0)

  if args.cells then
    for fi = 1, #spr.frames do
      local img = celImage(spr, args.layer, fi)
      for _, c in ipairs(args.cells) do
        if int(c.frame or 1) == fi then
          local r, g, b, a = parseColor(c.color)
          px(img, x0 + int(c.x), y0 + int(c.y), packColor(r, g, b, a, mode))
          written = written + 1
        end
      end
    end
  elseif args.rows then
    local frames = args.frames
    local img = celImage(spr, args.layer, frameIndex(spr, args.frame))
    for ri, row in ipairs(args.rows) do
      for ci = 1, #row do
        local v = row:sub(ci, ci)
        if v ~= "." then
          local r, g, b, a = parseColor(v)
          px(img, x0 + ci - 1, y0 + ri - 1, packColor(r, g, b, a, mode))
          written = written + 1
        end
      end
    end
  else
    die("provide either cells or rows")
  end

  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, pixelsWritten = written }
end

--- Apply the same op list to many frames, with optional per-frame offsets.
function OPS.draw_frames(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local ops = args.ops or {}
  local frames = args.frames
  if not frames then
    frames = {}
    for i = 1, #spr.frames do frames[i] = i end
  end
  local results = {}
  for fi, frameSpec in ipairs(frames) do
    local frameNo = frameIndex(spr, istable(frameSpec) and frameSpec.index or frameSpec)
    local dx = istable(frameSpec) and int(frameSpec.dx or 0) or 0
    local dy = istable(frameSpec) and int(frameSpec.dy or 0) or 0
    local shifted = {}
    for _, op in ipairs(ops) do
      local c = {}
      for k, v in pairs(op) do c[k] = v end
      c.frame = frameNo
      for _, key in ipairs({ "x", "x1", "x2", "cx" }) do
        if c[key] ~= nil then c[key] = c[key] + dx end
      end
      for _, key in ipairs({ "y", "y1", "y2", "cy" }) do
        if c[key] ~= nil then c[key] = c[key] + dy end
      end
      if c.from then c.from = { c.from[1] + dx, c.from[2] + dy } end
      if c.to then c.to = { c.to[1] + dx, c.to[2] + dy } end
      if c.points then
        local pts = {}
        for _, p in ipairs(c.points) do pts[#pts + 1] = { p[1] + dx, p[2] + dy } end
        c.points = pts
      end
      shifted[#shifted + 1] = c
    end
    local counts = executeOps(spr, { ops = shifted, layer = args.layer })
    results[#results + 1] = { frame = frameNo - 1, ops = counts }
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, framesDrawn = results }
end

--- Paint a rectangular block from dense character rows.
--
-- Rows are strings; each character is looked up in `key`. "." and " " mean
-- "leave this pixel alone", so transparent gaps stay holes in the JSON rather
-- than becoming sparse Lua arrays (which would truncate under `#`/ipairs).
function OPS.pixels_encoded(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local img = celImage(spr, args.layer, args.frame)
  local mode = spr.colorMode
  local key = args.key or {}
  local rows = args.rows or die("rows required")
  local ox, oy = int(args.x or 0), int(args.y or 0)
  local written = 0

  for ri = 1, #rows do
    local row = rows[ri]
    for ci = 1, #row do
      local ch = row:sub(ci, ci)
      if ch ~= "." and ch ~= " " then
        local color = key[ch]
        if color == nil then die("character '%s' is not defined in key", ch) end
        local r, g, b, a = parseColor(color)
        px(img, ox + ci - 1, oy + ri - 1, packColor(r, g, b, a, mode))
        written = written + 1
      end
    end
  end

  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, pixelsWritten = written }
end

--- Write one character-grid per frame, each into its own frame.
function OPS.frames_from_grids(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local mode = spr.colorMode
  local key = args.key or {}
  local grids = args.grids or die("grids required")
  local ox, oy = int(args.x or 0), int(args.y or 0)
  local written = 0

  -- grow the timeline when there are more grids than frames
  while #spr.frames < #grids do
    spr:newFrame(#spr.frames + 1)
  end

  for gi = 1, #grids do
    local rows = grids[gi]
    local img = celImage(spr, args.layer, gi)
    for ri = 1, #rows do
      local row = rows[ri]
      for ci = 1, #row do
        local ch = row:sub(ci, ci)
        if ch ~= "." and ch ~= " " then
          local color = key[ch]
          if color == nil then die("character '%s' is not defined in key", ch) end
          local r, g, b, a = parseColor(color)
          px(img, ox + ci - 1, oy + ri - 1, packColor(r, g, b, a, mode))
          written = written + 1
        end
      end
    end
  end

  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, pixelsWritten = written }
end

--============================================================== transform =

function OPS.transform(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local action = (args.action or ""):lower()
  local target = args.target or "sprite"
  local layer = layerByName(spr, args.layer)
  local frames = args.frames
  local applied = {}

  local function inScope(fi)
    if not frames then return true end
    for _, f in ipairs(frames) do if int(f) == fi - 1 then return true end end
    return false
  end

  if action == "flip_h" or action == "flip_v" or action == "flip" then
    local orient = (args.axis or (action == "flip_v" and "vertical" or "horizontal")):lower()
    if orient == "vertical" or orient == "v" then orient = "vertical" else orient = "horizontal" end
    if target == "frame" then
      for fi = 1, #spr.frames do
        if inScope(fi) then
          app.activeFrame = spr.frames[fi]
          app.command.Flip{ ui = false, target = "frame", orientation = orient }
          applied[#applied + 1] = fi - 1
        end
      end
    elseif target == "layer" then
      app.activeLayer = layer
      app.command.Flip{ ui = false, target = "layer", orientation = orient }
    else
      app.command.Flip{ ui = false, target = "sprite", orientation = orient }
    end

  elseif action == "rotate" then
    local angle = args.degrees or 90
    if angle == 90 then
      app.command.Rotate{ ui = false, target = target, angle = 90 }
    elseif angle == 180 then
      app.command.Rotate{ ui = false, target = target, angle = 180 }
    elseif angle == 270 or angle == -90 then
      app.command.Rotate{ ui = false, target = target, angle = 270 }
    else
      die("only 90/180/270 degree rotations are supported for pixel art; got %s", tostring(angle))
    end

  elseif action == "outline" then
    -- add a 1px border of `color` around every opaque pixel (layer scoped)
    local color = args.color or "#000000"
    local r, g, b, a = parseColor(color)
    local mode = spr.colorMode
    for fi = 1, #spr.frames do
      if inScope(fi) then
        local img = celImage(spr, layer and layer.name, fi)
        local src = Image(img.width, img.height, mode)
        blit(src, img, 0, 0)
        local col = packColor(r, g, b, a, mode)
        local outside = args.outside ~= false
        local function opaqueAt(sx, sy)
          if sx < 0 or sy < 0 or sx >= src.width or sy >= src.height then return false end
          return pixelAlpha(src:getPixel(sx, sy), mode) > 0
        end
        for y = 0, img.height - 1 do
          for x = 0, img.width - 1 do
            local opaque = opaqueAt(x, y)
            if (outside and not opaque) or ((not outside) and opaque) then
              local neighbour
              if outside then
                neighbour = opaqueAt(x - 1, y) or opaqueAt(x + 1, y)
                  or opaqueAt(x, y - 1) or opaqueAt(x, y + 1)
              else
                neighbour = (not opaqueAt(x - 1, y)) or (not opaqueAt(x + 1, y))
                  or (not opaqueAt(x, y - 1)) or (not opaqueAt(x, y + 1))
              end
              if neighbour then px(img, x, y, col) end
            end
          end
        end
        applied[#applied + 1] = fi - 1
      end
    end
  else
    die("unknown transform action: %s", tostring(action))
  end

  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, applied = applied }
end

--================================================================== edit ==

function OPS.replace_color(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local mode = spr.colorMode
  local fromR, fromG, fromB, fromA = parseColor(args.from)
  local toR, toG, toB, toA = parseColor(args.to)
  local tol = int(args.tolerance or 0)
  local col = packColor(toR, toG, toB, toA, mode)
  local n = 0
  for fi = 1, #spr.frames do
    for _, l in ipairs(spr.layers) do
      if not l.isGroup then
        local img = imageOfCel(l:cel(spr.frames[fi]))
        if img then
          for y = 0, img.height - 1 do
            for x = 0, img.width - 1 do
              local r, g, b, a = unpackColor(img:getPixel(x, y), mode)
              if math.abs(r - fromR) <= tol and math.abs(g - fromG) <= tol
                and math.abs(b - fromB) <= tol and math.abs(a - fromA) <= tol then
                img:putPixel(x, y, col)
                n = n + 1
              end
            end
          end
        end
      end
    end
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, pixelsChanged = n }
end

function OPS.erase(doc, args)
  local spr = openDoc(doc)
  app.activeSprite = spr
  local mode = spr.colorMode
  local frames = {}
  if args.frames then
    for _, f in ipairs(args.frames) do frames[#frames + 1] = frameIndex(spr, f) end
  else
    for i = 1, #spr.frames do frames[i] = i end
  end
  local n = 0
  for _, fi in ipairs(frames) do
    local img = celImage(spr, args.layer, fi)
    local x, y, w, h = regionOf({ region = args.region, x = args.x, y = args.y,
      w = args.width, h = args.height }, img)
    local col = packColor(0, 0, 0, 0, mode)
    for yy = y, y + h - 1 do
      for xx = x, x + w - 1 do
        if xx >= 0 and yy >= 0 and xx < img.width and yy < img.height then
          img:putPixel(xx, yy, col)
          n = n + 1
        end
      end
    end
  end
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info, pixelsErased = n }
end

function OPS.copy_cel(doc, args)
  local spr = openDoc(doc)
  local srcFrame = frameIndex(spr, args.fromFrame)
  local toFrame = frameIndex(spr, args.toFrame)
  local srcLayer = layerByName(spr, args.fromLayer)
  local toLayer = layerByName(spr, args.toLayer or args.fromLayer)
  if not srcLayer then die("source layer not found") end
  local srcImg = imageOfCel(srcLayer:cel(spr.frames[srcFrame]))
  if not srcImg then die("source cel is empty") end
  app.activeSprite = spr
  local dstImg = celImage(spr, toLayer and toLayer.name, toFrame)
  dstImg:clear(packColor(0, 0, 0, 0, spr.colorMode))
  blit(dstImg, srcImg, 0, 0)
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

function OPS.onion_preview(doc, args)
  -- Render frame N with frame N-1 tinted red and N+1 tinted blue underneath.
  local spr = openDoc(doc)
  local mode = spr.colorMode
  local cur = frameIndex(spr, args.frame)
  local out = Image(spr.width, spr.height, mode)
  local function composite(fi, tint)
    if fi < 1 or fi > #spr.frames then return end
    for _, l in ipairs(spr.layers) do
      if l.isVisible and not l.isGroup then
        local img = imageOfCel(l:cel(spr.frames[fi]))
        if img then
          for y = 0, img.height - 1 do
            for x = 0, img.width - 1 do
              local r, g, b, a = unpackColor(img:getPixel(x, y), mode)
              if a > 0 then
                local nr, ng, nb = r, g, b
                if tint == "prev" then nr, ng, nb = round(r * 0.5 + 255 * 0.5), round(g * 0.3), round(b * 0.3)
                elseif tint == "next" then nr, ng, nb = round(r * 0.3), round(g * 0.4), round(b * 0.5 + 255 * 0.5) end
                out:putPixel(x, y, packColor(nr, ng, nb, math.floor(a * 0.55), mode))
              end
            end
          end
        end
      end
    end
  end
  composite(cur - 1, "prev")
  composite(cur + 1, "next")
  composite(cur, nil)
  local result = {
    width = out.width, height = out.height,
    format = "rgba8888",
    data = encodeRaw(out, mode),
  }
  spr:close()
  return { image = result }
end

--================================================================== view ==

function OPS.view(doc, args)
  local spr = openDoc(doc)
  local mode = spr.colorMode
  local frame = frameIndex(spr, args.frame)
  local out = Image(spr.width, spr.height, mode)

  local layers = args.layers
  for _, l in ipairs(spr.layers) do
    if not l.isGroup then
      local include = l.isVisible
      if layers then
        include = false
        for _, n in ipairs(layers) do if n == l.name then include = true end end
      end
      if include then
        local img = imageOfCel(l:cel(spr.frames[frame]))
        if img then
          blit(out, img, 0, 0)
        end
      end
    end
  end

  -- optional nearest-neighbour zoom for readability
  local scale = math.max(1, int(args.scale or 1))
  if scale > 1 then
    out:resize(spr.width * scale, spr.height * scale)
  end

  local result = {
    width = out.width,
    height = out.height,
    logicalWidth = spr.width,
    logicalHeight = spr.height,
    scale = scale,
    frame = frame - 1,
    mode = colorModeName(spr),
    format = "rgba8888",
    data = encodeRaw(out, mode),
  }
  spr:close()
  return { image = result }
end

function OPS.pick_color(doc, args)
  local spr = openDoc(doc)
  local mode = spr.colorMode
  local frame = frameIndex(spr, args.frame)
  local x, y = int(args.x), int(args.y)

  if x < 0 or y < 0 or x >= spr.width or y >= spr.height then
    local w, h = spr.width, spr.height
    spr:close()
    die("point (%d,%d) is outside the %dx%d canvas", x, y, w, h)
  end

  local out = Image(spr.width, spr.height, mode)
  for _, l in ipairs(spr.layers) do
    if l.isVisible and not l.isGroup then
      local img = imageOfCel(l:cel(spr.frames[frame]))
      if img then blit(out, img, 0, 0) end
    end
  end
  local p = out:getPixel(x, y)
  local r, g, b, a = unpackColor(p, mode)
  spr:close()
  return {
    x = x, y = y,
    rgba = { r = r, g = g, b = b, a = a },
    hex = string.format("#%02x%02x%02x", r, g, b),
    hexWithAlpha = string.format("#%02x%02x%02x%02x", r, g, b, a),
    opaque = a > 0,
  }
end

--- Full pixel dump of a frame as hex rows - lets an agent "see" the artwork
--- as text without decoding an image.
function OPS.inspect(doc, args)
  local spr = openDoc(doc)
  local mode = spr.colorMode
  local frame = frameIndex(spr, args.frame)
  local out = Image(spr.width, spr.height, mode)
  for _, l in ipairs(spr.layers) do
    if l.isVisible and not l.isGroup then
      local img = imageOfCel(l:cel(spr.frames[frame]))
      if img then blit(out, img, 0, 0) end
    end
  end

  local palette, lookup = {}, {}
  local rows = {}
  local maxCells = int(args.maxPixels or 4096)
  local truncated = (spr.width * spr.height) > maxCells

  for y = 0, spr.height - 1 do
    local cells = {}
    for x = 0, spr.width - 1 do
      local r, g, b, a = unpackColor(out:getPixel(x, y), mode)
      local ch
      if a == 0 then
        ch = "."
      else
        local hexv = string.format("#%02x%02x%02x", r, g, b)
        local idx = lookup[hexv]
        if not idx then
          if #palette < 32 then
            palette[#palette + 1] = hexv
            idx = #palette
          else
            idx = 0
          end
          lookup[hexv] = idx
        end
        if idx >= 1 and idx <= 32 then
          ch = string.format("%X", idx - 1)
        elseif idx == 0 then
          ch = "?"
        else
          -- more than 32 colours: fall back to a stable hash digit
          local h = (r * 7 + g * 13 + b * 17) % 32
          ch = string.format("%X", h)
        end
      end
      cells[#cells + 1] = ch
    end
    rows[#rows + 1] = table.concat(cells)
  end

  local info = spriteInfo(spr, doc)
  spr:close()
  return {
    sprite = info,
    frame = frame - 1,
    paletteLegend = palette,
    rows = rows,
    legendNote = "Each row is one image row. '.' is transparent; hex digits 0-9A-V index paletteLegend; '?' means more than 32 distinct colours.",
    truncated = truncated,
  }
end

--================================================================ export ==

local function ensureDir(path)
  local dir = app.fs.filePath(path)
  if dir and dir ~= "" and not app.fs.isDirectory(dir) then
    app.fs.makeAllDirectories(dir)
  end
end

function OPS.export_png(doc, args)
  local spr = openDoc(doc)
  local out = args.output or die("output path required")
  ensureDir(out)
  local scale = int(args.scale or 1)
  local frameArg = args.frame

  if frameArg ~= nil then
    local fi = frameIndex(spr, frameArg)
    local img = Image(spr.width, spr.height, spr.colorMode)
    for _, l in ipairs(spr.layers) do
      if l.isVisible and not l.isGroup then
        local ci = imageOfCel(l:cel(spr.frames[fi]))
        if ci then blit(img, ci, 0, 0) end
      end
    end
    if scale > 1 then img:resize(spr.width * scale, spr.height * scale) end
    img:saveAs(out)
    spr:close()
    return { output = out, width = img.width, height = img.height, frame = fi - 1 }
  end

  if scale == 1 and args.layers ~= true then
    spr:saveCopyAs(out)
  else
    -- composite manually so we can scale / restrict layers
    local img = Image(spr.width, spr.height, spr.colorMode)
    for _, l in ipairs(spr.layers) do
      if l.isVisible and not l.isGroup then
        local ci = imageOfCel(l:cel(spr.frames[frameIndex(spr, args.frame or 1)]))
        if ci then blit(img, ci, 0, 0) end
      end
    end
    if scale > 1 then img:resize(spr.width * scale, spr.height * scale) end
    img:saveAs(out)
  end
  spr:close()
  return { output = out, width = spr.width * scale, height = spr.height * scale }
end

function OPS.export_gif(doc, args)
  local spr = openDoc(doc)
  local out = args.output or die("output path required")
  ensureDir(out)
  if args.scale and int(args.scale) > 1 then
    spr:resize(spr.width * int(args.scale), spr.height * int(args.scale))
  end
  spr:saveCopyAs(out)
  spr:close()
  return { output = out, frames = "all" }
end

function OPS.export_sequence(doc, args)
  local spr = openDoc(doc)
  local dir = args.outputDir or die("outputDir required")
  local ext = args.format or "png"
  local name = args.name or app.fs.fileTitle(doc)
  ensureDir(pathjoin(dir, name .. "_000." .. ext))
  local outputs = {}
  for fi = 1, #spr.frames do
    local img = Image(spr.width, spr.height, spr.colorMode)
    for _, l in ipairs(spr.layers) do
      if l.isVisible and not l.isGroup then
        local ci = imageOfCel(l:cel(spr.frames[fi]))
        if ci then blit(img, ci, 0, 0) end
      end
    end
    local scale = int(args.scale or 1)
    if scale > 1 then img:resize(spr.width * scale, spr.height * scale) end
    local fname = string.format("%s_%03d.%s", name, fi - 1, ext)
    local full = pathjoin(dir, fname)
    img:saveAs(full)
    outputs[#outputs + 1] = full
  end
  spr:close()
  return { outputs = outputs, count = #outputs, outputDir = dir }
end

function OPS.export_sheet(doc, args)
  local spr = openDoc(doc)
  local out = args.output or die("output path required")
  local dataOut = args.dataOutput
  ensureDir(out)
  if dataOut then ensureDir(dataOut) end

  -- ExportSpriteSheet's own `scale` parameter is silently ignored by this
  -- build, so upscaling is done by handing the command a scaled COPY of the
  -- sprite. Nothing is written back to the document.
  --
  -- The enlargement is a nearest-neighbour pixel copy rather than a call to
  -- Image:resize: resizing a cel's image in place here leaves the sprite
  -- rendering the original artwork inside a larger canvas, which produces a
  -- sheet of oversized empty cells.
  local scale = math.max(1, int(args.scale or 1))
  local target = spr
  if scale > 1 then
    target = recanvas(spr, spr.width * scale, spr.height * scale, 0, 0)
    local mode = spr.colorMode
    for fi = 1, #target.frames do
      for _, l in ipairs(target.layers) do
        local cel = l:cel(target.frames[fi])
        if cel and cel.image then
          local src = cel.image
          local big = Image(src.width * scale, src.height * scale, mode)
          for y = 0, src.height - 1 do
            for x = 0, src.width - 1 do
              local p = src:getPixel(x, y)
              if pixelAlpha(p, mode) > 0 then
                for dy = 0, scale - 1 do
                  for dx = 0, scale - 1 do
                    big:putPixel(x * scale + dx, y * scale + dy, p)
                  end
                end
              end
            end
          end
          cel.image = big
        end
      end
    end
  end

  app.activeSprite = target
  local sheetType = (args.sheetType or "horizontal"):lower()
  local typeMap = {
    horizontal = SpriteSheetType.HORIZONTAL,
    vertical = SpriteSheetType.VERTICAL,
    rows = SpriteSheetType.ROWS,
    columns = SpriteSheetType.COLUMNS,
    packed = SpriteSheetType.PACKED,
  }
  local params = {
    ui = false,
    type = typeMap[sheetType] or SpriteSheetType.HORIZONTAL,
    textureFilename = out,
  }
  if args.dataOutput then
    params.dataFilename = dataOut
    params.dataFormat = (args.dataFormat == "json-array") and SpriteSheetDataFormat.JSON_ARRAY
      or SpriteSheetDataFormat.JSON_HASH
  end
  if args.tag then params.tag = args.tag end
  if args.frameRange then params.frameRange = Range(int(args.frameRange[1]) - 1, int(args.frameRange[2]) - 1) end
  if args.columns then params.columns = int(args.columns) end
  if args.rows then params.rows = int(args.rows) end
  if args.borderPadding then params.borderPadding = int(args.borderPadding) end
  if args.shapePadding then params.shapePadding = int(args.shapePadding) end
  if args.innerPadding then params.innerPadding = int(args.innerPadding) end
  if args.trim then params.trim = true end
  if args.extrude then params.extrude = true end
  if args.ignoreEmpty then params.ignoreEmpty = true end
  if args.mergeDuplicates then params.mergeDuplicates = true end
  if args.splitLayers then params.splitLayers = true end

  app.command.ExportSpriteSheet(params)

  if target ~= spr then target:close() end
  spr:close()
  return { output = out, dataOutput = dataOut, sheetType = sheetType, scale = scale }
end

function OPS.import_image(doc, args)
  local src = args.source or die("source image path required")
  if not app.fs.isFile(src) then die("image not found: %s", src) end

  if args.asNewSprite or not app.fs.isFile(doc) then
    local img = app.open(src)
    if not img then die("could not open %s", src) end
    app.activeSprite = img
    local w, h = img.width, img.height
    img:saveAs(doc)
    img:close()
    return { sprite = { path = doc, width = w, height = h } }
  end

  local spr = openDoc(doc)
  app.activeSprite = spr
  local layerName = args.layer
  local layer = layerName and layerByName(spr, layerName) or nil
  if not layer then
    layer = spr:newLayer()
    layer.name = layerName or ("imported " .. app.fs.fileTitle(src))
  end
  local srcSprite = app.open(src)
  if not srcSprite then die("could not open %s", src) end
  local img = Image(srcSprite.width, srcSprite.height, spr.colorMode)
  blit(img, srcSprite.cels[1].image, 0, 0)
  local frame = frameIndex(spr, args.frame)
  local dest = celImage(spr, layer.name, frame)
  local ox, oy = int(args.x or 0), int(args.y or 0)
  blit(dest, img, ox, oy)
  srcSprite:close()
  saveDoc(spr, doc)
  local info = spriteInfo(spr, doc)
  spr:close()
  return { sprite = info }
end

----------------------------------------------------------------------------
-- entry point
----------------------------------------------------------------------------

local function readJSONFile(path)
  local f = io.open(path, "r")
  if not f then die("could not read command file: %s", tostring(path)) end
  local content = f:read("*a")
  f:close()
  local ok, data = pcall(json.decode, content)
  if not ok then die("invalid command JSON: %s", tostring(data)) end
  return data
end

local function writeResult(path, tbl)
  local ok, encoded = pcall(json.encode, tbl)
  if not ok then
    encoded = json.encode({ ok = false, error = "failed to encode result: " .. tostring(encoded) })
  end
  local f = io.open(path, "w")
  if not f then die("could not write result file: %s", tostring(path)) end
  f:write(encoded)
  f:close()
end

local function main()
  local cmdPath = os.getenv("ASEPRITE_CMD")
  local outPath = os.getenv("ASEPRITE_OUT")
  if not cmdPath or not outPath then
    warn("ASEPRITE_CMD / ASEPRITE_OUT environment variables are required")
    return 1
  end

  local request = readJSONFile(cmdPath)
  local cmd = request.cmd or die("request is missing 'cmd'")
  local args = request.args or {}
  local doc = request.doc

  local handler = OPS[cmd]
  local ok, result = pcall(function()
    if not handler then die("unknown command: %s", tostring(cmd)) end
    return handler(doc, args)
  end)

  if ok then
    RESULT.ok = true
    RESULT.data = result or {}
    -- sprite info is usually large; keep it but let the caller trim
    writeResult(outPath, RESULT)
    return 0
  end

  RESULT.ok = false
  RESULT.error = tostring(result)
  RESULT.data = nil
  writeResult(outPath, RESULT)
  return 0
end

local exitCode = main()
if exitCode ~= 0 then
  os.exit(exitCode)
end