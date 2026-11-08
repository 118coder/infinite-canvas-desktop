"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

type CanvasErrorBoundaryProps = {
    children: ReactNode;
    /** 出错占位里显示的名称（如节点类型），仅用于日志与提示 */
    label?: string;
    /** 页面级兜底时的整块替换 UI；不传则渲染紧凑的节点级占位卡片 */
    fallback?: ReactNode;
};

type CanvasErrorBoundaryState = { error: Error | null };

// 节点/页面级错误边界：此前全项目没有任何 ErrorBoundary，某个节点的媒体数据异常
// 抛错时 React 会卸载整棵树，画布直接白屏且没有恢复入口。节点级边界把错误限制在
// 单个节点内（占位卡片 + 重试），页面级兜底边界保证至少有整页错误提示可操作。
export class CanvasErrorBoundary extends Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
    state: CanvasErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): CanvasErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error) {
        console.error("画布渲染失败", this.props.label || "", error);
    }

    render() {
        if (this.state.error) {
            if (this.props.fallback) return this.props.fallback;
            return (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-center">
                    <AlertTriangle className="size-5 shrink-0 text-red-500" />
                    <div className="text-[13px] font-medium text-red-500">节点渲染失败</div>
                    <div className="max-w-full truncate px-1 text-xs text-stone-500 dark:text-stone-400" title={this.state.error.message}>
                        {this.state.error.message}
                    </div>
                    <button
                        type="button"
                        className="shrink-0 rounded-md border border-stone-300 px-2 py-1 text-xs transition-colors hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
                        onClick={() => this.setState({ error: null })}
                    >
                        重试渲染
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
