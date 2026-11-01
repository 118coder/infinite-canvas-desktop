"use client";

import { create } from "zustand";

import type { AuthUser } from "@/services/api/auth";

// 本地版没有账号体系：永远处于未登录状态，AI 请求走浏览器直连渠道
export const useUserStore = create<{ token: string; user: AuthUser | null; isReady: boolean }>(() => ({
    token: "",
    user: null,
    isReady: true,
}));
