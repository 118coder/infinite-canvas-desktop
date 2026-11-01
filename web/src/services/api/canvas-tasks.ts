import { apiPost } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

export async function stopCanvasTask(kind: "image" | "video" | "audio", id: string, workflow: boolean, source: "canvas" | "video-workbench" = "canvas") {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再停止云端任务");
    return apiPost<{ stopped: boolean }>("/api/v1/canvas/tasks/stop", { kind, id, workflow, source }, token);
}
