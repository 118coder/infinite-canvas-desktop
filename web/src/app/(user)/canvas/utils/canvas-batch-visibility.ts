import type { CanvasNodeData } from "../types";

/** 未展开的图片组子图不参与画布渲染、连线与框选。 */
export function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

/** 热路径版本：先用 id→node 映射查组根节点，避免逐个节点线性查找。 */
export function isHiddenBatchChildFast(node: CanvasNodeData, rootById: Map<string, CanvasNodeData>, collapsingBatchIds?: Set<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = rootById.get(rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function isHiddenBatchEndpointFast(node: CanvasNodeData, rootById: Map<string, CanvasNodeData>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = rootById.get(rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}
