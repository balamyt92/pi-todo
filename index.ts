/**
 * index.ts — точка входа pi-todo.
 *
 * Собирает всё вместе: тул `todo`, команды `/todos` и `/todos-toggle-widget`,
 * горячую клавишу переключения режима и жизненный цикл виджета.
 *
 * Виджет создаётся сразу (конструктор UI не требует), контекст UI получает на
 * session_start. Режим хранится только в памяти этой сессии.
 *
 * Изоляция по сессиям. Субагенты (`@tintinweb/pi-subagents`) спавнятся в том
 * же процессе и привязывают этот же модуль расширения: `bindExtensions()`
 * эмиттирует `session_start` для дочерней сессии. Состояние хранится под
 * ключом `sessionManager.getSessionId()` (см. `store.ts`), поэтому дочерняя
 * сессия проигрывает СВОЮ ветку в СВОЙ ключ и живой список основной
 * сессии не трогает. Прежний гард `shouldPreserveLiveList` стал ненужен:
 * «чужой» session_start теперь по определению пишет в чужой ключ.
 *
 * Все UI-операции (перерисовка виджета, сброс дисплейного состояния)
 * выполняются только для событий UI-сессии — события субагентов не должны
 * дёргать виджет основной сессии.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodoCommands } from "./commands.ts";
import { TodoOverlay } from "./overlay.ts";
import { replayFromBranch } from "./replay.ts";
import {
	clearUiSessionIfMatches,
	forgetSession,
	getState,
	getUiSessionId,
	replaceState,
	setUiSession,
} from "./store.ts";
import { registerTodoTool } from "./tool.ts";
import { TOGGLE_SHORTCUT, TOOL_NAME } from "./types.ts";

export default function (pi: ExtensionAPI) {
	const overlay = new TodoOverlay();

	/**
	 * Сессия этого рантайма.
	 *
	 * Factory перезапускается на каждую ЗАГРУЗКУ расширений — создание сессии,
	 * `/reload`, спавн субагента со своим resource loader. Это вызов
	 * `loadExtensionsCached` в `resource-loader.js`, а НЕ `bindExtensions`
	 * (последний только проставляет UI-context и эмиттит `session_start`,
	 * factory не трогает). Переходы `/new`/`/resume`/`/fork` дают свежее
	 * замыкание: по docs/extensions.md за ними следует `session_shutdown` →
	 * перезагрузка ресурсов → `session_start`.
	 *
	 * Итог: переменная принадлежит ровно одной сессии. Нужна для `renderCall`,
	 * который не получает `ctx` и иначе не мог бы отличить свой список от
	 * списка UI-сессии.
	 */
	let ownSessionId: string | undefined;

	registerTodoTool(pi, () => ownSessionId);
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
		const sid = ctx.sessionManager.getSessionId();
		ownSessionId = sid;
		replaceState(sid, replayFromBranch(ctx));
		if (ctx.hasUI) {
			setUiSession(sid);
			overlay.setUICtx(ctx.ui);
			// Новая сессия — дефолтный режим (развёрнутый).
			overlay.reset();
			overlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const replayed = replayFromBranch(ctx);
		// Компакция — та же сессия: если записи `todo` попали в сводку и исчезли
		// из ветки, пустой replay не должен терять живой список.
		if (!(replayed.tasks.length === 0 && getState(sid).tasks.length > 0)) {
			replaceState(sid, replayed);
		}
		if (sid === getUiSessionId()) {
			overlay.reset();
			overlay.update();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		replaceState(sid, replayFromBranch(ctx));
		if (sid === getUiSessionId()) {
			overlay.reset();
			overlay.update();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (sid === getUiSessionId()) {
			overlay.dispose();
			// Не оставляем сиротную запись UI-сессии в Map на время жизни
			// процесса: состояние персистентно в ветке и вернётся replay'ем на
			// следующем session_start.
			forgetSession(sid);
			clearUiSessionIfMatches(sid);
			return;
		}
		// Дочерняя сессия завершилась — её состояние больше не нужно,
		// иначе Map растёт на каждый спавн субагента.
		forgetSession(sid);
	});

	// --- Обновление виджета по ходу работы агента -------------------------

	// Читаем состояние в момент события; replay здесь НЕ делаем — ветка после
	// tool_execution_end ещё не содержит свежей записи. События субагентов
	// игнорируем: виджет принадлежит UI-сессии.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		if (ctx.sessionManager.getSessionId() !== getUiSessionId()) return;
		overlay.update();
	});

	// Новый ход агента — скрываем выполненные задачи прошлого хода.
	// beginTurn скрывает только если предыдущий ход завершился (agent_settled),
	// поэтому ретрай внутри хода не прячет ещё живые задачи.
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.sessionManager.getSessionId() !== getUiSessionId()) return;
		overlay.beginTurn();
	});

	// Ход устаканился — вооружаем скрытие выполненных к следующему ходу.
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.sessionManager.getSessionId() !== getUiSessionId()) return;
		overlay.endTurn();
	});
}

export { TodoOverlay };
