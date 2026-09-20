/**
 * reducer.ts — чистый редьюсер состояния задач.
 *
 * `(state, action, params) → (state, op)`. Валидация живёт внутри редьюсера:
 * структурные проверки + проверки, учитывающие текущее состояние (легальность
 * перехода, висячие/удалённые `blockedBy`, самоблокировка, циклы).
 */

import { isTransitionValid } from "./invariants.ts";
import { detectCycle } from "./graph.ts";
import type { Task, TaskAction, TaskMutationParams, TaskState, TaskStatus } from "./types.ts";

/**
 * Результат редьюсера — закрытый размеченный союз. Добавление новой ветки
 * требует обработать её в компиляторе во всех `switch`.
 */
export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string; unblocked: number[] }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

/**
 * Снять с задачи `task` блокировку от `depId`.
 *
 * Возвращает исходный объект, если снимать нечего, — каскад не плодит
 * копии всей задачи на ровном месте.
 */
function stripBlocker(task: Task, depId: number): Task {
	if (!task.blockedBy?.includes(depId)) return task;
	const kept = task.blockedBy.filter((id) => id !== depId);
	const copy: Task = { ...task };
	if (kept.length > 0) copy.blockedBy = kept;
	else delete copy.blockedBy;
	return copy;
}

export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			// `blockedBy` — только для create; на update он молча игнорировался,
			// что вводило модель в заблуждение. Явно просим аддитивные поля.
			if (params.blockedBy !== undefined) {
				return errorResult(state, "blockedBy is create-only; use addBlockedBy / removeBlockedBy on update");
			}

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };

			// Каскад F8: входящие `blockedBy` на удаляемую задачу снимаем.
			//
			// Без этого delete противоречит собственным запретам редьюсера:
			// `create` (:45) и `addBlockedBy` (:107) отказываются ссылаться на
			// удалённую задачу, но уже существующая ссылка на неё остаётся
			// навсегда. Практика проверена живьём: удаление #8 оставило
			// `blockedBy: #8` у #9, и `selectCurrentTask` перестал считать её
			// разблокированной, хотя блокировщик исчез.
			//
			// Снимаем со ВСЕХ остальных задач, не только с видимых: tombstone
			// может стоять в списке, а ссылка на него быть у кого угодно.
			const unblocked: number[] = [];
			const newTasks = state.tasks.map((t) => {
				if (t.id === current.id) return updated;
				const stripped = stripBlocker(t, current.id);
				if (stripped !== t) unblocked.push(t.id);
				return stripped;
			});

			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject, unblocked },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return { state: { tasks: [], nextId: 1 }, op: { kind: "clear", count } };
		}

		default: {
			// Достижимо только при рантайм-значении вне союза TaskAction (схема
			// StringEnum это отсекает). Защита от падения `execute` на undefined.
			return errorResult(state, `unknown action: ${String(action)}`);
		}
	}
}
