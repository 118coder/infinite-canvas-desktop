import type { CanvasNodeData, ViewportTransform } from "../types";

const CELL_SIZE = 512;

export type WorldRect = { left: number; top: number; right: number; bottom: number; width: number; height: number; k: number };
export type NodeSpatialIndex = { cell: number; buckets: Map<string, CanvasNodeData[]> };

function bucketKey(cx: number, cy: number) {
    return `${cx}:${cy}`;
}

/** 把节点按世界坐标网格分桶，节点移动/新增时整体重建，成本 O(N) 一次。 */
export function buildNodeSpatialIndex(nodes: CanvasNodeData[]): NodeSpatialIndex {
    const buckets = new Map<string, CanvasNodeData[]>();
    nodes.forEach((node) => {
        const x0 = Math.floor(node.position.x / CELL_SIZE);
        const x1 = Math.floor((node.position.x + node.width) / CELL_SIZE);
        const y0 = Math.floor(node.position.y / CELL_SIZE);
        const y1 = Math.floor((node.position.y + node.height) / CELL_SIZE);
        for (let cx = x0; cx <= x1; cx += 1) {
            for (let cy = y0; cy <= y1; cy += 1) {
                const key = bucketKey(cx, cy);
                const bucket = buckets.get(key);
                if (bucket) bucket.push(node);
                else buckets.set(key, [node]);
            }
        }
    });
    return { cell: CELL_SIZE, buckets };
}

/** 按视口矩形取候选节点，结果保持 nodes 原始顺序，避免 React key 抖动。 */
export function queryNodeSpatialIndex(index: NodeSpatialIndex, rect: WorldRect, ordered: CanvasNodeData[]): CanvasNodeData[] {
    const x0 = Math.floor(rect.left / index.cell);
    const x1 = Math.floor(rect.right / index.cell);
    const y0 = Math.floor(rect.top / index.cell);
    const y1 = Math.floor(rect.bottom / index.cell);
    const candidates = new Set<CanvasNodeData>();
    for (let cx = x0; cx <= x1; cx += 1) {
        for (let cy = y0; cy <= y1; cy += 1) {
            const bucket = index.buckets.get(bucketKey(cx, cy));
            if (bucket) bucket.forEach((node) => candidates.add(node));
        }
    }
    return ordered.filter((node) => candidates.has(node) && node.position.x + node.width > rect.left && node.position.x < rect.right && node.position.y + node.height > rect.top && node.position.y < rect.bottom);
}

/** 屏幕像素边距换算成世界边距：放大时不会裁剪过多、缩小时不会裁剪过少。 */
export function viewportWorldRect(viewport: ViewportTransform, screenWidth: number, screenHeight: number, paddingPx = 280): WorldRect {
    const k = Math.max(viewport.k, 0.05);
    const padding = paddingPx / k;
    const left = -viewport.x / k - padding;
    const top = -viewport.y / k - padding;
    const right = left + screenWidth / k + padding * 2;
    const bottom = top + screenHeight / k + padding * 2;
    return { left, top, right, bottom, width: right - left, height: bottom - top, k };
}

export function rectsIntersect(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
