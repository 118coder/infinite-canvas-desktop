import { localForageStorage } from "@/lib/localforage-storage";
import { CanvasNodeType, type CanvasNodeData } from "../types";

/**
 * 隐藏图片是"视图偏好"，不属于画布数据：
 * 单独按项目存放在 localforage，不写进 nodes / project，也不进导出包与撤销历史。
 * 隐藏的节点不挂载到画布、不参与连线/框选/适应视图/排版，也不再排队生成预览档位，
 * 因此能真正降低大量图片的重复渲染与解码压力。
 */

const KEY_PREFIX = "infinite-canvas:hidden:";
const SAVE_DELAY = 400;
export const EMPTY_HIDDEN_IDS: ReadonlySet<string> = new Set<string>();

const hiddenByProject = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function subscribeHiddenNodes(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getHiddenNodeIds(projectId: string): ReadonlySet<string> {
    return hiddenByProject.get(projectId) || EMPTY_HIDDEN_IDS;
}

export async function loadHiddenNodeIds(projectId: string): Promise<void> {
    try {
        const raw = await localForageStorage.getItem(`${KEY_PREFIX}${projectId}`);
        const ids = raw ? (JSON.parse(raw) as unknown) : null;
        if (Array.isArray(ids)) {
            hiddenByProject.set(projectId, new Set(ids.filter((id): id is string => typeof id === "string")));
        } else if (!hiddenByProject.has(projectId)) {
            hiddenByProject.set(projectId, new Set());
        }
    } catch {
        if (!hiddenByProject.has(projectId)) hiddenByProject.set(projectId, new Set());
    }
    listeners.forEach((listener) => listener());
}

function commit(projectId: string, next: Set<string>) {
    hiddenByProject.set(projectId, next);
    listeners.forEach((listener) => listener());
    const existing = timers.get(projectId);
    if (existing) clearTimeout(existing);
    timers.set(projectId, setTimeout(() => {
        timers.delete(projectId);
        const value = hiddenByProject.get(projectId);
        if (!value) return;
        const write = () => void Promise.resolve(localForageStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify([...value]))).catch(() => undefined);
        if (typeof requestIdleCallback === "function") requestIdleCallback(write, { timeout: 1000 });
        else setTimeout(write, 0);
    }, SAVE_DELAY));
}

export function addHiddenNodeIds(projectId: string, ids: Iterable<string>) {
    const next = new Set(getHiddenNodeIds(projectId));
    let changed = false;
    for (const id of ids) {
        if (!next.has(id)) {
            next.add(id);
            changed = true;
        }
    }
    if (changed) commit(projectId, next);
}

export function removeHiddenNodeIds(projectId: string, ids: Iterable<string>) {
    const next = new Set(getHiddenNodeIds(projectId));
    let changed = false;
    for (const id of ids) {
        if (next.delete(id)) changed = true;
    }
    if (changed) commit(projectId, next);
}

export function clearHiddenNodeIds(projectId: string) {
    if (getHiddenNodeIds(projectId).size) commit(projectId, new Set<string>());
}

/** 节点自身或其所属的组/图片组被隐藏时，都不参与渲染与交互。 */
export function isNodeHiddenFast(node: CanvasNodeData, hiddenIds: ReadonlySet<string>): boolean {
    if (!hiddenIds.size) return false;
    if (hiddenIds.has(node.id)) return true;
    const groupId = node.metadata?.groupId;
    if (groupId && hiddenIds.has(groupId)) return true;
    const batchRootId = node.metadata?.batchRootId;
    return Boolean(batchRootId && hiddenIds.has(batchRootId));
}

/** 连线的任一端被隐藏，整条线都不画，避免出现"连到空气"的线。 */
export function isHiddenConnectionEndpointFast(from: CanvasNodeData, to: CanvasNodeData, hiddenIds: ReadonlySet<string>, nodeById: Map<string, CanvasNodeData>): boolean {
    if (!hiddenIds.size) return false;
    if (isNodeHiddenFast(from, hiddenIds) || isNodeHiddenFast(to, hiddenIds)) return true;
    // 图片组根节点虽未被单独勾选，但子图全部隐藏时也不该留下连到空框的线（O(子图数)）
    const batchEmpty = (node: CanvasNodeData) => Boolean(node.metadata?.isBatchRoot && node.metadata?.batchChildIds?.length && !node.metadata.batchChildIds.some((id) => {
        const child = nodeById.get(id);
        return child && !isNodeHiddenFast(child, hiddenIds);
    }));
    return Boolean(batchEmpty(from) || batchEmpty(to));
}

/**
 * 右键菜单的"单张隐藏"只勾选命中的节点；"整组隐藏"会把组框/批次根节点
 * 及其全部成员一起记入隐藏集合，保证展开/收起状态回来时仍整组隐藏。
 */
export function resolveHideTargets(targetIds: Iterable<string>, nodes: CanvasNodeData[], wholeGroup: boolean): Set<string> {
    const ids = new Set(targetIds);
    if (!wholeGroup) return ids;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const id of [...ids]) {
        const node = nodeById.get(id);
        if (!node) continue;
        const rootId = node.metadata?.groupId || node.metadata?.batchRootId || (node.metadata?.isBatchRoot || node.type === CanvasNodeType.Group ? node.id : "");
        if (!rootId) continue;
        ids.add(rootId);
        const root = nodeById.get(rootId);
        root?.metadata?.batchChildIds?.forEach((childId) => ids.add(childId));
        nodes.forEach((candidate) => {
            if (candidate.metadata?.groupId === rootId || candidate.metadata?.batchRootId === rootId) ids.add(candidate.id);
        });
    }
    return ids;
}
