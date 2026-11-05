"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "../types";
import type { CanvasAlignmentGuides } from "../utils/canvas-alignment";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    gridSize?: number;
    alignmentGuides?: CanvasAlignmentGuides;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    /** 视口层的浮层（空画布引导等），不随缩放平移 */
    overlay?: React.ReactNode;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewport, tool, backgroundMode = "lines", gridSize = 48, alignmentGuides = {}, onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, overlay, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
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
    const scaleRef = useRef(viewport.k);
    const worldRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);
    // 手势（平移/滚轮缩放）期间的实时 transform：直接写 DOM，state 只在手势结束后提交。
    // 中途任何 React 重渲染都会把手势 transform 覆盖回旧 state，造成“画面瞬移回退一帧”的刷新感，
    // 所以每次渲染后用 layout effect 把最新手势 transform 重新套回去。
    const liveTransformRef = useRef<ViewportTransform | null>(null);
    const wheelGestureRef = useRef<ViewportTransform | null>(null);
    const wheelCommitTimerRef = useRef<number | null>(null);
    const wheelFrameRef = useRef<number | null>(null);
    const viewportPropRef = useRef(viewport);
    const gestureStartViewportRef = useRef<ViewportTransform>(viewport);
    viewportPropRef.current = viewport;

    useEffect(() => {
        scaleRef.current = viewport.k;
    }, [viewport.k]);

    // 手势进行中：渲染后重新套用最新手势 transform，避免重渲染把 DOM 打回旧 state；
    // 手势已结束或被外部提交（适应全部节点、聚焦节点等）打断：清掉 live 记录，让外部值生效
    useLayoutEffect(() => {
        if (panState.current.isPanning) {
            const live = liveTransformRef.current;
            if (live) applyViewportTransform(live, worldRef.current, gridRef.current, gridSizeRef.current);
            return;
        }
        if (wheelGestureRef.current) {
            if (viewportPropRef.current !== gestureStartViewportRef.current) {
                cancelWheelGesture();
                liveTransformRef.current = null;
                return;
            }
            const live = liveTransformRef.current;
            if (live) applyViewportTransform(live, worldRef.current, gridRef.current, gridSizeRef.current);
            return;
        }
        liveTransformRef.current = null;
    });

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (wheelFrameRef.current) cancelAnimationFrame(wheelFrameRef.current);
            if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
            // 失焦打断平移时把已发生的位移提交给 state，避免 DOM 与 state 脱节
            if (nextViewportRef.current) {
                applyLiveTransform(nextViewportRef.current);
                onViewportChange(nextViewportRef.current);
                nextViewportRef.current = null;
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    const applyLiveTransform = (next: ViewportTransform) => {
        liveTransformRef.current = next;
        applyViewportTransform(next, worldRef.current, gridRef.current, gridSizeRef.current);
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
    };

    // 滚轮手势尚未提交时立刻把结果交给 state：开始平移前、或手势需要让位给外部操作时调用
    const flushPendingWheel = () => {
        const pending = wheelGestureRef.current;
        if (!pending) return;
        cancelWheelGesture();
        liveTransformRef.current = pending;
        onViewportChange(pending);
    };

    const handleWheel = (event: React.WheelEvent<HTMLDivElement> | WheelEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (event instanceof WheelEvent) {
            if (!event.ctrlKey || !containerRef.current?.contains(target)) return;
            event.preventDefault();
            event.stopPropagation();
        } else if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        // 缩放手势期间只写 DOM 不进 state：每个滚轮事件都 setState 会让整棵画布树（含全部节点）重渲染，
        // 大画布下明显卡顿；停手 140ms 后一次性提交，节点反缩放面板靠 --canvas-inverse-scale 跟随。
        const live = wheelGestureRef.current || liveTransformRef.current || viewport;
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

        if (!wheelGestureRef.current) gestureStartViewportRef.current = viewportPropRef.current;
        wheelGestureRef.current = next;
        scaleRef.current = newScale;
        if (!wheelFrameRef.current) {
            wheelFrameRef.current = requestAnimationFrame(() => {
                wheelFrameRef.current = null;
                const pending = wheelGestureRef.current;
                if (pending) applyLiveTransform(pending);
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
            const live = liveTransformRef.current || viewport;
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: live.x,
                initialY: live.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
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

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;
            if (event.buttons === 0) {
                panState.current.isPanning = false;
                setIsPanning(false);
                document.body.style.cursor = "";
                return;
            }
            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                // 拖动画布时直接写 transform，只做一次合成，不触发 React 重渲染；
                // 抬手时再把最终 viewport 提交给上层，十几张 4K 图也不会掉帧。
                if (nextViewportRef.current) applyLiveTransform(nextViewportRef.current);
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
            if (nextViewportRef.current) {
                applyLiveTransform(nextViewportRef.current);
                onViewportChange(nextViewportRef.current);
                nextViewportRef.current = null;
            }
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        document.addEventListener("wheel", handleWheel, { capture: true, passive: false });
        return () => {
            container.removeEventListener("wheel", preventWheelScroll);
            document.removeEventListener("wheel", handleWheel, true);
        };
    }, [containerRef, handleWheel]);

    const temporaryTool = isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className={`relative h-full w-full select-none overflow-hidden ${activeTool === "pan" || isPanning ? "[&_*]:!cursor-[inherit]" : ""}`}
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={activeTool === "pan" ? undefined : handlePointerDown}
            onPointerDownCapture={activeTool === "pan" ? handlePointerDown : undefined}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
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
                style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`, willChange: "transform", "--canvas-inverse-scale": 1 / viewport.k } as React.CSSProperties}
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

    const size = gridSize * viewport.k;
    const x = viewport.x % size;
    const y = viewport.y % size;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    // 用 transform 位移替代 background-position：后者每帧都要重绘整块背景，
    // 前者只是图层合成，平移时不会和节点抢渲染线程。
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

// 平移/缩放手势期间直接改 DOM 样式，避免每帧 setState 触发整棵画布树重渲染
function applyViewportTransform(next: ViewportTransform, world: HTMLElement | null, grid: HTMLElement | null, gridSize: number) {
    if (world) {
        world.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.k})`;
        world.style.setProperty("--canvas-inverse-scale", String(1 / next.k));
    }
    if (grid) {
        const size = gridSize * next.k;
        grid.style.backgroundSize = `${size}px ${size}px`;
        grid.style.transform = `translate3d(${next.x % size}px, ${next.y % size}px, 0)`;
    }
}
