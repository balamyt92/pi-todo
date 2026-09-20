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
 * Читает состояние UI-сессии через `getUiState()` в момент отрисовки —
 * задачи субагентов в него не попадают (изоляция по сессиям, см. `store.ts`).
 * НИКОГДА не делает replay из `tool_execution_end` — ветка там ещё устаревшая.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatCollapsedLine, formatOverlayTaskLine, formatStatusLabel } from "./format.ts";
import { getUiState } from "./store.ts";
import {
	selectAllCompleted,
	selectCurrentTask,
	selectEffectiveState,
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTodoCounts,
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

	/**
	 * Граница хода. Скрывать выполненные прошлого хода разрешено только когда
	 * тот ход завершился (`agent_settled`). На ретрае внутри хода `agent_start`
	 * повторяется без settle — иначе ещё живые задачи исчезли бы посреди хода.
	 */
	private turnSettled = true;

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
		this.maintainDisplayState();
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			this.unregister();
			return;
		}

		this.applyAutoCollapse({ tasks: [...visible], nextId: snapshot.nextId });
		this.render();
	}

	/** Полный сброс дисплейного состояния (новая сессия). */
	reset(): void {
		this.mode = "expanded";
		this.autoCollapseSuppressed = false;
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
		this.turnSettled = true;
	}

	/**
	 * Начало хода: скрыть выполненные прошлого хода, но только если тот ход
	 * завершился. Повторный `agent_start` (ретрай) скрытия не делает.
	 */
	beginTurn(): void {
		if (!this.turnSettled) return;
		this.hideCompletedTasksFromPreviousTurn();
		this.turnSettled = false;
	}

	/** Конец хода (`agent_settled`): вооружаем скрытие к следующему ходу. */
	endTurn(): void {
		this.turnSettled = true;
	}

	/** Скрыть выполненные задачи предыдущего хода. */
	private hideCompletedTasksFromPreviousTurn(): void {
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

	private applyAutoCollapse(state: TaskState): void {
		if (!selectAllCompleted(state)) {
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
	/**
	 * Чистый снимок UI-состояния для отрисовки. Без мутаций.
	 *
	 * Прогоняется через `selectEffectiveState`, чтобы висячие `blockedBy` на
	 * удалённые задачи не влияли на «текущую задачу» и отрисовку блокировок
	 * (F8, читающая сторона).
	 */
	private getSnapshot(): TaskState {
		const state = selectEffectiveState(getUiState());
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	/**
	 * Обслуживание дисплейных множеств перед перерисовкой: откат `nextId`
	 * (пересоздание списка) обнуляет историю; выполненные, которых больше нет
	 * в состоянии, убираются из множеств скрытия. Вызывается только из
	 * `update()`, чтобы горячий путь `renderWidget()` оставался чистым.
	 */
	private maintainDisplayState(): void {
		const state = getUiState();
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

	/**
	 * Свёрнутый режим: ровно одна строка.
	 *
	 * Здесь НАМЕРЕННО нет `trackDisplayedCompleted()`, в отличие от
	 * `renderExpanded()`. Асимметрия осознанная.
	 *
	 * Свёрнутая строка — это прогресс: `● 3/7 [████░░] 43% · #3 Пишу тесты`.
	 * Если помечать показанные выполненные к скрытию на следующем ходу,
	 * счётчик потеряет числитель: 3/7 превратится в 0/4, то есть прогресс
	 * визуально обнулится ровно тогда, когда пользователь смотрит на
	 * компактный индикатор. В развёрнутом режиме скрытие выполненных —
	 * фича («панель показывает текущую работу»), в свёрнутом оно разрушает
	 * единственную полезную цифру.
	 *
	 * Практический эффект: если виджет был свёрнут весь ход, выполненные в
	 * том ходу задачи НЕ попадут в `completedTaskIdsPendingHide` и останутся
	 * в счётчике. Если он был развёрнут — попадут и на следующем ходу
	 * скроются. Переключение режима не переписывает уже накопленное множество
	 * скрытия, поэтому поведение стабильно внутри хода.
	 */
	private renderCollapsed(theme: Theme, width: number, state: TaskState): string[] {
		const counts = selectTodoCounts(state);
		const current = selectCurrentTask(state);
		const line = formatCollapsedLine(counts, current, theme, width);
		return [truncateToWidth(line, width, "…")];
	}

	/**
	 * Запомнить выполненные задачи, показанные в этом ходе, чтобы скрыть их на
	 * следующем. Побочный эффект отрисовки вынесен из тела render в явный метод.
	 */
	private trackDisplayedCompleted(tasks: readonly Task[]): void {
		for (const taskId of overlayIdsOfCompleted(tasks)) {
			if (!this.completedTaskIdsPendingHide.has(taskId) && !this.hiddenCompletedTaskIds.has(taskId)) {
				this.completedTaskIdsPendingHide.add(taskId);
			}
		}
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
		const hasOverflow = layout.hiddenCompleted > 0 || layout.truncatedTail > 0;
		layout.visible.forEach((task, i) => {
			// Последний узел без переполнения — «└─», иначе ветка «├─».
			const connector = !hasOverflow && i === layout.visible.length - 1 ? "└─" : "├─";
			lines.push(truncate(`${theme.fg("dim", connector)} ${formatOverlayTaskLine(task, theme, showIds)}`));
		});

		// Что показали как выполненное — скроем на следующем ходе.
		this.trackDisplayedCompleted(state.tasks);

		if (!hasOverflow) return lines;

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
