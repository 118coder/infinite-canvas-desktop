"use client";

import { useSyncExternalStore } from "react";

import type { ViewportTransform } from "../types";

export const INITIAL_VIEWPORT: ViewportTransform = { x: 0, y: 0, k: 1 };
// 裁剪刷新步长（屏幕像素）。视口裁剪本身带 280px 缓冲，160px 步进不会露出空白。
const CULL_STEP = 160;
const CULL_SCALE_RATIO = 0.12;

type StateListener = () => void;
type LiveListener = (viewport: ViewportTransform) => void;
type GestureListener = (active: boolean) => void;

let live: ViewportTransform = { ...INITIAL_VIEWPORT };
let committed: ViewportTransform = { ...INITIAL_VIEWPORT };
let liveTransform: ViewportTransform | null = null;
let cullKey = 0;
let gestureDepth = 0;
let appliedScale = Number.NaN;
let lastCull: ViewportTransform = { ...INITIAL_VIEWPORT };
let dom: { world: HTMLElement | null; grid: HTMLElement | null; gridSize: number } = { world: null, grid: null, gridSize: 48 };
let latestContainer: HTMLElement | null = null;

const stateListeners = new Set<StateListener>();
const liveListeners = new Set<LiveListener>();
const commitListeners = new Set<LiveListener>();
const gestureListeners = new Set<GestureListener>();

function emitState() {
    stateListeners.forEach((listener) => listener());
}

function bumpCull() {
    cullKey += 1;
    emitState();
}

function writeDom(next: ViewportTransform) {
    const scaleChanged = next.k !== appliedScale;
    if (dom.world) {
        dom.world.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.k})`;
        // 自定义属性是继承属性，每帧写会让整棵节点子树重新计算样式；只有缩放变化时才需要。
        if (scaleChanged) dom.world.style.setProperty("--canvas-inverse-scale", String(1 / next.k));
    }
    if (dom.grid) {
        const size = Math.max(dom.gridSize * next.k, 1);
        if (scaleChanged) dom.grid.style.backgroundSize = `${size}px ${size}px`;
        dom.grid.style.transform = `translate3d(${next.x % size}px, ${next.y % size}px, 0)`;
    }
    appliedScale = next.k;
}

function maybeBumpCull(next: ViewportTransform) {
    const moved = Math.abs(next.x - lastCull.x) > CULL_STEP || Math.abs(next.y - lastCull.y) > CULL_STEP;
    const zoomed = Math.abs(Math.log(Math.max(next.k, 0.001) / Math.max(lastCull.k, 0.001))) > CULL_SCALE_RATIO;
    if (moved || zoomed) {
        lastCull = next;
        bumpCull();
    }
}

function notifyLive(next: ViewportTransform) {
    liveListeners.forEach((listener) => listener(next));
}

function setGestureActive(active: boolean) {
    if (active) {
        if (dom.world) dom.world.style.pointerEvents = "none";
        latestContainer?.classList.add("canvas-gesture");
    } else {
        if (dom.world) dom.world.style.pointerEvents = "";
        latestContainer?.classList.remove("canvas-gesture");
    }
    gestureListeners.forEach((listener) => listener(active));
}

export const viewportStore = {
    getLive: () => live,
    getCommitted: () => committed,
    getLiveTransform: () => liveTransform,
    getCullKey: () => cullKey,
    isGestureActive: () => gestureDepth > 0,

    subscribe: (listener: StateListener) => {
        stateListeners.add(listener);
        return () => { stateListeners.delete(listener); };
    },
    subscribeLive: (listener: LiveListener) => {
        liveListeners.add(listener);
        return () => { liveListeners.delete(listener); };
    },
    onCommit: (listener: LiveListener) => {
        commitListeners.add(listener);
        return () => { commitListeners.delete(listener); };
    },
    onGestureChange: (listener: GestureListener) => {
        gestureListeners.add(listener);
        return () => { gestureListeners.delete(listener); };
    },

    registerDom(world: HTMLElement | null, grid: HTMLElement | null, gridSize: number) {
        dom = { world, grid, gridSize };
        latestContainer = world?.parentElement || null;
        appliedScale = Number.NaN;
        writeDom(liveTransform || committed);
    },
    setGridSize(gridSize: number) {
        dom.gridSize = gridSize;
        appliedScale = Number.NaN;
        writeDom(liveTransform || committed);
    },
    reapplyLive() {
        if (liveTransform) writeDom(liveTransform);
    },

    beginGesture() {
        gestureDepth += 1;
        if (gestureDepth === 1) setGestureActive(true);
    },
    endGesture() {
        gestureDepth = Math.max(0, gestureDepth - 1);
        if (gestureDepth === 0) setGestureActive(false);
    },

    /** 手势/动画期间唯一允许的视口更新：只写 DOM，不触发整页 React 渲染。 */
    applyLive(next: ViewportTransform) {
        live = next;
        liveTransform = next;
        writeDom(next);
        notifyLive(next);
        maybeBumpCull(next);
    },

    /** 手势结束或一次性外部命令：提交为 React 可读取的稳定值。 */
    commit(next: ViewportTransform) {
        committed = next;
        live = next;
        liveTransform = null;
        writeDom(next);
        lastCull = next;
        bumpCull();
        notifyLive(next);
        commitListeners.forEach((listener) => listener(next));
    },
    commitTransform(transform: (previous: ViewportTransform) => ViewportTransform) {
        viewportStore.commit(transform(committed));
    },

    /** 恢复项目视口，不触发持久化订阅。 */
    reset(next: ViewportTransform) {
        committed = next;
        live = next;
        liveTransform = null;
        writeDom(next);
        lastCull = next;
        bumpCull();
        notifyLive(next);
    },
};

export function useCommittedViewport() {
    return useSyncExternalStore(viewportStore.subscribe, viewportStore.getCommitted, viewportStore.getCommitted);
}

function getCommittedScale() {
    return committed.k;
}

export function useCommittedScale() {
    return useSyncExternalStore(viewportStore.subscribe, getCommittedScale, getCommittedScale);
}

export function useCullKey() {
    return useSyncExternalStore(viewportStore.subscribe, viewportStore.getCullKey, viewportStore.getCullKey);
}
