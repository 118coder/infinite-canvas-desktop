"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Download, Maximize, Pause, Play, Volume2, VolumeX, X } from "lucide-react";

const CanvasPanoramaViewer = dynamic(() => import("./canvas-panorama-viewer"), { ssr: false, loading: () => null });

const VIDEO_PREVIEW_CONTROL_CLASS = "flex size-9 items-center justify-center rounded-lg text-white transition-colors hover:bg-white/10";

export function FullscreenPreview({ src, alt, isVideo, isPanorama, proxyGeneratedPanorama = false, onDownload, onClose, hasPrev, hasNext, onPrev, onNext }: { src: string; alt: string; isVideo?: boolean; isPanorama?: boolean; proxyGeneratedPanorama?: boolean; onDownload: () => void; onClose: () => void; hasPrev?: boolean; hasNext?: boolean; onPrev?: () => void; onNext?: () => void }) {
    const [zoom, setZoom] = useState<number>(1);
    const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState<boolean>(false);
    const [videoDuration, setVideoDuration] = useState(0);
    const [videoTime, setVideoTime] = useState(0);
    const [isVideoPlaying, setIsVideoPlaying] = useState(false);
    const [videoVolume, setVideoVolume] = useState(1);
    const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({ x: 0, y: 0, panX: 0, panY: 0 });
    const imgRef = useRef<HTMLImageElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const videoPlayerRef = useRef<HTMLDivElement>(null);

    const toggleVideoPlayback = () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play();
        else video.pause();
    };

    useEffect(() => {
        if (!isVideo) return;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        videoRef.current?.focus({ preventScroll: true });
        return () => previousFocus?.focus({ preventScroll: true });
    }, [isVideo]);

    useEffect(() => {
        const el = imgRef.current;
        if (!el) return;
        el.addEventListener("wheel", handleWheel, { passive: false });
        return () => el.removeEventListener("wheel", handleWheel);
    });

    const handleWheel = (e: WheelEvent) => {
        e.stopPropagation();
        e.preventDefault();
        setZoom((z) => {
            const next = Math.max(0.2, Math.min(8, z - e.deltaY * 0.001));
            if (next <= 1) setPanOffset({ x: 0, y: 0 });
            return next;
        });
    };

    const handlePointerDown = (e: ReactPointerEvent) => {
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY, panX: panOffset.x, panY: panOffset.y };
    };

    const handlePointerMove = (e: ReactPointerEvent) => {
        if (!isDragging) return;
        e.preventDefault();
        setPanOffset({
            x: dragStartRef.current.panX + (e.clientX - dragStartRef.current.x),
            y: dragStartRef.current.panY + (e.clientY - dragStartRef.current.y),
        });
    };

    const handlePointerUp = (e: ReactPointerEvent) => {
        setIsDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
    };

    return (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/80 backdrop-blur-sm" data-canvas-no-zoom={isPanorama ? "" : undefined} onClick={onClose}>
            {hasPrev || hasNext ? (
                <>
                    <button
                        type="button"
                        disabled={!hasPrev}
                        onClick={(e) => { e.stopPropagation(); onPrev?.(); }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="absolute left-4 top-1/2 z-[2010] -translate-y-1/2 flex size-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition-all hover:bg-white/10 hover:scale-105 active:scale-95 disabled:opacity-20 disabled:cursor-not-allowed"
                    >
                        <ChevronLeft className="size-6" />
                    </button>
                    <button
                        type="button"
                        disabled={!hasNext}
                        onClick={(e) => { e.stopPropagation(); onNext?.(); }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="absolute right-4 top-1/2 z-[2010] -translate-y-1/2 flex size-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition-all hover:bg-white/10 hover:scale-105 active:scale-95 disabled:opacity-20 disabled:cursor-not-allowed"
                    >
                        <ChevronRight className="size-6" />
                    </button>
                </>
            ) : null}
            {isPanorama ? (
                <div className="h-[85vh] w-[85vw] supports-[height:round(1px,1px)]:h-[round(85vh,1px)] supports-[height:round(1px,1px)]:w-[round(85vw,1px)] overflow-hidden rounded-2xl shadow-[0_24px_72px_rgba(0,0,0,0.4)]" onClick={(event) => event.stopPropagation()}>
                    <CanvasPanoramaViewer src={src} alt={alt} proxyGeneratedPanorama={proxyGeneratedPanorama} immersive />
                </div>
            ) : isVideo ? (
                <div
                    ref={videoPlayerRef}
                    className="relative flex max-h-[85vh] max-w-[85vw] items-center justify-center overflow-hidden rounded-2xl bg-black shadow-[0_24px_72px_rgba(0,0,0,0.4)] fullscreen:h-screen fullscreen:w-screen fullscreen:max-h-none fullscreen:max-w-none fullscreen:rounded-none [&:fullscreen>video]:h-screen [&:fullscreen>video]:w-screen [&:fullscreen>video]:max-h-none [&:fullscreen>video]:max-w-none"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDownCapture={(event) => {
                        if (event.code !== "Space") return;
                        event.preventDefault();
                        event.stopPropagation();
                        toggleVideoPlayback();
                    }}
                    data-canvas-no-zoom
                >
                    <video
                        ref={videoRef}
                        src={src}
                        aria-label={alt}
                        tabIndex={-1}
                        playsInline
                        preload="metadata"
                        onLoadStart={() => { setVideoDuration(0); setVideoTime(0); setIsVideoPlaying(false); }}
                        onDurationChange={(event) => setVideoDuration(event.currentTarget.duration)}
                        onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)}
                        onPlay={() => setIsVideoPlaying(true)}
                        onPause={() => setIsVideoPlaying(false)}
                        onVolumeChange={(event) => setVideoVolume(event.currentTarget.muted ? 0 : event.currentTarget.volume)}
                        onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                        className="block max-h-[85vh] max-w-[85vw] object-contain outline-none"
                    />
                    <button type="button" aria-label="关闭预览" onClick={onClose} className="absolute right-4 top-4 z-20 flex size-9 items-center justify-center rounded-lg text-white transition-colors hover:bg-black/25">
                        <X className="size-6" />
                    </button>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-5 pb-3 pt-24">
                        <div className="mb-2 flex justify-between text-xs font-medium tabular-nums text-white">
                            <span>{formatPreviewTime(videoTime)}</span>
                            <span>{formatPreviewTime(videoDuration)}</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={videoDuration || 0}
                            step="0.01"
                            value={Math.min(videoTime, videoDuration || 0)}
                            aria-label="视频进度"
                            onChange={(event) => {
                                const time = Number(event.currentTarget.value);
                                if (videoRef.current) videoRef.current.currentTime = time;
                                setVideoTime(time);
                            }}
                            onPointerUp={() => videoRef.current?.focus({ preventScroll: true })}
                            className="pointer-events-auto block h-1 w-full cursor-pointer appearance-none rounded-full focus-visible:outline-none [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                            style={{ background: `linear-gradient(to right, #67e8f9 ${videoDuration ? Math.min(videoTime / videoDuration, 1) * 100 : 0}%, rgba(255,255,255,0.35) 0)` }}
                        />
                        <div className="pointer-events-auto mt-2 flex items-center justify-between">
                            <div className="flex items-center gap-1">
                                <button type="button" aria-label={isVideoPlaying ? "暂停" : "播放"} onPointerDown={(event) => event.preventDefault()} onClick={toggleVideoPlayback} className={VIDEO_PREVIEW_CONTROL_CLASS}>
                                    {isVideoPlaying ? <Pause className="size-5" /> : <Play className="size-5" />}
                                </button>
                                <div className="group/volume flex items-center">
                                    <button type="button" aria-label={videoVolume === 0 ? "恢复声音" : "静音"} onPointerDown={(event) => event.preventDefault()} onClick={() => { if (videoRef.current) videoRef.current.muted = !videoRef.current.muted; }} className={VIDEO_PREVIEW_CONTROL_CLASS}>
                                        {videoVolume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
                                    </button>
                                    <input type="range" min={0} max={1} step="0.01" value={videoVolume} aria-label="音量" onChange={(event) => { const volume = Number(event.currentTarget.value); if (!videoRef.current) return; if (volume === 0) videoRef.current.muted = true; else { videoRef.current.volume = volume; videoRef.current.muted = false; } }} onPointerUp={() => videoRef.current?.focus({ preventScroll: true })} className="h-1 w-0 pointer-events-none cursor-pointer appearance-none rounded-full opacity-0 transition-[width,opacity] duration-200 focus-visible:outline-none group-hover/volume:mx-1 group-hover/volume:w-20 group-hover/volume:pointer-events-auto group-hover/volume:opacity-100 [&::-moz-range-thumb]:size-2 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white" style={{ background: `linear-gradient(to right, white ${videoVolume * 100}%, rgba(255,255,255,0.35) 0)` }} />
                                </div>
                            </div>
                            <div className="flex items-center gap-1">
                                <button type="button" aria-label="下载视频" onPointerDown={(event) => event.preventDefault()} onClick={onDownload} className={VIDEO_PREVIEW_CONTROL_CLASS}>
                                    <Download className="size-5" />
                                </button>
                                <button type="button" aria-label="全屏播放" onPointerDown={(event) => event.preventDefault()} onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void videoPlayerRef.current?.requestFullscreen(); }} className={VIDEO_PREVIEW_CONTROL_CLASS}>
                                    <Maximize className="size-5" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <img
                    ref={imgRef}
                    src={src}
                    alt={alt}
                    draggable={false}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    className={`max-h-[85vh] max-w-[85vw] object-contain rounded-2xl shadow-[0_24px_72px_rgba(0,0,0,0.4)] ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
                    onClick={(e) => e.stopPropagation()}
                    onDragStart={(e) => e.preventDefault()}
                    style={{
                        transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                        transition: isDragging ? "none" : "transform 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                />
            )}
        </div>
    );
}

function formatPreviewTime(value: number) {
    if (!Number.isFinite(value)) return "0:00";
    const seconds = Math.floor(value);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
