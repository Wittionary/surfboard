// Constants derived from spec §5, §8, and §11.

import type { WorkItemType, SyncStatus } from "./types.ts";

export const API_VERSION = "surfboard.ado/v1" as const;

export const ADO_API_VERSION_DEFAULT = "7.1" as const;

export const WORK_ITEM_TYPES: readonly WorkItemType[] = [
  "Epic",
  "Feature",
  "PBI",
  "Enabler",
  "Task",
] as const;

// Spec §5.4 parent matrix. Empty array = root, no parent allowed.
export const PARENT_MATRIX: Record<WorkItemType, readonly WorkItemType[]> = {
  Epic: [],
  Feature: ["Epic"],
  PBI: ["Feature"],
  Enabler: ["Feature"],
  Task: ["PBI", "Enabler"],
};

export const WORK_ITEM_KINDS_REQUIRING_PARENT: readonly WorkItemType[] = [
  "Feature",
  "PBI",
  "Enabler",
  "Task",
] as const;

export const SYNC_STATUSES: readonly SyncStatus[] = [
  "local_only",
  "synced",
  "local_changed",
  "remote_changed",
  "conflict_blocked",
  "validation_failed",
  "push_failed",
  "pull_failed",
  "deleted_remotely",
] as const;

// Spec §8.7 hotkeys. Combinations chosen to avoid common browser defaults.
export type HotkeyAction =
  | "push_all_displayed"
  | "pull_all_displayed"
  | "push_selected_row"
  | "pull_selected_row"
  | "refresh_validate";

export const HOTKEYS: Record<HotkeyAction, { alt: true; shift: true; key: string }> = {
  push_all_displayed: { alt: true, shift: true, key: "U" },
  pull_all_displayed: { alt: true, shift: true, key: "I" },
  push_selected_row: { alt: true, shift: true, key: "J" },
  pull_selected_row: { alt: true, shift: true, key: "K" },
  refresh_validate: { alt: true, shift: true, key: "V" },
};

// Field reference names that the app treats specially or always considers required.
export const SYSTEM_TITLE_FIELD = "System.Title" as const;
export const SYSTEM_TAGS_FIELD = "System.Tags" as const;
export const SYSTEM_REV_FIELD = "System.Rev" as const;
export const SYSTEM_STATE_FIELD = "System.State" as const;
export const SYSTEM_PARENT_FIELD = "System.Parent" as const;

export const HIERARCHY_REVERSE_REL = "System.LinkTypes.Hierarchy-Reverse" as const;
export const HIERARCHY_FORWARD_REL = "System.LinkTypes.Hierarchy-Forward" as const;

export const ADO_PATCH_MEDIA_TYPE = "application/json-patch+json" as const;

export const DEFAULT_SERVER_HOST = "127.0.0.1" as const;
export const DEFAULT_SERVER_PORT = 3000;

export const SQLITE_FILE_RELATIVE = ".surfboard/surfboard.db" as const;

export const APP_VERSION = "0.1.0" as const;
