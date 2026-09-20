/**
 * selectors.ts — производные данные из канонического состояния.
 *
 * Все селекторы чистые и зависят только от `TaskState`. Никаких кэшей и
 * мутаций: развёрнутый виджет, свёрнутая строка и `/todos` считают своё
 * представление здесь, а не в местах отрисовки.
 */

import type { Task, TaskState } from "./types.ts";

/** Задачи без tombstone'ов — каноническое «что видно». */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

/**
 * Нормализованное представление состояния: из `blockedBy` всех задач
 * вычёркнуты ссылки на удалённые задачи (F8, читающая сторона).
 *
 * Зачем он нужен, если `delete` уже делает каскад. Каскад предотвращает
 * НОВЫЕ висячие ссылки, но не лечит уже накопленные: в сессиях, записанных
 * до этого фикса, `blockedBy` на tombstone остаётся после replay, и
 * `selectCurrentTask` продолжает считать такую задачу заблокированной.
 * Нормализация на границе чтения терпит и старые данные, и новые.
 *
 * Возвращает ТОТ ЖЕ объект, когда вычёркивать нечего — в нормальном потоке
 * (каскад уже отработал) аллокации нет.
 */
export function selectEffectiveState(state: TaskState): TaskState {
	const deleted = new Set<number>();
	for (const t of state.tasks) {
		if (t.status === "deleted") deleted.add(t.id);
	}
	if (deleted.size === 0) return state;

	let changed = false;
	const tasks = state.tasks.map((t) => {
		if (!t.blockedBy?.length) return t;
		const kept = t.blockedBy.filter((id) => !deleted.has(id));
		if (kept.length === t.blockedBy.length) return t;
		changed = true;
		const copy: Task = { ...t };
		if (kept.length > 0) copy.blockedBy = kept;
		else delete copy.blockedBy;
		return copy;
	});

	return changed ? { tasks, nextId: state.nextId } : state;
}

export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
}

/** Группировка видимых задач по статусу. */
export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

/** Счётчики для заголовка виджета и свёрнутой строки. */
export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

/** Есть ли хоть одна незавершённая задача (pending или in_progress). */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

/** Все видимые задачи выполнены. Пустой список — не «выполнено». */
export function selectAllCompleted(state: TaskState): boolean {
	const counts = selectTodoCounts(state);
	return counts.total > 0 && counts.completed === counts.total;
}

/**
 * «Текущая» задача для свёрнутого режима:
 * 1) любая in_progress;
 * 2) иначе первая pending без блокировок;
 * 3) иначе первая pending.
 * Если незавершённых нет — undefined (свёрнутая строка показывается без хвоста).
 */
export function selectCurrentTask(state: TaskState): Task | undefined {
	const visible = selectVisibleTasks(state);
	const inProgress = visible.find((t) => t.status === "in_progress");
	if (inProgress) return inProgress;
	const pending = visible.filter((t) => t.status === "pending");
	return pending.find((t) => !t.blockedBy || t.blockedBy.length === 0) ?? pending[0];
}

/**
 * Показывать ли `#id` в строках виджета. Без единой `⛓ #N` ссылки номер
 * строки ни на что не ссылается и только шумит.
 */
export function selectShowTaskIds(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}

/** Тема задачи по id — для подписи в renderCall. */
export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
	return state.tasks.find((t) => t.id === id)?.subject;
}

export interface OverlayLayout {
	visible: readonly Task[];
	hiddenCompleted: number;
	truncatedTail: number;
}

/**
 * Компоновка развёрнутого виджета при переполнении: сначала жертвуем
 * выполненными, затем обрезаем хвост из незавершённых.
 *
 * `budget` — сколько строк доступно под задачи (вызывающий резервирует
 * строку заголовка); при переполнении ещё одна строка внутри резервируется
 * под строку-сводку.
 */
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
	}
	const innerBudget = budget - 1;
	const nonCompleted = all.filter((t) => t.status !== "completed");
	const totalCompleted = all.length - nonCompleted.length;
	if (nonCompleted.length <= innerBudget) {
		const kept = new Set<Task>(nonCompleted);
		for (const t of all) {
			if (kept.size >= innerBudget) break;
			if (t.status === "completed") kept.add(t);
		}
		const visible = all.filter((t) => kept.has(t));
		const shownCompleted = visible.filter((t) => t.status === "completed").length;
		return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
	}
	const visible = nonCompleted.slice(0, innerBudget);
	const truncatedTail = nonCompleted.length - innerBudget;
	return { visible, hiddenCompleted: totalCompleted, truncatedTail };
}

