import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "../types";

type LayoutUnit = {
    key: string;
    nodeIds: string[];
    width: number;
    height: number;
    x: number;
    y: number;
    links: string[];
};

type RowLayout = { key: string; x: number; y: number };

const GAP_X = 140;
const GAP_Y = 96;

// 按连线拓扑做分层整理：组框连同成员、批量子图跟随所属单元整体移动，
// 没有连线的单元保持原位，避免无关节点被大规模挪动。
export function computeAutoLayout(nodes: CanvasNodeData[], connections: CanvasConnection[]): Map<string, Position> {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const childIdsByGroupId = new Map<string, string[]>();
    nodes.forEach((node) => {
        const groupId = node.metadata?.groupId;
        if (!groupId || !nodeById.has(groupId)) return;
        childIdsByGroupId.set(groupId, [...(childIdsByGroupId.get(groupId) || []), node.id]);
    });

    const unitKeyByNodeId = new Map<string, string>();
    const units = new Map<string, LayoutUnit>();
    nodes.forEach((node) => {
        if (node.metadata?.groupId && nodeById.has(node.metadata.groupId)) return;
        if (node.metadata?.batchRootId && nodeById.has(node.metadata.batchRootId)) return;
        const children = [
            ...(node.type === CanvasNodeType.Group ? childIdsByGroupId.get(node.id) || [] : []),
            ...nodes.filter((item) => !item.metadata?.groupId && item.metadata?.batchRootId === node.id).map((item) => item.id),
        ];
        unitKeyByNodeId.set(node.id, node.id);
        children.forEach((childId) => unitKeyByNodeId.set(childId, node.id));
        units.set(node.id, { key: node.id, nodeIds: [node.id, ...children], width: node.width, height: node.height, x: node.position.x, y: node.position.y, links: [] });
    });

    connections.forEach((connection) => {
        const from = unitKeyByNodeId.get(connection.fromNodeId);
        const to = unitKeyByNodeId.get(connection.toNodeId);
        if (!from || !to || from === to) return;
        if (!units.get(from)!.links.includes(to)) units.get(from)!.links.push(to);
    });

    // 并查集分连通分量：只整理有连线的分量，孤立节点不动
    const parentOf = new Map<string, string>();
    units.forEach((_, key) => parentOf.set(key, key));
    const findRoot = (key: string): string => {
        let root = key;
        while (parentOf.get(root) !== root) root = parentOf.get(root)!;
        while (parentOf.get(key) !== root) {
            const next = parentOf.get(key)!;
            parentOf.set(key, root);
            key = next;
        }
        return root;
    };
    units.forEach((unit) => unit.links.forEach((target) => {
        const rootA = findRoot(unit.key);
        const rootB = findRoot(target);
        if (rootA !== rootB) parentOf.set(rootA, rootB);
    }));
    const componentKeys = new Map<string, string[]>();
    units.forEach((_, key) => {
        const root = findRoot(key);
        componentKeys.set(root, [...(componentKeys.get(root) || []), key]);
    });

    const nextPositions = new Map<string, Position>();
    componentKeys.forEach((keys) => {
        if (keys.length === 1) return;
        layoutComponent(units, keys, nodeById, nextPositions);
    });
    return nextPositions;
}

function layoutComponent(units: Map<string, LayoutUnit>, keys: string[], nodeById: Map<string, CanvasNodeData>, nextPositions: Map<string, Position>) {
    const incoming = new Map<string, string[]>();
    keys.forEach((key) => {
        units.get(key)!.links.forEach((target) => {
            if (keys.includes(target)) incoming.set(target, [...(incoming.get(target) || []), key]);
        });
    });

    // 分层：最长路径法，成环的回边按 0 处理
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
    keys.forEach((key) => layerOf(key));

    // 层内重心法排序，减少连线交叉
    let order = [...keys];
    for (let sweep = 0; sweep < 4; sweep += 1) {
        const index = new Map(order.map((key, i) => [key, i]));
        const averageOf = (neighborKeys: string[], fallback: number) => {
            const values = neighborKeys.map((key) => index.get(key)).filter((value): value is number => value !== undefined);
            return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
        };
        const descending = sweep % 2 === 1;
        const byLayer = new Map<number, string[]>();
        order.forEach((key) => {
            const layer = layers.get(key)!;
            byLayer.set(layer, [...(byLayer.get(layer) || []), key]);
        });
        order = [];
        [...byLayer.keys()].sort((a, b) => (descending ? b - a : a - b)).forEach((layer) => {
            byLayer.get(layer)!.sort((a, b) => {
                const valueA = descending ? averageOf(units.get(a)!.links.filter((target) => layers.get(target) === layer + 1), index.get(a) ?? 0) : averageOf(incoming.get(a) || [], index.get(a) ?? 0);
                const valueB = descending ? averageOf(units.get(b)!.links.filter((target) => layers.get(target) === layer + 1), index.get(b) ?? 0) : averageOf(incoming.get(b) || [], index.get(b) ?? 0);
                return valueA - valueB;
            });
            order.push(...byLayer.get(layer)!);
        });
    }

    // 同层竖向堆叠，各列相对最高列垂直居中
    const byLayer = new Map<number, string[]>();
    order.forEach((key) => {
        const layer = layers.get(key)!;
        byLayer.set(layer, [...(byLayer.get(layer) || []), key]);
    });
    const layerNumbers = [...byLayer.keys()].sort((a, b) => a - b);
    const columnWidths = layerNumbers.map((layer) => Math.max(...byLayer.get(layer)!.map((key) => units.get(key)!.width)));
    const columnXs = layerNumbers.map((_, i) => columnWidths.slice(0, i).reduce((sum, width) => sum + width + GAP_X, 0));
    const columns = layerNumbers.map((layer, index) => {
        let y = 0;
        const rows = byLayer.get(layer)!.map((key): RowLayout => {
            const row = { key, x: columnXs[index], y };
            y += units.get(key)!.height + GAP_Y;
            return row;
        });
        return { rows, height: Math.max(y - GAP_Y, 0) };
    });
    const maxHeight = Math.max(...columns.map((column) => column.height));
    columns.forEach((column) => {
        const offsetY = (maxHeight - column.height) / 2;
        column.rows.forEach((row) => {
            row.y += offsetY;
        });
    });

    // 平移让布局后包围盒中心与原始包围盒中心一致，视口不跑飞
    const originalBounds = boundsOf(keys.map((key) => units.get(key)!));
    const laidBounds = boundsOf(
        columns.flatMap((column) => column.rows).map((row) => {
            const unit = units.get(row.key)!;
            return { x: row.x, y: row.y, width: unit.width, height: unit.height };
        }),
    );
    const offsetX = (originalBounds.left + originalBounds.right) / 2 - (laidBounds.left + laidBounds.right) / 2;
    const offsetY = (originalBounds.top + originalBounds.bottom) / 2 - (laidBounds.top + laidBounds.bottom) / 2;

    columns.flatMap((column) => column.rows).forEach((row) => {
        const unit = units.get(row.key)!;
        const dx = row.x + offsetX - unit.x;
        const dy = row.y + offsetY - unit.y;
        unit.nodeIds.forEach((nodeId) => {
            const node = nodeById.get(nodeId);
            if (node) nextPositions.set(nodeId, { x: node.position.x + dx, y: node.position.y + dy });
        });
    });
}

function boundsOf(items: { x: number; y: number; width: number; height: number }[]) {
    return items.reduce(
        (bounds, item) => ({ left: Math.min(bounds.left, item.x), top: Math.min(bounds.top, item.y), right: Math.max(bounds.right, item.x + item.width), bottom: Math.max(bounds.bottom, item.y + item.height) }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}
