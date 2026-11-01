import SparkMD5 from "spark-md5";

// 引用包用 MD5 作为图片身份标识（Web Crypto 只提供 SHA 系列，MD5 走 spark-md5）。
export function md5Bytes(bytes: Uint8Array): string {
    return SparkMD5.ArrayBuffer.hash(bytes.slice().buffer);
}

export function md5Text(text: string): string {
    return SparkMD5.hash(text);
}

// 分片计算大文件 MD5，避免几十 MB 的图片一次性读进内存
export async function md5Blob(blob: Blob, chunkSize = 4 * 1024 * 1024): Promise<string> {
    if (blob.size <= chunkSize) return SparkMD5.ArrayBuffer.hash(await blob.arrayBuffer());
    const spark = new SparkMD5.ArrayBuffer();
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
        spark.append(await blob.slice(offset, offset + chunkSize).arrayBuffer());
    }
    return spark.end();
}
