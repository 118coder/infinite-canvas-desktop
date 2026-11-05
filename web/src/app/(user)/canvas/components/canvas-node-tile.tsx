"use client";

import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { allLodKeys } from "@/lib/image-thumbnail";
import { getImagePreviewVersion, previewUrlFor, subscribeImagePreview } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";

type CanvasNodeTileProps = {
    data: CanvasNodeData;
    isSelected: boolean;
    onMouseDown: (event: ReactMouseEvent, nodeId: string) => void;
    onContextMenu: (event: ReactMouseEvent, nodeId: string) => void;
    onViewImage?: (node: CanvasNodeData) => void;
};

const TYPE_LABEL: Record<string, string> = {
    [CanvasNodeType.Text]: "文本",
    [CanvasNodeType.Config]: "生成配置",
    [CanvasNodeType.Director]: "导演台",
    [CanvasNodeType.Video]: "视频",
    [CanvasNodeType.Audio]: "音频",
    [CanvasNodeType.Image]: "图片",
    [CanvasNodeType.Panorama]: "全景图",
    [CanvasNodeType.Group]: "组",
};

/**
 * DOM 级 LOD：缩小画布或视口内节点过多时，用这个极简瓦片替代完整的 CanvasNode。
 * 关键约定：瓦片不能把节点画成空心黑框。图片节点优先用任意已生成的 LOD 档位，
 * 档位尚未就绪时暂时用原内容（配合 lazy/async 解码），后台小档生成后会自动替换；
 * 组节点保持透明边框让子节点可见，文本/配置等节点直接显示文字内容。
 */
export const CanvasNodeTile = memo(function CanvasNodeTile({ data, isSelected, onMouseDown, onContextMenu, onViewImage }: CanvasNodeTileProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const projectId = useCanvasUiStore((state) => state.openProjectId) || "";
    const baseKey = `canvas-node:${projectId}:${data.id}`;
    const content = data.metadata?.content || "";
    const storageKey = data.metadata?.storageKey;
    const previewSource = `${data.metadata?.primaryImageId || ""}:${data.metadata?.imageTaskResultId || ""}:${storageKey || content}`;

    // 订阅全部档位：任一档位在后台生成完成，该瓦片单独刷新，不牵动其它节点。
    const lodKeys = useMemo(() => allLodKeys(baseKey), [baseKey]);
    const lodToken = lodKeys.join("|");
    const subscribePreview = useCallback(
        (onStoreChange: () => void) => {
            const offs = lodKeys.map((key) => subscribeImagePreview(key, onStoreChange));
            return () => offs.forEach((off) => off());
        },
        [lodToken],
    );
    const getPreviewSnapshot = useCallback(
        () => lodKeys.reduce((sum, key) => sum + getImagePreviewVersion(key), 0),
        [lodToken],
    );
    useSyncExternalStore(subscribePreview, getPreviewSnapshot, getPreviewSnapshot);

    const isImage = isCanvasImageNodeType(data.type);
    const isGroup = data.type === CanvasNodeType.Group;
    const isText = data.type === CanvasNodeType.Text;
    // 从低档到高档找任意已就绪的预览；都没有时回退原内容，避免出现无内容的色块。
    const cachedPreview = lodKeys.map((key) => previewUrlFor(key, previewSource)).find((url) => Boolean(url)) || "";
    const targetSrc = isImage ? cachedPreview || content : "";
    // 小档生成完成后先预解码再换 src，避免 src 变化那一帧图像被清空造成闪烁。
    const [displaySrc, setDisplaySrc] = useState(() => targetSrc);
    useEffect(() => {
        if (!targetSrc || targetSrc === displaySrc) return;
        let cancelled = false;
        const image = new Image();
        image.decoding = "async";
        image.src = targetSrc;
        const apply = () => {
            if (!cancelled) setDisplaySrc(targetSrc);
        };
        if (typeof image.decode === "function") void image.decode().then(apply, apply);
        else {
            image.onload = apply;
            image.onerror = apply;
        }
        return () => { cancelled = true; };
    }, [targetSrc, displaySrc]);
    const imageSource = displaySrc || targetSrc;

    const frameStyle = {
        transform: `translate(${data.position.x}px, ${data.position.y}px)`,
        width: data.width,
        height: data.height,
        boxShadow: isSelected ? `inset 0 0 0 2px ${theme.node.activeStroke}` : undefined,
        cursor: "grab",
    } as const;
    const interaction = {
        onMouseDown: (event: ReactMouseEvent) => onMouseDown(event, data.id),
        onContextMenu: (event: ReactMouseEvent) => onContextMenu(event, data.id),
        onDoubleClick: () => {
            if (isImage && content) onViewImage?.(data);
        },
    };

    // 组节点必须保持透明，否则会盖住框内的子节点。
    if (isGroup) {
        return (
            <div
                data-node-id={data.id}
                className="node-element absolute select-none"
                style={{ ...frameStyle, contain: "layout style", background: "transparent", border: `1px dashed ${theme.node.stroke}`, borderRadius: 12 }}
                {...interaction}
            >
                <span className="absolute -top-5 left-1 whitespace-nowrap text-xs" style={{ color: theme.node.muted }}>{data.title || "组"}</span>
            </div>
        );
    }

    return (
        <div
            data-node-id={data.id}
            className="node-element absolute select-none"
            style={{ ...frameStyle, contain: "layout style paint", background: theme.node.fill, borderRadius: 10, overflow: "hidden" }}
            {...interaction}
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
            ) : isText ? (
                <div className="h-full w-full overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-xs leading-5" style={{ color: theme.node.text }}>
                    {content || data.title || "文本"}
                </div>
            ) : (
                <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs" style={{ color: theme.node.text }}>
                    <span className="line-clamp-2 opacity-80">{data.title || TYPE_LABEL[data.type] || "节点"}</span>
                </div>
            )}
        </div>
    );
});
