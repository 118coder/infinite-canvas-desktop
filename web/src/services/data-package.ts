import { saveAs } from "file-saver";
import localforage from "localforage";

import { useCanvasStore, type CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";

const DATA_PACKAGE_NAME = "data-package.json";
const IMAGE_LOG_STORE = "image_generation_logs";
const VIDEO_LOG_STORE = "video_generation_logs";
const LOG_DB_NAME = "infinite-canvas";

export type DataPackageFileEntry = { storageKey: string; path: string; mimeType: string; bytes: number };

export type DataPackage = {
    app: "infinite-canvas";
    kind: "data-package";
    version: 1;
    exportedAt: string;
    projects: CanvasProject[];
    assets: Asset[];
    config: AiConfig;
    skills: unknown[];
    imageLogs: { key: string; value: unknown }[];
    videoLogs: { key: string; value: unknown }[];
    files: DataPackageFileEntry[];
};

// 导出完整数据工程：画布项目、我的素材、应用配置（含本地渠道密钥）、本地 Agent Skill、
// 生图/视频工作台历史，以及它们引用的全部本地图片和媒体文件。
export async function exportDataPackage() {
    const projects = useCanvasStore.getState().projects;
    const assets = useAssetStore.getState().assets;
    const config = useConfigStore.getState().config;
    const skills = await loadLocalSkills();
    const imageLogs = await readStoreEntries(IMAGE_LOG_STORE);
    const videoLogs = await readStoreEntries(VIDEO_LOG_STORE);

    const storageKeys = new Set<string>();
    collectStorageKeys(projects, storageKeys);
    collectStorageKeys(assets, storageKeys);
    collectStorageKeys(skills, storageKeys);
    collectStorageKeys(imageLogs, storageKeys);
    collectStorageKeys(videoLogs, storageKeys);

    const zipFiles: { name: string; data: BlobPart }[] = [];
    const files: DataPackageFileEntry[] = [];
    for (const storageKey of storageKeys) {
        if (!storageKey.startsWith("image:") && !storageKey.startsWith("file:") && !storageKey.startsWith("video:")) continue;
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (!blob) continue;
        const path = `files/${safeFileName(storageKey)}`;
        files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
        zipFiles.push({ name: path, data: blob });
    }

    const data: DataPackage = {
        app: "infinite-canvas",
        kind: "data-package",
        version: 1,
        exportedAt: new Date().toISOString(),
        projects,
        assets,
        config,
        skills,
        imageLogs,
        videoLogs,
        files,
    };
    const zip = await createZip([{ name: DATA_PACKAGE_NAME, data: JSON.stringify(data) }, ...zipFiles]);
    saveAs(zip, `画布数据工程-${new Date().toISOString().slice(0, 10)}.zip`);
    return { projects: projects.length, assets: assets.length, files: files.length };
}

// 导入数据工程：按 id 合并画布与素材（同 id 覆盖、其余保留），整体替换应用配置与本地 Skill，
// 合并工作台历史记录，并恢复全部引用的本地文件。
const importTrace = (message: string) => {
    const host = window as unknown as { __importTrace?: string[] };
    host.__importTrace = host.__importTrace || [];
    host.__importTrace.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
};

export async function importDataPackage(file: File) {
    importTrace(`start ${file.name} ${file.size}`);
    const zip = await readZip(file);
    importTrace("zip read");
    const entry = zip.get(DATA_PACKAGE_NAME);
    if (!entry) throw new Error("不是有效的数据工程文件（缺少 data-package.json）");
    const data = JSON.parse(await entry.text()) as DataPackage;
    if (data.app !== "infinite-canvas" || data.kind !== "data-package") throw new Error("不是有效的数据工程文件");
    importTrace("json parsed");

    await Promise.all([
        waitForStoreHydration(useCanvasStore),
        waitForStoreHydration(useAssetStore),
        waitForStoreHydration(useConfigStore),
    ]);
    importTrace(`stores hydrated (canvas=${useCanvasStore.persist.hasHydrated()} assets=${useAssetStore.persist.hasHydrated()} config=${useConfigStore.persist.hasHydrated()})`);

    await Promise.all(
        (data.files || []).map(async (fileEntry) => {
            const blob = zip.get(fileEntry.path);
            if (!blob) return;
            const typed = blob.type ? blob : blob.slice(0, blob.size, fileEntry.mimeType || "application/octet-stream");
            await (fileEntry.storageKey.startsWith("image:") ? setImageBlob(fileEntry.storageKey, typed) : setMediaBlob(fileEntry.storageKey, typed));
        }),
    );
    importTrace(`files restored (${data.files?.length || 0})`);

    if (Array.isArray(data.projects)) {
        const canvasStore = useCanvasStore.getState();
        const currentProjects = canvasStore.projects;
        const importedIds = new Set(data.projects.map((project) => project.id));
        const merged = [...currentProjects.filter((project) => !importedIds.has(project.id)), ...data.projects].sort(
            (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
        );
        useCanvasStore.setState({ projects: merged });
        importTrace(`projects set (${merged.length})`);
    }

    if (Array.isArray(data.assets)) {
        const assetStore = useAssetStore.getState();
        const importedIds = new Set(data.assets.map((asset) => asset.id));
        const merged = [...assetStore.assets.filter((asset) => !importedIds.has(asset.id)), ...data.assets].sort(
            (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
        );
        useAssetStore.setState({ assets: merged });
        importTrace(`assets set (${merged.length})`);
    }

    if (data.config && typeof data.config === "object") {
        useConfigStore.setState({ config: { ...defaultConfig, ...data.config } });
        importTrace("config set");
    }

    if (Array.isArray(data.skills)) {
        await localforage.createInstance({ name: LOG_DB_NAME, storeName: "agent_skills" }).setItem("items", data.skills);
        await useAgentSkillStore.getState().loadSkills();
        importTrace("skills set");
    }

    const restoredLogs = await writeStoreEntries(IMAGE_LOG_STORE, data.imageLogs) + await writeStoreEntries(VIDEO_LOG_STORE, data.videoLogs);
    importTrace(`logs set (${restoredLogs})`);
    return { projects: data.projects?.length || 0, assets: data.assets?.length || 0, logs: restoredLogs };
}

// 调试句柄：在浏览器控制台可用 window.__importDebug 直接调用导入/导出
if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__importDebug = { importDataPackage, exportDataPackage };
}

async function waitForStoreHydration(store: { persist: { hasHydrated: () => boolean; onFinishHydration: (callback: () => void) => () => void } }) {
    if (store.persist.hasHydrated()) return;
    await new Promise<void>((resolve) => {
        const unsubscribe = store.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
    });
}

async function loadLocalSkills(): Promise<unknown[]> {
    try {
        const items = await localforage.createInstance({ name: LOG_DB_NAME, storeName: "agent_skills" }).getItem<unknown[]>("items");
        return Array.isArray(items) ? items : [];
    } catch {
        return [];
    }
}

async function readStoreEntries(storeName: string) {
    const entries: { key: string; value: unknown }[] = [];
    try {
        await localforage.createInstance({ name: LOG_DB_NAME, storeName }).iterate((value, key) => {
            entries.push({ key, value });
        });
    } catch {
        return [];
    }
    return entries;
}

async function writeStoreEntries(storeName: string, entries?: { key: string; value: unknown }[]) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const store = localforage.createInstance({ name: LOG_DB_NAME, storeName });
    await Promise.all(entries.map((entry) => store.setItem(entry.key, entry.value)));
    return entries.length;
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof (value as { storageKey?: unknown }).storageKey === "string" && (value as { storageKey: string }).storageKey.includes(":")) keys.add((value as { storageKey: string }).storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return keys;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}
