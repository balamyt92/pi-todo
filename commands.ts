/**
 * commands.ts — слэш-команды расширения.
 *
 *   /todos        — развёрнутый список задач в чате
 *   /todos-toggle-widget  — переключить режим виджета (или явно: expand / collapse)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { formatStatusLabel } from "./format.ts";
import type { TodoOverlay, ViewMode } from "./overlay.ts";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./selectors.ts";
import { getState } from "./store.ts";
import { LIST_COMMAND_NAME, TOGGLE_COMMAND_NAME } from "./types.ts";

const SECTION_PENDING = "── Ожидание ──";
const SECTION_IN_PROGRESS = "── В работе ──";
const SECTION_COMPLETED = "── Выполнено ──";

const MSG_NO_TODOS = "Задач пока нет. Попросите агента добавить!";
const MSG_REQUIRES_UI = "Команда требует интерактивного режима";

function commandLine(task: {
	id: number;
	subject: string;
	status: string;
	activeForm?: string;
	blockedBy?: number[];
}, glyph: string): string {
	const form = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
	const block = task.blockedBy?.length ? `    ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${task.id} ${task.subject}${form}${block}`;
}

/** `/todos` — список задач текущей ветки, сгруппированный по статусам. */
export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(LIST_COMMAND_NAME, {
		description: "Показать все задачи текущей ветки, сгруппированные по статусам",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_UI, "error");
				return;
			}
			const state = getState();
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(MSG_NO_TODOS, "info");
				return;
			}
			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);

			const headerParts: string[] = [];
			if (counts.completed > 0) headerParts.push(`${counts.completed}/${counts.total} выполнено`);
			if (counts.inProgress > 0) headerParts.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) headerParts.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [headerParts.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(SECTION_PENDING);
				for (const task of groups.pending) lines.push(commandLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(SECTION_IN_PROGRESS);
				for (const task of groups.inProgress) lines.push(commandLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push(SECTION_COMPLETED);
				for (const task of groups.completed) lines.push(commandLine(task, "✓"));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/**
 * `/todos-toggle-widget [expand|collapse]`
 *
 * Без аргумента — переключить текущий режим. С аргументом — выставить явно.
 * Когда задач нет, виджет невидим, поэтому смену режима подтверждаем
 * уведомлением.
 */
export function registerTodoToggleCommand(pi: ExtensionAPI, overlay: TodoOverlay): void {
	pi.registerCommand(TOGGLE_COMMAND_NAME, {
		description: "Переключить виджет задач: свёрнутый ⇄ развёрнутый",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "expand", label: "развернуть" },
				{ value: "collapse", label: "свернуть" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_UI, "error");
				return;
			}
			const raw = (args ?? "").trim().toLowerCase();
			let mode: ViewMode;
			if (raw === "expand" || raw === "развернуть" || raw === "развёрнуть") {
				mode = overlay.setMode("expanded");
			} else if (raw === "collapse" || raw === "свернуть") {
				mode = overlay.setMode("collapsed");
			} else {
				mode = overlay.toggle();
			}

			if (selectVisibleTasks(getState()).length === 0) {
				ctx.ui.notify(mode === "collapsed" ? "pi-todo: виджет свёрнут" : "pi-todo: виджет развёрнут", "info");
			}
		},
	});
}

/** Регистрация обеих команд. Вызывается один раз из index.ts. */
export function registerTodoCommands(pi: ExtensionAPI, overlay: TodoOverlay): void {
	registerTodosCommand(pi);
	registerTodoToggleCommand(pi, overlay);
}
