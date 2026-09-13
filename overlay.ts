/**
 * overlay.ts — контроллер виджета «задачи над редактором».
 *
 * Два режима:
 *   expanded   — заголовок + полный список (кап = MAX_EXPANDED_LINES строк);
 *   collapsed  — одна строка: счётчик, прогресс-бар и текущая задача.
 *
 * Режим переключается командой `/todos-toggle-widget` и горячей клавишей. Состояние
 * живёт только в памяти сессии: после перезапуска виджет развёрнут.
 *
 * Плюс авто-сворачивание: как только все задачи выполнены, панель схлопывается
 * в одну строку. Если пользователь после этого развернул вручную — обратно её
 * не заставляем (до следующего появления незавершённых задач).
 *
 * Читает состояние через `getState()` в момент отрисовки. НИКОГДА не делает
 * replay из `tool_execution_end` — ветка там ещё устаревшая.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatCollapsedLine, formatOverlayTaskLine, formatStatusLabel } from "./format.ts";
import { getState as storeGetState } from "./store.ts";
import {
	selectCurrentTask,
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTodoCounts,
	type TodoCounts,
} from "./selectors.ts";
import type { Task, TaskState } from "./types.ts";
import { MAX_EXPANDED_LINES, WIDGET_KEY } from "./types.ts";

export type ViewMode = "collapsed" | "expanded";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;

	/** Текущий режим отрисовки. */
	private mode: ViewMode = "expanded";

	/**
	 * Пользователь явно развернул панель — авто-сворачивание «выключено»,
	 * пока не появится незавершённая задача.
	 */
	private autoCollapseSuppressed = false;

	/** Выполненные, показанные в этом ходе — скрываются на следующем agent_start. */
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		// Сверяем по идентичности: повторные session_start идемпотентны, а при
		// смене контекста (/reload) сбрасываемся, чтобы update() зарегистрировал
		// виджет заново.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	getMode(): ViewMode {
		return this.mode;
	}

	/** Явная установка режима + перерисовка. */
	setMode(mode: ViewMode): ViewMode {
		this.mode = mode;
		// Ручное разворачивание отключает авто-сворачивание до появления
		// незавершённых задач.
		this.autoCollapseSuppressed = mode === "expanded";
		this.update();
		return this.mode;
	}

	/** Переключить свёрнуто/развёрнуто. Возвращает новый режим. */
	toggle(): ViewMode {
		return this.setMode(this.mode === "expanded" ? "collapsed" : "expanded");
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			this.unregister();
			return;
		}

		this.applyAutoCollapse(selectTodoCounts({ tasks: [...visible], nextId: snapshot.nextId }));
		this.render();
	}

	/** Полный сброс дисплейного состояния (новая сессия). */
	reset(): void {
		this.mode = "expanded";
		this.autoCollapseSuppressed = false;
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	/** Скрыть выполненные задачи предыдущего хода (вызывается на agent_start). */
	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.reset();
	}

	// -----------------------------------------------------------------------
	// Внутреннее
	// -----------------------------------------------------------------------

	private applyAutoCollapse(counts: TodoCounts): void {
		const allDone = counts.total > 0 && counts.completed === counts.total;
		if (!allDone) {
			// Появилась незавершённая работа — снимаем запрет, авто-сворачивание
			// снова сработает, когда всё закроют.
			this.autoCollapseSuppressed = false;
			return;
		}
		if (this.autoCollapseSuppressed) return;
		this.mode = "collapsed";
	}

	private unregister(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private render(): void {
		if (!this.uiCtx) return;
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui: TUI, theme: Theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
			return;
		}
		this.tui?.requestRender();
	}

	/**
	 * Снимок состояния + самоочищение дисплейных множеств: если состояние
	 * откатилось назад (пересоздание id), дисплейная история невалидна.
	 */
	private getSnapshot(): TaskState {
		const state = storeGetState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.completedTaskIdsPendingHide.clear();
			this.hiddenCompletedTaskIds.clear();
		}
		this.lastNextId = state.nextId;

		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: TaskState): readonly Task[] {
		return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: Task): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];
		const overlayState: TaskState = { tasks: [...overlayTasks], nextId: snapshot.nextId };
		return this.mode === "collapsed"
			? this.renderCollapsed(theme, width, overlayState)
			: this.renderExpanded(theme, width, overlayState);
	}

	/** Свёрнутый режим: ровно одна строка. */
	private renderCollapsed(theme: Theme, width: number, state: TaskState): string[] {
		const counts = selectTodoCounts(state);
		const current = selectCurrentTask(state);
		const line = formatCollapsedLine(counts, current, theme, width);
		return [truncateToWidth(line, width, "…")];
	}

	/** Развёрнутый режим: заголовок + список + сводка о скрытом. */
	private renderExpanded(theme: Theme, width: number, state: TaskState): string[] {
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(state);
		const hasActive = selectHasActive(state);
		const showIds = selectShowTaskIds(state);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const heading = truncate(
			`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `Задачи (${counts.completed}/${counts.total})`)}`,
		);

		const lines: string[] = [heading];
		const layout = selectOverlayLayout(state, MAX_EXPANDED_LINES - 1);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}

		// Что показали как выполненное — скроем на следующем ходе.
		const newlyDisplayedCompletedTaskIds = overlayIdsOfCompleted(state.tasks).filter(
			(taskId) => !this.completedTaskIdsPendingHide.has(taskId) && !this.hiddenCompletedTaskIds.has(taskId),
		);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return lines;
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
		const summary =
			overflowParts.length > 0
				? `+${totalHidden} ещё (${overflowParts.join(", ")})`
				: `+${totalHidden} ещё`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return lines;
	}
}

function overlayIdsOfCompleted(tasks: readonly Task[]): number[] {
	return tasks.filter((t) => t.status === "completed").map((t) => t.id);
}
