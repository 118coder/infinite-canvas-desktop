"use client";

import { useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { ActiveConnectionPath, ConnectionPath } from "./canvas-connections";
import { useCommittedScale, useCullKey, viewportStore } from "../stores/use-viewport-store";
import { isHiddenBatchChildFast, isHiddenBatchEndpointFast } from "../utils/canvas-batch-visibility";
import { buildNodeSpatialIndex, queryNodeSpatialIndex, rectsIntersect, viewportWorldRect, type WorldRect } from "../utils/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position, SelectionBox } from "../types";

type ActiveConnection = { connection: CanvasConnection; from: CanvasNodeData; to: CanvasNodeData };
type HitConnection = { connection: CanvasConnection; path: string };

type CanvasStageProps = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    nodeById: Map<string, CanvasNodeData>;
    theme: CanvasTheme;
    screenWidth: number;
    screenHeight: number;
    selectedConnectionId: string | null;
    relatedConnectionIds: Set<string>;
    connectingParams: ConnectionHandle | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    selectionBox: SelectionBox | null;
    collapsingBatchIds: Set<string>;
    onSelectConnection: (connectionId: string) => void;
    onConnectionContextMenu: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
    renderNode: (node: CanvasNodeData, scale: number, lightweight: boolean) => ReactNode;
    children?: ReactNode;
};

// 双阈值迟滞：进入轻量态要低于 0.4，退出要高于 0.55。
// 单阈值或按节点数量判定，都会在反复缩放经过边界时来回替换整套节点 DOM，表现为画面闪烁。
const LIGHTWEIGHT_ENTER_SCALE = 0.4;
const LIGHTWEIGHT_EXIT_SCALE = 0.55;

/**
 * 画布世界层的渲染子树。它单独订阅视口的裁剪 tick 与提交后的缩放，
 * 因此平移/缩放手势不会再重渲染 6000 多行的画布页主体。
 */
export function CanvasStage({ nodes, connections, nodeById, theme, screenWidth, screenHeight, selectedConnectionId, relatedConnectionIds, connectingParams, mouseWorld, connectionTargetNodeId, selectionBox, collapsingBatchIds, onSelectConnection, onConnectionContextMenu, renderNode, children }: CanvasStageProps) {
    const cullKey = useCullKey();
    const scale = useCommittedScale();
    const lightweightRef = useRef(false);
    const index = useMemo(() => buildNodeSpatialIndex(nodes), [nodes]);

    const { rect, visibleNodes } = useMemo(() => {
        const current = viewportWorldRect(viewportStore.getLive(), screenWidth, screenHeight);
        const visible = queryNodeSpatialIndex(index, current, nodes).filter((node) => !isHiddenBatchChildFast(node, nodeById, collapsingBatchIds));
        return { rect: current, visibleNodes: visible };
        // cullKey / scale 是视口变化的提交信号；live 视口在回调里读取，避免每帧进 state。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index, nodes, nodeById, collapsingBatchIds, cullKey, scale, screenWidth, screenHeight]);

    const { normalPath, hitConnections, activeConnections } = useMemo(() => collectConnections({ connections, nodeById, rect, selectedConnectionId, relatedConnectionIds }), [connections, nodeById, rect, selectedConnectionId, relatedConnectionIds]);
    // 用 live 缩放判定，缩放手势跨过阈值时立即切到瓦片，不会在手势中继续挂载完整节点；
    // 平移时 k 不变，判定保持稳定。传给节点的 scale 仍是 committed 值，避免手势中反复换档解码。
    // 手势期间冻结节点形态：跨过阈值也不在拖拽/缩放途中增删装饰元素，
    // 等手势结束的 commit 再一次性切换，避免画面出现"刷新"感。
    if (!viewportStore.isGestureActive()) {
        const liveScale = viewportStore.getLive().k;
        lightweightRef.current = lightweightRef.current ? liveScale < LIGHTWEIGHT_EXIT_SCALE : liveScale < LIGHTWEIGHT_ENTER_SCALE;
    }
    const lightweight = lightweightRef.current;

    return (
        <>
            <svg
                className="pointer-events-none absolute overflow-visible"
                style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, zIndex: 6 }}
                viewBox={`${rect.left} ${rect.top} ${rect.width} ${rect.height}`}
            >
                {/* 未激活连线合并成一条 path，避免逐条组件与巨型 SVG 图层。 */}
                {normalPath ? <path d={normalPath} stroke={theme.node.muted} strokeWidth="2" strokeOpacity="0.82" fill="none" pointerEvents="none" /> : null}
                {hitConnections.map(({ connection, path }) => (
                    <path
                        key={connection.id}
                        data-connection-id={connection.id}
                        d={path}
                        stroke="transparent"
                        strokeWidth="16"
                        fill="none"
                        style={{ cursor: "pointer", pointerEvents: "stroke" }}
                        onClick={(event) => {
                            event.stopPropagation();
                            onSelectConnection(connection.id);
                        }}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onConnectionContextMenu(event, connection.id);
                        }}
                    />
                ))}
                {activeConnections.map(({ connection, from, to }) => (
                    <ConnectionPath
                        key={connection.id}
                        connection={connection}
                        from={from}
                        to={to}
                        active
                        onSelect={() => onSelectConnection(connection.id)}
                        onContextMenu={(event) => onConnectionContextMenu(event, connection.id)}
                    />
                ))}
                {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
            </svg>

            {visibleNodes.map((node) => renderNode(node, scale, lightweight))}

            {selectionBox ? (
                <svg
                    className="pointer-events-none absolute z-[100] overflow-visible"
                    style={{
                        left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                        top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                        width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                        height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                    }}
                >
                    <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeWidth={1.5 / scale} strokeDasharray={`${10 / scale} ${6 / scale}`} />
                </svg>
            ) : null}
            {children}
        </>
    );
}

function collectConnections({ connections, nodeById, rect, selectedConnectionId, relatedConnectionIds }: { connections: CanvasConnection[]; nodeById: Map<string, CanvasNodeData>; rect: WorldRect; selectedConnectionId: string | null; relatedConnectionIds: Set<string> }) {
    const normalParts: string[] = [];
    const hitConnections: HitConnection[] = [];
    const activeConnections: ActiveConnection[] = [];

    connections.forEach((connection) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        if (!from || !to || isHiddenBatchEndpointFast(from, nodeById) || isHiddenBatchEndpointFast(to, nodeById)) return;

        const startX = from.position.x + from.width;
        const startY = from.position.y + from.height / 2;
        const endX = to.position.x;
        const endY = to.position.y + to.height / 2;
        const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
        const segment = {
            left: Math.min(startX, endX) - curvature,
            right: Math.max(startX, endX) + curvature,
            top: Math.min(startY, endY),
            bottom: Math.max(startY, endY),
        };
        if (!rectsIntersect(segment, rect)) return;

        const path = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
        if (selectedConnectionId === connection.id || relatedConnectionIds.has(connection.id)) {
            activeConnections.push({ connection, from, to });
        } else {
            normalParts.push(path);
            hitConnections.push({ connection, path });
        }
    });

    return { normalPath: normalParts.join(" "), hitConnections, activeConnections };
}
