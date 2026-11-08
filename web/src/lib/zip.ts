import { unzip, zip } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export type ZipProgress = (stage: string, percent: number) => void;

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    // 与 readZip 同理用异步压缩：几百 MB 媒体导出时 zipSync 会把主线程按住数秒，界面假死
    const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        zip(Object.fromEntries(entries), { level: 0 }, (error, data) => {
            if (error) reject(error);
            else resolve(data);
        });
    });
    return new Blob([new Uint8Array(zipped)], { type: "application/zip" });
}

// 读取 zip：改用 fflate 的异步解压，避免几十 MB 包在主线程上一次性同步解压导致界面假死
// （老实现用 unzipSync，40MB+ 的包会把主线程按住好几秒，导入按钮看起来像"卡死在读取"）。
export async function readZip(file: Blob, onProgress?: ZipProgress): Promise<Map<string, Blob>> {
    onProgress?.("读取文件", 5);
    const bytes = new Uint8Array(await readBlobBuffer(file));
    onProgress?.("解压文件", 15);
    const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(bytes, { filter: (entry) => !entry.name.endsWith("/") }, (error, data) => {
            if (error) reject(error);
            else resolve(data);
        });
    });
    onProgress?.("解压完成", 40);
    const map = new Map<string, Blob>();
    for (const [name, data] of Object.entries(entries)) {
        map.set(name, new Blob([new Uint8Array(data)], { type: guessMimeType(name) }));
    }
    return map;
}

async function readBlobBuffer(file: Blob): Promise<ArrayBuffer> {
    if (typeof file.arrayBuffer === "function") {
        try {
            return await file.arrayBuffer();
        } catch {
            // WebView2 下超大 Blob 偶尔会走到这里，退回到 FileReader
        }
    }
    return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (result instanceof ArrayBuffer) resolve(result);
            else reject(new Error("读取压缩包失败"));
        };
        reader.onerror = () => reject(reader.error || new Error("读取压缩包失败"));
        reader.readAsArrayBuffer(file);
    });
}

function guessMimeType(name: string) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".json")) return "application/json";
    return "";
}
