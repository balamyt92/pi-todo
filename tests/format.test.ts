/**
 * Тесты форматирования: прогресс-бар, свёрнутая строка, заголовки задач.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	clampBarWidth,
	formatCollapsedLine,
	formatOverlayTaskLine,
	progressPercent,
	renderProgressBar,
	renderTodoResult,
	taskDisplayTitle,
} from "../format.ts";
import type { Task } from "../types.ts";
import type { TodoCounts } from "../selectors.ts";

/** Тема-заглушка: без ANSI, только чистый текст. */
export function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

function counts(partial: Partial<TodoCounts>): TodoCounts {
	return { total: 0, pending: 0, inProgress: 0, completed: 0, ...partial };
}

describe("renderProgressBar", () => {
	it("3/7 на ширине 14 — 6 заполненных", () => {
		const bar = renderProgressBar(3, 7, 14, plainTheme());
		assert.equal(bar, "[██████░░░░░░░░]");
	});

	it("0% — пустой бар", () => {
		const bar = renderProgressBar(0, 5, 10, plainTheme());
		assert.equal(bar, "[░░░░░░░░░░]");
	});

	it("100% — полный бар", () => {
		const bar = renderProgressBar(5, 5, 10, plainTheme());
		assert.equal(bar, "[██████████]");
	});

	it("total = 0 не делит на ноль", () => {
		assert.equal(progressPercent(0, 0), 0);
	});
});

describe("clampBarWidth", () => {
	it("ниже минимума → минимум", () => assert.equal(clampBarWidth(2), 8));
	it("выше максимума → максимум", () => assert.equal(clampBarWidth(100), 28));
	it("в диапазоне → как есть", () => assert.equal(clampBarWidth(15), 15));
	it("NaN → минимум", () => assert.equal(clampBarWidth(Number.NaN), 8));
});

describe("formatCollapsedLine", () => {
	const current: Task = {
		id: 3,
		subject: "написать тесты",
		status: "in_progress",
		activeForm: "пишу тесты",
	};

	it("содержит счётчик, процент и текущую задачу", () => {
		const line = formatCollapsedLine(counts({ total: 7, completed: 3, pending: 3, inProgress: 1 }), current, plainTheme(), 100);
		assert.match(line, /3\/7/);
		assert.match(line, /43%/);
		assert.match(line, /#3 пишу тесты/);
	});

	it("одна строка без переносов", () => {
		const line = formatCollapsedLine(counts({ total: 7, completed: 3 }), current, plainTheme(), 80);
		assert.equal(line.includes("\n"), false);
	});

	it("без текущей задачи — без хвоста « · »", () => {
		const line = formatCollapsedLine(counts({ total: 4, completed: 4 }), undefined, plainTheme(), 80);
		assert.equal(line.includes(" · "), false);
		assert.match(line, /4\/4/);
		assert.match(line, /100%/);
	});

	it("на узком терминале бар не схлопывается в ноль", () => {
		const line = formatCollapsedLine(counts({ total: 7, completed: 3 }), current, plainTheme(), 20);
		assert.ok(line.includes("["), "бар должен остаться");
	});
});

describe("taskDisplayTitle", () => {
	it("для in_progress берёт activeForm", () => {
		const t: Task = { id: 1, subject: "написать тесты", status: "in_progress", activeForm: "пишу тесты" };
		assert.equal(taskDisplayTitle(t), "пишу тесты");
	});

	it("для pending берёт subject", () => {
		const t: Task = { id: 1, subject: "написать тесты", status: "pending" };
		assert.equal(taskDisplayTitle(t), "написать тесты");
	});

	it("in_progress без activeForm — subject", () => {
		const t: Task = { id: 1, subject: "собрать пакет", status: "in_progress" };
		assert.equal(taskDisplayTitle(t), "собрать пакет");
	});
});

describe("formatOverlayTaskLine", () => {
	it("pending без блокировок", () => {
		const t: Task = { id: 1, subject: "A", status: "pending" };
		assert.equal(formatOverlayTaskLine(t, plainTheme(), false), "○ A");
	});

	it("с блокировками и #id", () => {
		const t: Task = { id: 2, subject: "B", status: "pending", blockedBy: [1, 3] };
		assert.equal(formatOverlayTaskLine(t, plainTheme(), true), "○ #2 B ⛓ #1,#3");
	});

	it("in_progress показывает activeForm в скобках", () => {
		const t: Task = { id: 1, subject: "A", status: "in_progress", activeForm: "делаю A" };
		assert.equal(formatOverlayTaskLine(t, plainTheme(), false), "◐ A (делаю A)");
	});
});

describe("renderTodoResult", () => {
	it("ошибка редьюсера → глиф ✗ и текст ошибки, а не целевой статус", () => {
		const result = {
			details: {
				action: "update",
				params: { id: 1, status: "in_progress" },
				tasks: [{ id: 1, subject: "A", status: "completed" }],
				nextId: 2,
				error: "illegal transition completed → in_progress",
			},
		};
		const lines = renderTodoResult(result, plainTheme()).render(200).join("\n");
		assert.match(lines, /✗/);
		assert.match(lines, /illegal transition/);
		// Отклонённый переход не должен показать целевой статус «в работе» как успех.
		assert.equal(lines.includes("в работе"), false);
	});

	it("успешный create → статус последней задачи", () => {
		const result = {
			details: {
				action: "create",
				params: {},
				tasks: [{ id: 1, subject: "A", status: "pending" }],
				nextId: 2,
			},
		};
		const lines = renderTodoResult(result, plainTheme()).render(200).join("\n");
		assert.match(lines, /ожидание/);
	});
});
