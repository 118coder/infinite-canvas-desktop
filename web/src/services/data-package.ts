import { saveAs } from "file-saver";
import localforage from "localforage";

import { persistCanvasProjectsNow, replaceCanvasProjects, useCanvasStore, type CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { md5Blob } from "@/lib/md5";
import { createZip, readZip, type ZipProgress } from "@/lib/zip";
import { getMediaBlob, setMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";

const DATA_PACKAGE_NAME = "data-package.json";
const IMAGE_LOG_STORE = "image_generation_logs";
const VIDEO_LOG_STORE = "video_generation_logs";
const LOG_DB_NAME = "infinite-canvas";
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const CANVAS_LS_KEY = "infinite-canvas:ai_config_store";
const REPAIR_QUEUE_KEY = "infinite-canvas:media-repair-queue";

// 小于该长度的 data URL 继续内联保存（图标、缩略图等），更大的走本地 blob 存储。
const INLINE_MEDIA_LIMIT = 8192;
// 需要被重写成 storageKey 的字段
const MEDIA_FIELDS = ["content", "url", "dataUrl"] as const;

export type DataPackageMode = "full" | "reference";

export type DataPackageFileEntry = {
    storageKey: string;
    /** 完整包为压缩包内路径；引用包为空字符串 */
    path: string;
    /** 人类可读文件名，引用包定位缺失图片时按它匹配 */
    fileName: string;
    mimeType: string;
    bytes: number;
    /** 文件内容 MD5（小写十六进制），引用包的核心校验依据 */
    md5: string;
};

export type DataPackage = {
    app: "infinite-canvas";
    kind: "data-package";
    /** v1：完整包（含 blob）；引用包复用 v1 结构 + mode: "reference" */
    version: 1;
    mode?: DataPackageMode;
    exportedAt: string;
    projects: CanvasProject[];
    assets: Asset[];
    config: AiConfig;
    skills: unknown[];
    imageLogs: { key: string; value: unknown }[];
    videoLogs: { key: string; value: unknown }[];
    files: DataPackageFileEntry[];
};

export type MissingMediaEntry = {
    storageKey: string;
    fileName: string;
    mimeType: string;
    bytes: number;
    md5: string;
    /** 引用该图片的节点标题，便于用户辨认 */
    titles: string[];
};

export type DataPackageExportResult = {
    mode: DataPackageMode;
    projects: number;
    assets: number;
    files: number;
    bytes: number;
    missing: number;
};

export type DataPackageImportResult = {
    mode: DataPackageMode;
    projects: number;
    assets: number;
    logs: number;
    files: number;
    missing: MissingMediaEntry[];
};

type ScrubContext = {
    /** storageKey → 人类可读文件名线索 */
    hints: Map<string, string>;
};

// 导出数据工程。
// full：完整包，所有 blob 打进 zip，开箱即用（体积大）。
// reference：引用包，只导出 JSON + 每张图片的 storageKey / MD5 / 文件名清单，不含 blob（几百 KB）。
export async function exportDataPackage(mode: DataPackageMode = "full", onProgress?: ZipProgress): Promise<DataPackageExportResult> {
    const context: ScrubContext = { hints: new Map() };
    onProgress?.("整理数据", 2);

    // 统一把节点里的 base64 大图和会话级 blob: 死链换成 storageKey，
    // 这样导出的 JSON 只有几百 KB，不会再出现 28MB 的 data-package.json。
    const projects = await scrubMedia(currentProjects(), context);
    const assets = await scrubMedia(useAssetStore.getState().assets, context);
    const skills = await scrubMedia(await loadLocalSkills(), context);
    const imageLogs = await scrubMedia(await readStoreEntries(IMAGE_LOG_STORE), context);
    const videoLogs = await scrubMedia(await readStoreEntries(VIDEO_LOG_STORE), context);
    const config = useConfigStore.getState().config;

    const storageKeys = new Set<string>();
    collectStorageKeys(projects, storageKeys);
    collectStorageKeys(assets, storageKeys);
    collectStorageKeys(skills, storageKeys);
    collectStorageKeys(imageLogs, storageKeys);
    collectStorageKeys(videoLogs, storageKeys);

    const zipFiles: { name: string; data: BlobPart }[] = [];
    const files: DataPackageFileEntry[] = [];
    const usedNames = new Set<string>();
    let missing = 0;
    const keys = Array.from(storageKeys);
    for (let index = 0; index < keys.length; index += 1) {
        const storageKey = keys[index];
        if (!isLocalMediaKey(storageKey)) continue;
        const blob = await getBlobByKey(storageKey);
        const hint = context.hints.get(storageKey) || "";
        if (!blob) {
            // 本地本来就没有这个文件：完整包里跳过，引用包仍然列出来，接收端需要自行补齐
            if (mode !== "reference") continue;
            missing += 1;
            files.push({ storageKey, path: "", fileName: uniqueFileName(safeMediaName(hint, storageKey, ""), usedNames), mimeType: "", bytes: 0, md5: "" });
            continue;
        }
        const md5 = await md5Blob(blob);
        const fileName = uniqueFileName(safeMediaName(hint, storageKey, blob.type), usedNames);
        const path = mode === "full" ? `files/${fileName}` : "";
        files.push({ storageKey, path, fileName, mimeType: blob.type || "application/octet-stream", bytes: blob.size, md5 });
        if (mode === "full") {
            zipFiles.push({ name: path, data: blob });
        }
        onProgress?.(`打包媒体 ${index + 1}/${keys.length}`, 5 + Math.round((70 * (index + 1)) / Math.max(1, keys.length)));
    }

    const pkg: DataPackage = {
        app: "infinite-canvas",
        kind: "data-package",
        version: 1,
        mode,
        exportedAt: new Date().toISOString(),
        projects,
        assets,
        config,
        skills,
        imageLogs,
        videoLogs,
        files,
    };
    onProgress?.("写入压缩包", 80);
    const payload = JSON.stringify(pkg);
    const zip = await createZip([{ name: DATA_PACKAGE_NAME, data: payload }, ...zipFiles]);
    const suffix = mode === "reference" ? "引用包" : "完整包";
    saveAs(zip, `画布数据工程-${suffix}-${new Date().toISOString().slice(0, 10)}.zip`);
    onProgress?.("完成", 100);
    return { mode, projects: projects.length, assets: assets.length, files: files.length, bytes: zip.size, missing };
}

// 导入数据工程。
// 完整包：恢复 blob → 修复节点 content → 写持久层。
// 引用包：逐个校验 storageKey 是否已在本地存在，缺失的列进"待补齐"队列，不阻塞画布导入。
export async function importDataPackage(file: File, onProgress?: ZipProgress): Promise<DataPackageImportResult> {
    const zip = await readZip(file, onProgress);
    const entry = zip.get(DATA_PACKAGE_NAME);
    if (!entry) throw new Error("不是有效的数据工程文件（缺少 data-package.json）");
    onProgress?.("解析数据", 45);
    const data = JSON.parse(await entry.text()) as DataPackage;
    if (data.app !== "infinite-canvas" || data.kind !== "data-package") throw new Error("不是有效的数据工程文件");
    const mode: DataPackageMode = data.mode === "reference" ? "reference" : "full";
    const manifest = (Array.isArray(data.files) ? data.files : []).filter((item) => item && typeof item.storageKey === "string" && item.storageKey);

    // 1. 恢复包内媒体文件（完整包才有 path）
    onProgress?.("恢复媒体文件", 50);
    const available = new Set<string>();
    for (const item of manifest) {
        if (!item.path) continue;
        const blob = zip.get(item.path);
        if (!blob) continue;
        const existing = await getBlobByKey(item.storageKey);
        if (existing && (!item.bytes || existing.size === item.bytes || existing.size === blob.size)) {
            available.add(item.storageKey);
            continue;
        }
        try {
            await writeMediaBlob(item.storageKey, blob, item.mimeType);
            available.add(item.storageKey);
        } catch {
            // 写失败不阻断导入，留到下面的缺失检测里提示用户补齐
        }
    }

    // 2. 校验本地是否已有对应 blob，区分"已存在"与"缺失"
    onProgress?.("校验本地图片", 65);
    const missing: MissingMediaEntry[] = [];
    for (const item of manifest) {
        if (available.has(item.storageKey)) continue;
        const existing = await getBlobByKey(item.storageKey);
        if (existing) {
            available.add(item.storageKey);
            continue;
        }
        missing.push({ storageKey: item.storageKey, fileName: item.fileName || "", mimeType: item.mimeType || "", bytes: item.bytes || 0, md5: item.md5 || "", titles: [] });
    }

    // 3. 修复节点 content：能解析的换成当前会话可用地址，缺图的清空并标记，避免留下死链
    onProgress?.("修复画布节点", 72);
    const projects: CanvasProject[] = [];
    for (const project of data.projects || []) {
        const nodes: CanvasProject["nodes"] = [];
        for (const node of project.nodes || []) nodes.push(await restoreNodeMedia(node, available));
        projects.push({ ...project, nodes });
    }

    // 4. 写入画布项目（此时 JSON 已经很小，走 store 的持久化通道，避免和 store 抢同一个 key）
    replaceCanvasProjects(mergeProjects(await readCanvasProjects(), projects));
    await persistCanvasProjectsNow();

    // 5. 素材
    const assets = await Promise.all((data.assets || []).map((asset) => restoreAssetMedia(asset, available)));
    if (assets.length) {
        const assetState = useAssetStore.getState();
        const importedIds = new Set(assets.map((asset) => asset.id));
        const mergedAssets = [...assetState.assets.filter((asset) => !importedIds.has(asset.id)), ...assets].sort(
            (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
        );
        useAssetStore.setState({ assets: mergedAssets });
    }

    // 6. 配置
    if (data.config && typeof data.config === "object") {
        const merged = { ...defaultConfig, ...data.config };
        localStorage.setItem(CANVAS_LS_KEY, JSON.stringify({ state: { config: merged }, version: 0 }));
    }

    // 7. 本地 Skill 与生成历史
    if (Array.isArray(data.skills) && data.skills.length) {
        await localforage.createInstance({ name: LOG_DB_NAME, storeName: "agent_skills" }).setItem("items", data.skills);
    }
    const logs = (await writeStoreEntries(IMAGE_LOG_STORE, data.imageLogs)) + (await writeStoreEntries(VIDEO_LOG_STORE, data.videoLogs));

    // 8. 缺失清单：补上引用它的节点标题，并合并进待补齐队列
    for (const item of missing) {
        const titles = new Set<string>();
        for (const project of projects) {
            for (const node of project.nodes || []) {
                if (node.metadata?.storageKey === item.storageKey && node.title) titles.add(node.title);
            }
        }
        item.titles = Array.from(titles).slice(0, 4);
        if (!item.fileName) item.fileName = item.titles[0] || item.storageKey;
    }
    saveRepairQueue(mergeRepairQueue(missing, available));
    onProgress?.("完成", 100);

    return { mode, projects: projects.length, assets: assets.length, logs, files: available.size, missing };
}

/* ---------------------------------- 缺失图片补齐 ---------------------------------- */

export function loadRepairQueue(): MissingMediaEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(window.localStorage.getItem(REPAIR_QUEUE_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is MissingMediaEntry => Boolean(item && typeof item.storageKey === "string"));
    } catch {
        return [];
    }
}

export function saveRepairQueue(items: MissingMediaEntry[]) {
    if (typeof window === "undefined") return;
    if (!items.length) {
        window.localStorage.removeItem(REPAIR_QUEUE_KEY);
        return;
    }
    window.localStorage.setItem(REPAIR_QUEUE_KEY, JSON.stringify(items));
}

export function removeRepairEntry(storageKey: string) {
    saveRepairQueue(loadRepairQueue().filter((item) => item.storageKey !== storageKey));
}

// 用用户挑选的本地图片补齐缺失项：优先按 MD5 精确匹配，其次文件名，再次文件大小。
export async function repairMissingMedia(files: File[], targetStorageKey?: string): Promise<{ repaired: MissingMediaEntry[]; unmatched: number; remaining: MissingMediaEntry[] }> {
    const pending = loadRepairQueue();
    const repaired: MissingMediaEntry[] = [];
    let unmatched = 0;
    for (const file of files) {
        if (!file) continue;
        let index = -1;
        if (targetStorageKey) index = pending.findIndex((item) => item.storageKey === targetStorageKey);
        if (index < 0) {
            const digest = await md5Blob(file).catch(() => "");
            if (digest) index = pending.findIndex((item) => Boolean(item.md5) && item.md5 === digest);
        }
        if (index < 0) {
            const name = normalizeFileName(file.name);
            index = pending.findIndex((item) => normalizeFileName(item.fileName) === name);
        }
        if (index < 0) index = pending.findIndex((item) => Boolean(item.bytes) && item.bytes === file.size);
        if (index < 0) {
            unmatched += 1;
            continue;
        }
        const item = pending[index];
        await writeMediaBlob(item.storageKey, file, item.mimeType || file.type);
        pending.splice(index, 1);
        repaired.push(item);
    }
    saveRepairQueue(pending);
    return { repaired, unmatched, remaining: pending };
}

// 补齐后清掉节点里残留的空 content 记录，让下次打开画布时按 storageKey 重新解析
export async function resolveRepairedProjects(repaired: MissingMediaEntry[]) {
    if (!repaired.length) return;
    const keys = new Set(repaired.map((item) => item.storageKey));
    const projects = await readCanvasProjects();
    let touched = false;
    const next = await Promise.all(
        projects.map(async (project) => ({
            ...project,
            nodes: await Promise.all(
                (project.nodes || []).map(async (node) => {
                    const key = node.metadata?.storageKey;
                    if (!key || !keys.has(key)) return node;
                    const url = await resolveMediaUrlForKey(key);
                    touched = true;
                    return { ...node, metadata: { ...node.metadata, content: url } };
                }),
            ),
        })),
    );
    if (!touched) return;
    replaceCanvasProjects(next);
    await persistCanvasProjectsNow();
}

/* ---------------------------------- 内部实现 ---------------------------------- */

function currentProjects(): CanvasProject[] {
    return useCanvasStore.getState().projects;
}

async function readCanvasProjects(): Promise<CanvasProject[]> {
    // 已经水合过就以内存中的 store 为准（persist 层会用同一个 key 落盘），
    // 只有还没水合（内存为空）时才去 IndexedDB 里补读，避免把未保存的编辑覆盖掉。
    const live = currentProjects();
    if (live.length || useCanvasStore.getState().hydrated) return live;
    try {
        const value = await localforage.createInstance({ name: LOG_DB_NAME, storeName: "app_state" }).getItem<string>(CANVAS_STORE_KEY);
        if (!value) return live;
        const parsed = JSON.parse(value) as { state?: { projects?: CanvasProject[] } };
        return parsed?.state?.projects || [];
    } catch {
        return live;
    }
}

function mergeProjects(existing: CanvasProject[], incoming: CanvasProject[]) {
    const incomingIds = new Set(incoming.map((project) => project.id));
    return [...existing.filter((project) => !incomingIds.has(project.id)), ...incoming].sort(
        (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
    );
}

// 内联 base64 / 会话级 blob: 链接 → storageKey
async function scrubMedia<T>(value: T, context: ScrubContext): Promise<T> {
    if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (const item of value) items.push(await scrubMedia(item, context));
        return items as unknown as T;
    }
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const storageKey = typeof source.storageKey === "string" ? source.storageKey : "";
    if (storageKey && typeof source.title === "string" && source.title) context.hints.set(storageKey, source.title);

    let next: Record<string, unknown> | null = null;
    for (const field of MEDIA_FIELDS) {
        const raw = source[field];
        if (typeof raw !== "string" || !raw) continue;
        if (raw.startsWith("blob:")) {
            // blob URL 只在本会话有效，换机器/重开必死，清空后由 storageKey 重建
            next = next || { ...source };
            next[field] = "";
            continue;
        }
        if (!raw.startsWith("data:") || raw.length <= INLINE_MEDIA_LIMIT) continue;
        const key = await externalizeInlineMedia(raw, storageKey);
        next = next || { ...source };
        next[field] = "";
        if (key && !storageKey) next.storageKey = key;
    }

    const base = next || { ...source };
    for (const key of Object.keys(base)) {
        const child = base[key];
        if (child && typeof child === "object") base[key] = await scrubMedia(child, context);
    }
    return base as unknown as T;
}

async function externalizeInlineMedia(dataUrl: string, preferredKey: string): Promise<string | null> {
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return null;
    const md5 = await md5Blob(blob).catch(() => "");
    const key = isLocalMediaKey(preferredKey) ? preferredKey : `${mediaKeyPrefix(blob.type)}${md5 || Date.now()}`;
    try {
        await writeMediaBlob(key, blob, blob.type);
        return key;
    } catch {
        return null;
    }
}

function dataUrlToBlob(dataUrl: string): Blob | null {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = dataUrl.slice(5, comma);
    const mimeType = (meta.split(";")[0] || "application/octet-stream").trim() || "application/octet-stream";
    try {
        if (!meta.includes(";base64")) {
            return new Blob([decodeURIComponent(dataUrl.slice(comma + 1))], { type: mimeType });
        }
        const binary = atob(dataUrl.slice(comma + 1));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new Blob([bytes], { type: mimeType });
    } catch {
        return null;
    }
}

async function restoreNodeMedia(node: CanvasProject["nodes"][number], available: Set<string>): Promise<CanvasProject["nodes"][number]> {
    const metadata = node.metadata;
    if (!metadata) return node;
    const storageKey = typeof metadata.storageKey === "string" ? metadata.storageKey : "";
    const content = typeof metadata.content === "string" ? metadata.content : "";

    // 包里的内联 base64 大图：立刻落到本地 blob 存储，避免它进入画布 store 后再被反复 JSON.stringify
    if (content.startsWith("data:") && content.length > INLINE_MEDIA_LIMIT) {
        const key = await externalizeInlineMedia(content, storageKey);
        if (!key) return { ...node, metadata: { ...metadata, content: "" } };
        available.add(key);
        const url = await resolveMediaUrlForKey(key);
        return { ...node, metadata: { ...metadata, storageKey: key, content: url } };
    }

    if (!storageKey || !isLocalMediaKey(storageKey)) {
        // 失效的旧会话 blob 链接直接清掉，不留死链
        return content.startsWith("blob:") ? { ...node, metadata: { ...metadata, content: "" } } : node;
    }

    if (!available.has(storageKey)) {
        // 引用包缺图：content 清空，渲染层显示"图片缺失"，等待用户补齐
        return { ...node, metadata: { ...metadata, content: "" } };
    }

    const url = await resolveMediaUrlForKey(storageKey);
    return { ...node, metadata: { ...metadata, content: url || "" } };
}

async function restoreAssetMedia(asset: Asset, available: Set<string>): Promise<Asset> {
    const data = asset.data as Record<string, unknown>;
    const storageKey = typeof data.storageKey === "string" ? data.storageKey : "";
    let nextData = data;
    for (const field of ["url", "dataUrl"] as const) {
        const raw = data[field];
        if (typeof raw !== "string" || !raw) continue;
        if (raw.startsWith("data:") && raw.length > INLINE_MEDIA_LIMIT) {
            const key = await externalizeInlineMedia(raw, storageKey);
            if (key) {
                available.add(key);
                nextData = { ...nextData, [field]: await resolveMediaUrlForKey(key), storageKey: storageKey || key };
            }
            continue;
        }
        if (raw.startsWith("blob:")) nextData = { ...nextData, [field]: "" };
    }
    return nextData === data ? asset : ({ ...asset, data: nextData } as Asset);
}

function isLocalMediaKey(storageKey: string | undefined | null): storageKey is string {
    if (!storageKey || typeof storageKey !== "string") return false;
    if (storageKey.startsWith("server:") || storageKey.startsWith("comfy:")) return false;
    return /^(image|file|video|audio|media|asset-media):/.test(storageKey);
}

function mediaKeyPrefix(mimeType: string) {
    if (mimeType.startsWith("image/")) return "image:";
    if (mimeType.startsWith("video/")) return "video:";
    if (mimeType.startsWith("audio/")) return "audio:";
    return "file:";
}

async function getBlobByKey(storageKey: string) {
    try {
        return storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
    } catch {
        return undefined;
    }
}

async function writeMediaBlob(storageKey: string, blob: Blob, mimeType?: string) {
    const typed = mimeType && blob.type !== mimeType ? blob.slice(0, blob.size, mimeType) : blob;
    if (storageKey.startsWith("image:")) await setImageBlob(storageKey, typed);
    else await setMediaBlob(storageKey, typed);
}

async function resolveMediaUrlForKey(storageKey: string) {
    try {
        return storageKey.startsWith("image:") ? await resolveImageUrl(storageKey, "") : await resolveMediaUrl(storageKey, "");
    } catch {
        return "";
    }
}

function mergeRepairQueue(items: MissingMediaEntry[], available: Set<string>) {
    const merged = new Map<string, MissingMediaEntry>();
    for (const item of loadRepairQueue()) {
        if (available.has(item.storageKey)) continue;
        merged.set(item.storageKey, item);
    }
    for (const item of items) merged.set(item.storageKey, item);
    return Array.from(merged.values());
}

function normalizeFileName(value: string) {
    return value
        .split(/[\\/]/)
        .pop()!
        .toLowerCase()
        .replace(/\s+/g, "")
        .trim();
}

function safeMediaName(hint: string, storageKey: string, mimeType: string) {
    const extension = mimeExtension(mimeType) || hint.match(/\.[a-z0-9]{2,5}$/i)?.[0] || "";
    let base = hint
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
    if (base.length > 48) base = base.slice(0, 48).trim();
    if (!base) base = storageKey.replace(/^[a-z-]+:/i, "").slice(0, 24) || "media";
    return `${base}${extension}`;
}

function uniqueFileName(fileName: string, used: Set<string>) {
    if (!used.has(fileName)) {
        used.add(fileName);
        return fileName;
    }
    const dot = fileName.lastIndexOf(".");
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const extension = dot > 0 ? fileName.slice(dot) : "";
    let index = 2;
    let candidate = `${base}-${index}${extension}`;
    while (used.has(candidate)) {
        index += 1;
        candidate = `${base}-${index}${extension}`;
    }
    used.add(candidate);
    return candidate;
}

function mimeExtension(mimeType: string) {
    if (!mimeType) return "";
    if (mimeType === "image/png") return ".png";
    if (mimeType === "image/jpeg") return ".jpg";
    if (mimeType === "image/webp") return ".webp";
    if (mimeType === "image/gif") return ".gif";
    if (mimeType === "video/mp4") return ".mp4";
    if (mimeType === "video/webm") return ".webm";
    if (mimeType === "audio/mpeg") return ".mp3";
    if (mimeType === "audio/wav") return ".wav";
    return "";
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

function collectStorageKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof (value as { storageKey?: unknown }).storageKey === "string" && (value as { storageKey: string }).storageKey.includes(":")) {
        keys.add((value as { storageKey: string }).storageKey);
    }
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return keys;
}

// 调试句柄：在浏览器控制台可用 window.__importDebug 直接调用导入/导出/补齐
if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__importDebug = {
        importDataPackage,
        exportDataPackage,
        loadRepairQueue,
        repairMissingMedia,
        resolveRepairedProjects,
    };
}
