import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { CanvasNodeType, type CanvasAssistantReference, type CanvasConnection, type CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "./canvas-panorama";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    previewSource?: string;
    text?: string;
    active: boolean;
};

export function assistantReferenceContentFromNode(node: CanvasNodeData): Partial<CanvasAssistantReference> | null {
    const content = node.metadata?.content;
    if (node.type === CanvasNodeType.Text) {
        const text = content || node.metadata?.prompt;
        return text ? { text } : null;
    }
    if (!content) return null;
    if (isCanvasImageNodeType(node.type)) return { dataUrl: content, url: undefined, storageKey: node.metadata!.storageKey, mimeType: node.metadata!.mimeType };
    if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) return { dataUrl: undefined, url: content, storageKey: node.metadata!.storageKey, mimeType: node.metadata!.mimeType };
    return null;
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], contextNodeId?: string | null) {
    const contextNodes = contextNodeId ? getMentionResourceNodes(contextNodeId, nodes, connections) : [];
    const globalReferences = labelResourceNodes(nodes.filter(isCanvasReferenceNode), false);
    const activeByNodeId = new Map(labelResourceNodes(contextNodes, true).map((reference) => [reference.nodeId, reference]));
    return globalReferences.map((reference) => activeByNodeId.get(reference.nodeId) || reference);
}

export function buildAllCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes.filter(isCanvasReferenceNode), true);
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true);
}

// 一次建索引供全量节点复用：原来每个节点都 filter 全部连线 + find 全部节点，
// 整张表是 O(N² + N·E)；这里预建 id→node 与 toNodeId→来源连线桶，整张表降到 O(N + E)。
// 索引只在 nodes/connections 的引用变化时重建（调用方已有结构等价缓存，拖拽不重建）。
type ResourceIndex = {
    byId: Map<string, CanvasNodeData>;
    incoming: Map<string, CanvasConnection[]>;
    outgoing: Map<string, CanvasConnection[]>;
};

export function buildResourceIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]): ResourceIndex {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, CanvasConnection[]>();
    const outgoing = new Map<string, CanvasConnection[]>();
    connections.forEach((connection) => {
        if (connection.fromNodeId === connection.toNodeId) return;
        if (!incoming.has(connection.toNodeId)) incoming.set(connection.toNodeId, []);
        incoming.get(connection.toNodeId)!.push(connection);
        if (!outgoing.has(connection.fromNodeId)) outgoing.set(connection.fromNodeId, []);
        outgoing.get(connection.fromNodeId)!.push(connection);
    });
    return { byId, incoming, outgoing };
}

export function buildNodeMentionReferencesIndexed(node: CanvasNodeData, index: ResourceIndex) {
    return labelResourceNodes(getMentionResourceNodesIndexed(node.id, index), true);
}

function getMentionResourceNodesIndexed(nodeId: string, index: ResourceIndex) {
    const configInputs = getConnectedConfigResourceNodesIndexed(nodeId, index);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodesIndexed(nodeId, index);
    if (ownInputs.length) return ownInputs;
    const node = index.byId.get(nodeId);
    return node && isCanvasReferenceNode(node) ? [node] : [];
}

function getContextResourceNodesIndexed(nodeId: string, index: ResourceIndex) {
    const connections = index.incoming.get(nodeId) || [];
    const result: CanvasNodeData[] = [];
    connections.forEach((connection) => {
        const node = index.byId.get(connection.fromNodeId);
        if (node && isCanvasReferenceNode(node)) result.push(node);
    });
    return result;
}

function getConnectedConfigResourceNodesIndexed(nodeId: string, index: ResourceIndex) {
    const configConnection = (index.outgoing.get(nodeId) || []).find((connection) => index.byId.get(connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextResourceNodesIndexed(configConnection.toNodeId, index).filter((node) => node.id !== nodeId);
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return getMentionResourceNodesIndexed(nodeId, buildResourceIndex(nodes, connections));
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const index = buildResourceIndex(nodes, connections);
    const configInputs = getConnectedConfigResourceNodesIndexed(nodeId, index);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodesIndexed(nodeId, index);
    return ownInputs;
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const index = counts[kind]++;
        const label = canvasResourceLabel(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.content,
                previewSource: `${node.metadata?.primaryImageId || ""}:${node.metadata?.imageTaskResultId || ""}:${node.metadata?.storageKey || node.metadata?.content || ""}`,
                text: node.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt : undefined,
                active,
            },
        ];
    });
}

export function canvasResourceLabel(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return seedanceReferenceLabel("video", index);
    if (kind === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

export function isCanvasReferenceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (isCanvasImageNodeType(node.type) && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    return null;
}
