# 数据工程导入修复 + 引用包（2026-11-02）

对应需求：导入数据包后画布进不去 / 图片节点空白；导出新增「完整包 / 引用包」两种模式，引用包支持缺失图片补齐。

## 一、问题 1：导入后画布进不去、图片节点空白

### 根因（三个叠加，缺一不可）

1. **恢复链路会整条挂住/中断，画布永远停在骨架屏**
   `canvas-client-page.tsx` 的 `restore()` 直接 `await hydrateCanvasImages(resetNodes)`，而后者是 `Promise.all` 且没有任何 try/catch：
   只要有一个节点的 `resolveImageUrl` / `uploadImage`（14MB base64 走 `fetch(data:...)`）抛错或长时间不返回，`setNodes` 和 `setProjectLoaded(true)` 就永远不会执行。
   表现就是截图 1：编辑器已经打开，但画布是空的点阵 + 骨架屏，看起来「无法进入画布」。

2. **节点内容被写成了不可恢复的值**
   早期版本 `fixNodeMetadata` 少 `await`，`metadata` 被序列化成 `{}`；叠加导入时把**会话级的 `blob:http://127.0.0.1:端口/xxx`** 直接写进 IndexedDB，重启后 origin 变化（旧实现每次启动随机端口），这些链接全部作废。
   一旦 `metadata` / `content` 丢了，节点只剩标题和位置，就渲染成截图 2 的「空图片节点」。

3. **桌面版每次启动换 origin，本地存储等于被清空**
   `desktop/main.go` 用 `127.0.0.1:0` 随机端口。IndexedDB / localStorage 按 origin 隔离，所以每开一次就是一套全新的空存储，
   画布项目、图片 blob、配置全部「消失」，这也是「导入成功了但再打开什么都没有」的直接原因。

### 改动要点

| 位置 | 改动 |
| --- | --- |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | `hydrateCanvasImages` 改为逐节点 try/catch；新增 `hydrateCanvasImagesSafe`（15s 总超时）与 `withTimeout`（单个 base64 转存 8s）；`restore()` 任何异常都回退为原始节点并保证 `setProjectLoaded(true)`，画布不会再卡在骨架屏 |
| 同上 | 解析失败时不再回填失效的 `blob:` 地址，而是清空 content，交给渲染层占位/自愈；远端 http 地址保留 |
| `web/src/app/(user)/canvas/components/canvas-node.tsx` | 新增 `RecoveringImageContent`：节点有 storageKey 但 content 为空时，先显示「正在恢复图片」，自行 `resolveImageUrl` 成功后渲染，失败显示「图片缺失 · 请在设置中补齐」，不再是无意义的「空图片节点」 |
| `desktop/main.go` | 固定端口：优先复用 `desktop-port.txt` 里上次成功监听的端口，其次 36512 起逐个尝试，全部占用才回退临时端口。origin 稳定，本地数据才能真正持久化 |

## 二、问题 2：导出两种模式 + 引用包缺失图片补齐

### 导出（`web/src/services/data-package.ts`）

两种模式共用同一套「媒体外置」逻辑：导出前把节点里的 `data:` 大图（一张 3840×2160 PNG 就有 14MB base64）落成 blob 并用 `storageKey` 引用，把 `blob:` 死链清空。
所以现在连完整包的 `data-package.json` 也只有几百 KB，不再是 28MB。

- **完整包**：`files[]` 每项带 `path`，所有 blob 打进 `files/`，换机导入开箱即用。
- **引用包**：`files[]` 只保留 `storageKey / fileName / mimeType / bytes / md5`，`path` 为空，不含任何 blob。
  清单里还带人类可读文件名（取自节点标题），方便用户在自己的素材目录里按名字找图。

### 导入

1. 完整包：按 `path` 恢复 blob（已存在且大小一致则跳过，避免重复导入 19MB）。
2. 逐个校验 `storageKey` 本地是否存在（`image_files` / `media_files`），分成 **已存在** 与 **缺失** 两组。
3. 节点 content 重建：能解析的换成当前会话可用地址；缺图的清空 content 并保留 storageKey。
4. 缺失清单落到 `localStorage` 的 `infinite-canvas:media-repair-queue`，设置弹窗里逐条展示（文件名 / 大小 / MD5 前缀 / 引用它的节点标题）。

### 补齐

- 单条「选择文件」：强制匹配到该行。
- 「批量定位文件」：一次多选，按 **MD5 → 文件名 → 文件大小** 依次自动配对。
- 补齐后写入 blob、清掉队列项、把对应节点 content 重新解析并落盘，队列清空时自动刷新画布。

## 三、涉及文件

- `web/src/services/data-package.ts`（重写导入/导出/补齐）
- `web/src/lib/md5.ts`（新增，spark-md5 分片计算）
- `web/src/lib/zip.ts`（改异步解压，几十 MB 包不再卡主线程）
- `web/src/app/(user)/canvas/stores/use-canvas-store.ts`（新增 `replaceCanvasProjects` / `persistCanvasProjectsNow`，取消 pending 防抖，避免旧内存状态覆盖刚导入的数据）
- `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- `web/src/app/(user)/canvas/components/canvas-node.tsx`
- `web/src/components/layout/app-config-modal.tsx`（两种导出按钮 + 缺失图片补齐面板）
- `desktop/main.go`（固定端口）
