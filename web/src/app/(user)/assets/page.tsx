"use client";

import { Copy, Download, Images, PencilLine, Search, Tag as TagIcon, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Card, Checkbox, Drawer, Dropdown, Empty, Image, Input, MenuProps, Modal, Pagination, Select, Space, Tag, Tooltip, Typography } from "antd";
import { saveAs } from "file-saver";

import { useCopyText } from "@/hooks/use-copy-text";
import { requestCanvasInsert } from "@/lib/canvas-handoff";
import { formatBytes } from "@/lib/image-utils";
import { cn } from "@/lib/utils";
import { useAssetStore, type Asset, type AssetKind } from "@/stores/use-asset-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";
import { AssetFormModal } from "@/components/assets/asset-form-modal";
import type { InsertAssetPayload } from "@/app/(user)/canvas/types";

function assetCanvasPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title, assetId: asset.id, source: "asset" };
    if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, source: "asset" };
    if (asset.kind === "audio") return { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, bytes: asset.data.bytes, mimeType: asset.data.mimeType, durationMs: asset.data.durationMs, source: "asset" };
    return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, source: "asset" };
}

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

const sortOptions = [
    { label: "最近更新", value: "updated" },
    { label: "最近创建", value: "created" },
    { label: "体积从大到小", value: "bytes" },
    { label: "标题 A-Z", value: "title" },
];

type SortKey = "updated" | "created" | "bytes" | "title";

// 筛选状态持久化：来回切页面不至于每次都重设一遍
const FILTER_STORAGE_KEY = "infinite-canvas:asset-filters";

type StoredFilters = {
    keyword: string;
    kind: AssetKind | "all";
    category: string;
    tags: string[];
    tagMatchAll: boolean;
    sort: SortKey;
    pageSize: number;
};

function loadFilters(): Partial<StoredFilters> {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(window.sessionStorage.getItem(FILTER_STORAGE_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export default function AssetsPage() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const assetInputRef = useRef<HTMLInputElement>(null);
    const restored = useRef(loadFilters());
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const removeAssets = useAssetStore((state) => state.removeAssets);
    const updateAssets = useAssetStore((state) => state.updateAssets);
    const [keyword, setKeyword] = useState(restored.current.keyword || "");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">(restored.current.kind || "all");
    const [categoryFilter, setCategoryFilter] = useState(restored.current.category || "");
    const [tagFilters, setTagFilters] = useState<string[]>(restored.current.tags || []);
    const [tagMatchAll, setTagMatchAll] = useState(Boolean(restored.current.tagMatchAll));
    const [sortKey, setSortKey] = useState<SortKey>(restored.current.sort || "updated");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(restored.current.pageSize || 12);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAssets, setDeletingAssets] = useState<Asset[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [tagDialogOpen, setTagDialogOpen] = useState(false);
    const [tagDraft, setTagDraft] = useState("");
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio"), [assets]);
    const categories = useMemo(() => Array.from(new Set(validAssets.flatMap((asset) => asset.category ? [asset.category] : []))), [validAssets]);
    const tags = useMemo(() => Array.from(new Set(validAssets.flatMap((asset) => asset.tags))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), [validAssets]);

    useEffect(() => {
        const payload: StoredFilters = { keyword, kind: kindFilter, category: categoryFilter, tags: tagFilters, tagMatchAll, sort: sortKey, pageSize };
        try {
            window.sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload));
        } catch {
            // sessionStorage 不可用时忽略即可
        }
    }, [keyword, kindFilter, categoryFilter, tagFilters, tagMatchAll, sortKey, pageSize]);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (categoryFilter && asset.category !== categoryFilter) return false;
            if (tagFilters.length) {
                const matched = tagMatchAll
                    ? tagFilters.every((tag) => asset.tags.includes(tag))
                    : tagFilters.some((tag) => asset.tags.includes(tag));
                if (!matched) return false;
            }
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter, categoryFilter, tagFilters, tagMatchAll]);

    const sortedAssets = useMemo(() => {
        const list = [...filteredAssets];
        list.sort((a, b) => {
            if (sortKey === "title") return (a.title || "").localeCompare(b.title || "", "zh-Hans-CN");
            if (sortKey === "bytes") return assetBytes(b) - assetBytes(a);
            if (sortKey === "created") return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "");
            return Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
        });
        return list;
    }, [filteredAssets, sortKey]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return sortedAssets.slice(start, start + pageSize);
    }, [sortedAssets, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(sortedAssets.length / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [sortedAssets.length, pageSize]);

    // 素材被删掉后同步清理选中项
    useEffect(() => {
        const alive = new Set(validAssets.map((asset) => asset.id));
        setSelectedIds((items) => items.filter((id) => alive.has(id)));
    }, [validAssets]);

    const selectedAssets = useMemo(() => validAssets.filter((asset) => selectedIds.includes(asset.id)), [validAssets, selectedIds]);
    const pageAllSelected = visibleAssets.length > 0 && visibleAssets.every((asset) => selectedIds.includes(asset.id));

    const toggleSelect = (id: string) => {
        setSelectedIds((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]));
    };

    const toggleSelectPage = () => {
        const pageIds = visibleAssets.map((asset) => asset.id);
        setSelectedIds((items) => (pageAllSelected ? items.filter((id) => !pageIds.includes(id)) : Array.from(new Set([...items, ...pageIds]))));
    };

    const clearFilters = () => {
        setKeyword("");
        setKindFilter("all");
        setCategoryFilter("");
        setTagFilters([]);
        setPage(1);
    };

    const openCreate = () => {
        setEditingAsset(null);
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setIsAssetOpen(true);
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, "文本已复制");
    };

    const copyAssetImage = async (asset: Asset) => {
        if (asset.kind !== "image") return;
        try {
            const response = await fetch(asset.data.dataUrl || asset.coverUrl);
            const blob = await response.blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
            message.success("图片已复制到剪贴板");
        } catch {
            message.error("复制图片失败，可以改用下载");
        }
    };

    const copyStorageKey = async (asset: Asset) => {
        const key = (asset.data as { storageKey?: string }).storageKey;
        if (!key) {
            message.info("这个素材没有本地存储键（外链或纯文本）");
            return;
        }
        await copyText(key, "storageKey 已复制");
    };

    const downloadAsset = (asset: Asset) => {
        if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return;
        const url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
        saveAs(url, `${asset.title || "asset"}.${asset.data.mimeType.split("/")[1] || "png"}`);
    };

    const insertIntoCanvas = (asset: Asset) => {
        const result = requestCanvasInsert([assetCanvasPayload(asset)]);
        if (!result.ok || !result.projectId) {
            message.warning("还没有打开过画布，请先打开一个画布再插入素材");
            return;
        }
        message.success("已排队插入画布，正在打开...");
        setTimeout(() => window.location.assign(`/canvas?project=${encodeURIComponent(result.projectId!)}`), 600);
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning("暂无素材可导出");
            return;
        }
        await exportAssets(validAssets);
    };

    const exportSelectedAssets = async () => {
        if (!selectedAssets.length) return;
        await exportAssets(selectedAssets);
        message.success(`已导出 ${selectedAssets.length} 个素材`);
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        try {
            const importedAssets = await readAssetPackage(file);
            importedAssets.forEach((asset) => {
                const payload = { ...asset } as Record<string, unknown>;
                delete payload.id;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset(payload as Parameters<typeof addAsset>[0]);
            });
            message.success(`已导入 ${importedAssets.length} 个素材`);
        } catch {
            message.error("导入失败，请选择有效的素材压缩包");
        } finally {
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const confirmDelete = () => {
        if (!deletingAssets.length) return;
        if (deletingAssets.length === 1) removeAsset(deletingAssets[0].id);
        else removeAssets(deletingAssets.map((asset) => asset.id));
        message.success(deletingAssets.length === 1 ? "素材已删除" : `已删除 ${deletingAssets.length} 个素材`);
        setSelectedIds((items) => items.filter((id) => !deletingAssets.some((asset) => asset.id === id)));
        setDeletingAssets([]);
    };

    const applyBatchTags = () => {
        const nextTags = Array.from(new Set(tagDraft.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean)));
        if (!nextTags.length) {
            message.warning("请输入要添加的标签");
            return;
        }
        selectedAssets.forEach((asset) => {
            const merged = Array.from(new Set([...(asset.tags || []), ...nextTags]));
            updateAssets([asset.id], { tags: merged });
        });
        message.success(`已给 ${selectedAssets.length} 个素材加上标签：${nextTags.join("、")}`);
        setTagDraft("");
        setTagDialogOpen(false);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">我的素材</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">收藏和管理常用素材，按类型、标题、分类和标签快速查找。</p>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder="搜索标题、内容、分类、标签或来源"
                            onChange={(event) => {
                                setPage(1);
                                setKeyword(event.target.value);
                            }}
                            onSearch={(value) => {
                                setPage(1);
                                setKeyword(value);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">类型</div>
                                <div className="flex flex-wrap gap-2">
                                    {kindOptions.map((option) => (
                                        <Tag.CheckableTag
                                            key={option.value}
                                            checked={kindFilter === option.value}
                                            className={cn("prompt-filter-tag", kindFilter === option.value && "is-active")}
                                            onChange={() => {
                                                setPage(1);
                                                setKindFilter(option.value as AssetKind | "all");
                                            }}
                                        >
                                            {option.label}
                                        </Tag.CheckableTag>
                                    ))}
                                </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <Select
                                    size="small"
                                    value={sortKey}
                                    options={sortOptions}
                                    className="w-[132px]"
                                    onChange={(value) => {
                                        setPage(1);
                                        setSortKey(value as SortKey);
                                    }}
                                />
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => void exportAllAssets()}
                                >
                                    导出素材
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => assetInputRef.current?.click()}
                                >
                                    导入素材
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={openCreate}
                                >
                                    新增素材
                                </button>
                            </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                            <div className="text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                            <div className="thin-scrollbar flex max-h-[112px] flex-wrap gap-2 overflow-y-auto pr-1">
                                {["", ...categories].map((category) => (
                                    <Tag.CheckableTag key={category || "all"} checked={categoryFilter === category} className={cn("prompt-filter-tag", categoryFilter === category && "is-active")} onChange={() => {
                                        setPage(1);
                                        setCategoryFilter(category);
                                    }}>
                                        {category || "全部"}
                                    </Tag.CheckableTag>
                                ))}
                            </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                            <div className="text-xs font-medium text-stone-500 dark:text-stone-400">标签</div>
                            <div className="thin-scrollbar flex max-h-[112px] flex-wrap items-center gap-2 overflow-y-auto pr-1">
                                <Tag.CheckableTag checked={tagFilters.length === 0} className={cn("prompt-filter-tag", tagFilters.length === 0 && "is-active")} onChange={() => {
                                    setPage(1);
                                    setTagFilters([]);
                                }}>
                                    全部
                                </Tag.CheckableTag>
                                {tags.map((tag) => (
                                    <Tag.CheckableTag key={tag} checked={tagFilters.includes(tag)} className={cn("prompt-filter-tag", tagFilters.includes(tag) && "is-active")} onChange={() => {
                                        setPage(1);
                                        setTagFilters((items) => items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]);
                                    }}>
                                        {tag}
                                    </Tag.CheckableTag>
                                ))}
                                {tagFilters.length > 1 ? (
                                    <button
                                        type="button"
                                        className={cn("cursor-pointer text-[11px] underline-offset-2 hover:underline", tagMatchAll ? "text-blue-600 dark:text-blue-400" : "text-stone-500 dark:text-stone-400")}
                                        onClick={() => {
                                            setPage(1);
                                            setTagMatchAll((value) => !value);
                                        }}
                                    >
                                        {tagMatchAll ? "需同时匹配所有标签" : "匹配任意一个标签"}
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    {selectedIds.length ? (
                        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-white/90 px-3 py-2 text-sm shadow-sm backdrop-blur dark:border-stone-800 dark:bg-stone-900/90">
                            <span className="font-medium">已选 {selectedIds.length} 项</span>
                            <Button size="small" onClick={toggleSelectPage}>
                                {pageAllSelected ? "取消本页全选" : "全选本页"}
                            </Button>
                            <Button size="small" icon={<TagIcon className="size-3.5" />} onClick={() => setTagDialogOpen(true)}>
                                批量打标签
                            </Button>
                            <Button size="small" onClick={() => void exportSelectedAssets()}>
                                导出选中
                            </Button>
                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => setDeletingAssets(selectedAssets)}>
                                删除选中
                            </Button>
                            <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={() => setSelectedIds([])}>
                                取消选择
                            </Button>
                        </div>
                    ) : null}

                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visibleAssets.map((asset) => (
                            <AssetCard
                                key={asset.id}
                                asset={asset}
                                selected={selectedIds.includes(asset.id)}
                                onToggleSelect={() => toggleSelect(asset.id)}
                                onOpen={() => setPreviewAsset(asset)}
                                onEdit={() => openEdit(asset)}
                                onCopy={copyAssetText}
                                onCopyImage={copyAssetImage}
                                onCopyStorageKey={copyStorageKey}
                                onDownload={downloadAsset}
                                onInsertCanvas={insertIntoCanvas}
                                onDelete={() => setDeletingAssets([asset])}
                            />
                        ))}
                    </div>

                    {!validAssets.length ? (
                        <div className="mx-auto mt-6 max-w-md rounded-2xl border border-dashed border-stone-300 px-6 py-12 text-center dark:border-stone-700">
                            <div className="text-base font-medium text-stone-900 dark:text-stone-100">素材库还是空的</div>
                            <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
                                在画布上右键图片选「存素材」，或把常用提示词、参考图手动添加进来，之后在画布和生成面板里都能直接复用。
                            </p>
                            <Space className="mt-4">
                                <Button type="primary" onClick={openCreate}>
                                    新增素材
                                </Button>
                                <Button onClick={() => assetInputRef.current?.click()}>导入素材包</Button>
                            </Space>
                        </div>
                    ) : !visibleAssets.length ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下没有素材" className="py-20">
                            <Button onClick={clearFilters}>清除筛选条件</Button>
                        </Empty>
                    ) : null}

                    <div className="flex justify-center">
                        <Pagination
                            current={page}
                            pageSize={pageSize}
                            total={sortedAssets.length}
                            showSizeChanger
                            showTotal={(total) => `共 ${total} 个素材`}
                            pageSizeOptions={[12, 24, 48, 96]}
                            onChange={(nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            }}
                        />
                    </div>
                </div>
            </main>

            <AssetFormModal open={isAssetOpen} asset={editingAsset} onClose={() => setIsAssetOpen(false)} />

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onCopyImage={copyAssetImage} onCopyStorageKey={copyStorageKey} onDownload={downloadAsset} onEdit={openEdit} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />

            <Modal title="批量打标签" open={tagDialogOpen} onCancel={() => setTagDialogOpen(false)} onOk={applyBatchTags} okText="添加" cancelText="取消">
                <p className="mb-2 text-sm text-stone-500 dark:text-stone-400">给选中的 {selectedAssets.length} 个素材追加标签，可用逗号或空格分隔多个。</p>
                <Input value={tagDraft} placeholder="例如：角色, 三视图" onChange={(event) => setTagDraft(event.target.value)} onPressEnter={applyBatchTags} />
            </Modal>

            <Modal
                title={deletingAssets.length > 1 ? `删除 ${deletingAssets.length} 个素材` : "删除素材"}
                open={Boolean(deletingAssets.length)}
                onCancel={() => setDeletingAssets([])}
                onOk={confirmDelete}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                {deletingAssets.length > 1 ? `确定删除选中的 ${deletingAssets.length} 个素材吗？删除后会从我的素材中移除。` : `确定删除「${deletingAssets[0]?.title || ""}」吗？删除后会从我的素材中移除。`}
            </Modal>
        </div>
    );
}

function AssetCard({
    asset,
    selected,
    onToggleSelect,
    onOpen,
    onEdit,
    onCopy,
    onCopyImage,
    onCopyStorageKey,
    onDownload,
    onInsertCanvas,
    onDelete,
}: {
    asset: Asset;
    selected: boolean;
    onToggleSelect: () => void;
    onOpen: () => void;
    onEdit: () => void;
    onCopy: (asset: Asset) => void;
    onCopyImage: (asset: Asset) => void;
    onCopyStorageKey: (asset: Asset) => void;
    onDownload: (asset: Asset) => void;
    onInsertCanvas: (asset: Asset) => void;
    onDelete: () => void;
}) {
    const cover = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "");
    const summary = assetSummary(asset);
    const hiddenTagCount = Math.max(0, (asset.tags?.length || 0) - 2);
    const menuItems: MenuProps["items"] = [
        { key: "select", label: selected ? "取消选择" : "选择此素材", onClick: onToggleSelect },
        { type: "divider" as const },
        { key: "edit", icon: <PencilLine className="size-3.5" />, label: "编辑", onClick: onEdit },
        { key: "insertCanvas", icon: <Images className="size-3.5" />, label: "插入画布", onClick: () => onInsertCanvas(asset) },
        ...(asset.kind === "text" ? [{ key: "copy", icon: <Copy className="size-3.5" />, label: "复制文本", onClick: () => onCopy(asset) }] : []),
        ...(asset.kind === "image" ? [{ key: "copyImage", icon: <Copy className="size-3.5" />, label: "复制图片", onClick: () => void onCopyImage(asset) }] : []),
        ...(asset.kind !== "text" ? [{ key: "storageKey", label: "复制 storageKey", onClick: () => void onCopyStorageKey(asset) }] : []),
        ...(asset.kind !== "text" ? [{ key: "download", icon: <Download className="size-3.5" />, label: "下载", onClick: () => onDownload(asset) }] : []),
        { type: "divider" as const },
        { key: "delete", icon: <Trash2 className="size-3.5" />, label: "删除", danger: true, onClick: onDelete },
    ];
    return (
        <Dropdown menu={{ items: menuItems }} trigger={["contextMenu"]}>
            <Card
                hoverable
                className={cn("group relative overflow-hidden transition-shadow", selected && "ring-2 ring-blue-500")}
                styles={{ body: { padding: 0 } }}
                cover={
                    <div className="relative">
                        <button type="button" className="block w-full text-left" onClick={onOpen}>
                            {cover ? (
                                <img
                                    src={cover}
                                    alt={asset.title}
                                    loading="lazy"
                                    decoding="async"
                                    className="aspect-[4/3] w-full bg-stone-100 object-cover dark:bg-stone-900"
                                />
                            ) : asset.kind === "video" ? (
                                <video src={asset.data.url + "#t=0.1"} muted playsInline preload="metadata" className="aspect-[4/3] w-full bg-stone-100 object-cover dark:bg-stone-900" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                            )}
                        </button>
                        <div className={cn("absolute left-2 top-2 transition-opacity", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
                            <Checkbox checked={selected} onChange={onToggleSelect} aria-label="选择素材" />
                        </div>
                        {asset.kind !== "text" ? (
                            <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                                {cardBadge(asset)}
                            </div>
                        ) : null}
                    </div>
                }
            >
                <button type="button" className="block w-full text-left" onClick={onOpen}>
                    <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <Tooltip title={asset.title}>
                                    <h2 className="line-clamp-2 text-sm font-semibold leading-5 text-stone-950 dark:text-stone-100">{asset.title}</h2>
                                </Tooltip>
                                <Typography.Text type="secondary" className="mt-1 block truncate text-xs">
                                    {asset.source || "未标注来源"} · {formatRelative(asset.updatedAt)}
                                </Typography.Text>
                            </div>
                            <Tag className="m-0 shrink-0 text-[11px]">{assetKindLabel(asset.kind)}</Tag>
                        </div>
                        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} className="!mb-0 !mt-2 !text-xs !leading-5">
                            {summary}
                        </Typography.Paragraph>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {(asset.tags || []).slice(0, 2).map((tag) => (
                                <Tag key={tag} className="m-0 text-[11px]">
                                    {tag}
                                </Tag>
                            ))}
                            {hiddenTagCount ? <Tag className="m-0 text-[11px]">+{hiddenTagCount}</Tag> : null}
                            {!asset.tags?.length ? <Tag className="m-0 text-[11px]">无标签</Tag> : null}
                        </div>
                    </div>
                </button>
                <div className="flex items-center gap-2 px-4 pb-4">
                    <Button size="small" onClick={onOpen}>
                        查看
                    </Button>
                    <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                        编辑
                    </Button>
                    {asset.kind === "text" ? (
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                            复制
                        </Button>
                    ) : null}
                    {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" ? (
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(asset)}>
                            下载
                        </Button>
                    ) : null}
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                        删除
                    </Button>
                </div>
            </Card>
        </Dropdown>
    );
}

function AssetDrawer({
    asset,
    onClose,
    onCopy,
    onCopyImage,
    onCopyStorageKey,
    onDownload,
    onEdit,
}: {
    asset: Asset | null;
    onClose: () => void;
    onCopy: (asset: Asset) => void;
    onCopyImage: (asset: Asset) => void;
    onCopyStorageKey: (asset: Asset) => void;
    onDownload: (asset: Asset) => void;
    onEdit: (asset: Asset) => void;
}) {
    const cover = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "") : "";
    const storageKey = asset ? (asset.data as { storageKey?: string }).storageKey : "";
    return (
        <Drawer title="素材详情" open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={cover} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{assetKindLabel(asset.kind)}</Tag>
                            {asset.category ? <Tag color="blue">{asset.category}</Tag> : null}
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            内容
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <video src={asset.data.url} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : asset.kind === "audio" ? (
                            <audio src={asset.data.url} controls className="mt-2 w-full" />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 text-xs dark:border-stone-800">
                        <Typography.Text type="secondary" className="mb-2 block">
                            元信息
                        </Typography.Text>
                        <div className="grid gap-1.5 sm:grid-cols-[80px_minmax(0,1fr)]">
                            <span className="text-stone-500 dark:text-stone-400">来源</span>
                            <span className="break-all">{asset.source || "未标注"}</span>
                            <span className="text-stone-500 dark:text-stone-400">分类</span>
                            <span>{asset.category || "未分类"}</span>
                            <span className="text-stone-500 dark:text-stone-400">创建</span>
                            <span>{formatDateTime(asset.createdAt)}</span>
                            <span className="text-stone-500 dark:text-stone-400">更新</span>
                            <span>{formatDateTime(asset.updatedAt)}</span>
                            <span className="text-stone-500 dark:text-stone-400">体积</span>
                            <span>{formatBytes(assetBytes(asset))}</span>
                            {storageKey ? (
                                <>
                                    <span className="text-stone-500 dark:text-stone-400">storageKey</span>
                                    <span className="flex items-center gap-2 break-all">
                                        <code className="text-[11px]">{storageKey}</code>
                                        <Button size="small" type="link" className="!px-0" onClick={() => void onCopyStorageKey(asset)}>
                                            复制
                                        </Button>
                                    </span>
                                </>
                            ) : null}
                        </div>
                    </div>
                    <Space wrap>
                        <Button type="primary" icon={<PencilLine className="size-4" />} onClick={() => onEdit(asset)}>
                            编辑
                        </Button>
                        {asset.kind === "text" ? (
                            <Button icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                复制文本
                            </Button>
                        ) : null}
                        {asset.kind === "image" ? (
                            <Button icon={<Copy className="size-4" />} onClick={() => void onCopyImage(asset)}>
                                复制图片
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" ? (
                            <Button icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? "下载视频" : asset.kind === "audio" ? "下载音频" : "下载图片"}
                            </Button>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

function assetBytes(asset: Asset) {
    if (asset.kind === "text") return new Blob([asset.data.content || ""]).size;
    return asset.data.bytes || 0;
}

function cardBadge(asset: Asset) {
    if (asset.kind === "image" || asset.kind === "video") return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)}`;
    return formatBytes("bytes" in asset.data ? asset.data.bytes || 0 : 0);
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    if (asset.kind === "audio") return `${formatBytes(asset.data.bytes || 0)} · ${asset.data.mimeType}`;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSearchText(asset: Asset) {
    return [asset.title, asset.source || "", asset.category || "", (asset.tags || []).join(" "), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase();
}

function assetKindLabel(kind: AssetKind) {
    if (kind === "image") return "图片";
    if (kind === "video") return "视频";
    if (kind === "audio") return "音频";
    return "文本";
}

function formatRelative(value?: string) {
    if (!value) return "";
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return "";
    const diff = Date.now() - time;
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    return new Date(time).toLocaleDateString("zh-CN");
}

function formatDateTime(value?: string) {
    if (!value) return "—";
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return "—";
    return new Date(time).toLocaleString("zh-CN", { hour12: false });
}
