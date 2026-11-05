"use client";

import { memo, useCallback, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { lodKeyFor, SMALL_LOD_LEVEL } from "@/lib/image-thumbnail";
import { getImagePreviewVersion, previewUrlFor, skipsImagePreview, subscribeImagePreview } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import type { CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";

type CanvasNodeTileProps = {
    data: CanvasNodeData;
    isSelected: boolean;
    onMouseDown: (event: ReactMouseEvent, nodeId: string) => void;
    onContextMenu: (event: ReactMouseEvent, nodeId: string) => void;
    onViewImage?: (node: CanvasNodeData) => void;
};

/**
 * DOM 级 LOD：缩小画布或视口内节点过多时，用这个极简瓦片替代完整的 CanvasNode。
 * 500 张 4K 图同时进入视口时，只挂载 500 个轻量 div + @256 小档位图，
 * 不挂载标题、边框装饰、四角拉伸柄、连线端点与底部面板。
 */
export const CanvasNodeTile = memo(function CanvasNodeTile({ data, isSelected, onMouseDown, onContextMenu, onViewImage }: CanvasNodeTileProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const projectId = useCanvasUiStore((state) => state.openProjectId) || "";
    const baseKey = `canvas-node:${projectId}:${data.id}`;
    const smallKey = lodKeyFor(baseKey, SMALL_LOD_LEVEL);
    const content = data.metadata?.content || "";
    const storageKey = data.metadata?.storageKey;
    const previewSource = `${data.metadata?.primaryImageId || ""}:${data.metadata?.imageTaskResultId || ""}:${storageKey || content}`;

    // 只订阅 @256 与主档：后台预生成小档完成后该瓦片单独刷新，不牵动其它节点。
    const subscribePreview = useCallback(
        (onStoreChange: () => void) => {
            const offSmall = subscribeImagePreview(smallKey, onStoreChange);
            const offMain = subscribeImagePreview(baseKey, onStoreChange);
            return () => {
                offSmall();
                offMain();
            };
        },
        [baseKey, smallKey],
    );
    const getPreviewSnapshot = useCallback(
        () => getImagePreviewVersion(smallKey) + getImagePreviewVersion(baseKey),
        [baseKey, smallKey],
    );
    useSyncExternalStore(subscribePreview, getPreviewSnapshot, getPreviewSnapshot);

    const isImage = isCanvasImageNodeType(data.type);
    // blob/data/comfy 源没有预览档位，这类节点直接用原内容；远程源绝不回退 4K 原图。
    const isLocalSource = skipsImagePreview(content, storageKey);
    const imageSource = isImage
        ? previewUrlFor(smallKey, previewSource) || previewUrlFor(baseKey, previewSource) || (isLocalSource ? content : "")
        : "";

    return (
        <div
            data-node-id={data.id}
            className="node-element absolute select-none"
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                contain: "layout style paint",
                background: theme.node.fill,
                borderRadius: 10,
                overflow: "hidden",
                boxShadow: isSelected ? `inset 0 0 0 2px ${theme.node.activeStroke}` : undefined,
                cursor: "grab",
            }}
            onMouseDown={(event) => onMouseDown(event, data.id)}
            onContextMenu={(event) => onContextMenu(event, data.id)}
            onDoubleClick={() => {
                if (isImage && content) onViewImage?.(data);
            }}
        >
            {imageSource ? (
                <img
                    src={imageSource}
                    alt={data.title}
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    className="pointer-events-none block h-full w-full select-none object-cover"
                />
            ) : (
                <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs opacity-70" style={{ color: theme.node.text }}>
                    <span className="line-clamp-2">{data.title || (isImage ? "图片" : "节点")}</span>
                </div>
            )}
        </div>
    );
});
