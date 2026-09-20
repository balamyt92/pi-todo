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

describe("delete: каскад входящих blockedBy (F8)", () => {
	/** #2 и #3 заблокированы на #1; у #3 ещё живая зависимость от #4. */
	function withInbound(): TaskState {
		return {
			tasks: [
				{ id: 1, subject: "Блокировщик", status: "pending" },
				{ id: 2, subject: "Ждёт #1", status: "pending", blockedBy: [1] },
				{ id: 3, subject: "Ждёт #1 и #4", status: "pending", blockedBy: [1, 4] },
				{ id: 4, subject: "Свободна", status: "pending" },
			],
			nextId: 5,
		};
	}

	it("удаление снимает id из blockedBy у всех остальных", () => {
		const res = applyTaskMutation(withInbound(), "delete", { id: 1 });
		assert.equal(res.op.kind, "delete");
		assert.equal(res.state.tasks.find((t) => t.id === 2)!.blockedBy, undefined);
		assert.deepEqual(res.state.tasks.find((t) => t.id === 3)!.blockedBy, [4]);
	});

	it("op.unblocked перечисляет разблокированные", () => {
		const res = applyTaskMutation(withInbound(), "delete", { id: 1 });
		assert.equal(res.op.kind, "delete");
		assert.deepEqual(res.op.unblocked, [2, 3]);
	});

	it("удаление без входящих ссылок даёт пустой unblocked", () => {
		// У #2 никто не ссылается — каскаду снимать нечего.
		const res = applyTaskMutation(withInbound(), "delete", { id: 2 });
		assert.equal(res.op.kind, "delete");
		assert.deepEqual(res.op.unblocked, []);
	});

	it("каскад не мутирует исходное состояние", () => {
		const before = withInbound();
		const t2Ref = before.tasks[1]!.blockedBy;
		applyTaskMutation(before, "delete", { id: 1 });
		assert.equal(before.tasks[1]!.blockedBy, t2Ref, "тот же экземпляр массива");
		assert.deepEqual(before.tasks[1]!.blockedBy, [1], "и содержимое целое");
	});

	it("задача остаётся заблокированной живой зависимостью после каскада", () => {
		// Удаляем #4 — у #3 должна остаться зависимость от #1.
		const res = applyTaskMutation(withInbound(), "delete", { id: 4 });
		assert.deepEqual(res.state.tasks.find((t) => t.id === 3)!.blockedBy, [1]);
		assert.deepEqual(res.op.kind === "delete" ? res.op.unblocked : [], [3]);
	});
});
