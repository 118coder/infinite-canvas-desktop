# 交接文档：密集图片排版 / 右键隐藏 / 4K 预览队列优先级

> 本轮基于 v0.11.0（`ed1baad`）继续优化，三项改动都**不改项目数据模型、不改 nodes/project 字段、不改导出格式**。
> 动手前先读 `AGENTS.md` 与上一版 `docs/progress/handoff-canvas-optimization.md`，里面记录的视口双通道、LOD、零闪烁红线仍然完全适用。

## 一、本轮实现了什么

### 1. 网格排版（解决"图片多时堆成一条长竖列"）

| 文件 | 改动 |
| --- | --- |
| `web/src/app/(user)/canvas/utils/canvas-grid-layout.ts`（新增） | `computeGridLayout(nodes, connections): Map<string, Position>`。把组框连同成员、图片组连同子图视为一个"单元"，按连线层级排序，压成接近 16:9 的网格；行列尺寸取单元实际包围盒，单元在格内居中，最后整体平移回原包围盒中心。**只算位置，不动节点数据**。 |
| `canvas-toolbar.tsx` | 新增「网格排版」按钮（`tool-gridlayout`），与原有「整理布局」并存。 |
| `canvas-context-menu.tsx` | 画布空白处右键新增「网格排版（图片多更清爽）」。 |
| `canvas-client-page.tsx` | 新增 `gridLayoutNodes` 回调：算位置 → `setNodes` → `fitView`，沿用原有整理布局的落盘/撤销链路。 |

**为什么保留原「整理布局」**：拓扑分层适合少量节点看流程；网格排版适合几十上百张图片看整体，两者互补，不替换原行为。

### 2. 右键隐藏图片（单张 / 整组）

| 文件 | 改动 |
| --- | --- |
| `web/src/app/(user)/canvas/utils/canvas-hidden-nodes.ts`（新增） | 隐藏状态按项目存 `infinite-canvas:hidden:<projectId>`（localforage），**与 `nodes` / project 完全隔离**，不进导出包、不进撤销历史。导出：`subscribeHiddenNodes` / `getHiddenNodeIds` / `loadHiddenNodeIds` / `addHiddenNodeIds` / `removeHiddenNodeIds` / `clearHiddenNodeIds` / `isNodeHiddenFast` / `isHiddenConnectionEndpointFast` / `resolveHideTargets`。规则：节点自身、所属 group、所属图片组任一被隐藏即不显示。 |
| `canvas-context-menu.tsx` | 节点右键新增「隐藏选中图片」「隐藏整个分组」「取消隐藏」；画布空白右键新增「显示隐藏的图片（N）」。 |
| `canvas-stage.tsx` | `visibleNodes` 与连线收集都过滤隐藏节点，隐藏节点不挂载 DOM、不生成 `<img>`。 |
| `canvas-side-panel.tsx` | 每个节点行新增眼睛按钮，隐藏行半透明，可单独恢复（否则隐藏节点无法从画布恢复）。 |
| `canvas-client-page.tsx` | 接线：菜单/侧栏/工具栏回调、删除节点时清理隐藏标记、`fitView`/框选/连线落点/全选都跳过隐藏节点。 |

**关键取舍**：隐藏是视图偏好，不是删除。节点、连线、图片本体、生成历史全部保留；刷新后隐藏状态从 localforage 恢复。

### 3. 大量 4K 图片预览队列优化

| 文件 | 改动 |
| --- | --- |
| `web/src/services/image-storage.ts` | 预览队列从纯 FIFO 改成**带优先级的最小堆式线性扫描**：`ensureImagePreview(..., priority=0)` 一路透传到 `queueImagePreview`；`drainPreviewQueue` 每次取优先级最小（同优先级按入队序号）的任务。手势门控、并发 4、12ms 分批、按 key 去重、四档 LOD 全部不变。 |
| `canvas-node.tsx` | 视口内节点请求当前档位时传 `priority=0`。 |
| `canvas-client-page.tsx` | 后台批量 @256 传 `priority=2`；隐藏图片不排队生成档位，取消隐藏时重新排队（`previewHiddenRef`）。 |

**为什么这样做**：冷启动 500 张图时，节点数组顺序随机，视口内图片可能排在队尾，用户先看到一批原图兜底。优先级让"正在看的图片"先拿到档位，队列总量不变、内存不变、闪烁机制不变。

### 4. @提及引用派生表 O(N²) → O(N+E)（同日追加）

用户要求评估 `fast-anything` skill 能否用 Rust 提速，结论是**不替换为 Rust**：该工具对 JS/TS 产出 napi-rs 原生模块，只能给 Node 加载，浏览器/WebView2 用不了（要用必须走 WASM，工具不支持）；Go 侧瓶颈全在 SQLite/HTTP I/O，无纯计算热点，且本机 `go` 不在 PATH；verify 阶段还卡在 `libnode.dll not found`。评估沙箱已删除。

但实测找到了真正值得做的纯 TS 优化：`buildNodeMentionReferences` 全量派生表原本每个节点都全量 `connections.filter` + `nodes.find`，是 O(N²+N·E)。

| 文件 | 改动 |
| --- | --- |
| `utils/canvas-resource-references.ts` | 新增 `buildResourceIndex`（id→节点、toNodeId→入边、fromNodeId→出边三个 Map）、`buildNodeMentionReferencesIndexed`；`getMentionResourceNodes` / `getGenerationResourceNodes` 内部改走索引版，**导出签名与返回结构完全不变**；`buildCanvasResourceReferences` / `buildAllCanvasResourceReferences` 未动。 |
| `[id]/canvas-client-page.tsx` | 全量派生 `useMemo` 改为建一次索引后逐节点复用。 |

**实测**（node 自包含复刻算法）：n=100 0.72→0.14ms、n=500 13.69→0.78ms、n=2000 130→5.16ms，加速 5~25 倍。这是纯算法优化，无新增依赖、无 FFI/WASM、不改数据格式。

**评估过但没做的方案**：
- `<img loading="lazy">`：节点已被视口裁剪，收益小，且可能在拖拽时引入空白帧，触碰零闪烁红线。
- 原图兜底 `fetchPriority="low"`：试过又撤回——冷启动唯一可见的就是原图，降优先级会让空窗更长。
- Original decode 并发闸门（上一版交接建议）：会给"先显示原图不出现纯色块"的红线引入空白风险，本轮不动。

## 二、必须保持的既有机制（改错就回归）

1. **视口双通道**：`viewportStore.getLive()` 是唯一真源；平移/缩放只写 DOM，`commit` 才通知订阅者；不要引入 `setViewport`。
2. **零闪烁红线**：`CanvasNode` 的 `lightweight` 只是 prop，轻量态与完整态必须同一个组件；`<img src>` 永不为空；换档前预解码；双阈值 0.4/0.55；手势期冻结形态。
3. **LOD 四档**：`256 / 768 / 1536 / 2048`，1536 无后缀；画布永远不用 4K 原图；删除名单用 `allLodKeys()` 覆盖所有档位。
4. **预览队列**：手势期间停摆；不要用 `requestIdleCallback`（会被持续拖拽饿死）。
5. **隐藏只影响渲染与交互**：`hiddenNodeIds` 不进 `updateProject`，不进 `computeGridLayout` / `computeAutoLayout` 的输入，也不进 `collectImageStorageKeys`；这样才能保证"数据状态不受影响"。

## 三、验证结果（工具侧，不等于功能通过）

- `web/node_modules/.bin/tsc --noEmit`：**11 个错误，全部是改动前就有的**（`canvas-client-page.tsx` 9 个 `string | undefined`、`audio-settings-panel.tsx` 与 `minimax-tts-voice-select.tsx` 各 1 个 TS2347）。本轮改动文件 0 新增错误。
- `next build --webpack` 三次均失败在 `EPERM: open '.next/trace'`，是本机文件锁环境问题（删除 `.next` 后立刻重建仍被锁），与代码无关；构建缓存已直接删除（未进回收站）。本地构建没拿到绿色结论，但**云端构建已通过**。
- 云端：本地提交 `4bdfaf3` 经 Git Data API 推送为远程 `adb0dcff`（远程原 main 的 tree 与本地父提交完全一致，仅 commit 哈希因历史重写不同）；GitHub Actions `CI` 与 `Build Desktop` 均 success（run 45800370444 / 45800370445）。
- `desktop-latest` 新 exe：sha256 `403b1e6f688a4d284cbb61eee7c2ecaa2110b08ad1c42cb1c97ccf56ba1dee16`，70,722,560 字节；已下载校验并覆盖仓库根目录旧 exe（旧 sha256 `56e08b14...`），临时下载文件已删除。
- `git diff --stat`：8 个已跟踪文件改动 + 2 个新工具文件；未触碰用户原有的 `desktop_url.txt` 修改与根目录未跟踪的 exe/zip。

**必须由用户实机验收**：
1. 网格排版：几十张图片用「网格排版」后应铺成方阵、无重叠、连线明显变短；原有「整理布局」行为不变。
2. 隐藏：节点右键单张/整组隐藏后画布不再渲染该节点与连线；侧栏眼睛按钮可恢复；画布空白右键「显示隐藏的图片（N）」可一键恢复；刷新页面隐藏状态保持。
3. 数据完整性：隐藏 → 取消隐藏 → 撤销/重做/导出/重新导入，节点、连线、图片本体都在；隐藏不产生任何 project 数据变化。
4. 4K 队列：大量 4K 图打开画布，视口内图片应先清晰；拖拽/缩放不新增闪烁；取消隐藏后图片能重新显示。
5. 构建：在能正常写 `.next` 的环境跑一次 `next build` 与云端 Build Desktop。

## 四、遗留问题与风险（按风险排序）

1. **生产构建未验证**：本机 `.next/trace` EPERM 导致 `next build` 跑不完，需在正常环境补跑；类型检查已过。
2. **隐藏状态不随导出包迁移**：当前按 `projectId` 存在本机 localforage；导出/导入到另一台电脑后隐藏状态不会跟着走。这是刻意的（隐藏是本地视图偏好），如果用户希望跨设备同步，需要改为项目字段并同步改导出格式与数据模型。
3. **隐藏组框的连线**：整组隐藏会连组框一起隐藏；若只隐藏组内部分图片，组框仍在，指向被隐藏图片的连线会消失但组框连线可能保留（O(1) 过滤只覆盖图片组 batchChildIds，未展开普通 group 成员）。见 `isHiddenConnectionEndpointFast`，改动时注意保持热路径 O(子图数)。
4. **优先级是静态的**：`priority` 在入队时定，视口在队列排空前大幅移动时不会重排已入队任务。500 张图场景可接受；若要求严格视口中心优先，需要在 `applyLive` 里回调重排队列（会动到视口 store，风险高，本轮没做）。
5. **网格排版会改节点坐标**：与既有「整理布局」一样是用户主动触发的数据变更，会进撤销历史；"数据状态不受影响"指的是不改类型/字段/连线语义，不是禁止位置变化。
6. **隐藏计数含已删除节点的短暂残留**：删除时已 `removeHiddenNodeIds`，但异步保存 400ms 内刷新可能看到旧计数；下次加载会以本地已写数据为准。
7. 上一版交接里未解决的问题（发版脚本化、预览缓存配额、`canvas-client-page.tsx` 拆分等）本轮未处理，仍有效。

## 五、文件地图（本轮相关）

| 文件 | 职责 |
| --- | --- |
| `utils/canvas-grid-layout.ts` | 网格排版算法，纯函数 |
| `utils/canvas-hidden-nodes.ts` | 隐藏状态存储与快速判定，独立持久化 |
| `components/canvas-stage.tsx` | 渲染/连线过滤隐藏节点 |
| `components/canvas-context-menu.tsx` | 隐藏/网格排版菜单项 |
| `components/canvas-side-panel.tsx` | 逐节点显示/隐藏开关 |
| `components/canvas-toolbar.tsx` | 网格排版按钮 |
| `[id]/canvas-client-page.tsx` | 回调接线、隐藏时跳过预览生成、交互过滤 |
| `services/image-storage.ts` | 带优先级的预览生成队列 |
| `components/canvas-node.tsx` | 视口内档位请求优先级 |
