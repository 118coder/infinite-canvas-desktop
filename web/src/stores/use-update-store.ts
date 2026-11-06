"use client";

import { create } from "zustand";

import { APP_VERSION } from "@/constant/env";
import { parseChangelog } from "@/lib/release";

// 只看正式版：GitHub Releases API 自动排除 draft / prerelease，desktop-latest 滚动包不会被误判
const RELEASES_API = "https://api.github.com/repos/118coder/infinite-canvas-desktop/releases?per_page=8";
const RELEASES_PAGE = "https://github.com/118coder/infinite-canvas-desktop/releases";
// 兜底通道：API 被限流或网络受限时直接读 main 上的公开文件，不占 API 配额
const RAW_VERSION_URL = "https://raw.githubusercontent.com/118coder/infinite-canvas-desktop/main/VERSION";
const RAW_CHANGELOG_URL = "https://raw.githubusercontent.com/118coder/infinite-canvas-desktop/main/CHANGELOG.md";
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

type GithubRelease = {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    body?: unknown;
    draft?: unknown;
    prerelease?: unknown;
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

// 主通道：Releases API，能拿到发行说明和该版本的发行页链接
async function fetchOfficialReleases(): Promise<UpdateRelease[]> {
    const response = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const releases = (await response.json()) as GithubRelease[];
    if (!Array.isArray(releases)) throw new Error("版本信息格式异常");
    const official = releases
        .filter((release) => release.draft === false && release.prerelease === false && typeof release.tag_name === "string" && typeof release.body === "string")
        .map((release) => ({
            version: (release.tag_name as string).trim(),
            url: typeof release.html_url === "string" ? release.html_url : RELEASES_PAGE,
            publishedAt: typeof release.published_at === "string" ? release.published_at.slice(0, 10) : "",
            items: parseReleaseBody(release.body as string),
        }))
        .filter((release) => toVersionParts(release.version) !== null);
    if (!official.length) throw new Error("没有可用版本");
    return official;
}

// 兜底通道：VERSION 决定「最新版本」，CHANGELOG 决定变更摘要；两者任一失败都会整体失败
async function fetchFallbackReleases(): Promise<UpdateRelease[]> {
    const [versionResponse, changelogResponse] = await Promise.all([
        fetch(RAW_VERSION_URL, { signal: AbortSignal.timeout(10000) }),
        fetch(RAW_CHANGELOG_URL, { signal: AbortSignal.timeout(10000) }),
    ]);
    if (!versionResponse.ok) throw new Error(`HTTP ${versionResponse.status}`);
    const version = (await versionResponse.text()).trim();
    if (!toVersionParts(version)) throw new Error("版本号格式异常");
    const blocks = changelogResponse.ok ? parseChangelog(await changelogResponse.text()).filter((release) => release.version !== "Unreleased") : [];
    const releases = blocks.slice(0, 5).map((release) => ({
        version: release.version,
        url: `${RELEASES_PAGE}/tag/${release.version}`,
        publishedAt: release.date,
        items: release.items,
    }));
    if (releases[0]?.version !== version) {
        releases.unshift({ version, url: RELEASES_PAGE, publishedAt: "", items: [] });
    }
    return releases.slice(0, 5);
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
            const releases = await fetchOfficialReleases().catch(() => fetchFallbackReleases());
            const checkedAt = Date.now();
            set({
                latestVersion: releases[0].version,
                releases: releases.slice(0, 5),
                checked: true,
                checkedAt,
                hasNewVersion: isNewerVersion(releases[0].version, APP_VERSION),
            });
            // 只有成功才记录检查时间，避免一次网络抖动把静默检查压后 24 小时
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
