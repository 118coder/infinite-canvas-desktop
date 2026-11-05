"use client";

import { create } from "zustand";

import { APP_VERSION } from "@/constant/env";

// 只看正式版：GitHub Releases API 自动排除 prerelease，desktop-latest 滚动包不会被误判
const RELEASES_API = "https://api.github.com/repos/118coder/infinite-canvas-desktop/releases?per_page=8";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_AT_KEY = "infinite-canvas:update-check-at";

export type UpdateRelease = {
    version: string;
    url: string;
    publishedAt: string;
    items: { type: string; content: string }[];
};

type UpdateStore = {
    latestVersion: string;
    releases: UpdateRelease[];
    checking: boolean;
    checked: boolean;
    checkedAt: number;
    error: string;
    hasNewVersion: boolean;
    check: () => Promise<boolean>;
    checkIfDue: () => Promise<void>;
};

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)\.?(\d+)?/);
    return match ? match.slice(1).filter(Boolean).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

// 发行说明由发版流程从 CHANGELOG 生成，行格式：`- **新增** xxx`
function parseReleaseBody(body: string) {
    return body
        .split("\n")
        .map((line) => line.trim().match(/^-\s+\*\*([^*]+)\*\*\s+(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => ({ type: match[1].replace(/^\[|\]$/g, "").trim(), content: match[2].trim() }));
}

export const useUpdateStore = create<UpdateStore>()((set, get) => ({
    latestVersion: APP_VERSION,
    releases: [],
    checking: false,
    checked: false,
    checkedAt: 0,
    error: "",
    hasNewVersion: false,
    check: async () => {
        if (get().checking) return false;
        set({ checking: true, error: "" });
        try {
            const response = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const releases = (await response.json()) as Array<{ tag_name?: unknown; html_url?: unknown; published_at?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown }>;
            const official = releases
                .filter((release) => release.draft === false && release.prerelease === false && typeof release.tag_name === "string" && typeof release.body === "string")
                .map((release) => ({
                    version: (release.tag_name as string).trim(),
                    url: typeof release.html_url === "string" ? release.html_url : "https://github.com/118coder/infinite-canvas-desktop/releases",
                    publishedAt: typeof release.published_at === "string" ? release.published_at.slice(0, 10) : "",
                    items: parseReleaseBody(release.body as string),
                }))
                .filter((release) => toVersionParts(release.version) !== null);
            if (!official.length) throw new Error("没有可用版本");
            const checkedAt = Date.now();
            set({ latestVersion: official[0].version, releases: official.slice(0, 5), checked: true, checkedAt, hasNewVersion: isNewerVersion(official[0].version, APP_VERSION) });
            try {
                window.localStorage.setItem(CHECK_AT_KEY, String(checkedAt));
            } catch {
                // 忽略不可用存储
            }
            return true;
        } catch (error) {
            set({ error: error instanceof Error ? error.message : "检查更新失败", checked: true, checkedAt: Date.now() });
            return false;
        } finally {
            set({ checking: false });
        }
    },
    checkIfDue: async () => {
        let last = 0;
        try {
            last = Number(window.localStorage.getItem(CHECK_AT_KEY) || 0) || 0;
        } catch {
            // 忽略不可用存储
        }
        if (Date.now() - last < CHECK_INTERVAL_MS) return;
        await get().check();
    },
}));
