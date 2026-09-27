# aseprite-mcp

一个 [MCP](https://modelcontextprotocol.io) 服务器，让 AI agent 能够**在 Aseprite 里真正画出像素画和逐帧动画**——不只是导出，而是创建画布、分层、逐像素作画、编排帧与动画标签、管理调色板、导出 GIF / 精灵表。

它通过 Aseprite 官方的 `--script` 无头批处理接口驱动 Aseprite，所有操作都落在真实的 `.aseprite` 文件上，所以你随时可以用 Aseprite 打开 agent 画的东西继续手工修改。

**零依赖**：不需要 `npm install`，只用 Node 内置模块 + 一份 Lua 脚本。

<p align="center">
  <img src="docs/images/slime-sheet.png" alt="通过本服务器绘制的绿色史莱姆四帧待机动画" width="640">
  <br>
  <em>18×14 的绿色史莱姆待机循环（挤压拉伸）——由 <code>test/slime.js</code> 通过这些 MCP 工具生成。</em>
</p>

---

## 需求

- **Aseprite** 1.3+（开发与完整验证基于 1.3.18.3）
- **Node.js** 18+
- 无需任何 npm 包

## 安装

克隆仓库，然后让 MCP 客户端指向 `src/server.js`：

```bash
git clone https://github.com/baichuan4167-lang/aseprite-mcp.git
node aseprite-mcp/src/server.js
```

服务器会自动在常见安装路径下寻找 Aseprite 可执行文件。如果装在别处，设置 `ASEPRITE_PATH`（见下表）。

### 接入 MCP 客户端

MCP 服务器走 stdio 传输。在客户端的 MCP 配置里加一项：

```json
{
  "mcpServers": [
    {
      "name": "aseprite",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<aseprite-mcp 的绝对路径>\\src\\server.js"],
      "env": [
        { "name": "ASEPRITE_PATH", "value": "C:\\Program Files\\Aseprite\\aseprite.exe" },
        { "name": "ASEPRITE_MCP_WORKSPACE", "value": "<你的项目目录>" }
      ]
    }
  ]
}
```

> `command` 必须是**绝对路径**。Windows 下建议直接指向 `node.exe`，避免 `npx` / `.cmd` 带来的路径问题。macOS 下可执行文件在 `Aseprite.app/Contents/MacOS/aseprite`。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ASEPRITE_PATH` | 自动探测 | Aseprite 可执行文件的完整路径 |
| `ASEPRITE_MCP_WORKSPACE` | 会话工作目录 | 工作区根目录 |
| `ASEPRITE_MCP_ART_ROOT` | `<工作区>/art` | `.aseprite` 文档存放位置 |
| `ASEPRITE_MCP_EXPORT_ROOT` | `<工作区>/out` | 导出文件默认落点 |
| `ASEPRITE_MCP_TIMEOUT_MS` | `120000` | 单次调用的超时时间 |

---

## 30 秒上手

```
1. aseprite_create_sprite  document="hero" width=16 height=16
2. aseprite_pixels         rows=["..kk..", ".kssk."] key={k:"#1a1c2c", s:"#ffcd75"} x=4 y=4
3. aseprite_view           includeAscii=true        ← 真正"看一眼"再改
4. aseprite_add_frames     count=3 durationMs=100
5. aseprite_set_tag        name="idle" from=0 to=3
6. aseprite_export_gif     output="hero.gif" scale=6
```

坐标一律 **0 起始、原点在左上角**，x 向右、y 向下。

---

## 工作方式

```
agent ──MCP/stdio──▶ server.js ──写命令 JSON──▶ aseprite.exe -b --script aseprite_lib.lua
                          ▲                                    │
                          └──────── 读结果 JSON ◀──────────────┘
```

每次工具调用会启动一个 Aseprite 无头进程，执行 `src/lua/aseprite_lib.lua`，然后把结果写回文件由服务器读取。

**磁盘上的 `.aseprite` 文件永远是唯一事实来源。** 这让每次调用互相独立、可以任意顺序执行，也意味着 agent 在画的过程中你可以随时用 Aseprite 打开文件查看。

对同一个文档的并发调用会被串行化，避免互相覆盖。

---

## 工具一览（43 个）

### 文档

| 工具 | 作用 |
| --- | --- |
| `aseprite_create_sprite` | 新建画布：尺寸、色彩模式（rgb / indexed / grayscale）、初始帧数、图层名、调色板 |
| `aseprite_open` | 指向一个已存在的 `.aseprite` 文件并设为当前文档 |
| `aseprite_info` | 画布尺寸、色彩模式、图层、每帧时长、动画标签 |
| `aseprite_status` | Aseprite 安装位置、工作区目录、现有文档列表 |

### 图层

| 工具 | 作用 |
| --- | --- |
| `aseprite_add_layer` | 新增图层，可指定 `below` / `above` 精确插入位置 |
| `aseprite_set_layer` | 改名、不透明度、可见性、混合模式 |
| `aseprite_remove_layer` | 删除图层 |
| `aseprite_merge_layer_down` | 向下合并（手工合成，不依赖 Aseprite 命令） |

### 帧 / 动画

| 工具 | 作用 |
| --- | --- |
| `aseprite_add_frames` | 插入空帧（`before` / `after` / `end`） |
| `aseprite_remove_frame` | 删除帧 |
| `aseprite_duplicate_frame` | 复制帧到下一格——做动画最常用的起点 |
| `aseprite_move_frame` | 调整帧顺序 |
| `aseprite_set_frame_duration` | 设置帧时长（毫秒），可只改某个区间 |
| `aseprite_copy_cel` | 把某图层某帧的画面复制到另一帧 |
| `aseprite_set_tag` | 创建/更新动画标签（如 `walk`），可设方向与循环 |
| `aseprite_remove_tag` | 删除标签 |
| `aseprite_set_loop` | 设置循环区间 |

### 绘画

| 工具 | 作用 |
| --- | --- |
| `aseprite_pixels` | **主力工具**。矩形像素块，两种写法：`pixels`（十六进制二维数组）或 `rows`+`key`（紧凑字符网格） |
| `aseprite_fill_regions` | 零散像素点，逐点指定颜色 |
| `aseprite_frames_from_grids` | **一次画出整段动画**：每帧一个字符网格 |
| `aseprite_draw` | 几何图元：直线、矩形、椭圆、多边形、样条曲线、油漆桶、渐变、抖动、图案、文字 |
| `aseprite_draw_across_frames` | 同一组图元画到多帧，可按帧给位移——做位移动画的最省 token 方式 |
| `aseprite_text` | 内置 5×7 像素字体 |
| `aseprite_erase` | 把矩形区域擦成透明 |

`aseprite_draw` 支持的 `op`：

```
{op:"pixel",   x, y, color}
{op:"line",    x1, y1, x2, y2, color}
{op:"rect",    x, y, w, h, color, filled}
{op:"ellipse", cx, cy, rx, ry, color, filled}
{op:"polygon", points:[[x,y],...], color, filled}
{op:"spline",  points:[[x,y],...], color}      Catmull-Rom 平滑曲线
{op:"fill",    x, y, color, tolerance}
{op:"clear",   x, y, w, h}
{op:"gradient",x, y, w, h, from, to, bands, direction}
{op:"dither",  x, y, w, h, colors:[a,b], matrix:"bayer2|bayer4|bayer8", ratio}
{op:"pattern", x, y, w, h, tile:[[...],[...]]}
{op:"text",    text, x, y, color, scale}
```

### 调色板

| 工具 | 作用 |
| --- | --- |
| `aseprite_set_palette` | 直接设置颜色列表 |
| `aseprite_load_palette` | 载入内置复古色板：`pico8` `gameboy` `nes` `db16` `db32` `sweetie16` `endesga32`，或 `.gpl` / `.ase` 文件 |
| `aseprite_get_palette` | 读当前调色板 |
| `aseprite_quantize_palette` | 把作品压缩到 N 色（作品本身色数已 ≤N 时精确保留原色，不做近似） |

> 这些内置色板多数是**他人的作品，且没有明确的开放许可**。收录它们是因为它们是像素画
> 社区的事实标准、Aseprite 本身也内置了它们；但如果你打算商用，请向原作者确认授权。
> 署名信息见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

### 画布与变换

| 工具 | 作用 |
| --- | --- |
| `aseprite_resize_canvas` | 改画布大小，不缩放画面，可选 9 种锚点 |
| `aseprite_crop` | 裁剪 |
| `aseprite_scale_sprite` | 整数倍缩放 |
| `aseprite_transform` | 水平/垂直翻转、90/180/270 旋转、加 1px 描边 |
| `aseprite_replace_color` | 整体替换某个颜色（可带容差） |
| `aseprite_flatten` | 合并所有可见图层 |

### 观察

| 工具 | 作用 |
| --- | --- |
| `aseprite_view` | **把画面渲染成 PNG 返回**，可同时返回精确的字符像素图 |
| `aseprite_onion_preview` | 洋葱皮：上一帧染红、下一帧染青，用来检查动作衔接 |
| `aseprite_pick_color` | 读取某点最终合成颜色 |
| `aseprite_inspect_pixels` | 整帧输出为字符网格 + 调色板图例（纯文本，最省 token） |

> Agent 无法"看见"画面，除非你把画面交给它。`aseprite_view` 和 `aseprite_onion_preview` 就是它的眼睛——**画完一定要看**。

### 导入导出

| 工具 | 作用 |
| --- | --- |
| `aseprite_export_png` | 单帧 PNG，可整数倍放大 |
| `aseprite_export_gif` | 动画 GIF（按每帧自己的时长） |
| `aseprite_export_sequence` | 逐帧 PNG 序列 |
| `aseprite_export_sprite_sheet` | 精灵表 PNG **+ JSON 元数据**（帧矩形、时长、标签、图层），可直接喂给游戏引擎 |
| `aseprite_import_image` | 导入外部图片：作为新文档（描摹参考图），或贴到当前文档的图层上 |

---

## 给 agent 的建议工作流

1. **定尺寸**：角色/道具 16–32px，场景 64–128px。像素画尺寸小才好看。
2. **分层**：轮廓、底色、阴影、高光分开放，改一层不动其他层。
3. **用紧凑格式**：`aseprite_pixels` 的 `rows`+`key` 比 `pixels` 省大量 token。
4. **看**：每次画完调 `aseprite_view`，别凭想象继续。
5. **动画**：`aseprite_duplicate_frame` 复制再用 `aseprite_draw_across_frames` 只改动的部分；`aseprite_onion_preview` 检查动作连贯。
6. **导**：游戏用精灵表+JSON，预览用 GIF。

---

## 测试

不需要 Aseprite，CI 每次推送都会跑：

```bash
node test/syntax-check.js   # 所有 JS 可解析、无 UTF-8 BOM、Lua 可编译
node test/protocol.js       # MCP 握手与完整工具清单，无需 Aseprite
```

需要真实 Aseprite 环境：

```bash
node test/smoke.js          # 85 项端到端断言，覆盖每个工具
node test/slime.js          # 画一只绿色史莱姆待机循环并导出
node test/demo-art.js       # 画一个完整的 4 帧行走动画并导出
```

`smoke.js` 通过真实的 stdio 协议启动服务器，逐项验证每个工具的行为与产物——包括**解码导出的 PNG 并测量实际墨迹**，因为只校验尺寸曾经放过一个真实的缩放 bug。两个示例脚本会生成 `art/*.aseprite`，以及 `out/` 下的 GIF、精灵表、序列帧。

针对最容易出问题的行为，另有几个定位探针：

| 脚本 | 用途 |
| --- | --- |
| `test/probe-sheet-verify.js` | 解码精灵表并测量每帧墨迹（能抓出缩放 bug） |
| `test/probe-canvas.js` | 画布缩放/裁剪行为 |
| `test/probe-view.js` | 预览渲染的缩放处理 |
| `test/probe-grids.js` | 字符网格驱动的多帧绘制 |
| `test/probe-quantize.js` | 调色板量化 |

`test/harness.js` 是一个走 stdio 的小型 MCP 客户端，`test/png.js` 是零依赖的 PNG 解码器，上面各套测试都用到。

---

## 实现说明

这个 Aseprite 版本的 Lua API 与官方文档有不少出入，`src/lua/aseprite_lib.lua` 里为此绕过了若干坑，都写在注释里。要点：

- **`json.decode` 返回的是 userdata 而不是 table**，`type(x) == "table"` 会失败 → 统一用 `istable()` 判断。
- **`Image:drawImage(src, Rectangle(...), x, y)` 会把目标清空**，只有 `drawImage(src, x, y)` 形式可靠 → 所有拷贝走 `blit()`。
- **`Sprite:newFrame(n)` 的 n 是"帧时长（秒）"而不是索引**，且 `reorderFrame` / `DuplicateFrame` / `Crop` / `MergeDown` 命令都不存在 → 帧的插入、复制、排序通过"按目标顺序重建时间轴"实现。
- **`app.command.CanvasSize` 不会真正改变画布尺寸**，`Sprite:resize` 会缩放但摧毁 cel 内容 → 画布操作改为按 cel 重建。
- **图层顺序靠可写的 `Layer.stackIndex`**（值即最终位置），没有 `reorderLayer`。
- **索引色模式下 `getPixel` 返回的是调色板索引**，不是 RGBA 字 → 色值存取统一走区分色彩模式的辅助函数。
- **浮点数是致命问题**：JSON 解码出的数字都是浮点，而 Aseprite 的 Lua 绑定要求整数，所以每个坐标都经过 `int()`。
- **Aseprite 的 Lua 没有位运算**，base64 与位操作全部手写。
- **不能有 UTF-8 BOM**：带 BOM 的 `.lua` 会直接语法报错。

因为字体命令 `DrawText` 在批处理模式下不可用，内置了一套 5×7 位图字体（`FONT` 表），可直接阅读和修改。

## 许可

MIT
