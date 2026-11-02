# 画布 4K 图拖拽卡顿优化（2026-11-02）

## 瓶颈定位

| 瓶颈 | 证据 | 影响 |
| --- | --- | --- |
| 4K 原图直接进画布 | `image-thumbnail.ts` 的 `CANVAS_IMAGE_PREVIEW_MAX_EDGE = 768`，而 `pickImageSource` 用 `渲染尺寸 × scale × dpr` 和它比较；节点宽 640、scale 1、dpr 1.5 时需求 960 > 768，于是**回退到 3840×2160 原图** | 单张 4K 解码约 33MB，12 张接近 400MB；合成/上传显存昂贵，拖拽掉帧 |
| 平移每帧 setState | `infinite-canvas.tsx` 的 pan 在 rAF 里调用 `onViewportChange` | 每帧重渲染整个画布页（节点树、SVG 连线、各种 map），12 个节点下就足以打满主线程 |
| 网格整屏重绘 | `CanvasGrid` 用 `background-position` 跟随 viewport | 每帧重绘一整屏背景，与节点抢渲染线程 |
| 节点 memo 失效 | `CanvasNode` 只有默认浅比较，父组件每帧重建内联回调；`mentionReferences` 依赖 `nodes`，拖拽时每帧重建 | 默认浅比较必然失败，所有节点（含大图）跟着重渲染 |

## 改动

1. `lib/image-thumbnail.ts`：`CANVAS_IMAGE_PREVIEW_MAX_EDGE` 768 → 1536；`services/image-storage.ts` 预览版本升到 2，旧缩略图自动重生成。
2. `infinite-canvas.tsx`：平移期间用 `applyViewportTransform()` 直接改 `world`/`grid` 的 `transform`，`pointerup` 时才 `onViewportChange` 提交；世界层加 `will-change: transform` 单独合成；网格改为「大尺寸图层 + translate3d」。
3. `canvas-node.tsx`：给 `React.memo` 加 `areCanvasNodePropsEqual`，只比较 data/scale/选中关联/batch 状态等渲染相关字段，回调不参与比较（面板展开的节点强制更新）；`mentionReferences` 仅文本节点比较；`<img decoding="async">`。

## 验收

- 画布放 10+ 张 4K 图，`100%` 缩放下拖动平移：DevTools Performance 里每帧不应出现大面积 Layout/Paint（只剩 Composite），FPS 稳定 60；
- 拖动单个大图节点：只有该节点与其连线重绘，其余节点不重新渲染（React Profiler 可见）；
- 缩放到 200% 以上仍应清晰（超过 1.5 倍时回退原图，属预期）。
