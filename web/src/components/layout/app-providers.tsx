"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { ClientRootInit } from "@/components/layout/client-root-init";
import { getAntThemeConfig } from "@/lib/app-theme";
import { CANVAS_STORAGE_ALERT_EVENT, type CanvasStorageAlert } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUpdateStore } from "@/stores/use-update-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

// 全局监听画布本地存储的保存/读取失败事件，给用户明确的告警而不是静默丢数据。
function CanvasStorageAlerts() {
    const { message } = App.useApp();

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<CanvasStorageAlert>).detail;
            if (!detail) return;
            if (detail.kind === "load-failed") message.error({ content: detail.message, duration: 0 });
            else message.error(detail.message);
        };
        window.addEventListener(CANVAS_STORAGE_ALERT_EVENT, handler);
        return () => window.removeEventListener(CANVAS_STORAGE_ALERT_EVENT, handler);
    }, [message]);

    return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
    const theme = useThemeStore((state) => state.theme);
    const dark = theme === "dark";
    const checkIfDue = useUpdateStore((state) => state.checkIfDue);

    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = theme;
    }, [dark, theme]);

    // 每 24 小时静默检查一次新版本；有新版时设置齿轮显示绿点
    useEffect(() => {
        void checkIfDue();
    }, [checkIfDue]);

    return (
        <ConfigProvider locale={zhCN} theme={getAntThemeConfig(dark)}>
            <App>
                <CanvasStorageAlerts />
                <QueryClientProvider client={queryClient}>
                    <ClientRootInit>{children}</ClientRootInit>
                </QueryClientProvider>
            </App>
        </ConfigProvider>
    );
}
