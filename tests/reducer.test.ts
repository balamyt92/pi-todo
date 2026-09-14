/**
 * Тесты редьюсера: создание, переходы статусов, блокировки, ошибки.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTaskMutation } from "../reducer.ts";
import { EMPTY_STATE } from "../types.ts";
import type { TaskState } from "../types.ts";

function stateWith(...statuses: string[]): TaskState {
	return {
		tasks: statuses.map((status, i) => ({
			id: i + 1,
			subject: `Задача ${i + 1}`,
			status: status as never,
		})),
		nextId: statuses.length + 1,
	};
}

describe("create", () => {
	it("добавляет задачу с pending и увеличивает nextId", () => {
		const res = applyTaskMutation(EMPTY_STATE, "create", { subject: "Первая" });
		assert.equal(res.op.kind, "create");
		assert.equal(res.state.tasks.length, 1);
		assert.equal(res.state.tasks[0]?.id, 1);
		assert.equal(res.state.tasks[0]?.status, "pending");
		assert.equal(res.state.nextId, 2);
	});

	it("без subject — ошибка, состояние не меняется", () => {
		const res = applyTaskMutation(EMPTY_STATE, "create", { subject: "   " });
		assert.equal(res.op.kind, "error");
		assert.equal(res.state.tasks.length, 0);
	});

	it("blockedBy на несуществующую задачу — ошибка", () => {
		const res = applyTaskMutation(EMPTY_STATE, "create", { subject: "X", blockedBy: [99] });
		assert.equal(res.op.kind, "error");
	});
});

describe("update", () => {
	it("pending → in_progress разрешён", () => {
		const res = applyTaskMutation(stateWith("pending"), "update", { id: 1, status: "in_progress" });
		assert.equal(res.op.kind, "update");
		assert.equal((res.op as { toStatus: string }).toStatus, "in_progress");
	});

	it("completed → in_progress запрещён", () => {
		const res = applyTaskMutation(stateWith("completed"), "update", { id: 1, status: "in_progress" });
		assert.equal(res.op.kind, "error");
		assert.match(String((res.op as { message: string }).message), /illegal transition/);
	});

	it("без изменяемых полей — ошибка", () => {
		const res = applyTaskMutation(stateWith("pending"), "update", { id: 1 });
		assert.equal(res.op.kind, "error");
	});

	it("blockedBy на update — ошибка (create-only)", () => {
		const res = applyTaskMutation(stateWith("pending"), "update", { id: 1, blockedBy: [2] });
		assert.equal(res.op.kind, "error");
		assert.match((res.op as { message: string }).message, /create-only/);
	});

	it("metadata с null удаляет ключ", () => {
		const start: TaskState = {
			tasks: [{ id: 1, subject: "A", status: "pending", metadata: { a: 1, b: 2 } }],
			nextId: 2,
		};
		const res = applyTaskMutation(start, "update", { id: 1, metadata: { b: null } });
		assert.deepEqual(res.state.tasks[0]?.metadata, { a: 1 });
	});

	it("addBlockedBy, создающий цикл, отклоняется", () => {
		const start: TaskState = {
			tasks: [
				{ id: 1, subject: "A", status: "pending", blockedBy: [2] },
				{ id: 2, subject: "B", status: "pending" },
			],
			nextId: 3,
		};
		// 2 блокируется на 1, а 1 уже блокируется на 2 → цикл
		const res = applyTaskMutation(start, "update", { id: 2, addBlockedBy: [1] });
		assert.equal(res.op.kind, "error");
	});

	it("removeBlockedBy чистит блок", () => {
		const start: TaskState = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" },
				{ id: 2, subject: "B", status: "pending", blockedBy: [1] },
			],
			nextId: 3,
		};
		const res = applyTaskMutation(start, "update", { id: 2, removeBlockedBy: [1] });
		assert.equal(res.op.kind, "update");
		assert.equal(res.state.tasks[1]?.blockedBy, undefined);
	});
});

describe("delete / clear", () => {
	it("delete помечает tombstone", () => {
		const res = applyTaskMutation(stateWith("pending"), "delete", { id: 1 });
		assert.equal(res.op.kind, "delete");
		assert.equal(res.state.tasks[0]?.status, "deleted");
	});

	it("повторный delete той же задачи — ошибка", () => {
		const res = applyTaskMutation(stateWith("deleted"), "delete", { id: 1 });
		assert.equal(res.op.kind, "error");
	});

	it("clear обнуляет состояние", () => {
		const res = applyTaskMutation(stateWith("pending", "completed"), "clear", {});
		assert.equal(res.op.kind, "clear");
		assert.equal(res.state.tasks.length, 0);
		assert.equal(res.state.nextId, 1);
	});
});
