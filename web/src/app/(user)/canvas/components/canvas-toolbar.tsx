import { useState, type CSSProperties, type ReactNode } from "react";
import { Button, Segmented, Switch, Tooltip } from "antd";
import { CircleDot, CloudUpload, Download, Eraser, FolderOpen, FolderPlus, Globe2, Grid2x2, Hand, Image as ImageIcon, Info, Layers3, Moon, MousePointer2, Music2, Network, Palette, Redo2, Settings2, Square, Sun, Trash2, Type, Undo2, Upload, Video } from "lucide-react";

import { canvasThemes, type CanvasBackgroundMode, type CanvasColorTheme, type CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";

type ToolbarItem = {
    id: string;
    label: string;
    shortcut?: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    danger?: boolean;
};

export function CanvasToolbar({
    selectedCount,
    canvasTool,
    canUndo,
    canRedo,
    backgroundMode,
    showImageInfo,
    minimapOpen,
    gridSpacing,
    sidebarWidth,
    onAddImage,
    onAddVideo,
    onAddAudio,
    onAddText,
    onAddPanorama,
    onAddDirector,
    onAddConfig,
    onUndo,
    onRedo,
    onUpload,
    onDelete,
    onClear,
    onCanvasToolChange,
    onBackgroundModeChange,
    onShowImageInfoChange,
    onAutoLayout,
    onOpenMyAssets,
    onToggleMinimap,
    onGridSpacingChange,
    onBatchSaveAssets,
    onBatchDownload,
    onBatchUploadCloud,
}: {
    selectedCount: number;
    canvasTool: "select" | "pan";
    canUndo: boolean;
    canRedo: boolean;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    minimapOpen: boolean;
    gridSpacing: number;
    sidebarWidth: number;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddPanorama: () => void;
    onAddDirector: () => void;
    onAddConfig: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onCanvasToolChange: (tool: "select" | "pan") => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onAutoLayout: () => void;
    onOpenMyAssets: () => void;
    onToggleMinimap: () => void;
    onGridSpacingChange: (spacing: number) => void;
    onBatchSaveAssets?: () => void;
    onBatchDownload?: () => void;
    onBatchUploadCloud?: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const theme = canvasThemes[colorTheme];
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)" };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };

    const groups: ToolbarItem[][] = [
        [
            { id: `tool-${canvasTool}`, label: canvasTool === "select" ? "选择" : "移动", shortcut: "Space 临时切换", icon: canvasTool === "select" ? <MousePointer2 className="size-4.5" /> : <Hand className="size-4.5" />, onClick: () => onCanvasToolChange(canvasTool === "select" ? "pan" : "select"), active: true },
            { id: "tool-undo", label: "撤销", shortcut: "Ctrl+Z", icon: <Undo2 className="size-4.5" />, onClick: onUndo, disabled: !canUndo },
            { id: "tool-redo", label: "重做", shortcut: "Ctrl+Y", icon: <Redo2 className="size-4.5" />, onClick: onRedo, disabled: !canRedo },
        ],
        [
            { id: "tool-text", label: "文本", icon: <Type className="size-4.5" />, onClick: onAddText },
            { id: "tool-image", label: "图片", icon: <ImageIcon className="size-4.5" />, onClick: onAddImage },
            { id: "tool-video", label: "视频", icon: <Video className="size-4.5" />, onClick: onAddVideo },
            { id: "tool-audio", label: "音频", icon: <Music2 className="size-4.5" />, onClick: onAddAudio },
            { id: "tool-panorama", label: "全景图", icon: <Globe2 className="size-4.5" />, onClick: onAddPanorama },
            { id: "tool-director", label: "导演台", icon: <Layers3 className="size-4.5" />, onClick: onAddDirector },
            { id: "tool-config", label: "生成配置", icon: <Settings2 className="size-4.5" />, onClick: onAddConfig },
            { id: "tool-upload", label: "上传素材", icon: <Upload className="size-4.5" />, onClick: onUpload },
        ],
        [
            { id: "tool-autolayout", label: "整理布局", icon: <Network className="size-4.5" />, onClick: onAutoLayout },
            { id: "tool-assets", label: "我的素材", icon: <FolderOpen className="size-4.5" />, onClick: onOpenMyAssets },
            { id: "tool-style", label: "画布外观", icon: <Palette className="size-4.5" />, onClick: () => setAppearanceOpen((value) => !value), active: appearanceOpen },
        ],
        selectedCount
            ? [
                  ...(onBatchSaveAssets ? [{ id: "tool-batch-save", label: "选中存素材", icon: <FolderPlus className="size-4.5" />, onClick: onBatchSaveAssets }] : []),
                  ...(onBatchDownload ? [{ id: "tool-batch-download", label: "批量下载", icon: <Download className="size-4.5" />, onClick: onBatchDownload }] : []),
                  ...(onBatchUploadCloud ? [{ id: "tool-batch-cloud", label: "批量上传云存储", icon: <CloudUpload className="size-4.5" />, onClick: onBatchUploadCloud }] : []),
                  { id: "tool-delete", label: "删除选中", shortcut: "Delete", icon: <Trash2 className="size-4.5" />, onClick: onDelete, danger: true },
              ]
            : [],
        [{ id: "tool-clear", label: "清空画布", icon: <Eraser className="size-4.5" />, onClick: onClear, danger: true }],
    ];

    return (
        <div className="pointer-events-none absolute bottom-5 z-50 flex justify-center" style={{ left: sidebarWidth ? sidebarWidth + 16 : 16, right: 16 }}>
            <div className="thin-scrollbar pointer-events-auto flex h-14 max-w-full items-center gap-1 overflow-x-auto rounded-xl border px-2 shadow-lg backdrop-blur [&>*]:shrink-0" style={dockStyle}>
                {groups.flatMap((group, groupIndex) => [
                    ...(groupIndex ? [<Divider key={`divider-${groupIndex}`} theme={theme} />] : []),
                    ...group.map((item) => <ToolbarButton key={item.id} item={item} theme={theme} activeStyle={activeStyle} />),
                ])}
            </div>

            {appearanceOpen ? (
                <div className="pointer-events-auto absolute bottom-[72px] z-30 w-[248px] -translate-x-1/2 rounded-xl border p-2.5 shadow-xl backdrop-blur" style={{ left: "50%", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}>
                    <div className="px-1 pb-2 text-sm font-medium opacity-65">画布外观</div>
                    <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">主题模式</div>
                    <div className="grid grid-cols-2 gap-1 rounded-lg p-1" style={{ background: theme.toolbar.itemHover }}>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="light" onThemeChange={setTheme}>
                            <Sun className="size-4" />
                            浅色
                        </CanvasThemeButton>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="dark" onThemeChange={setTheme}>
                            <Moon className="size-4" />
                            深色
                        </CanvasThemeButton>
                    </div>
                    <div className="mt-3 px-1 pb-1.5 text-[11px] font-medium opacity-50">网格样式</div>
                    <Segmented
                        className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                        value={backgroundMode}
                        onChange={(value) => onBackgroundModeChange(value as CanvasBackgroundMode)}
                        options={[
                            { value: "dots", label: <span className="inline-flex items-center gap-1.5"><CircleDot className="size-4" />点</span> },
                            { value: "lines", label: <span className="inline-flex items-center gap-1.5"><Grid2x2 className="size-4" />线</span> },
                            { value: "blank", label: <span className="inline-flex items-center gap-1.5"><Square className="size-4" />空白</span> },
                        ]}
                    />
                    <div className="mt-3 px-1 pb-1.5 text-[11px] font-medium opacity-50">网格间距</div>
                    <Segmented
                        className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                        value={gridSpacing}
                        onChange={(value) => onGridSpacingChange(value as number)}
                        options={[
                            { value: 24, label: "紧凑" },
                            { value: 48, label: "标准" },
                            { value: 96, label: "宽松" },
                        ]}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                            <Layers3 className="size-3.5" />
                            小地图
                        </span>
                        <Switch size="small" checked={minimapOpen} onChange={onToggleMinimap} />
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                            <Info className="size-3.5" />
                            图片信息
                        </span>
                        <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function ToolbarButton({ item, theme, activeStyle }: { item: ToolbarItem; theme: CanvasTheme; activeStyle: CSSProperties }) {
    return (
        <Tooltip title={item.shortcut ? `${item.label}（${item.shortcut}）` : item.label} placement="top" mouseEnterDelay={0.25}>
            <Button
                type="text"
                aria-label={item.label}
                className="!h-8 !w-8 !min-w-8 !p-0"
                disabled={item.disabled}
                style={item.active ? activeStyle : item.danger ? { color: "#f87171", opacity: item.disabled ? 0.35 : 1 } : { color: theme.toolbar.item, opacity: item.disabled ? 0.35 : 1 }}
                icon={item.icon}
                onClick={item.onClick}
            />
        </Tooltip>
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="mx-1 h-6 w-px" style={{ background: theme.toolbar.border }} />;
}

function CanvasThemeButton({ colorTheme, targetTheme, onThemeChange, children }: { colorTheme: CanvasColorTheme; targetTheme: CanvasColorTheme; onThemeChange: (theme: CanvasColorTheme) => void; children: ReactNode }) {
    const theme = canvasThemes[colorTheme];
    const active = colorTheme === targetTheme;
    const activeStyle = colorTheme === "light" ? { background: "#111111", color: "#ffffff" } : { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };

    return (
        <AnimatedThemeToggler
            theme={colorTheme}
            targetTheme={targetTheme}
            onThemeChange={onThemeChange}
            className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition"
            style={active ? activeStyle : { color: theme.toolbar.item }}
            aria-label={`切换到${targetTheme === "dark" ? "深色" : "浅色"}主题`}
            title={`切换到${targetTheme === "dark" ? "深色" : "浅色"}主题`}
        >
            {children}
        </AnimatedThemeToggler>
    );
}
