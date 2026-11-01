import { saveAs } from "file-saver";
import localforage from "localforage";

import { useCanvasStore, type CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { getImageBlob, setImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";

const DATA_PACKAGE_NAME = "data-package.json";
const IMAGE_LOG_STORE = "image_generation_logs";
const VIDEO_LOG_STORE = "video_generation_logs";
const LOG_DB_NAME = "infinite-canvas";
const CANVAS_STORE_IDB = "infinite-canvas";
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const CANVAS_LS_KEY = "infinite-canvas:ai_config_store";

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

    const pkg: DataPackage = {
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
    const zip = await createZip([{ name: DATA_PACKAGE_NAME, data: JSON.stringify(pkg) }, ...zipFiles]);
    saveAs(zip, `画布数据工程-${new Date().toISOString().slice(0, 10)}.zip`);
    return { projects: projects.length, assets: assets.length, files: files.length };
}

// 导入数据工程：绕过 zustand store 直接写持久层（避免大 JSON 卡死主线程），
// 把 base64 大图转为本地 blob 存储，恢复 blob 后修正旧会话死链接，最后刷新页面。
export async function importDataPackage(file: File): Promise<{ projects: number; assets: number; logs: number }> {
    const zip = await readZip(file);
    const entry = zip.get(DATA_PACKAGE_NAME);
    if (!entry) throw new Error("不是有效的数据工程文件（缺少 data-package.json）");
    const data = JSON.parse(await entry.text()) as DataPackage;
    if (data.app !== "infinite-canvas" || data.kind !== "data-package") throw new Error("不是有效的数据工程文件");

    // 1. 恢复引用的图片和媒体 blob 到本地存储
    await Promise.all(
        (data.files || []).map(async (fileEntry) => {
            const blob = zip.get(fileEntry.path);
            if (!blob) return;
            const typed = blob.type ? blob : blob.slice(0, blob.size, fileEntry.mimeType || "application/octet-stream");
            await (fileEntry.storageKey.startsWith("image:") ? setImageBlob(fileEntry.storageKey, typed) : setMediaBlob(fileEntry.storageKey, typed));
        }),
    );

    // 2. 修正节点 content：把旧会话死链接替换为新地址，base64 大图转为本地存储
    const projects = (data.projects || []).map((project) => ({
        ...project,
        nodes: (project.nodes || []).map((node) => ({ ...node, metadata: fixNodeMetadata(node.metadata) })),
    }));

    // 3. 修正素材 content
    const assets = (data.assets || []).map((asset) => ({ ...asset }));

    // 4. 直接写画布项目到 IndexedDB（绕过 zustand 避免 28MB JSON.stringify 卡死）
    const existingProjects = await readCanvasProjectsFromIdb();
    const importedIds = new Set(projects.map((p) => p.id));
    const mergedProjects = [...existingProjects.filter((p) => !importedIds.has(p.id)), ...projects].sort(
        (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
    );
    await writeCanvasProjectsToIdb(mergedProjects);

    // 5. 直接写素材到 IndexedDB
    if (Array.isArray(data.assets) && data.assets.length) {
        const assetStore = useAssetStore.getState();
        const importedAssetIds = new Set(assets.map((a) => a.id));
        const mergedAssets = [...assetStore.assets.filter((a) => !importedAssetIds.has(a.id)), ...assets].sort(
            (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
        );
        useAssetStore.setState({ assets: mergedAssets });
    }

    // 6. 直接写配置到 localStorage
    if (data.config && typeof data.config === "object") {
        const merged = { ...defaultConfig, ...data.config };
        localStorage.setItem(CANVAS_LS_KEY, JSON.stringify({ state: { config: merged }, version: 0 }));
    }

    // 7. 恢复本地 Skill
    if (Array.isArray(data.skills) && data.skills.length) {
        await localforage.createInstance({ name: LOG_DB_NAME, storeName: "agent_skills" }).setItem("items", data.skills);
    }

    // 8. 恢复生成历史
    const logsWritten = await writeStoreEntries(IMAGE_LOG_STORE, data.imageLogs) + await writeStoreEntries(VIDEO_LOG_STORE, data.videoLogs);

    return { projects: projects.length, assets: assets.length, logs: logsWritten };
}

// 修正节点 metadata：死 blob 链接 → 新地址，base64 大图 → 本地存储
async function fixNodeMetadata(metadata: CanvasProject["nodes"][number]["metadata"]): Promise<CanvasProject["nodes"][number]["metadata"]> {
    if (!metadata) return metadata;
    const content = metadata.content;
    if (!content) return metadata;
    const sk = metadata.storageKey;

    // base64 大图 → 上传到本地 IndexedDB 并用 fresh blob URL 替换
    if (content.startsWith("data:image/") && content.length > 10000) {
        try {
            const stored = await uploadImage(content, { localOnly: true });
            return { ...metadata, content: stored.url, storageKey: stored.storageKey, bytes: stored.bytes, mimeType: stored.mimeType };
        } catch { return metadata; }
    }

    // 旧会话 blob: 死链接 → 从本地存储重新解析
    if (sk && (content.startsWith("blob:") || (content.startsWith("http:") && content.includes("127.0.0.1")))) {
        try {
            const fresh = sk.startsWith("image:") ? await resolveImageUrl(sk, "") : await resolveMediaUrl(sk, "");
            if (fresh && fresh !== content) return { ...metadata, content: fresh };
        } catch { /* 保持原值 */ }
    }
    return metadata;
}

// 直接读写 canvas store 的 IndexedDB 持久层
async function readCanvasProjectsFromIdb(): Promise<CanvasProject[]> {
    try {
        const db = await openIdb(CANVAS_STORE_IDB);
        const value = await new Promise<string | null>((resolve) => {
            const req = db.transaction("app_state", "readonly").objectStore("app_state").get(CANVAS_STORE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
        db.close();
        if (!value) return [];
        const parsed = JSON.parse(value);
        return parsed?.state?.projects || [];
    } catch {
        return [];
    }
}

async function writeCanvasProjectsToIdb(projects: CanvasProject[]) {
    const db = await openIdb(CANVAS_STORE_IDB);
    await new Promise((resolve, reject) => {
        const tx = db.transaction("app_state", "readwrite");
        tx.objectStore("app_state").put(JSON.stringify({ state: { projects }, version: 0 }), CANVAS_STORE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

function openIdb(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
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

// 调试句柄：在浏览器控制台可用 window.__importDebug 直接调用导入/导出
if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__importDebug = { importDataPackage, exportDataPackage };
}
