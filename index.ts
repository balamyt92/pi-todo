/**
 * index.ts — точка входа pi-todo.
 *
 * Собирает всё вместе: тул `todo`, команды `/todos` и `/todos-toggle-widget`,
 * горячую клавишу переключения режима и жизненный цикл виджета.
 *
 * Виджет создаётся сразу (конструктор UI не требует), контекст UI получает на
 * session_start. Режим хранится только в памяти этой сессии.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodoCommands } from "./commands.ts";
import { TodoOverlay } from "./overlay.ts";
import { replayFromBranch } from "./replay.ts";
import { getState, replaceState } from "./store.ts";
import { registerTodoTool } from "./tool.ts";
import type { TaskState } from "./types.ts";
import { TOGGLE_SHORTCUT, TOOL_NAME } from "./types.ts";

/**
 * Пустой replay не должен затирать уже живой список.
 *
 * `replayFromBranch()` перечитывает задачи из записей тула `todo` в ветке. Если
 * в ветке этих записей нет, replay возвращает пустое состояние. Слепая запись
 * такого пустого результата стирает видимый список у пользователя. Это случается,
 * когда сторонние расширения эмиттируют «чужой» `session_start`:
 *
 *   `@tintinweb/pi-subagents` при спавне субагента строит дочернюю сессию и
 *   вызывает `bindExtensions()`, из-за чего В РОДИТЕЛЬСКОМ ПРОЦЕССЕ срабатывает
 *   второй `session_start` с тем же `reason: "startup"`. Ветка дочерней сессии
 *   задач родителя не содержит → пустой replay → затирание списка.
 *
 * Сохраняем текущий список, когда replay пуст, но у нас есть живой список, И это
 * не осмысленный переход пользователя. Для `new`/`resume`/`fork` пустая ветка
 * означает «переключились на сессию без задач» — там применяем пустое состояние.
 */
function shouldPreserveLiveList(reason: string | undefined, replayed: TaskState): boolean {
	const genuineTransition = reason === "new" || reason === "resume" || reason === "fork";
	return !genuineTransition && replayed.tasks.length === 0 && getState().tasks.length > 0;
}

export default function (pi: ExtensionAPI) {
	const overlay = new TodoOverlay();

	registerTodoTool(pi);
	registerTodoCommands(pi, overlay);

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "pi-todo: переключить свёрнутый/развёрнутый режим виджета",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			overlay.toggle();
		},
	});

	// --- Жизненный цикл сессии --------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		const replayed = replayFromBranch(ctx);
		// Не затираем живой список «чужим» пустым session_start (boot / дочерняя
		// сессия субагента) — см. shouldPreserveLiveList.
		if (!shouldPreserveLiveList(event.reason, replayed)) {
			replaceState(replayed);
		}
		if (ctx.hasUI) {
			overlay.setUICtx(ctx.ui);
			// Новая сессия — дефолтный режим (развёрнутый).
			overlay.reset();
			overlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		const replayed = replayFromBranch(ctx);
		// Компакция — та же сессия: если записи `todo` попали в сводку и исчезли
		// из ветки, пустой replay не должен терять видимый список.
		if (!shouldPreserveLiveList(undefined, replayed)) {
			replaceState(replayed);
		}
		overlay.reset();
		overlay.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		overlay.reset();
		overlay.update();
	});

	pi.on("session_shutdown", async () => {
		overlay.dispose();
	});

	// --- Обновление виджета по ходу работы агента -------------------------

	// Читаем состояние в момент события; replay здесь НЕ делаем — ветка после
	// tool_execution_end ещё не содержит свежей записи.
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		overlay.update();
	});

	// Новый ход агента — скрываем выполненные задачи прошлого хода.
	pi.on("agent_start", async () => {
		overlay.hideCompletedTasksFromPreviousTurn();
	});
}

export { TodoOverlay };
