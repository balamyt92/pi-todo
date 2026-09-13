/**
 * invariants.ts — допустимые переходы статусов задачи.
 *
 * `completed` — односторонний переход в `deleted` (назад в `in_progress`
 * нельзя); `deleted` — терминальное состояние.
 */

import type { TaskStatus } from "./types.ts";

export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

/** Идемпотентный переход same→same разрешён, остальные — по таблице. */
export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
