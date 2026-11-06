# 交接文档：v0.10.0 画布性能 / 视觉连续性 / 检查更新

> 给下一个接手的 AI：本文记录当前版本的真实状态、改错就会回归的机制、遗留风险与下一轮建议顺序。
> 动手前先读根目录 `AGENTS.md`（改动前必须征得用户同意、完成后同步 `docs/progress/pending-test.md` 与 `CHANGELOG.md` 的 `Unreleased`、云端构建后必须把 exe 下载并交付到本地等）。

## 一、当前状态

v0.10.0 已作为**正式版**发布：tag `v0.10.0` 指向提交 `3edb9a6abe721527f56091bd32a26ab9602f1c46`，发行页资产为 `infinite-canvas-desktop.exe`（69,809,152 字节，sha256 `3d2b7442b5947fb01ff3bcfaa7cfd59413e7c01352f682972403f6d19500402b`）与 `infinite-canvas-v0.10.0-win-x64.zip`。`VERSION` = `v0.10.0`，`CHANGELOG.md` 有对应 `## v0.10.0` 记录且 `Unreleased` 已清空保留。仓库根目录的 exe 就是这份发行资产。

下一轮唯一的前置输入是**用户对「500 张 4K 图拖拽/缩放」和「零刷新闪烁」的最终实机结论**，待验收清单在 `docs/progress/pending-test.md` 前四节。用户已两次确认「比之前好多了」，但从未确认达到标准。

### 本轮提交链（旧 → 新）

| 提交 | 内容 | 云端结论 |
| --- | --- | --- |
| `6b0731f` | 上一批交接文档（基线） | — |
| `da094bc` | 视口拆 live/committed 双通道 store、`CanvasStage` 裁剪隔离、空间索引、外围组件内部订阅 | Build Desktop success |
| `f547703` | 图片四档 LOD、画布永不回退 4K、DOM 级轻量瓦片 `CanvasNodeTile` | success |
| `a77985a` | 修缩小黑框与换档闪烁：瓦片按类型渲染、换档预解码、0.4/0.55 双阈值、队列改分批 | success |
| `a11dcda` | 轻量态与完整态合并回同一个 `CanvasNode`（`lightweight` prop），删除 `CanvasNodeTile` | success |
| `3edb9a6` | 发布 v0.10.0：版本号、CHANGELOG 归档、检查更新兜底、删除旧实现、打 tag | Release / Build Desktop / Docker image 均 success |

`CI` 整体仍是红的，但只有 `go-test` 失败（失败步骤 `Go test`），`web-build` 是绿的；这是长期既有问题，与本批改动无关。

## 二、必须了解的机制（改错直接回归）

### 2.1 视口双通道（`web/src/app/(user)/canvas/stores/use-viewport-store.ts`）

- 视口唯一真源是 `viewportStore.getLive()`；**任何屏幕 → 世界坐标换算都必须读它**，读 React state 会拿到手势前的旧值。
- `applyLive()` 逐帧只写 DOM（world 的 `translate3d` + 网格位移）；`commit()` 只在手势结束或一次性命令时触发并通知订阅者。外部操作（小地图拖拽、聚焦动画、缩放滑杆、适应视图、重置）统一 `applyLive` + 结束 `commit`，**禁止再引入 `setViewport`**。
- 缩放不变时**不要**写 `--canvas-inverse-scale` 与 `background-size`：这两个属性被整棵子树继承，每帧写会让节点面板与右键菜单全部重算样式。
- 手势期 world 设 `pointer-events: none`，容器只加 `.canvas-gesture` 一个 class。**不要加 `.canvas-gesture *` 这类后代选择器**，起手/抬手会触发全子树样式重算。
- `beginGesture/endGesture` 有嵌套计数，同时驱动预览队列门控；页面卸载必须把手势全部 end 掉，否则预览队列会永久停摆。
- `useLayoutEffect` 里重新套用 live transform 的那段兜底**不能删**，否则中途 React 重渲染会把画面打回一帧旧值。
- 裁剪 tick 由 `CULL_STEP = 160`（位移）与 `CULL_SCALE_RATIO = 0.12`（缩放对数比）触发，`useCullKey()` 是 `CanvasStage` 的重渲染信号。

### 2.2 图片 LOD（`lib/image-thumbnail.ts` + `services/image-storage.ts` + `components/canvas-node.tsx`）

- 档位 `IMAGE_LOD_LEVELS = [256, 768, 1536, 2048]`，`lodKeyFor(baseKey, level)` 生成 key，**1536 用无后缀主档**，其余 `@N`。
- `pickLodLevel` 按屏幕实际渲染像素离散选档，`lodFallbackKeys` 从目标档逐档回退到 `@256`；画布**永远不用 4K 原图**，只有 `skipsImagePreview()` 认定的源（`data:` 内联长串、comfy 源）才用原内容。
- **`img` 的 `src` 永不为空**：档位都没就绪时先兜底 `content`，`new Image().decode()` 成功后才 `setDisplaySrc` 换档；解码失败也要 `apply()`，否则会永远停在旧图。
- `blob:` 对象 URL 同页可 fetch，**必须允许生成预览**，否则本地导入的 4K 图永远没有档位。
- 生成队列：`IMAGE_PREVIEW_CONCURRENCY = 4`，每 12ms 分批推进，手势期间整体停摆。**不要改回 `requestIdleCallback`**，持续拖拽时 idle 会被饿死，小档永远生成不完，画面就在原图与占位之间反复跳。
- 打开画布只排队生成 `@256`；1536/2048 由 `ImageContent` 在节点放大进入完整态时按需生成。
- **任何「删除/清理预览」的名单必须覆盖全部档位**：restore 里用 `allLodKeys()`，`deleteImagePreviews()` 内部也会把 `canvas-node:` 主档展开成全部档位。新增档位要同步改 `IMAGE_LOD_LEVELS`，否则每次打开画布都会被误删重生成。

### 2.3 视觉连续性（用户红线所在）

- **轻量态与完整态必须是同一个组件**：`CanvasNode` 用 `lightweight` prop 控制，只跳过标题、组标题、四角拉伸柄、连线端点、信息条与底部面板，`NodeContent → ImageContent → <img>` 子树原样保留。早先的 `CanvasNodeTile` 双组件方案会卸载重建整套 DOM 与 `<img>`，图片重新加载就是用户看到的"偶尔刷新"，**已删除，不要再引入**。
- 形态切换用双阈值迟滞：`LIGHTWEIGHT_ENTER_SCALE = 0.4` 进入、`LIGHTWEIGHT_EXIT_SCALE = 0.55` 退出；**手势期间冻结**（`viewportStore.isGestureActive()` 时不更新 `lightweightRef`），只在手势结束的 commit 切换一次。
- 传给节点的 `scale` 用 committed.k（手势中冻结），否则缩放过程中会反复换档解码。
- 用户红线，任何改动都不能破坏：**画布不出现无内容的纯色/黑色占位块**（宁可短暂显示原图）、**缩放与拖拽不出现任何刷新/闪白/闪黑**。

### 2.4 裁剪与连线

- 裁剪在独立的 `components/canvas-stage.tsx`，订阅裁剪 tick，用 `utils/canvas-spatial-index.ts` 的网格桶增量计算，边距恒定 280 屏幕像素（`280 / k` 换算）。
- 连线层按视口裁剪，未激活连线合并成单条 path。**不要恢复 10000×10000 固定 SVG 或 `translateZ(0)`**，那会变成巨型合成层，每帧重绘。
- `utils/canvas-batch-visibility.ts` 是组子节点判定的 O(1) 版本，热路径（框选求交、连线端点）用它，不要再写 `nodes.find` 全量扫描。

### 2.5 memo 与回调稳定性

- 都是 memo，**传给它们的回调必须 `useCallback` 稳定引用**，否则 memo 全废：`CanvasNode`、`ConnectionPath`、`CanvasToolbar`、`CanvasZoomControls`、`CanvasSidePanel`。
- `CanvasMiniMap`、`CanvasNodeHoverToolbar`、`CanvasZoomControls` 已改为**内部订阅视口**，不再接收 `viewport` / `scale` / `onViewportChange` props；小地图节点层是单个 `<canvas>`，视口框与悬浮工具栏通过 `subscribeLive` 直写 DOM。
- 左栏列表虚拟化：行高必须保持等高 56px（`NODE_ROW_HEIGHT`），改行内容高度要同步改 stride 与 `contain-intrinsic-size`；选中定位依赖等高假设，且已去掉平滑滚动并加 150ms 防抖。

### 2.6 检查更新（`web/src/stores/use-update-store.ts`）

- 唯一实现，别处不要再写第二份。数据源 `GET /repos/118coder/infinite-canvas-desktop/releases?per_page=8`，**只认 `draft === false && prerelease === false`**，所以 `desktop-latest` 滚动包永远不会被当成新版本；最新版本取过滤后的第一个。
- 当前版本来自构建注入的 `NEXT_PUBLIC_APP_VERSION`（`build-desktop.yml` / `release.yml` 读根目录 `VERSION`）；未注入时是 `dev`，设置页显示「开发版（未打包）」。
- 兜底通道：API 失败时读 `raw.githubusercontent.com/.../main/VERSION` + `CHANGELOG.md`，用 `lib/release.ts` 的 `parseChangelog` 解析摘要。**这条兜底要求发版时 main 上的 `VERSION` 与 `CHANGELOG` 已同步**，只打 tag 不改 main 会给出旧版本号。
- 24h 静默检查（localStorage `infinite-canvas:update-check-at`），**只有成功才写时间戳**，一次网络抖动不会把检查压后一天。
- 发行说明由 `release.yml` 从 `CHANGELOG` 生成，行格式必须是 `- **类型** 内容`，否则「关于」面板摘要为空。发布必须是 `draft: false` + `prerelease: false`，否则客户端看不到。
- UI：设置 → 关于（`app-config-modal.tsx` 的 `UpdateSection`）+ 顶栏设置齿轮绿点；只提示不强制、不自动下载。

### 2.7 持久化

- 视口单独存 `infinite-canvas:viewport:<projectId>`（`utils/canvas-viewport-storage.ts`），不再随项目对象写入，**不要把手势中的视口每帧塞进 `updateProject`**。
- 项目数据 300ms 防抖，全量 `JSON.stringify` 放 `requestIdleCallback`（`stores/use-canvas-store.ts`）；节点拖动期间不逐帧落盘。

## 三、已验证 / 待验证

**本轮已用工具侧验证（不等于功能通过）**

- `tsc --noEmit`：11 个错误全部既有（`canvas-client-page.tsx` 的 3279/3284/3290 行 `string | undefined`，`audio-settings-panel.tsx`、`minimax-tts-voice-select.tsx` 的 TS2347），改动文件 0 新增。
- 发行资产 sha256 与 GitHub asset digest 一致；exe 二进制内嵌 `v0.10.0`。
- 检查更新数据链路按应用真实取值方式核验：正式版列表 `[v0.10.0, v0.9.0]`、`v0.10.0` 排第一、发行说明解析出 15 条、`v0.9.0` 客户端判定「有新版」而 `v0.10.0` 客户端判定「已是最新」、兜底 raw `VERSION` 返回 `v0.10.0`。
- 桌面壳（`desktop/`）与前端都没有 CSP 或请求拦截，`api.github.com` 与 `raw.githubusercontent.com` 的 fetch 不会被拦。

**必须由用户实机验收**（清单见 `docs/progress/pending-test.md`）

1. 500 张 4K 图：中键连续拖拽 5 秒、滚轮放大到 200%、缩小到适应全部、来回跨越 0.4/0.55 阈值多次。
2. 视觉连续性：任何缩放与拖拽都不闪、无黑框、图片不出现"消失又重新出现"。
3. 设置 → 关于点「检查更新」显示「已是最新版本」+ `v0.10.0`，顶部版本号与齿轮无绿点；若手上有 v0.9.0 的 exe，打开应提示发现 `v0.10.0` 且「前往下载」可跳到发行页。
4. 重开画布后视口位置正确、预览档位复用（不重新生成）。

## 四、遗留问题与风险（按风险排序）

1. **冷启动解码峰值**：画布首次打开且没有任何档位缓存时，`img` 会先兜底显示原内容，500 张 4K 图集中解码可能仍卡一次。这是为「不出现黑框」做的取舍，尚未加限流。建议：原图兜底改由 `IntersectionObserver` 触发 + 在途并发上限（如 6），优先保证视口中心区域。
2. **缩放瞬间的合成层重栅格化模糊**：手势中 world 层被 GPU 缩放，跨大倍率时浏览器要重新光栅化，会出现短暂模糊。这**不是刷新**，但用户对视觉很敏感。建议：手势结束 commit 时对 world 做一次无变化的 `translate3d` 重写以触发重栅格化，或对手势期限制 layer 尺寸。
3. **发版流程依赖手工脚本**：本机代理只放行 `api.github.com`，`github.com` 的 git 隧道返回 502、直连超时、SSH 无密钥，所以 `git push` 不通，每次推送都是临时 Python 脚本走 Git Data API（blobs → trees → commits → PATCH refs），tag 也是 `POST /git/refs`。建议落成仓库内 `scripts/release/`，避免每轮重写。
4. **`canvas-client-page.tsx` 仍约 6500 行**：全屏预览与媒体恢复已拆出，剩余大块是生成链路与节点操作 handlers。继续拆分要单独开一批，不要和性能修复混在一起。
5. **`CI` 的 `go-test` 长期红**：前后端改动前后都红，未排查根因；本地 Go 环境也坏（`C:\go` 报 GOROOT 未设置，需 `export GOROOT=C:\go`），本地 `go build ./desktop` 会因 go.sum 缺 `go-webview2` 失败（云端构建前会 `go mod tidy`）。
6. **文档与行为不一致**：`docs/canvas/canvas-shortcuts.md` 写「拖动画布空白处：平移视图」，代码实际是**框选**。未擅自改交互语义，需产品决策后再动文档或代码。
7. **预览缓存只增不减**：IndexedDB 里的 `@256/@768/@1536/@2048` 没有总量上限与回收策略，只有「删除未使用」清理。长期使用会持续膨胀，建议加配额（如按画布维度 LRU）。
8. **`desktop-latest` 每次 push 重建**：digest 每次不同，功能相同。做发行校验时认 tag 发行资产，不要拿滚动包比对 sha256。
9. **WebView2 GPU 参数未验证**：`desktop/main.go` 注入的 `--enable-gpu-rasterization --enable-zero-copy` 是否生效只能在 `edge://gpu` 实机确认；代码层优化不依赖它。

## 五、下一轮建议顺序

1. **P0**：收用户实测结论。若冷启动仍卡 → 做第 1 条限流；若反馈缩放有模糊 → 做第 2 条重栅格化；若两者都不是问题则直接进 P1。
2. **P1**：发版脚本化（第 3 条），把 Git Data API 流程固化，含 tag 与资产校验。
3. **P1**：`canvas-client-page.tsx` 拆分只做「生成链路」一块，配 React Profiler 对比。
4. **P2**：预览缓存配额与回收；`go-test` 根因排查；`canvas-shortcuts.md` 语义对齐。

## 六、构建、发布与交付

**日常构建（不打 tag）**

1. 提交并推 `main` → 自动触发 `CI` + `Build Desktop`（后者覆盖 `desktop-latest` 滚动发行）。
2. 查结论：`GET /repos/118coder/infinite-canvas-desktop/actions/runs?head_sha=<sha>`，本机没有 `gh`，用 curl + python。
3. 构建成功后从 `desktop-latest` 下载 exe 覆盖仓库根目录，校验 digest，告知用户双击重启验证——**不要停在「云端构建成功」**。

**正式发版**（按 `AGENTS.md` 发版流程）

1. `CHANGELOG.md` 的 `Unreleased` 整理成 `## vX.Y.Z` 并保留空的 `Unreleased`；`VERSION` 提升一位。
2. 提交 → 推 `main` → `POST /git/refs` 建 `refs/tags/vX.Y.Z`（tag 事件会触发 `release.yml`，产出 exe + zip 并生成 Release）。
3. 校验：Release 的 `draft=false`、`prerelease=false`、两个资产都在、body 能被 `- **类型** 内容` 解析；`raw` 上 main 的 `VERSION` 已是新版本。
4. 从**该 tag 的发行资产**下载 exe 覆盖根目录并校验 digest。

**不要动**用户自己的 `desktop_url.txt` 修改与根目录的 `infinite-canvas-v0.9.0-win-x64.zip`（历史发行包，一直未纳入版本库）。

## 七、文件地图（本批相关）

| 文件 | 职责 |
| --- | --- |
| `web/src/app/(user)/canvas/stores/use-viewport-store.ts` | 视口唯一真源：live/committed 双通道、DOM transform 写入、裁剪 tick、手势计数与门控 |
| `web/src/app/(user)/canvas/components/canvas-stage.tsx` | 画布渲染子树：裁剪、连线合并、双阈值轻量态 |
| `web/src/app/(user)/canvas/utils/canvas-spatial-index.ts` | 节点网格桶索引（裁剪、命中、框选求交） |
| `web/src/app/(user)/canvas/utils/canvas-batch-visibility.ts` | 组子节点 O(1) 可见性判定 |
| `web/src/app/(user)/canvas/utils/canvas-viewport-storage.ts` | 视口独立持久化 |
| `web/src/app/(user)/canvas/components/infinite-canvas.tsx` | 画布容器：手势、网格、滚轮、live transform 兜底 |
| `web/src/app/(user)/canvas/components/canvas-node.tsx` | 节点渲染：`lightweight` 形态、LOD 选档与预解码换档 |
| `web/src/app/(user)/canvas/components/canvas-connections.tsx` | 连线（memo，激活线双描边代替滤镜） |
| `web/src/app/(user)/canvas/components/canvas-mini-map.tsx` | 小地图：canvas 绘制 + 内部订阅视口 + rAF 合帧拖拽 |
| `web/src/app/(user)/canvas/components/canvas-zoom-controls.tsx` | 缩放控件：内部订阅 committed scale |
| `web/src/app/(user)/canvas/components/canvas-node-hover-toolbar.tsx` | 悬浮工具栏：内部订阅视口并直写 DOM |
| `web/src/app/(user)/canvas/components/canvas-side-panel.tsx` | 左侧面板：memo + `useDeferredValue` + 虚拟化行 |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | 画布页主组件（restore / 生成链路 / 手势接线），约 6500 行，待拆 |
| `web/src/services/image-storage.ts` | 预览生成队列、按 key 订阅、手势门控、档位清理 |
| `web/src/lib/image-thumbnail.ts` | LOD 档位定义、选档与回退、OffscreenCanvas 生成 |
| `web/src/stores/use-update-store.ts` | 检查更新（Releases API + raw 兜底 + 24h 节流） |
| `web/src/lib/release.ts` | CHANGELOG 解析（兜底通道复用） |
| `web/src/components/layout/app-config-modal.tsx` | 设置弹窗（含 `UpdateSection` 关于区块） |
| `.github/workflows/build-desktop.yml` / `release.yml` | 日常构建（滚动包）/ 打 tag 正式发布 |
| `desktop/main.go` | 桌面壳：WebView2、固定端口、GPU 参数 |
