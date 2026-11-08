import { resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";

import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { isCanvasImageNodeType } from "./canvas-panorama";

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    // 限制并发：服务端存储的画布首次恢复时会逐节点请求元数据，N 路并发会把连接池和服务端打满
    return mapWithConcurrency(nodes, 6, async (node) => {
            try {
                const content = node.metadata?.content;
                if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveMediaUrl(node.metadata.storageKey, content) } };
                if (!isCanvasImageNodeType(node.type) || (!content && !node.metadata?.storageKey)) return node;
                if (node.metadata?.storageKey) {
                    const resolved = await resolveImageUrl(node.metadata.storageKey, "");
                    if (resolved) return { ...node, metadata: { ...node.metadata, content: resolved } };
                    // 解析失败：会话级 blob: 链接和 base64 一定已经失效，清空后交给"图片缺失"占位；
                    // 远端 http 地址仍然保留，至少让用户看到原图。
                    const fallback = content && !content.startsWith("blob:") && !content.startsWith("data:") ? content : "";
                    return { ...node, metadata: { ...node.metadata, content: fallback } };
                }
                if (!content || !content.startsWith("data:image/")) return node;
                // 内联 base64 大图转本地存储：加超时，单个节点失败不影响整张画布
                const uploaded = await withTimeout(uploadImage(content, { localOnly: true }), 8000);
                return { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded) } };
            } catch (error) {
                console.error("节点媒体恢复失败", node.id, error);
                return node;
            }
    });
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
}

// 恢复媒体时整体加超时兜底：底层 IndexedDB/图片解码卡住时，画布仍然可以进入
export async function hydrateCanvasImagesSafe(nodes: CanvasNodeData[]) {
    try {
        return await withTimeout(hydrateCanvasImages(nodes), 15000);
    } catch (error) {
        console.error("画布媒体恢复超时，改用原始节点", error);
        return nodes.map((node) =>
            node.metadata?.storageKey && (node.metadata?.content || "").startsWith("blob:")
                ? { ...node, metadata: { ...node.metadata, content: "" } }
                : node,
        );
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("媒体恢复超时")), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
