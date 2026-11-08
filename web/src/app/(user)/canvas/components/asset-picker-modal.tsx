"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, Empty, Input, Modal, Pagination, Tag } from "antd";
import { ImagePlus, Plus, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAssetFilters, recordRecentAssetId, type AssetKindFilter } from "@/hooks/use-asset-filters";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import type { InsertAssetPayload } from "../types";

export type { InsertAssetPayload } from "../types";

export type AssetPickerTab = "my-assets";

type Props = {
    open: boolean;
    defaultTab?: AssetPickerTab;
    onInsert: (payload: InsertAssetPayload) => void;
    onInsertMany?: (payloads: InsertAssetPayload[]) => void;
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, onInsertMany, onClose }: Props) {
    return (
        <Modal title="选择素材" open={open} onCancel={onClose} footer={null} width="min(860px, 94vw)" destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab onInsert={onInsert} onInsertMany={onInsertMany} />
        </Modal>
    );
}

const PAGE_SIZE = 12;

const kindOptions: Array<{ label: string; value: AssetKindFilter }> = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

function AssetFilters({ categories, tags, category, selectedTags, onCategoryChange, onTagsChange }: { categories: string[]; tags: string[]; category: string; selectedTags: string[]; onCategoryChange: (value: string) => void; onTagsChange: (values: string[]) => void }) {
    return (
        <div className="grid gap-3">
            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                <div className="thin-scrollbar flex max-h-[112px] flex-wrap gap-2 overflow-y-auto pr-1">
                    {["", ...categories].map((value) => (
                        <Tag.CheckableTag key={value || "all"} checked={category === value} className={cn("prompt-filter-tag", category === value && "is-active")} onChange={() => onCategoryChange(value)}>
                            {value || "全部"}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">标签</div>
                <div className="thin-scrollbar flex max-h-[112px] flex-wrap gap-2 overflow-y-auto pr-1">
                    <Tag.CheckableTag checked={selectedTags.length === 0} className={cn("prompt-filter-tag", selectedTags.length === 0 && "is-active")} onChange={() => onTagsChange([])}>
                        全部
                    </Tag.CheckableTag>
                    {tags.map((tag) => (
                        <Tag.CheckableTag
                            key={tag}
                            checked={selectedTags.includes(tag)}
                            className={cn("prompt-filter-tag", selectedTags.includes(tag) && "is-active")}
                            onChange={() => onTagsChange(selectedTags.includes(tag) ? selectedTags.filter((value) => value !== tag) : [...selectedTags, tag])}
                        >
                            {tag}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>
        </div>
    );
}

function AssetCover({ asset }: { asset: Asset }) {
    // 订阅缩略图缓存版本，previewUrlFor 命中后触发重渲染
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision, getImagePreviewRevision);
    const mediaUrl = asset.kind === "image" ? asset.data.dataUrl : asset.kind === "video" ? asset.data.url : "";
    const storageKey = asset.kind === "text" ? undefined : asset.data.storageKey;
    const source = `${storageKey || ""}:${mediaUrl}`;
    const cover = asset.coverUrl || mediaUrl;
    const previewKey = `asset-card:${asset.id}`;
    const previewUrl = previewUrlFor(previewKey, source);

    useEffect(() => {
        if (!cover) return;
        void ensureImagePreview(previewKey, cover, storageKey, source).catch(() => undefined);
    }, [cover, previewKey, source, storageKey]);

    if (asset.kind === "video" && cover) return <video src={`${cover}#t=0.1`} muted playsInline preload="metadata" className="aspect-[4/3] w-full object-cover" />;
    return <img src={previewUrl || cover || ""} alt={asset.title} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />;
}

function PickerCard({ asset, selected, selectable, onToggle, onOpen }: { asset: Asset; selected: boolean; selectable: boolean; onToggle: () => void; onOpen: () => void }) {
    return (
        <div className={cn("group relative overflow-hidden rounded-lg border bg-white text-left transition dark:bg-stone-900", selected ? "border-blue-500 ring-2 ring-blue-500/40" : "border-stone-200 hover:border-stone-400 hover:shadow-md dark:border-stone-700 dark:hover:border-stone-500")}>
            <button type="button" className="block w-full cursor-pointer" onClick={onOpen}>
                {asset.kind === "text" ? (
                    <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{asset.data.content}</div>
                ) : asset.kind === "audio" ? (
                    <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{asset.title}</div>
                ) : (
                    <AssetCover asset={asset} />
                )}
                <div className="p-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{asset.title}</span>
                        <Tag className="m-0 shrink-0 text-[10px]">{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "文本"}</Tag>
                    </div>
                </div>
            </button>
            {selectable ? (
                <div className={cn("absolute left-2 top-2 transition-opacity", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
                    <Checkbox checked={selected} onChange={onToggle} aria-label="选择素材" onClick={(event) => event.stopPropagation()} />
                </div>
            ) : null}
        </div>
    );
}

function MyAssetsTab({ onInsert, onInsertMany }: { onInsert: (payload: InsertAssetPayload) => void; onInsertMany?: (payloads: InsertAssetPayload[]) => void }) {
    const { message } = App.useApp();
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const filters = useAssetFilters(
        useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio"), [assets]),
        { pageSize: PAGE_SIZE },
    );
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [createOpen, setCreateOpen] = useState(false);
    const [createKind, setCreateKind] = useState<"text" | "image" | "video" | "audio">("image");
    const [createTitle, setCreateTitle] = useState("");
    const [createText, setCreateText] = useState("");
    const [createUrl, setCreateUrl] = useState("");
    const [saving, setSaving] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    const { keyword, setKeyword, kind, setKind, category, setCategory, selectedTags, setSelectedTags, categories, tagOptions, filtered, items, page, setPage } = filters;

    const buildPayload = (asset: Asset): InsertAssetPayload => {
        if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title, assetId: asset.id, source: "asset" };
        if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, source: "asset" };
        if (asset.kind === "audio") return { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, bytes: asset.data.bytes, mimeType: asset.data.mimeType, durationMs: asset.data.durationMs, source: "asset" };
        return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, source: "asset" };
    };

    const selectedAssets = items.filter((asset) => selectedIds.includes(asset.id));
    const toggleSelect = (assetId: string) => setSelectedIds((current) => (current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]));

    const insertSelected = () => {
        if (!selectedAssets.length) return;
        if (selectedAssets.length === 1) {
            recordRecentAssetId(selectedAssets[0].id);
            onInsert(buildPayload(selectedAssets[0]));
        } else if (onInsertMany) {
            onInsertMany(selectedAssets.map(buildPayload));
        } else {
            selectedAssets.forEach((asset) => {
                recordRecentAssetId(asset.id);
                onInsert(buildPayload(asset));
            });
        }
        setSelectedIds([]);
    };

    const resetCreateForm = () => {
        setCreateTitle("");
        setCreateText("");
        setCreateUrl("");
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const createAsset = async () => {
        const title = createTitle.trim();
        if (!title) {
            message.error("请输入素材名称");
            return;
        }
        setSaving(true);
        try {
            if (createKind === "text") {
                const content = createText.trim();
                if (!content) {
                    message.error("请输入文本内容");
                    return;
                }
                addAsset({ kind: "text", title, coverUrl: "", tags: [], source: "素材选择器", data: { content } });
            } else if (createKind === "image") {
                if (!selectedFile && !createUrl.trim()) {
                    message.error("请选择图片或填写图片 URL");
                    return;
                }
                const stored = selectedFile ? await uploadImage(selectedFile) : null;
                addAsset({
                    kind: "image",
                    title,
                    coverUrl: stored?.url || createUrl.trim(),
                    tags: [],
                    source: "素材选择器",
                    data: stored ? { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } : { dataUrl: createUrl.trim(), width: 0, height: 0, bytes: 0, mimeType: "image/*" },
                });
            } else if (createKind === "video") {
                if (!selectedFile && !createUrl.trim()) {
                    message.error("请选择视频或填写视频 URL");
                    return;
                }
                const stored = selectedFile ? await uploadAssetMediaFile(selectedFile, "asset-video") : null;
                addAsset({
                    kind: "video",
                    title,
                    coverUrl: "",
                    tags: [],
                    source: "素材选择器",
                    data: stored
                        ? { url: stored.url, storageKey: stored.storageKey, width: stored.width || 0, height: stored.height || 0, bytes: stored.bytes, mimeType: stored.mimeType }
                        : { url: createUrl.trim(), width: 0, height: 0, bytes: 0, mimeType: "video/mp4" },
                });
            } else {
                if (!selectedFile && !createUrl.trim()) {
                    message.error("请选择音频或填写音频 URL");
                    return;
                }
                const stored = selectedFile ? await uploadAssetMediaFile(selectedFile, "asset-audio") : null;
                addAsset({
                    kind: "audio",
                    title,
                    coverUrl: "",
                    tags: [],
                    source: "素材选择器",
                    data: stored ? { url: stored.url, storageKey: stored.storageKey, bytes: stored.bytes, mimeType: stored.mimeType, durationMs: stored.durationMs } : { url: createUrl.trim(), mimeType: "audio/mpeg" },
                });
            }
            message.success("素材已新增");
            setCreateOpen(false);
            resetCreateForm();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "新增素材失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索素材"
                    value={keyword}
                    allowClear
                    onChange={(e) => setKeyword(e.target.value)}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag key={opt.value} checked={kind === opt.value} className={cn("prompt-filter-tag", kind === opt.value && "is-active")} onChange={() => setKind(opt.value)}>
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
                {onInsertMany ? (
                    <Button size="small" type={selectedIds.length ? "primary" : "default"} disabled={!selectedIds.length} onClick={insertSelected}>
                        插入所选{selectedIds.length ? `（${selectedIds.length}）` : ""}
                    </Button>
                ) : null}
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => setCreateOpen(true)}>
                    新增素材
                </Button>
            </div>
            <AssetFilters categories={categories} tags={tagOptions} category={category} selectedTags={selectedTags} onCategoryChange={setCategory} onTagsChange={setSelectedTags} />

            {items.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {items.map((asset) => (
                        <PickerCard
                            key={asset.id}
                            asset={asset}
                            selected={selectedIds.includes(asset.id)}
                            selectable={Boolean(onInsertMany) && asset.kind !== "text"}
                            onToggle={() => toggleSelect(asset.id)}
                            onOpen={() => {
                                recordRecentAssetId(asset.id);
                                onInsert(buildPayload(asset));
                            }}
                        />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有素材" className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
            <Modal
                title="新增素材"
                open={createOpen}
                onCancel={() => {
                    setCreateOpen(false);
                    resetCreateForm();
                }}
                onOk={() => void createAsset()}
                okText="保存"
                confirmLoading={saving}
                destroyOnHidden
            >
                <div className="space-y-3 pt-2">
                    <div className="flex gap-2">
                        {[
                            { value: "image" as const, label: "图片" },
                            { value: "text" as const, label: "文本" },
                            { value: "video" as const, label: "视频" },
                            { value: "audio" as const, label: "音频" },
                        ].map((item) => (
                            <Tag.CheckableTag key={item.value} checked={createKind === item.value} className={cn("prompt-filter-tag", createKind === item.value && "is-active")} onChange={() => setCreateKind(item.value)}>
                                {item.label}
                            </Tag.CheckableTag>
                        ))}
                    </div>
                    <Input value={createTitle} placeholder="素材名称" onChange={(event) => setCreateTitle(event.target.value)} />
                    {createKind === "text" ? (
                        <Input.TextArea value={createText} autoSize={{ minRows: 5, maxRows: 10 }} placeholder="文本内容" onChange={(event) => setCreateText(event.target.value)} />
                    ) : (
                        <div className="space-y-2">
                            <input ref={fileInputRef} type="file" accept={createKind === "image" ? "image/*" : createKind === "video" ? "video/*" : "audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"} className="hidden" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
                            <Button icon={<ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()}>
                                {selectedFile ? selectedFile.name : createKind === "image" ? "选择图片" : createKind === "video" ? "选择视频" : "选择音频"}
                            </Button>
                            <Input value={createUrl} placeholder={createKind === "image" ? "图片 URL" : createKind === "video" ? "视频 URL" : "音频 URL"} onChange={(event) => setCreateUrl(event.target.value)} />
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    );
}
