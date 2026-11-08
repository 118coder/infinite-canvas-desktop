import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { deleteImagePreviews } from "@/services/image-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";

export type CanvasSidePanelState = {
    open: boolean;
    width: number;
};

export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 280 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 464 };

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let forceSaveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
// 仅保留最近一次待写入的完整 value，序列化与落盘推迟到空闲时段执行。
let latestPersistValue: StorageValue<CanvasStore> | null = null;
let lastWrittenValue: StorageValue<CanvasStore> | null = null;
let lastWriteAt = 0;
// 读取失败后进入只读保护：禁止任何写入覆盖旧数据，直到刷新页面读取成功。
let loadFailed = false;
let lastFailureNoticeAt = 0;
// 连续操作会让防抖不断重置，超过该间隔必须强制落盘一次，避免长时间零写入。
const MAX_SAVE_DELAY_MS = 2000;
const WRITE_FAILURE_NOTICE_INTERVAL_MS = 30000;

export const CANVAS_STORAGE_ALERT_EVENT = "canvas-storage-alert";
export type CanvasStorageAlert = { kind: "write-failed" | "load-failed"; message: string };

function notifyStorageAlert(alert: CanvasStorageAlert) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<CanvasStorageAlert>(CANVAS_STORAGE_ALERT_EVENT, { detail: alert }));
}

function notifyWriteFailure() {
    const now = Date.now();
    if (now - lastFailureNoticeAt < WRITE_FAILURE_NOTICE_INTERVAL_MS) return;
    lastFailureNoticeAt = now;
    console.error("[canvas-store] 画布保存失败：浏览器存储空间不足或不可用，数据可能未落盘");
    notifyStorageAlert({ kind: "write-failed", message: "画布保存失败：浏览器存储空间不足或被限制，请尽快在「设置 → 数据工程」导出备份" });
}

function runPersistWrite(name: string) {
    if (!latestPersistValue || latestPersistValue === lastWrittenValue) return;
    if (forceSaveTimer) {
        clearTimeout(forceSaveTimer);
        forceSaveTimer = null;
    }
    const payload = JSON.stringify(latestPersistValue);
    lastWrittenValue = latestPersistValue;
    lastWriteAt = Date.now();
    void Promise.resolve(localForageStorage.setItem(name, payload)).catch(notifyWriteFailure);
}

// 在浏览器空闲时段执行写入，避免松手后的主线程抖顿。
function schedulePersistWrite(name: string, idleTimeout: number) {
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => runPersistWrite(name), { timeout: idleTimeout });
    } else {
        setTimeout(() => runPersistWrite(name), 0);
    }
}

function clearPersistTimers() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (forceSaveTimer) {
        clearTimeout(forceSaveTimer);
        forceSaveTimer = null;
    }
}

// 卸载兜底：页面隐藏/关闭前把未落盘的改动直接发起写入。
// IndexedDB 事务一旦开启不受页面卸载影响，这里只负责把事务尽早启动。
function flushPersistToStorage() {
    if (loadFailed || !latestPersistValue || latestPersistValue === lastWrittenValue) return;
    clearPersistTimers();
    void Promise.resolve(localForageStorage.setItem(CANVAS_STORE_KEY, JSON.stringify(latestPersistValue))).catch(notifyWriteFailure);
}

if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushPersistToStorage);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushPersistToStorage();
    });
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        let localValue: string | null = null;
        try {
            localValue = await localForageStorage.getItem(name);
        } catch {
            loadFailed = true;
            console.error("[canvas-store] 画布数据读取失败，已暂停保存以避免覆盖旧数据");
            notifyStorageAlert({ kind: "load-failed", message: "画布数据读取失败，已暂停自动保存以保护原有数据；请刷新页面重试，或从「设置 → 数据工程」导出恢复" });
            return null;
        }
        if (!localValue) return null;
        try {
            const parsed = JSON.parse(localValue) as StorageValue<CanvasStore>;
            if (!parsed?.state || !Array.isArray(parsed.state.projects)) throw new Error("结构异常");
            loadFailed = false;
            return parsed;
        } catch {
            loadFailed = true;
            console.error("[canvas-store] 画布数据解析失败，已暂停保存以避免覆盖旧数据");
            notifyStorageAlert({ kind: "load-failed", message: "画布数据解析失败，已暂停自动保存以保护原有数据；请勿新建画布，并从「设置 → 数据工程」尝试恢复" });
            return null;
        }
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) {
            return;
        }
        if (loadFailed) return;
        queuedPersistState = nextState;
        // 定时器只负责调度，不在此做序列化 / 落盘。
        latestPersistValue = value;
        const overdue = Date.now() - lastWriteAt >= MAX_SAVE_DELAY_MS;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            // 防抖到期后让出主线程，在浏览器空闲时段再序列化并写入。
            schedulePersistWrite(name, overdue ? 200 : 1000);
        }, overdue ? 0 : 400);
        // 防抖被连续操作不断重置时，用最长写入间隔兜底强制落盘。
        if (!overdue && !forceSaveTimer) {
            forceSaveTimer = setTimeout(() => {
                forceSaveTimer = null;
                schedulePersistWrite(name, 500);
            }, MAX_SAVE_DELAY_MS - (Date.now() - lastWriteAt));
        }
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                    sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: options?.pendingAgentRequest ? { ...DEFAULT_CANVAS_AGENT_PANEL, open: true } : DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: (source.chatSessions || []).map((session) => ({ ...session, codexThreadId: undefined, codexServiceId: undefined })),
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: source.agentPanel || DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                return project.id;
            },
            openProject: (id) =>
                get().projects.find((item) => item.id === id) || null,
            renameProject: (id, title) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    title: title.trim() || project.title,
                    autoTitlePending: false,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
            },
            deleteProjects: (ids) => {
                void deleteImagePreviews(
                    get().projects
                        .filter((project) => ids.includes(project.id))
                        .flatMap((project) => project.nodes.map((node) => `canvas-node:${project.id}:${node.id}`)),
                );
                set((state) => ({
                    projects: state.projects.filter(
                        (project) => !ids.includes(project.id),
                    ),
                }));
            },
            updateProject: (id, patch) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

// 整体替换项目列表（数据工程导入用）。
// 关键点：先取消 pending 的防抖保存，否则旧的 in-memory 状态会在 400ms 后把刚导入的数据盖掉。
export function replaceCanvasProjects(projects: CanvasProject[]) {
    clearPersistTimers();
    queuedPersistState = null;
    useCanvasStore.setState({ projects });
}

// 立即落盘画布项目，不走 400ms 防抖，导入后立刻 reload 也不会丢数据。
export async function persistCanvasProjectsNow(projects?: CanvasProject[]) {
    const next = projects || useCanvasStore.getState().projects;
    clearPersistTimers();
    queuedPersistState = null;
    const value = { state: { projects: next }, version: 0 } as StorageValue<CanvasStore>;
    lastWrittenValue = value;
    lastWriteAt = Date.now();
    await localForageStorage.setItem(CANVAS_STORE_KEY, JSON.stringify(value));
}
