"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { BetweenHorizontalStart, Boxes, Copy, CopyPlus, Download, GalleryHorizontal, GalleryHorizontalEnd, Image as ImageIcon, Maximize, Music2, Network, Save, SquareSplitHorizontal, Trash2, Type, Ungroup, Upload, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "../types";
import type { VideoFramePosition } from "../utils/canvas-video-frame";

type NodeMenuActions = {
    onCaptureVideoFrame?: (position: VideoFramePosition) => void;
    onDuplicate: () => void;
    onGroup?: () => void;
    onUngroup?: () => void;
    onCopyContent?: () => void;
    onSaveAsset?: () => void;
    onDownload?: () => void;
    onDelete: () => void;
};

export function CanvasContextMenu({
    menu,
    canCaptureVideoFrame,
    nodeActions,
    onClose,
    onCanvasCreate,
    onCanvasUpload,
    onSelectAll,
    onFitView,
    onAutoLayout,
    onPaste,
}: {
    menu: ContextMenuState;
    canCaptureVideoFrame: boolean;
    nodeActions: NodeMenuActions;
    onClose: () => void;
    onCanvasCreate: (type: "image" | "text" | "video" | "audio", position: { x: number; y: number }) => void;
    onCanvasUpload: (position: { x: number; y: number }) => void;
    onSelectAll: () => void;
    onFitView: () => void;
    onAutoLayout: () => void;
    onPaste: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {menu.type === "node" ? <NodeMenuItems canCaptureVideoFrame={canCaptureVideoFrame} actions={nodeActions} /> : null}
            {menu.type === "connection" ? <MenuButton icon={<Trash2 className="size-4" />} label="删除连线" onClick={nodeActions.onDelete} danger /> : null}
            {menu.type === "canvas" ? (
                <>
                    <MenuButton icon={<ImageIcon className="size-4" />} label="新建图片" onClick={() => onCanvasCreate("image", { x: menu.worldX, y: menu.worldY })} />
                    <MenuButton icon={<Video className="size-4" />} label="新建视频" onClick={() => onCanvasCreate("video", { x: menu.worldX, y: menu.worldY })} />
                    <MenuButton icon={<Music2 className="size-4" />} label="新建音频" onClick={() => onCanvasCreate("audio", { x: menu.worldX, y: menu.worldY })} />
                    <MenuButton icon={<Type className="size-4" />} label="新建文本" onClick={() => onCanvasCreate("text", { x: menu.worldX, y: menu.worldY })} />
                    <MenuButton icon={<Upload className="size-4" />} label="上传文件" onClick={() => onCanvasUpload({ x: menu.worldX, y: menu.worldY })} />
                    <Divider />
                    <MenuButton icon={<Copy className="size-4" />} label="粘贴节点" onClick={onPaste} />
                    <MenuButton icon={<SquareSplitHorizontal className="size-4" />} label="全选节点" onClick={onSelectAll} />
                    <MenuButton icon={<Network className="size-4" />} label="整理节点布局" onClick={onAutoLayout} />
                    <MenuButton icon={<Maximize className="size-4" />} label="适应全部节点" onClick={onFitView} />
                </>
            ) : null}
        </div>
    );
}

function NodeMenuItems({ canCaptureVideoFrame, actions }: { canCaptureVideoFrame: boolean; actions: NodeMenuActions }) {
    return (
        <>
            {canCaptureVideoFrame ? (
                <>
                    <MenuButton icon={<BetweenHorizontalStart className="size-4" />} label="截取首帧" onClick={() => actions.onCaptureVideoFrame?.("first")} />
                    <MenuButton icon={<GalleryHorizontalEnd className="size-4" />} label="截取尾帧" onClick={() => actions.onCaptureVideoFrame?.("last")} />
                    <MenuButton icon={<GalleryHorizontal className="size-4" />} label="截取当前帧" onClick={() => actions.onCaptureVideoFrame?.("current")} />
                    <Divider />
                </>
            ) : null}
            {actions.onGroup ? <MenuButton icon={<Boxes className="size-4" />} label="打组" onClick={actions.onGroup} /> : null}
            {actions.onUngroup ? <MenuButton icon={<Ungroup className="size-4" />} label="取消打组" onClick={actions.onUngroup} /> : null}
            <MenuButton icon={<CopyPlus className="size-4" />} label="创造副本" onClick={actions.onDuplicate} />
            {actions.onCopyContent ? <MenuButton icon={<Copy className="size-4" />} label="复制内容" onClick={actions.onCopyContent} /> : null}
            {actions.onSaveAsset ? <MenuButton icon={<Save className="size-4" />} label="保存到我的素材" onClick={actions.onSaveAsset} /> : null}
            {actions.onDownload ? <MenuButton icon={<Download className="size-4" />} label="下载" onClick={actions.onDownload} /> : null}
            <Divider />
            <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={actions.onDelete} danger />
        </>
    );
}

function Divider() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />;
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
