# 「生成」按钮误走衍生分支 + 缓存写入 C 盘（2026-11-02）

## 一、已生成节点点「生成」却又开新一轮、还拿旧图当参考

### 现象

在已经出图的图片节点上改提示词、点面板右下角的生成按钮，结果画布上多出一个新节点在「生成中」，而不是把当前节点重新生成一遍。

### 根因：按钮的分支条件由一个隐藏配置决定

`canvas-client-page.tsx` 的 `handleGenerateNode` 是两个入口共用的实现，图片分支靠 `overwriteExisting` 决定「在本节点重生成」还是「另开一个新节点」：

```ts
// 修改前
const overwriteExisting = effectiveConfig.nodeRegenerateBehavior === "overwrite" && sourceNode?.type === mode && ...
const rootId = isEmptyImageNode ? nodeId : nanoid();   // false → 新建节点
```

而 `nodeRegenerateBehavior` 的默认值是 `"new-node"`（`stores/use-config-store.ts`），且会被数据工程一起导入。所以绝大多数用户点「生成」时 `overwriteExisting` 恒为 `false`：

1. `rootId = nanoid()` → 新建一个空图片节点，原节点保留；
2. 新节点还会被连上原节点（`fromNodeId: nodeId → toNodeId: rootId`），它的「参考内容」里就出现旧图；
3. 之后在这个新节点上再点生成/重新生成，旧图就作为参考图一起发出去 —— 也就是"复用已生成的图片作为参考再发起新一轮生成"。

另外 `sourceNode?.type === mode` 这个判断把全景图节点排除在外（`type` 是 `panorama`、`mode` 是 `image`），同样会掉进新建分支。

### 修改点

| 位置 | 改动 |
| --- | --- |
| `canvas-client-page.tsx:3289` | 去掉对 `nodeRegenerateBehavior` 的依赖：节点类型与生成模式匹配、且节点已有内容/任务时，`overwriteExisting` 直接为 `true` → 就地重新生成；全景图等图片类节点用 `isCanvasImageNodeType` 判断，不会再漏进新建分支 |
| 同上 | 文本节点不参与覆盖分支（原本就在本节点按"改写原文"处理），避免改变文本节点的既有行为 |
| `canvas-client-page.tsx:3305` | 自引用过滤补一条 `image.id !== nodeId`，即使有从自身连出来的连线也不会把旧图带进请求 |
| `stores/use-config-store.ts` | 删除 `nodeRegenerateBehavior` 字段与默认值 |
| `components/layout/app-config-modal.tsx` | 删除「已有内容的节点再次生成时 / 覆盖当前节点 / 新建节点重新生成」单选，换成一句行为说明（保留旧结果请用「创造副本」Ctrl/Cmd+D） |
| `canvas-node-prompt-panel.tsx` | 文本节点的生成中判断不再依赖该配置 |

### 正确的重试流程（修改后）

面板「生成」按钮 → `handleGenerateNode(nodeId, mode, prompt)`：

1. 用当前连线重建生成上下文，并剔除本节点自身（按节点 id、storageKey、content 三重过滤）；
2. `overwriteExisting = true` → 清空本节点的 `content/storageKey`、状态置为 loading；
3. 只用「提示词 + 上游连线参考」发起一次生成，结果直接落回本节点；
4. 不会新建节点，也不会把本节点旧图写进 `references`。

想保留旧结果时用「创造副本」（Ctrl/Cmd+D），再在新副本上改提示词生成。

### 验证方式（实机）

1. 打开一张已出图的图片节点，改提示词后点生成：应看到**同一个节点**变成「生成中」，画布上不出现新节点；
2. 生成完成后检查该节点的「参考内容」：不应出现它自己上一轮的结果；
3. 打开生成请求日志（或反推提示词对比）：请求里的参考图数量应等于上游连线数量，且不含自身图；
4. 空节点、文本节点、视频/音频节点的生成行为应保持原样（视频/音频同样改为就地重新生成）。

## 二、生成的图片缓存落在 C 盘

### 根因

画布项目、生成的图片 blob、HTTP 缓存都在 WebView2 的**用户数据目录**里（IndexedDB）。`go-webview2` 在没指定 `DataPath` 时会落到 `%AppData%\<exe 名>`，即 `C:\Users\<用户>\AppData\Roaming\infinite-canvas-desktop.exe`。图片动辄几 MB，几百张就能把 C 盘吃掉。

### 修改点（`desktop/main.go`）

- `webview2.NewWithOptions` 传入 `DataPath: prepareWebViewDataPath()`，固定为 **exe 同级的 `userdata/` 目录**；
- 首次启动时如果发现旧目录 `%AppData%\<exe 名>` 存在且 `userdata/` 不存在：先尝试 `os.Rename`（同盘秒迁，顺带释放 C 盘），跨盘失败则逐文件复制，复制失败就**保留旧目录继续用**（绝不丢数据），复制成功才删旧目录；
- `userdata/` 建不出来（例如 exe 放在受保护目录）时返回空值，回退到 WebView2 默认目录，不会影响启动。

### 验证方式（实机）

1. 把新版 exe 放到非 C 盘目录启动，确认同级出现 `userdata/`；
2. 生成几张图，确认 `userdata/` 体积增长，而 `C:\Users\<用户>\AppData\Roaming\infinite-canvas-desktop.exe` 不再增长（旧版本升级过来的应已被迁移/删除）；
3. 重启应用，画布与图片应完整保留（端口固定 + 数据目录固定两个前提同时满足）；
4. exe 若放在无写权限目录，日志应出现"迁移失败/回退"，应用仍能正常打开。
