import type { InsertAssetPayload } from "@/app/(user)/canvas/types";

const LAST_CANVAS_ID_KEY = "infinite-canvas:last-canvas-id";
const PENDING_INSERT_KEY = "infinite-canvas:pending-canvas-insert";
const PENDING_INSERT_TTL_MS = 24 * 60 * 60 * 1000;

export function rememberCanvasId(projectId: string) {
    try {
        window.localStorage.setItem(LAST_CANVAS_ID_KEY, projectId);
    } catch {
        // 忽略不可用存储，功能退化为“请在画布中操作”
    }
}

export function lastCanvasId(): string | null {
    try {
        return window.localStorage.getItem(LAST_CANVAS_ID_KEY);
    } catch {
        return null;
    }
}

type PendingCanvasInsert = { projectId: string; payloads: InsertAssetPayload[]; createdAt: number };

// “我的素材”页发起：把待插入素材排队，然后跳到最近打开的画布
export function requestCanvasInsert(payloads: InsertAssetPayload[]): { ok: boolean; projectId: string | null } {
    const projectId = lastCanvasId();
    if (!projectId) return { ok: false, projectId: null };
    const pending: PendingCanvasInsert = { projectId, payloads, createdAt: Date.now() };
    try {
        window.localStorage.setItem(PENDING_INSERT_KEY, JSON.stringify(pending));
    } catch {
        return { ok: false, projectId };
    }
    return { ok: true, projectId };
}

// 画布页消费：打开对应画布时取出待插入素材；不匹配或过期则丢弃，避免旧数据滞留
export function consumePendingCanvasInsert(projectId: string): InsertAssetPayload[] | null {
    try {
        const raw = window.localStorage.getItem(PENDING_INSERT_KEY);
        if (!raw) return null;
        window.localStorage.removeItem(PENDING_INSERT_KEY);
        const pending = JSON.parse(raw) as PendingCanvasInsert;
        if (!pending || pending.projectId !== projectId || !Array.isArray(pending.payloads) || !pending.payloads.length) return null;
        if (!pending.createdAt || Date.now() - pending.createdAt > PENDING_INSERT_TTL_MS) return null;
        return pending.payloads;
    } catch {
        return null;
    }
}
