"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";
import { useCommittedViewport, viewportStore } from "../stores/use-viewport-store";

const MINIMAP_WIDTH = 240;
const MINIMAP_HEIGHT = 160;

export function Minimap({ nodes, viewportSize }: { nodes: CanvasNodeData[]; viewportSize: { width: number; height: number } }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewportRectRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ active: boolean; frame: number | null; pending: ViewportTransform | null; gestureStarted: boolean }>({ active: false, frame: null, pending: null, gestureStarted: false });
    const viewport = useCommittedViewport();

    const { worldBounds, scale, offset } = useMemo(() => {
        if (!nodes.length) {
            return { worldBounds: { x: -500, y: -500, w: 1000, h: 1000 }, scale: 0.16, offset: { x: 40, y: 0 } };
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        nodes.forEach((node) => {
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x + node.width);
            maxY = Math.max(maxY, node.position.y + node.height);
        });

        minX -= 500;
        minY -= 500;
        maxX += 500;
        maxY += 500;

        const boundsWidth = maxX - minX;
        const boundsHeight = maxY - minY;
        const nextScale = Math.min(MINIMAP_WIDTH / boundsWidth, MINIMAP_HEIGHT / boundsHeight);
        const mapContentW = boundsWidth * nextScale;
        const mapContentH = boundsHeight * nextScale;

        return {
            worldBounds: { x: minX, y: minY, w: boundsWidth, h: boundsHeight },
            scale: nextScale,
            offset: { x: (MINIMAP_WIDTH - mapContentW) / 2, y: (MINIMAP_HEIGHT - mapContentH) / 2 },
        };
    }, [nodes]);

    const toMinimap = useCallback(
        (worldX: number, worldY: number) => ({
            x: (worldX - worldBounds.x) * scale + offset.x,
            y: (worldY - worldBounds.y) * scale + offset.y,
        }),
        [offset.x, offset.y, scale, worldBounds.x, worldBounds.y],
    );

    const toWorld = useCallback(
        (minimapX: number, minimapY: number) => ({
            x: (minimapX - offset.x) / scale + worldBounds.x,
            y: (minimapY - offset.y) / scale + worldBounds.y,
        }),
        [offset.x, offset.y, scale, worldBounds.x, worldBounds.y],
    );

    const viewportRect = useMemo(() => {
        const vx = -viewport.x / viewport.k;
        const vy = -viewport.y / viewport.k;
        const vw = viewportSize.width / viewport.k;
        const vh = viewportSize.height / viewport.k;
        const p1 = toMinimap(vx, vy);
        const p2 = toMinimap(vx + vw, vy + vh);
        return { x: p1.x, y: p1.y, w: Math.max(p2.x - p1.x, 4), h: Math.max(p2.y - p1.y, 4) };
    }, [toMinimap, viewport.k, viewport.x, viewport.y, viewportSize.height, viewportSize.width]);

    // 手势期间视口矩形直接改 DOM，不触发 React 重渲染。
    useEffect(() => {
        const element = viewportRectRef.current;
        if (!element) return;
        return viewportStore.subscribeLive((next) => {
            const vx = -next.x / next.k;
            const vy = -next.y / next.k;
            const p1 = toMinimap(vx, vy);
            const p2 = toMinimap(vx + viewportSize.width / next.k, vy + viewportSize.height / next.k);
            element.style.left = `${p1.x}px`;
            element.style.top = `${p1.y}px`;
            element.style.width = `${Math.max(p2.x - p1.x, 4)}px`;
            element.style.height = `${Math.max(p2.y - p1.y, 4)}px`;
        });
    }, [toMinimap, viewportSize.height, viewportSize.width]);

    // 所有节点一次性画进单个 canvas，避免几百个 div 在每次视口提交时被重新协调。
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = globalThis.devicePixelRatio || 1;
        canvas.width = MINIMAP_WIDTH * dpr;
        canvas.height = MINIMAP_HEIGHT * dpr;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
        context.globalAlpha = 0.8;
        nodes.forEach((node) => {
            const pos = toMinimap(node.position.x, node.position.y);
            context.fillStyle = isCanvasImageNodeType(node.type) ? "#10b981" : node.type === CanvasNodeType.Video ? "#f97316" : node.type === CanvasNodeType.Audio ? "#a855f7" : node.type === CanvasNodeType.Config ? "#60a5fa" : theme.node.muted;
            context.fillRect(pos.x, pos.y, Math.max(node.width * scale, 2), Math.max(node.height * scale, 2));
        });
    }, [nodes, offset.x, offset.y, scale, theme, toMinimap]);

    useEffect(() => () => {
        if (dragRef.current.frame) cancelAnimationFrame(dragRef.current.frame);
        if (dragRef.current.gestureStarted) viewportStore.endGesture();
    }, []);

    const computeNext = (clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const world = toWorld(clientX - rect.left, clientY - rect.top);
        const k = viewportStore.getLive().k;
        return { x: viewportSize.width / 2 - world.x * k, y: viewportSize.height / 2 - world.y * k, k };
    };

    const endDrag = () => {
        const state = dragRef.current;
        if (state.frame) {
            cancelAnimationFrame(state.frame);
            state.frame = null;
        }
        const final = state.pending;
        state.pending = null;
        state.active = false;
        if (state.gestureStarted) {
            state.gestureStarted = false;
            viewportStore.endGesture();
        }
        if (final) viewportStore.commit(final);
    };

    return (
        <div className="absolute bottom-24 left-6 z-50 overflow-hidden rounded-lg border shadow-2xl backdrop-blur-sm" style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT, background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            <div
                ref={containerRef}
                className="relative h-full w-full cursor-crosshair"
                onPointerDown={(event) => {
                    const next = computeNext(event.clientX, event.clientY);
                    if (!next) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const state = dragRef.current;
                    state.active = true;
                    state.pending = next;
                    state.gestureStarted = true;
                    viewportStore.beginGesture();
                    viewportStore.applyLive(next);
                }}
                onPointerMove={(event) => {
                    const state = dragRef.current;
                    if (!state.active) return;
                    const next = computeNext(event.clientX, event.clientY);
                    if (!next) return;
                    state.pending = next;
                    if (state.frame) return;
                    state.frame = requestAnimationFrame(() => {
                        state.frame = null;
                        if (state.pending) viewportStore.applyLive(state.pending);
                    });
                }}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerLeave={endDrag}
            >
                <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }} />
                <div ref={viewportRectRef} className="pointer-events-none absolute border" style={{ left: viewportRect.x, top: viewportRect.y, width: viewportRect.w, height: viewportRect.h, borderColor: theme.node.activeStroke, background: `${theme.node.activeStroke}18` }} />
            </div>
        </div>
    );
}
