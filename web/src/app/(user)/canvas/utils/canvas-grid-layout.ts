import type { CanvasConnection, CanvasNodeData, Position } from "../types";

/**
 * 密集图片场景的"网格排版"：与按拓扑分层的整理布局互补。
 * 拓扑整理在大量图片指向同一节点时会堆成一条很长的竖列、连线全部交叉；
 * 这里把每个顶层单元（组框连同成员、图片组连同子图）当作一个方块，
 * 按连线层级排序后压成接近 16:9 的网格，行列尺寸取单元实际包围盒，
 * 因此不会重叠，整体包围盒中心保持不变，视口不会跑飞。
 * 只计算位置，不改动节点数据本身。
 */

type LayoutUnit = {
    key: string;
    nodeIds: string[];
    x: number;
    y: number;
    width: number;
    height: number;
};

const GAP = 110;
const TARGET_ASPECT = 1.7;

function boundsOf(items: { x: number; y: number; width: number; height: number }[]) {
    return items.reduce(
        (bounds, item) => ({ left: Math.min(bounds.left, item.x), top: Math.min(bounds.top, item.y), right: Math.max(bounds.right, item.x + item.width), bottom: Math.max(bounds.bottom, item.y + item.height) }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

export function computeGridLayout(nodes: CanvasNodeData[], connections: CanvasConnection[]): Map<string, Position> {
    const result = new Map<string, Position>();
    if (!nodes.length) return result;

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const memberIdsByRoot = new Map<string, string[]>();
    nodes.forEach((node) => {
        const rootId = node.metadata?.groupId || node.metadata?.batchRootId;
        if (!rootId || !nodeById.has(rootId)) return;
        memberIdsByRoot.set(rootId, [...(memberIdsByRoot.get(rootId) || []), node.id]);
    });

    const units: LayoutUnit[] = [];
    const unitKeyByNodeId = new Map<string, string>();
    nodes.forEach((node) => {
        // 子成员跟随所属单元整体移动，不单独占位
        if ((node.metadata?.groupId && nodeById.has(node.metadata.groupId)) || (node.metadata?.batchRootId && nodeById.has(node.metadata.batchRootId))) return;
        const nodeIds = [node.id, ...(memberIdsByRoot.get(node.id) || []).filter((id) => id !== node.id)];
        nodeIds.forEach((id) => unitKeyByNodeId.set(id, node.id));
        const bounds = boundsOf(nodeIds.map((id) => {
            const member = nodeById.get(id)!;
            return { x: member.position.x, y: member.position.y, width: member.width, height: member.height };
        }));
        units.push({ key: node.id, nodeIds, x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top });
    });

    // 层级：取最长入边路径，成环时按 0 处理，保证上游靠左、下游靠右
    const links = new Map<string, string[]>();
    connections.forEach((connection) => {
        const from = unitKeyByNodeId.get(connection.fromNodeId);
        const to = unitKeyByNodeId.get(connection.toNodeId);
        if (!from || !to || from === to) return;
        links.set(from, [...(links.get(from) || []), to]);
    });
    const incoming = new Map<string, string[]>();
    links.forEach((targets, from) => targets.forEach((to) => incoming.set(to, [...(incoming.get(to) || []), from])));
    const layers = new Map<string, number>();
    const visiting = new Set<string>();
    const layerOf = (key: string): number => {
        const cached = layers.get(key);
        if (cached !== undefined) return cached;
        if (visiting.has(key)) return 0;
        visiting.add(key);
        const layer = (incoming.get(key) || []).reduce((max, from) => Math.max(max, layerOf(from) + 1), 0);
        visiting.delete(key);
        layers.set(key, layer);
        return layer;
    };
    units.forEach((unit) => layerOf(unit.key));
    units.sort((a, b) => (layers.get(a.key)! - layers.get(b.key)!) || a.y - b.y || a.x - b.x);

    // 选列数：让网格宽高比尽量接近 16:9，同时按每列/每行的最大单元留出空间
    let bestColumns = 1;
    let bestScore = Infinity;
    for (let columns = 1; columns <= units.length; columns += 1) {
        const rows = Math.ceil(units.length / columns);
        const columnWidths = new Array<number>(columns).fill(0);
        const rowHeights = new Array<number>(rows).fill(0);
        units.forEach((unit, index) => {
            const column = index % columns;
            const row = Math.floor(index / columns);
            columnWidths[column] = Math.max(columnWidths[column], unit.width);
            rowHeights[row] = Math.max(rowHeights[row], unit.height);
        });
        const width = columnWidths.reduce((sum, value) => sum + value, 0) + GAP * (columns - 1);
        const height = rowHeights.reduce((sum, value) => sum + value, 0) + GAP * (rows - 1);
        const score = Math.abs(Math.log(width / Math.max(height, 1) / TARGET_ASPECT));
        if (score < bestScore) {
            bestScore = score;
            bestColumns = columns;
        }
    }

    const columns = bestColumns;
    const columnWidths = new Array<number>(columns).fill(0);
    const rowHeights = new Array<number>(Math.ceil(units.length / columns)).fill(0);
    units.forEach((unit, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        columnWidths[column] = Math.max(columnWidths[column], unit.width);
        rowHeights[row] = Math.max(rowHeights[row], unit.height);
    });
    const columnXs = columnWidths.map((_, index) => columnWidths.slice(0, index).reduce((sum, width) => sum + width + GAP, 0));
    const rowYs = rowHeights.map((_, index) => rowHeights.slice(0, index).reduce((sum, height) => sum + height + GAP, 0));

    const placed = units.map((unit, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return {
            unit,
            x: columnXs[column] + (columnWidths[column] - unit.width) / 2,
            y: rowYs[row] + (rowHeights[row] - unit.height) / 2,
        };
    });

    const originalBounds = boundsOf(units);
    const laidBounds = boundsOf(placed.map((item) => ({ x: item.x, y: item.y, width: item.unit.width, height: item.unit.height })));
    const offsetX = (originalBounds.left + originalBounds.right) / 2 - (laidBounds.left + laidBounds.right) / 2;
    const offsetY = (originalBounds.top + originalBounds.bottom) / 2 - (laidBounds.top + laidBounds.bottom) / 2;

    placed.forEach(({ unit, x, y }) => {
        const dx = x + offsetX - unit.x;
        const dy = y + offsetY - unit.y;
        unit.nodeIds.forEach((id) => {
            const node = nodeById.get(id);
            if (node) result.set(id, { x: node.position.x + dx, y: node.position.y + dy });
        });
    });
    return result;
}
