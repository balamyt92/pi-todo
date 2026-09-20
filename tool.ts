/**
 * tool.ts — регистрация тула `todo`.
 *
 * execute: редьюсер → коммит в store → конверт ответа модели.
 * renderCall / renderResult — человекочитаемая отрисовка в транскрипте.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderTodoCall, renderTodoResult } from "./format.ts";
import { applyTaskMutation } from "./reducer.ts";
import { buildToolResult } from "./response.ts";
import { commitState, getState } from "./store.ts";
import { EMPTY_STATE, TOOL_LABEL, TOOL_NAME, TodoParamsSchema, type TaskMutationParams } from "./types.ts";

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

export function registerTodoTool(
	pi: ExtensionAPI,
	/**
	 * Идентификатор сессии, которой принадлежит ЭТОТ рантайм расширения.
	 * Захватывается в factory-замыкании на `session_start` (см. `index.ts`).
	 * Нужен потому, что `renderCall` не получает `ctx` — единственный способ
	 * узнать, чей список рисовать.
	 */
	getOwnSessionId: () => string | undefined,
): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		/*
		 * Почему ошибки валидации НЕ бросаются.
		 *
		 * Документация pi: флаг `isError` ставит только `throw` из `execute`;
		 * возврат значения его не ставит никогда. Здесь отклонённая операция
		 * возвращается как `op.kind === "error"` с текстом `Error: ...` в
		 * `content` и `details.error`.
		 *
		 * Это вынужденная сделка, а не oversight. При `throw` мы теряем
		 * `details` — а именно в `details` лежит канонический снимок `tasks`/`nextId`,
		 * из которого `replay.ts` восстанавливает состояние при перезапуске,
		 * вилке и `/tree`. Бросок означал бы, что отклонённый вызов не пишет
		 * снимок, и replay промахнулся бы на одну операцию назад.
		 *
		 * Компоновка сигналов при этом не ломается:
		 *   - модель получает недвусмысленный `Error: <причина>` в content;
		 *   - `renderTodoResult` рисует `✗ <причина>` и СОЗНАТЕЛЬНО не показывает
		 *     статус, вычисленный из неизменённого состояния (иначе отклонённый
		 *     update с `params.status` выглядел бы как применённый);
		 *   - `overlay.update()` на `tool_execution_end` вызывается только при
		 *     `!event.isError`, поэтому отклонённая операция не дёргает виджет.
		 *
		 * Если будете «чинить» это на `throw` — вместе с снимком в `details`
		 * сломается replay. Правка должна сохранять `details`.
		 */

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as TaskMutationParams;
			// Состояние изолировано по сессиям: субагент в том же процессе мутирует
			// СВОЙ список и не видит/не трогает список основной TUI-сессии.
			const sessionId = ctx.sessionManager.getSessionId();
			const result = applyTaskMutation(getState(sessionId), typed.action as never, typed);
			commitState(sessionId, result.state);
			// НЕ бросаем при op.kind === "error" — см. комментарий про isError.
			return buildToolResult(typed.action as never, typed, result.state, result.op);
		},

		renderCall(args, theme, _context) {
			// Состояние СВОЕЙ сессии, а не UI-сессии. Рендерер принадлежит
			// рантайму той сессии, которой принадлежит вызов тула. `getUiState()`
			// вернул бы список основной TUI-сессии, и подстановка темы по #id
			// показала бы неверную задачу, когда `todo` вызывает дочерняя сессия.
			const sid = getOwnSessionId();
			return renderTodoCall(args as TaskMutationParams & { action: never }, theme, sid ? getState(sid) : EMPTY_STATE);
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}
