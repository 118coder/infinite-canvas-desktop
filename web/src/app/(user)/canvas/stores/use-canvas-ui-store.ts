import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CanvasNodeMetadata, CanvasNodeType } from "../types";

type CanvasUiStore = {
    generationDefaults: Partial<Record<CanvasNodeType.Image | CanvasNodeType.Video, Pick<CanvasNodeMetadata, "quality" | "size" | "vquality">>>;
    gridSpacing: number;
    minimapOpen: boolean;
    openProjectId: string | null;
    editingProjectId: string | null;
    editingProjectTitle: string;
    selectedProjectIds: string[];
    deleteProjectIds: string[];
    setGridSpacing: (gridSpacing: number) => void;
    setMinimapOpen: (minimapOpen: boolean) => void;
    setOpenProjectId: (openProjectId: string | null) => void;
    startEditingProject: (id: string, title: string) => void;
    setEditingProjectTitle: (title: string) => void;
    stopEditingProject: () => void;
    toggleSelectedProjectId: (id: string, selected: boolean) => void;
    setDeleteProjectIds: (ids: string[]) => void;
    removeSelectedProjectIds: (ids: string[]) => void;
};

export const useCanvasUiStore = create<CanvasUiStore>()(persist((set) => ({
    generationDefaults: {},
    gridSpacing: 48,
    minimapOpen: false,
    openProjectId: null,
    editingProjectId: null,
    editingProjectTitle: "",
    selectedProjectIds: [],
    deleteProjectIds: [],
    setGridSpacing: (gridSpacing) => set({ gridSpacing }),
    setMinimapOpen: (minimapOpen) => set({ minimapOpen }),
    setOpenProjectId: (openProjectId) => set({ openProjectId }),
    startEditingProject: (editingProjectId, editingProjectTitle) => set({ editingProjectId, editingProjectTitle }),
    setEditingProjectTitle: (editingProjectTitle) => set({ editingProjectTitle }),
    stopEditingProject: () => set({ editingProjectId: null }),
    toggleSelectedProjectId: (id, selected) => set((state) => ({ selectedProjectIds: selected ? [...new Set([...state.selectedProjectIds, id])] : state.selectedProjectIds.filter((item) => item !== id) })),
    setDeleteProjectIds: (deleteProjectIds) => set({ deleteProjectIds }),
    removeSelectedProjectIds: (ids) => set((state) => ({ selectedProjectIds: state.selectedProjectIds.filter((id) => !ids.includes(id)) })),
}), {
    name: "infinite-canvas:canvas_ui_store",
    partialize: (state) => ({ generationDefaults: state.generationDefaults, gridSpacing: state.gridSpacing, minimapOpen: state.minimapOpen }),
}));
