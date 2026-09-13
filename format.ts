/**
 * format.ts — визуальное форматирование: глифы, строки списка, прогресс-бар.
 *
 * Здесь живёт ЕДИНСТВЕНное представление статуса (глиф + цвет) и вся
 * раскладка однострочной свёрнутой панели. Отрисовка (`overlay.ts`) только
 * вызывает эти функции и обрезает строки по ширине терминала.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { deriveBlocks } from "./graph.ts";
import { selectTaskSubjectById, type TodoCounts } from "./selectors.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "./types.ts";

// ---------------------------------------------------------------------------
// Подписи статусов (рус.)
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<TaskStatus, string> = {
	pending: "ожидание",
	in_progress: "в работе",
	completed: "выполнено",
	deleted: "удалена",
};

export function formatStatusLabel(status: TaskStatus): string {
	return STATUS_LABEL[status];
}

// ---------------------------------------------------------------------------
// Глифы и цвета
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

/** Префикс действия в renderCall: `+` create, `→` update, `×` delete, `›` get, `☰` list, `∅` clear. */
export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

/** Глиф статуса в строке виджета (отличается от STATUS_GLYPH для completed/deleted). */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/**
 * Заголовок задачи для показа человеку: для in_progress предпочитается
 * `activeForm` («пишу тесты» вместо «написать тесты»).
 */
export function taskDisplayTitle(task: Task): string {
	if (task.status === "in_progress" && task.activeForm) return task.activeForm;
	return task.subject;
}

/** Одна строка развёрнутого виджета: глиф + тема + (опц. #id) + блокировки. */
export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(t.status, theme);
	const subjectColor = t.status === "completed" || t.status === "deleted" ? "dim" : "text";
	let subject = theme.fg(subjectColor, t.subject);
	if (t.status === "completed" || t.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph}`;
	if (showId) line += ` ${theme.fg("accent", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
	}
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/** Строка для чат-вывода `/todos`. */
export function formatCommandTaskLine(t: Task, glyph: string): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${t.id} ${t.subject}${form}${block}`;
}

// ---------------------------------------------------------------------------
// Прогресс-бар
// ---------------------------------------------------------------------------

const BAR_FILLED = "█";
const BAR_EMPTY = "░";
export const BAR_MIN_WIDTH = 8;
export const BAR_MAX_WIDTH = 28;

export function clampBarWidth(width: number, min = BAR_MIN_WIDTH, max = BAR_MAX_WIDTH): number {
	if (!Number.isFinite(width)) return min;
	return Math.max(min, Math.min(max, Math.floor(width)));
}

/**
 * `[████████░░░░░░░░░░]` — закрашенная часть пропорциональна выполненому.
 * Символьная ширина строки равна `width + 2` (скобки).
 */
export function renderProgressBar(completed: number, total: number, width: number, theme: Theme): string {
	const safeWidth = clampBarWidth(width);
	const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
	const filled = Math.round(ratio * safeWidth);
	const empty = safeWidth - filled;
	return (
		theme.fg("dim", "[") +
		(filled > 0 ? theme.fg("success", BAR_FILLED.repeat(filled)) : "") +
		(empty > 0 ? theme.fg("dim", BAR_EMPTY.repeat(empty)) : "") +
		theme.fg("dim", "]")
	);
}

export function progressPercent(completed: number, total: number): number {
	if (total <= 0) return 0;
	return Math.round((completed / total) * 100);
}

/**
 * Свёрнутая строка:
 *
 *     ● 3/7 [████████░░░░░░░░░░] 43% · #3 Пишу тесты
 *
 * Ширина бара подбирается под фактическую ширину терминала так, чтобы строка
 * целиком влезала в `width`. Если текущей задачи нет (всё выполнено) — хвост
 * ` · ...` отсутствует.
 */
export function formatCollapsedLine(
	counts: TodoCounts,
	current: Task | undefined,
	theme: Theme,
	width: number,
): string {
	const allDone = counts.total > 0 && counts.completed === counts.total;
	const icon = allDone
		? theme.fg("success", "✓")
		: counts.inProgress > 0
			? theme.fg("accent", "▶")
			: theme.fg("dim", "○");

	const counter = theme.fg("success", String(counts.completed)) + theme.fg("dim", `/${counts.total}`);
	const percent = progressPercent(counts.completed, counts.total);
	const pctText = theme.fg("muted", `${percent}%`);

	// Подбираем ширину бара из остатка места: всё остальное считаем в
	// видимых (без ANSI) символах.
	const plainTail = current ? ` · #${current.id} ${taskDisplayTitle(current)}` : "";
	const plainHead = `${allDone ? "✓" : counts.inProgress > 0 ? "▶" : "○"} ${counts.completed}/${counts.total} [] ${percent}%`;
	const reserved = visibleWidth(plainHead) + visibleWidth(plainTail);
	const barWidth = clampBarWidth(width - reserved);
	const bar = renderProgressBar(counts.completed, counts.total, barWidth, theme);

	const parts = [icon, counter, bar, pctText];
	if (current) {
		const ref = theme.fg("accent", `#${current.id}`);
		const title = theme.fg(
			current.status === "completed" ? "dim" : "text",
			taskDisplayTitle(current),
		);
		parts.push(theme.fg("dim", "·"), `${ref} ${title}`);
	}
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Хуки отрисовки тула
// ---------------------------------------------------------------------------

/** Тело `renderCall`: что модель вызвала. */
export function renderTodoCall(
	args: TaskMutationParams & { action: TaskAction },
	theme: Theme,
	state: { tasks: Task[]; nextId: number },
): Text {
	const glyph = ACTION_GLYPH[args.action] ?? args.action;
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

	if (args.action === "create" && args.subject) {
		text += ` ${theme.fg("dim", args.subject)}`;
	} else if ((args.action === "update" || args.action === "get" || args.action === "delete") && args.id !== undefined) {
		const subject = selectTaskSubjectById(state, args.id);
		text += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
	} else if (args.action === "list" && args.status) {
		text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
	}
	return new Text(text, 0, 0);
}

/** Тело `renderResult`: эхо статуса операции. */
export function renderTodoResult(result: { details?: unknown }, theme: Theme): Text {
	const details = result.details as TaskDetails | undefined;
	let status: TaskStatus | undefined;
	if (details) {
		const params = details.params as TaskMutationParams;
		switch (details.action) {
			case "create":
				status = details.tasks[details.tasks.length - 1]?.status;
				break;
			case "update":
				status = params.status ?? details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "delete":
				status = details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "list":
			case "get":
			case "clear":
				break;
		}
	}
	if (status) {
		return new Text(theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${formatStatusLabel(status)}`), 0, 0);
	}
	return new Text(theme.fg("success", "✓"), 0, 0);
}

/** Строки `get`: описание, блокировки, владелец. */
export function formatGetLines(task: Task, state: { tasks: Task[] }): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${formatStatusLabel(task.status)}] ${task.subject}`];
	if (task.description) lines.push(`  description: ${task.description}`);
	if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	return lines.join("\n");
}
