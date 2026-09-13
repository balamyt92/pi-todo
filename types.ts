/**
 * types.ts — доменные типы, схема параметра тула и строковые константы.
 *
 * Формат данных намеренно совместим с @juicesharp/rpiv-todo: имя тула `todo`
 * и форма `TaskDetails` не менялись, поэтому уже накопленная история сессий
 * проигрывается (`replay.ts`) без конвертации.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Идентичность расширения в Pi
// ---------------------------------------------------------------------------

/** Имя тула — канонический ключ фильтра при replay по ветке. Не переименовывать. */
export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";

/** Слэш-команда: развёрнутый список задач в чате. */
export const LIST_COMMAND_NAME = "todos";

/** Слэш-команда: переключение свёрнутый/развёрнутый режим виджета. */
export const TOGGLE_COMMAND_NAME = "todos-toggle-widget";

/**
 * Горячая клавиша переключения режима по умолчанию.
 * `ctrl+t` в Pi занят под `app.thinking.toggle`, поэтому используется
 * `ctrl+shift+t`. Меняется в одном месте — отсюда.
 */
export const TOGGLE_SHORTCUT = "ctrl+shift+t";

/** Ключ слота виджета в `ctx.ui.setWidget`. */
export const WIDGET_KEY = "pi-todo";

/** Максимум строк развёрнутого виджета, включая заголовок. */
export const MAX_EXPANDED_LINES = 12;

// ---------------------------------------------------------------------------
// Предметные типы
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Снимок состояния, который каждый успешный вызов `todo` возвращает в
 * `details`. `replay.ts` читает последний такой снимок из ветки, чтобы
 * восстановить состояние. Порядок и имена полей зафиксированы ради
 * совместности между версиями.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/** Каноническое состояние todo-списка — единственный источник истины. */
export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/**
 * «Открытый» набор входных полей, который принимает редьюсер. Index-сигнатура
 * `[key: string]: unknown` нужна, чтобы рантайм мог передавать
 * `Static<typeof TodoParamsSchema>` без кастов.
 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
}

// ---------------------------------------------------------------------------
// Схема параметров тула. Каждое `description` — это текст для модели.
// ---------------------------------------------------------------------------

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
