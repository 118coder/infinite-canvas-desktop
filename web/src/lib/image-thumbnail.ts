// 画布图片显示用的多级 LOD。
// 4K 原图解码后约 33MB/张，500 张会直接压垮解码线程与 GPU 合成；
// 因此画布显示永远只用位图档位，放大到最高档仍不足时拉伸最高档，绝不回退 4K 原图。
// 档位复用既有 key 约定：@256 小档、@768 中档、无后缀主档 1536，新增 @2048 放大档。
export const IMAGE_LOD_LEVELS = [256, 768, 1536, 2048] as const;
export const MAIN_LOD_LEVEL = 1536;
export const MAX_LOD_LEVEL = 2048;
export const SMALL_LOD_LEVEL = 256;
// 迟滞系数：需求长边接近档位上界时才升级，避免缩放过程中反复切档触发重复解码。
const LOD_HYSTERESIS = 0.9;

export function lodKeyFor(baseKey: string, level: number) {
    return level === MAIN_LOD_LEVEL ? baseKey : `${baseKey}@${level}`;
}

/** 删除/清理预览时必须覆盖全部档位，否则打开画布会把其它档位误删重生成。 */
export function allLodKeys(baseKey: string) {
    return IMAGE_LOD_LEVELS.map((level) => lodKeyFor(baseKey, level));
}

/** 从目标档一路回退到最低档：高档未生成时先显示低档，绝不显示原图。 */
export function lodFallbackKeys(baseKey: string, targetLevel: number) {
    return IMAGE_LOD_LEVELS.filter((level) => level <= targetLevel)
        .slice()
        .reverse()
        .map((level) => lodKeyFor(baseKey, level));
}

/** 按屏幕实际渲染像素需求选档，结果离散，缩放过程中不会连续变化。 */
export function pickLodLevel(requiredLongEdge: number) {
    for (const level of IMAGE_LOD_LEVELS) {
        if (requiredLongEdge <= level * LOD_HYSTERESIS) return level;
    }
    return MAX_LOD_LEVEL;
}

export function requiredLodLongEdge(renderedWidth: number, renderedHeight: number, scale: number, devicePixelRatio = globalThis.devicePixelRatio || 1) {
    return Math.max(renderedWidth, renderedHeight) * scale * devicePixelRatio;
}

type ImageSourceChoice = {
    previewUrl?: string;
    originalUrl: string;
};

/**
 * 画布显示统一入口：只要存在位图档位就用档位。
 * 原图只用于全屏预览；画布内遇到本地 blob/data 源（不会生成预览）才回退原图。
 */
export function pickImageSource({ previewUrl, originalUrl }: ImageSourceChoice) {
    return previewUrl || originalUrl;
}

export async function createImageThumbnail(blob: Blob, maxEdge: number = MAIN_LOD_LEVEL) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
        bitmap.close();
        // 原图本就小于该档位：直接缓存原 blob，保证 LOD 回退链每一档都有图可用，
        // 否则小图会把 @256/@768 全部悬空、只能显示占位色。
        return blob;
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    // OffscreenCanvas 可用时避免创建 DOM 节点与主线程 toBlob 回调，降低预览生成时的主线程占用。
    if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) {
            bitmap.close();
            return undefined;
        }
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        return await canvas.convertToBlob({ type: "image/webp", quality: 0.86 });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
        bitmap.close();
        return undefined;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return new Promise<Blob | undefined>((resolve) => canvas.toBlob((result) => resolve(result || undefined), "image/webp", 0.86));
}
