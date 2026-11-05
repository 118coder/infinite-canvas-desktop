# 交接文档：画布与素材优化批次 + 检查更新功能

> 给下一个接手的 AI：本文记录最近几轮改动的现状、必须了解的机制、遗留问题与建议的下一步。
> 动手前先读根目录 `AGENTS.md`（改动前必须征得用户同意、完成后更新 `docs/progress/pending-test.md` 与 `CHANGELOG.md` 的 `Unreleased`、构建后必须下载 exe 交付到本地等，规则都在里面）。

## 一、最近完成的工作（全部已推送并云端构建交付）

对应提交（自旧到新）：

| 提交 | 内容 |
| --- | --- |
| `8e25fb3` | 十项 UI/素材优化：工具栏避让侧栏 + 配置数组化 + 统一 Tooltip + 快捷键提示、外观面板合并小地图/网格间距、多选批量操作、缺失图片节点内补齐、素材选择器升级（缩略图/多选/最近使用）、素材页「插入画布」、拆出全屏预览与媒体恢复模块 |
| `01ffe00` | 平移/缩放手势直写 DOM（live transform + layout effect 防回跳）、滚轮缩放 140ms 空闲提交、节点拉伸 rAF 合并、移除页面级每秒时钟 |
| `3e5a64c` | 左栏列表 content-visibility、图片懒加载异步解码、细滚动条 + 防滚动穿透 |
| `fa30e36` | 256px 小档预览（`@256` key 后缀，与 1536 主档分 key 存取） |
| `f4bf8c1` | 性能九项（见下）+ 检查更新功能（方案 A） |

性能九项明细：

1. 左栏列表行 `contain-intrinsic-size` 估算 64→56px（修正滚动锚定跳动）
2. 桌面版 WebView2 注入 `--enable-gpu-rasterization --enable-zero-copy`（`desktop/main.go` main 顶部，用户已设环境变量时尊重用户值）
3. 打开画布约 3 秒后后台排队预生成 256 小档（`canvas-client-page.tsx` restore 内 setTimeout）
4. 左栏滚动期间门控缩略图订阅重渲染（停止滚动 160ms 后统一刷新）
5. 左栏「画布元素」列表窗口化虚拟化（等高行 56px + 6px 间距，只挂载滚动窗口附近约 26 行）
6. `ConnectionPath` React.memo（自定义比较 from/to 几何 + active，跳过回调比较——回调只依赖稳定 setter）
7. `visibleNodes` 视口裁剪边距改为恒定 280px 屏幕边距（`280 / viewport.k`，原固定世界边距放大时过多、缩小时过少）
8. （用户明确跳过未做）手势期间禁用 hover 过渡
9. 有界版：`CanvasToolbar` / `CanvasZoomControls` React.memo + 全部回调 useCallback 稳定引用（`canvas-client-page.tsx` 内 `handleToolbar*` 一组）；**client-page 本体（约 6500 行）仍未拆分**
10. 画布图片节点按渲染尺寸增加 768 中档预览（`@768`，`canvas-node.tsx` ImageContent 内 required ≤ 768 时启用，就地生成，放大自动回退主档/原图）

检查更新功能：

- `web/src/stores/use-update-store.ts`（新增）：数据源为 `api.github.com/repos/118coder/infinite-canvas-desktop/releases?per_page=8`，只取正式版（排除 prerelease，`desktop-latest` 滚动包不会误报）；24h 静默检查节奏（localStorage `infinite-canvas:update-check-at`）
- 设置弹窗顶部「关于」区块（`app-config-modal.tsx` 内 `UpdateSection`）：当前版本 + 检查更新按钮 + 新版本前 4 条变更摘要 + 「前往下载」（开 Releases 页，不强制不自动下载）
- 首页顶栏与画布页顶栏的设置齿轮：有新版时显示绿点
- 版本号来源：构建时把根目录 `VERSION` 注入 `NEXT_PUBLIC_APP_VERSION`（`build-desktop.yml` / `release.yml` / `build-desktop.ps1` 已改）；未注入时显示「开发版（未打包）」且不弹提示
- 旧设施 `hooks/use-version-check.ts` + `components/layout/version-release-modal.tsx` 已无引用（数据源指向 tigerowo 旧仓库），**确认无用后可删**，本次未动

## 二、必须了解的机制（改错会直接回归）

### 预览三档体系（`services/image-storage.ts` + `lib/image-thumbnail.ts`）

- 档位：主档 1536（key 原样）、中档 `@768`、小档 `@256`（`smallImagePreviewKey()` 生成后缀 key）
- `ensureImagePreview(key, url, storageKey, source, cachedOnly, maxEdge?)`：内部有请求去重、来源失效、全局队列（最多并行 2 张）
- **任何「删除未使用预览」的名单必须包含所有档位的 key**：`canvas-client-page.tsx` restore 里 `previewKeys` 已用 `flatMap` 同时含主档与 `@256`；若以后加新档位，记得同步扩展该名单，否则每次打开画布会被误删重生成
- 生成条件：`blob:`/`data:` 本地源与 comfy 源不生成（`ensureImagePreview` 内部直接删除并返回 undefined），调用方需有原图回退

### 画布手势（`components/infinite-canvas.tsx`）

- 平移/缩放手势期间 transform **只直写 DOM**（`liveTransformRef` + `applyViewportTransform`），state 在手势结束/空闲 140ms 后提交
- `useLayoutEffect` 兜底：任何中途 React 重渲染都会重新套用最新手势 transform，否则会出现「画面瞬移回退一帧」的刷新感——**不要移除这段**
- 滚轮手势被外部提交（适应全部节点/聚焦节点）打断时会自动放弃；新增外部 viewport 操作不需要额外处理
- `applyViewportTransform` 同时写 `--canvas-inverse-scale`（节点底部面板反缩放依赖它）

### 渲染裁剪与 memo 约定

- 画布节点本体已有视口裁剪：`canvas-client-page.tsx` 的 `visibleNodes`（边距 = 280 / k）
- `ConnectionPath`、`CanvasToolbar`、`CanvasZoomControls` 都是 memo：**给它们传新回调必须 useCallback 保持稳定引用**，否则 memo 失效
- 左栏列表虚拟化：行高必须保持等高 56px（`NODE_ROW_HEIGHT`），改行内容高度要同步改 stride 与 `contain-intrinsic-size`；选中定位逻辑依赖等高假设

### 检查更新

- 版本比较只认 `v?x.y.z`；`APP_VERSION === "dev"` 时红点恒不出现（开发模式属预期）
- `desktop-latest` 是无版本语义的滚动构建包，永远不要把它当作「最新版本」数据源

## 三、遗留问题与建议下一步

1. **用户对性能的最终评价未知**：九项优化交付后用户尚未反馈。若仍卡顿，下一批候选（按建议顺序）：
   - 连线层合并渲染（目前是逐条组件 + memo，可进一步合并为单层批量 path）
   - 画布节点按渲染尺寸预热/调度（`img.decode()` 预热即将进入视口的大图）
   - 手势期间禁用 hover 过渡（原方案 ⑧，被跳过）
   - `canvas-client-page.tsx`（约 6500 行）拆分：全屏预览与媒体恢复已拆出，剩余大块是生成链路与节点操作 handlers
2. **CI 的 go-test 长期红**：多次确认是既有失败（前端改动前后均红），**与本批全部改动无关**，但一直没排查根因；本地 `go build ./desktop` 也会因 go.sum 缺 `go-webview2` 条目失败（云端工作流构建前会 `go mod tidy`，属正常）。建议单独排查 go-test。
3. **本地 Go 环境损坏**：`C:\go` 的 go 二进制报「GOROOT is not set」，需 `export GOROOT=C:\go` 才能使用（Git Bash）；未修复。
4. **发版积压**：`VERSION` 仍是 v0.9.0，`CHANGELOG.md` 的 `Unreleased` 已累积五批变更；用户要求发版时按 `AGENTS.md` 发版流程整理。
5. **清理候选**：`use-version-check.ts` / `version-release-modal.tsx`（无引用、数据源过期）；确认后删除。
6. **桌面版体验**：WebView2 GPU 参数是否实际生效未在真机验证（可在 `edge://gpu` 确认）。

## 四、构建与交付流程（用户强依赖）

1. 提交并 push 到 `origin main`（仓库 `118coder/infinite-canvas-desktop`）→ 自动触发 `CI`（go-test + web-build）与 `Build Desktop`（产出 exe 并覆盖 `desktop-latest` 滚动发行）。
2. **构建成功后必须**从 `desktop-latest` 下载 `infinite-canvas-desktop.exe` 覆盖仓库根目录同名 exe 并告知用户重启验证——不要停在「云端构建成功」。
3. 验证构建结论用 GitHub API：`/repos/118coder/infinite-canvas-desktop/actions/runs?head_sha=<sha>`；本机没有 `gh` CLI，用 curl + python 解析。
4. 打 tag（`v*`）才触发正式 Release；日常验证不打 tag。

## 五、快速文件地图（本批相关）

| 文件 | 职责 |
| --- | --- |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | 画布页主组件（restore / 批量操作 / 手势接线 / visibleNodes / 工具栏稳定回调） |
| `web/src/app/(user)/canvas/components/infinite-canvas.tsx` | 画布容器：手势直写 DOM、live transform、网格、滚轮 |
| `web/src/app/(user)/canvas/components/canvas-side-panel.tsx` | 左侧面板：画布元素（虚拟化）/资产/提示词库三个页签 |
| `web/src/app/(user)/canvas/components/canvas-node.tsx` | 节点渲染：768 档、缺失图片节点内补齐、拉伸 rAF 合并 |
| `web/src/app/(user)/canvas/components/canvas-connections.tsx` | 连线（ConnectionPath memo） |
| `web/src/app/(user)/canvas/components/canvas-toolbar.tsx` / `canvas-zoom-controls.tsx` | 底部工具栏（批量操作、外观面板）与缩放控件（均 memo） |
| `web/src/app/(user)/canvas/utils/canvas-media-restore.ts` | 画布媒体恢复（hydrate 三函数，自 client-page 拆出） |
| `web/src/app/(user)/canvas/components/canvas-fullscreen-preview.tsx` | 全屏预览（自 client-page 拆出） |
| `web/src/services/image-storage.ts` / `web/src/lib/image-thumbnail.ts` | 预览三档体系 |
| `web/src/hooks/use-asset-filters.ts` | 素材过滤共享 hook（选择器 + 侧栏共用）+ 最近使用记录 |
| `web/src/lib/canvas-handoff.ts` | 「我的素材」→ 画布的插入队列 |
| `web/src/stores/use-update-store.ts` | 检查更新 |
| `web/src/components/layout/app-config-modal.tsx` | 设置弹窗（含 UpdateSection） |
| `desktop/main.go` | 桌面版壳（WebView2、固定端口、GPU 参数） |
