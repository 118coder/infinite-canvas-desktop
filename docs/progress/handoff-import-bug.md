# 交接文档：数据工程导入 bug 未解决

> **状态：已解决（2026-11-02）**。
> 根因与改动见 `docs/progress/fix-import-and-reference-package.md`：画布恢复链路缺兜底导致卡在骨架屏、
> 节点 content 被写成不可恢复值、桌面版随机端口导致 origin 每次变化。下方内容保留作为排查过程记录。

## 当前状态

**问题**：导入数据工程后，画布节点全部显示为「空图片节点」占位符，图片内容丢失。

**已尝试但未解决的修复**：
1. ✅ 已修复 `fixNodeMetadata` 缺少 `await` 的 bug（metadata 变成未 resolve 的 Promise）
2. ✅ 已添加 blob: 死链接 → 新地址的 re-resolve 逻辑
3. ✅ 已添加 base64 大图 → 本地 blob 存储的转换
4. ✅ 已改为绕过 zustand 直接写 IndexedDB（避免 28MB JSON.stringify 卡死）
5. ❌ 以上修复后仍然出现空图片节点

## 已确认的事实

### 数据包内容（用户真实包：画布数据工程-2026-11-01.zip）

- 1 个画布项目，12 个节点，15 条连线
- 总 JSON 大小 28.9MB
- 9 个图片 blob 文件（共 ~19MB）在 zip 的 files/ 目录
- 7 个节点的 content = `blob:http://127.0.0.1:旧端口/...`（旧会话死链接，有 storageKey）
- 2 个节点的 content = `data:image/png;base64,...`（各 ~14MB 的 base64 内嵌图片）
- 1 个 group 节点（content 为空，正常）
- `metadata.references` 数组只包含 storageKey（如 `image:xxx`），不是 base64 ✓
- 包内所有连线有效（无自环、无缺失节点引用）
- 包内 viewport 数据正常（k=0.595）
- config 正常（channelMode: local，2 个本地渠道）

### 导入流程代码（web/src/services/data-package.ts）

```
importDataPackage(file) 的流程：
1. readZip(file) → 解压 zip
2. waitForStoreHydration × 3 → 等待 zustand store 水合
3. setImageBlob / setMediaBlob → 恢复 9 个图片 blob 到 image_files/media_files store
4. fixNodeMetadata → 遍历节点，修正 content URL
   - blob: + storageKey → resolveImageUrl(storageKey) 替换
   - data:image/ > 10000 chars → uploadImage(content, { localOnly: true }) 转为本地存储
5. writeCanvasProjectsToIdb → 直接写 IndexedDB app_state（绕过 zustand）
6. 写 config 到 localStorage
7. 恢复 skills 和生成历史
```

### 已验证的事实

- 使用 1.4KB 合成测试包：**导入成功**，数据正确写入 IndexedDB，`resolveImageUrl` 能正确解析
- 使用用户真实 47MB 包：**导入卡死在 readZip**（`file.arrayBuffer()` 永远不返回）
  - 但直接在页面控制台用相同文件测试 arrayBuffer 是正常的（0.5ms）
  - 页面微任务没有饿死（Promise.resolve() 正常执行）
  - 页面主线程没有阻塞（evaluate 正常响应）
  - **原因不明**——可能是 47MB Blob 的 arrayBuffer 在 webview/IAB 中有某种限制
- `resolveImageUrl(storageKey)` 当 blob 存在于 image_files store 时会返回正确的 blob: URL
- `hydrateCanvasImages` 在画布项目加载时被调用（canvas-client-page.tsx:661），会对每个有 storageKey 的节点重新解析 content

### 根因分析

**最可能的原因链**：
1. 用户的真实包 47MB，`readZip` → `file.arrayBuffer()` 挂起（原因不明，可能是大文件在 webview/IAB 中的限制）
2. 导入中断 → 画布项目数据**未写入** IndexedDB → 打开画布时没有节点数据 → 但节点列表（左侧）显示 12 个节点是因为之前部分导入成功写入了 node 结构但 content 为空
3. 或者：导入部分完成（projects 写入但 blobs 未恢复），导致 `hydrateCanvasImages` 的 `resolveImageUrl` 找不到 blob → 返回 fallback（空字符串）→ content 变成空 → 「空图片节点」

**为什么 `resolveImageUrl` 返回空**：
- `resolveImageUrl(storageKey, fallback)` 当 blob 不在 store 中时返回 `fallback`
- `hydrateCanvasImages` 传入的 fallback 是 `node.metadata.content`（旧死链接）
- 但如果 `fixNodeMetadata` 已经把 content 清空或替换失败了，fallback 就是空的
- 或者：image_files store 根本没有被创建（localforage 多实例同 DB 不同 storeName 的版本升级问题）

### localforage 多实例问题（可能是根本原因）

项目使用多个 localforage 实例共享同一个 IndexedDB 数据库 "infinite-canvas"：
- `app_state` store（localforage-storage.ts）
- `image_files` store（image-storage.ts）
- `media_files` store（file-storage.ts）
- `image_previews` store（image-storage.ts）
- `image_generation_logs` / `video_generation_logs` store
- `agent_skills` store

**问题**：当 `app_state` 实例先打开 DB（创建 version 1，只有 app_state store），后续 `image_files` 实例用相同 version 打开时，`onupgradeneeded` 不触发，`image_files` store **不会被创建**。后续 `setItem` 会因为 store 不存在而失败。

**但这在正常使用中不是问题**——因为正常使用时所有实例在 app 启动时同时加载，localforage 内部会序列化 DB 打开操作。**但在导入场景中，如果 image_files 的首次访问发生在 app_state 已经创建 DB 之后，可能存在版本/升级问题。**

## 建议的下一步修复方案

### 方案 A：在导入时用原始 IDB API 创建所有缺失的 store

在 `importDataPackage` 的 blob 恢复步骤之前，用原生 `indexedDB.open(name, version + 1)` 强制升级 DB 并创建所有需要的 object store（image_files、media_files 等）。

```ts
async function ensureStores() {
    const stores = ["image_files", "media_files", "image_previews", "image_generation_logs", "video_generation_logs"];
    const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("infinite-canvas");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const existing = [...db.objectStoreNames];
    const missing = stores.filter((s) => !existing.includes(s));
    db.close();
    if (missing.length) {
        const newVersion = db.version + 1;
        await new Promise((resolve, reject) => {
            const req = indexedDB.open("infinite-canvas", newVersion);
            req.onupgradeneeded = () => {
                missing.forEach((s) => req.result.createObjectStore(s));
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
}
```

### 方案 B：不用 localforage 写 blob，用原始 IDB API

绕过 localforage 的 store 实例，直接用原生 IDB API 写 blob。这样避免了 localforage 实例的 store 初始化问题。

### 方案 C：导入后不直接写 IDB，改用 sessionStorage 中转 + 页面刷新后由 app 自己处理

把导入的数据暂存到 sessionStorage（或一个专用的 IDB store），然后 reload。在 app 启动时检查是否有待导入的数据，如果有则走正常的 store 水合路径（让 localforage 自己处理 store 创建）。

### 方案 D：图片节点渲染时添加 fallback 重解析

在 CanvasNode 组件的图片渲染中，当 `<img>` 加载失败（onerror）且节点有 storageKey 时，自动调用 `resolveImageUrl(storageKey)` 重试。这样即使导入时 content 没有正确修复，图片也能在渲染时自动恢复。

### 方案 E（最简单）：导入时跳过 fixNodeMetadata 的 URL 替换，只做 blob 恢复 + 直接写 IDB + reload

fixNodeMetadata 的 URL 替换在导入时可能不是必需的——`hydrateCanvasImages` 在画布加载时会重新解析。问题可能出在 fixNodeMetadata 自身引入了 bug（async 函数链中的某个 await 失败导致 content 被清空）。

**建议先尝试方案 E**：把 fixNodeMetadata 从导入流程中完全移除，直接把原始包数据写入 IDB，让 `hydrateCanvasImages` 在画布加载时处理 URL 解析。如果这样能正常显示图片，说明 fixNodeMetadata 有 bug。

## 需要修改的文件

| 文件 | 说明 |
|------|------|
| `web/src/services/data-package.ts` | 导入/导出核心逻辑（当前版本有问题） |
| `web/src/components/layout/app-config-modal.tsx` | 设置弹窗（导入按钮 + reload 逻辑） |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | 画布编辑器（项目加载 + hydrateCanvasImages） |
| `web/src/services/image-storage.ts` | setImageBlob / resolveImageUrl（localforage 实例） |
| `desktop/main.go` | WebView2 独立窗口 |

## 当前可以工作的功能

- ✅ 桌面版独立窗口（WebView2）
- ✅ 广告已删除
- ✅ 设置入口（齿轮按钮）
- ✅ 右键菜单屏蔽浏览器原生菜单
- ✅ 重新生成修复（主链路 + 重试链路）
- ✅ 创造副本状态修复
- ✅ 连线自动整理
- ✅ 完整包导出（含 47MB blob）
- ⚠️ 完整包导入：**BUG——导入后图片节点为空**

## 未实现的功能

- ❌ 引用包（只导出 storageKey + md5，不含 blob，导入时定位缺失图片）
