/**
 * index.ts — точка входа pi-todo.
 *
 * Собирает всё вместе: тул `todo`, команды `/todos` и `/todo-toggle`,
 * горячую клавишу переключения режима и жизненный цикл виджета.
 *
 * Виджет создаётся сразу (конструктор UI не требует), контекст UI получает на
 * session_start. Режим хранится только в памяти этой сессии.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodoCommands } from "./commands.ts";
import { TodoOverlay } from "./overlay.ts";
import { replayFromBranch } from "./replay.ts";
import { replaceState } from "./store.ts";
import { registerTodoTool } from "./tool.ts";
import { TOGGLE_SHORTCUT, TOOL_NAME } from "./types.ts";

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

	pi.on("session_start", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		if (ctx.hasUI) {
			overlay.setUICtx(ctx.ui);
			// Новая сессия — дефолтный режим (развёрнутый).
			overlay.reset();
			overlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
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
