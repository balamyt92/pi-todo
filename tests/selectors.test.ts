/**
 * Тесты селекторов: счётчики, «текущая» задача, компоновка при переполнении.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	selectAllCompleted,
	selectCurrentTask,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTasksByStatus,
	selectTodoCounts,
	selectVisibleTasks,
} from "../selectors.ts";
import type { Task, TaskState } from "../types.ts";

function tasks(...specs: Array<Partial<Task> & { status: Task["status"] }>): TaskState {
	return {
		tasks: specs.map((s, i) => ({
			id: i + 1,
			subject: `Задача ${i + 1}`,
			...s,
		})),
		nextId: specs.length + 1,
	};
}

describe("счётчики", () => {
	it("не считает tombstone'ы", () => {
		const s = tasks(
			{ status: "pending" },
			{ status: "completed" },
			{ status: "deleted" },
			{ status: "in_progress" },
		);
		const c = selectTodoCounts(s);
		assert.deepEqual(c, { total: 3, pending: 1, inProgress: 1, completed: 1 });
		assert.equal(selectVisibleTasks(s).length, 3);
	});

	it("пустой список — все нули", () => {
		const c = selectTodoCounts({ tasks: [], nextId: 1 });
		assert.deepEqual(c, { total: 0, pending: 0, inProgress: 0, completed: 0 });
	});
});

describe("selectCurrentTask", () => {
	it("предпочитает in_progress", () => {
		const s = tasks({ status: "pending" }, { status: "in_progress" }, { status: "pending" });
		assert.equal(selectCurrentTask(s)?.id, 2);
	});

	it("без in_progress берёт первую незаблокированную pending", () => {
		const s = tasks({ status: "completed" }, { status: "pending", blockedBy: [1] }, { status: "pending" });
		assert.equal(selectCurrentTask(s)?.id, 3);
	});

	it("все выполнены — undefined", () => {
		const s = tasks({ status: "completed" }, { status: "completed" });
		assert.equal(selectCurrentTask(s), undefined);
	});
});

describe("selectAllCompleted", () => {
	it("пустой список — не «выполнено»", () => {
		assert.equal(selectAllCompleted({ tasks: [], nextId: 1 }), false);
	});

	it("все completed — true", () => {
		assert.equal(selectAllCompleted(tasks({ status: "completed" }, { status: "completed" })), true);
	});

	it("одна pending — false", () => {
		assert.equal(selectAllCompleted(tasks({ status: "completed" }, { status: "pending" })), false);
	});
});

describe("selectShowTaskIds", () => {
	it("без блокировок — номера не показываем", () => {
		assert.equal(selectShowTaskIds(tasks({ status: "pending" }, { status: "pending" })), false);
	});

	it("есть blockedBy — показываем", () => {
		assert.equal(selectShowTaskIds(tasks({ status: "pending" }, { status: "pending", blockedBy: [1] })), true);
	});
});

describe("selectOverlayLayout", () => {
	it("всё влезает — без обрезки", () => {
		const s = tasks({ status: "pending" }, { status: "completed" });
		const l = selectOverlayLayout(s, 5);
		assert.equal(l.visible.length, 2);
		assert.equal(l.hiddenCompleted, 0);
		assert.equal(l.truncatedTail, 0);
	});

	it("при переполнении жертвуем выполненными", () => {
		const s = tasks(
			{ status: "completed" },
			{ status: "completed" },
			{ status: "pending" },
			{ status: "pending" },
		);
		const l = selectOverlayLayout(s, 3);
		assert.ok(l.hiddenCompleted > 0, "должны быть скрытые выполненные");
		assert.ok(
			l.visible.filter((t) => t.status === "pending").length === 2,
			"все pending должны остаться",
		);
	});

	it("незавершённых больше бюджета — обрезаем хвост", () => {
		const s = tasks(
			{ status: "pending" },
			{ status: "pending" },
			{ status: "pending" },
			{ status: "pending" },
			{ status: "pending" },
		);
		const l = selectOverlayLayout(s, 2);
		assert.ok(l.truncatedTail > 0);
		assert.equal(l.visible.length, 1);
	});
});

describe("selectTasksByStatus", () => {
	it("группирует по статусам", () => {
		const g = selectTasksByStatus(
			tasks({ status: "pending" }, { status: "completed" }, { status: "in_progress" }),
		);
		assert.equal(g.pending.length, 1);
		assert.equal(g.completed.length, 1);
		assert.equal(g.inProgress.length, 1);
	});
});
