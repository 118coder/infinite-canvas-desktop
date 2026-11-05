"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "../types";
import type { CanvasAlignmentGuides } from "../utils/canvas-alignment";
import { useCommittedViewport, viewportStore } from "../stores/use-viewport-store";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    gridSize?: number;
    alignmentGuides?: CanvasAlignmentGuides;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    /** 视口层的浮层（空画布引导等），不随缩放平移 */
    overlay?: React.ReactNode;
    children: React.ReactNode;
};

type GestureHandlers = {
    pointerMove: (event: PointerEvent) => void;
    pointerUp: () => void;
    wheel: (event: React.WheelEvent<HTMLDivElement> | WheelEvent) => void;
    blur: () => void;
};

export function InfiniteCanvas({ containerRef, tool, backgroundMode = "lines", gridSize = 48, alignmentGuides = {}, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, overlay, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const viewport = useCommittedViewport();
    const gridSizeRef = useRef(gridSize);
    gridSizeRef.current = gridSize;
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const worldRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const wheelGestureRef = useRef<ViewportTransform | null>(null);
    const wheelCommitTimerRef = useRef<number | null>(null);
    const wheelFrameRef = useRef<number | null>(null);
    const wheelActiveRef = useRef(false);
    const panActiveRef = useRef(false);
    const deselectRef = useRef(onCanvasDeselect);
    deselectRef.current = onCanvasDeselect;

    // 所有全局监听只挂载一次；处理器放在 ref 里，避免父组件重渲染时反复拆装监听器。
    const handlersRef = useRef<GestureHandlers>({
        pointerMove: () => undefined,
        pointerUp: () => undefined,
        wheel: () => undefined,
        blur: () => undefined,
    });

    const startWheelGesture = () => {
        if (wheelActiveRef.current) return;
        wheelActiveRef.current = true;
        viewportStore.beginGesture();
    };
    const stopWheelGesture = () => {
        if (!wheelActiveRef.current) return;
        wheelActiveRef.current = false;
        viewportStore.endGesture();
    };
    const startPanGesture = () => {
        if (panActiveRef.current) return;
        panActiveRef.current = true;
        viewportStore.beginGesture();
    };
    const stopPanGesture = () => {
        if (!panActiveRef.current) return;
        panActiveRef.current = false;
        viewportStore.endGesture();
    };

    const cancelWheelGesture = () => {
        if (wheelCommitTimerRef.current) {
            clearTimeout(wheelCommitTimerRef.current);
            wheelCommitTimerRef.current = null;
        }
        if (wheelFrameRef.current) {
            cancelAnimationFrame(wheelFrameRef.current);
            wheelFrameRef.current = null;
        }
        wheelGestureRef.current = null;
        stopWheelGesture();
    };

    // 滚轮手势尚未提交时立刻把结果交给 store：开始平移前、或手势需要让位给外部操作时调用
    const flushPendingWheel = () => {
        const pending = wheelGestureRef.current;
        if (!pending) return;
        if (wheelCommitTimerRef.current) {
            clearTimeout(wheelCommitTimerRef.current);
            wheelCommitTimerRef.current = null;
        }
        if (wheelFrameRef.current) {
            cancelAnimationFrame(wheelFrameRef.current);
            wheelFrameRef.current = null;
        }
        wheelGestureRef.current = null;
        stopWheelGesture();
        viewportStore.commit(pending);
    };

    const handleWheel: GestureHandlers["wheel"] = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (event instanceof WheelEvent) {
            if (!event.ctrlKey || !containerRef.current?.contains(target)) return;
            event.preventDefault();
            event.stopPropagation();
        } else if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        // 缩放手势期间只写 DOM 不进 React state：停手 140ms 后一次性提交。
        const live = viewportStore.getLive();
        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(live.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - live.x) / live.k;
        const worldY = (mouseY - live.y) / live.k;
        const next = { x: mouseX - worldX * newScale, y: mouseY - worldY * newScale, k: newScale };

        wheelGestureRef.current = next;
        startWheelGesture();
        if (!wheelFrameRef.current) {
            wheelFrameRef.current = requestAnimationFrame(() => {
                wheelFrameRef.current = null;
                const pending = wheelGestureRef.current;
                if (pending) viewportStore.applyLive(pending);
            });
        }
        if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = window.setTimeout(() => {
            wheelCommitTimerRef.current = null;
            flushPendingWheel();
        }, 140);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        const temporaryTool = isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan");
        if (activeTool === "pan" && (!target || !event.currentTarget.contains(target))) return;
        if (target?.closest("[data-canvas-no-zoom]") && activeTool !== "pan") return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        if (event.button === 0 && isBackgroundClick && document.activeElement instanceof HTMLElement && (document.activeElement.isContentEditable || document.activeElement instanceof HTMLMediaElement)) document.activeElement.blur();

        if (shouldPan) {
            event.preventDefault();
            if (activeTool === "pan") event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            flushPendingWheel();
            const live = viewportStore.getLive();
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: live.x,
                initialY: live.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            startPanGesture();
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id],[data-connection-create-menu]")) return;
        onCanvasDoubleClick?.(event);
    };

    handlersRef.current.pointerMove = (event: PointerEvent) => {
        if (!panState.current.isPanning) return;
        if (event.buttons === 0) {
            handlersRef.current.pointerUp();
            return;
        }
        const dx = event.clientX - panState.current.startX;
        const dy = event.clientY - panState.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.current.hasMoved = true;

        nextViewportRef.current = {
            x: panState.current.initialX + dx,
            y: panState.current.initialY + dy,
            k: viewportStore.getLive().k,
        };
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            // 拖动画布时只写 world / grid 的 transform，一帧一次合成，不触发任何 React 渲染。
            if (nextViewportRef.current) viewportStore.applyLive(nextViewportRef.current);
        });
    };

    handlersRef.current.pointerUp = () => {
        if (!panState.current.isPanning) return;
        if (!panState.current.hasMoved && panState.current.startedOnBackground) deselectRef.current?.();
        panState.current.isPanning = false;
        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        stopPanGesture();
        if (nextViewportRef.current) {
            const next = nextViewportRef.current;
            nextViewportRef.current = null;
            viewportStore.commit(next);
        }
    };

    handlersRef.current.blur = () => {
        if (panState.current.isPanning) handlersRef.current.pointerUp();
    };
    handlersRef.current.wheel = handleWheel;

    useLayoutEffect(() => {
        viewportStore.registerDom(worldRef.current, gridRef.current, gridSizeRef.current);
    }, []);

    useLayoutEffect(() => {
        // 手势中任何 React 重渲染都会把 world 的 transform 打回旧的 committed 值，
        // 渲染后立刻补写 live transform，避免画面瞬移回退一帧。
        viewportStore.reapplyLive();
    });

    useEffect(() => {
        viewportStore.setGridSize(gridSize);
    }, [gridSize]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };
        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
            setIsSpacePressed(false);
        };
        const onBlur = () => handlersRef.current.blur();
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", onBlur);
        };
    }, []);

    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => handlersRef.current.pointerMove(event);
        const onPointerUp = () => handlersRef.current.pointerUp();
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerUp);
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (wheelFrameRef.current) cancelAnimationFrame(wheelFrameRef.current);
            if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
        };
    }, []);

    useEffect(() => {
        // 外部操作（适应全部节点、聚焦节点、小地图等）提交时，放弃尚未落地的滚轮手势。
        const offCommit = viewportStore.onCommit(() => cancelWheelGesture());
        return () => {
            offCommit();
            // 页面卸载或切换项目时不能留下未结束的手势，否则预览队列会一直被门控住。
            while (viewportStore.isGestureActive()) viewportStore.endGesture();
        };
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        const onDocumentWheel = (event: WheelEvent) => handlersRef.current.wheel(event);
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        document.addEventListener("wheel", onDocumentWheel, { capture: true, passive: false });
        return () => {
            container.removeEventListener("wheel", preventWheelScroll);
            document.removeEventListener("wheel", onDocumentWheel, true);
        };
    }, [containerRef]);

    const onWheelReact = useCallback((event: React.WheelEvent<HTMLDivElement>) => handlersRef.current.wheel(event), []);
    const temporaryTool = isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;

    return (
        <div
            ref={containerRef}
            className={`relative h-full w-full select-none overflow-hidden ${activeTool === "pan" ? "canvas-pan-tool" : ""}`}
            style={{ background: theme.canvas.background, cursor: activeTool === "pan" ? "grab" : undefined }}
            onPointerDown={activeTool === "pan" ? undefined : handlePointerDown}
            onPointerDownCapture={activeTool === "pan" ? handlePointerDown : undefined}
            onDoubleClick={handleDoubleClick}
            onWheel={onWheelReact}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} gridSize={gridSize} gridRef={gridRef} />
            {typeof alignmentGuides.vertical === "number" ? (
                <div
                    className="pointer-events-none absolute inset-y-0 z-[90] w-px opacity-[.48]"
                    style={{
                        left: viewport.x + alignmentGuides.vertical * viewport.k,
                        backgroundImage: `repeating-linear-gradient(to bottom, ${theme.canvas.selectionStroke} 0 5px, transparent 5px 10px)`,
                    }}
                />
            ) : null}
            {typeof alignmentGuides.horizontal === "number" ? (
                <div
                    className="pointer-events-none absolute inset-x-0 z-[90] h-px opacity-[.48]"
                    style={{
                        top: viewport.y + alignmentGuides.horizontal * viewport.k,
                        backgroundImage: `repeating-linear-gradient(to right, ${theme.canvas.selectionStroke} 0 5px, transparent 5px 10px)`,
                    }}
                />
            ) : null}
            <div
                ref={worldRef}
                className="absolute origin-top-left"
                style={{ transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k})`, willChange: "transform", "--canvas-inverse-scale": 1 / viewport.k } as React.CSSProperties}
            >
                {children}
            </div>
            {overlay}
        </div>
    );
}

function CanvasGrid({ viewport, mode, gridSize, gridRef }: { viewport: ViewportTransform; mode: CanvasBackgroundMode; gridSize: number; gridRef?: React.RefObject<HTMLDivElement | null> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const size = Math.max(gridSize * viewport.k, 1);
    const x = viewport.x % size;
    const y = viewport.y % size;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    // 用 transform 位移替代 background-position：后者每帧都要重绘整块背景。
    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-40">
            <div
                ref={gridRef}
                style={{
                    position: "absolute",
                    inset: "-340px",
                    backgroundImage,
                    backgroundSize: `${size}px ${size}px`,
                    transform: `translate3d(${x}px, ${y}px, 0)`,
                    willChange: "transform",
                }}
            />
        </div>
    );
}
