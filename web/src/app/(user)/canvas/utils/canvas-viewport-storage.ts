import { localForageStorage } from "@/lib/localforage-storage";
import type { ViewportTransform } from "../types";

const KEY_PREFIX = "infinite-canvas:viewport:";
const SAVE_DELAY = 500;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, ViewportTransform>();

/** 视口单独存放，避免每次平移/缩放都重写整个项目对象并序列化全部 projects。 */
export async function loadViewport(projectId: string): Promise<ViewportTransform | null> {
    try {
        const raw = await localForageStorage.getItem(`${KEY_PREFIX}${projectId}`);
        if (!raw) return null;
        const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<ViewportTransform> | null;
        if (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.k) && (value.k as number) > 0) {
            return { x: value.x as number, y: value.y as number, k: value.k as number };
        }
    } catch {
        // 旧数据或存储不可用时回退项目内的视口。
    }
    return null;
}

export function scheduleViewportSave(projectId: string, viewport: ViewportTransform) {
    pending.set(projectId, viewport);
    const existing = timers.get(projectId);
    if (existing) clearTimeout(existing);
    timers.set(projectId, setTimeout(() => {
        timers.delete(projectId);
        const value = pending.get(projectId);
        pending.delete(projectId);
        if (!value) return;
        const write = () => {
            void Promise.resolve(localForageStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify(value))).catch(() => undefined);
        };
        if (typeof requestIdleCallback === "function") requestIdleCallback(write, { timeout: 1000 });
        else setTimeout(write, 0);
    }, SAVE_DELAY));
}
