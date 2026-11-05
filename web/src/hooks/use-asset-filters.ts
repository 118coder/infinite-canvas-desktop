"use client";

import { useEffect, useMemo, useState } from "react";

import type { Asset, AssetKind } from "@/stores/use-asset-store";

const RECENT_ASSETS_KEY = "infinite-canvas:asset-recent";
const RECENT_ASSETS_LIMIT = 30;

export type AssetKindFilter = AssetKind | "all";

export function readRecentAssetIds(): string[] {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(RECENT_ASSETS_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

// 最近在画布中插入过的素材排到最前，方便反复取用同一批素材
export function recordRecentAssetId(assetId: string) {
    if (!assetId) return;
    try {
        const next = [assetId, ...readRecentAssetIds().filter((id) => id !== assetId)].slice(0, RECENT_ASSETS_LIMIT);
        window.localStorage.setItem(RECENT_ASSETS_KEY, JSON.stringify(next));
    } catch {
        // 忽略不可用存储
    }
}

export function sortAssetsByRecent(assets: Asset[], recentIds: string[]): Asset[] {
    if (!recentIds.length) return assets;
    const order = new Map(recentIds.map((id, index) => [id, index]));
    return [...assets].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

type UseAssetFiltersOptions = {
    pageSize: number;
};

// 「我的素材」在画布侧栏 / 素材选择器共用的 关键词 + 类型 + 分类 + 标签 过滤与分页
export function useAssetFilters(assets: Asset[], { pageSize }: UseAssetFiltersOptions) {
    const [keyword, setKeyword] = useState("");
    const [kind, setKind] = useState<AssetKindFilter>("all");
    const [category, setCategory] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [page, setPage] = useState(1);
    const [recentIds, setRecentIds] = useState<string[]>([]);

    useEffect(() => {
        setRecentIds(readRecentAssetIds());
    }, []);

    const categories = useMemo(() => Array.from(new Set(assets.flatMap((asset) => (asset.category ? [asset.category] : [])))), [assets]);
    const tagOptions = useMemo(() => Array.from(new Set(assets.flatMap((asset) => asset.tags || []))), [assets]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        const list = assets.filter((asset) => {
            if (kind !== "all" && asset.kind !== kind) return false;
            if (category && asset.category !== category) return false;
            if (selectedTags.length && !selectedTags.some((tag) => (asset.tags || []).includes(tag))) return false;
            return !query || [asset.title, asset.category || "", ...(asset.tags || [])].join(" ").toLowerCase().includes(query);
        });
        return sortAssetsByRecent(list, recentIds);
    }, [assets, category, keyword, kind, recentIds, selectedTags]);

    const items = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

    useEffect(() => {
        setPage((value) => Math.min(value, Math.max(1, Math.ceil(filtered.length / pageSize))));
    }, [filtered.length, pageSize]);

    const resetPage = () => setPage(1);

    return {
        keyword,
        setKeyword: (value: string) => {
            resetPage();
            setKeyword(value);
        },
        kind,
        setKind: (value: AssetKindFilter) => {
            resetPage();
            setKind(value);
        },
        category,
        setCategory: (value: string) => {
            resetPage();
            setCategory(value);
        },
        selectedTags,
        setSelectedTags: (values: string[]) => {
            resetPage();
            setSelectedTags(values);
        },
        categories,
        tagOptions,
        filtered,
        items,
        page,
        setPage,
        pageSize,
    };
}
