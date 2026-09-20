/**
 * Тесты ответа модели: текст операции и нормализация висячих blockedBy (F8).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTaskMutation } from "../reducer.ts";
import { formatContent } from "../response.ts";
import type { Op } from "../reducer.ts";
import type { TaskState } from "../types.ts";

describe("ответ на delete (F8)", () => {
	it("сообщает, с каких задач снята блокировка", () => {
		const s: TaskState = {
			tasks: [
				{ id: 1, subject: "Блокировщик", status: "pending" },
				{ id: 2, subject: "Ждёт", status: "pending", blockedBy: [1] },
			],
			nextId: 3,
		};
		const res = applyTaskMutation(s, "delete", { id: 1 });
		assert.match(formatContent(res.op, res.state), /removed as blocker for #2/);
	});

	it("без разблокированных — без лишнего хвоста", () => {
		const s: TaskState = { tasks: [{ id: 1, subject: "Одинокая", status: "pending" }], nextId: 2 };
		const res = applyTaskMutation(s, "delete", { id: 1 });
		assert.equal(formatContent(res.op, res.state), "Deleted #1: Одинокая");
	});
});

describe("get поверх старой сессии с висячей ссылкой (F8)", () => {
	/** Снимок в формате ДО каскадного удаления: #2 ссылается на удалённую #1. */
	const stale: TaskState = {
		tasks: [
			{ id: 1, subject: "Удалённая", status: "deleted" },
			{ id: 2, subject: "Живая", status: "pending", blockedBy: [1] },
		],
		nextId: 3,
	};

	it("не показывает удалённого блокировщика", () => {
		const op: Op = { kind: "get", task: stale.tasks[1]! };
		const text = formatContent(op, stale);
		assert.ok(!text.includes("blockedBy"), `висячий блокировщик показан быть не должен: ${text}`);
	});

	it("живого блокировщика в get видно", () => {
		const s: TaskState = {
			tasks: [
				{ id: 1, subject: "Живой", status: "pending" },
				{ id: 2, subject: "Ждёт", status: "pending", blockedBy: [1] },
			],
			nextId: 3,
		};
		const op: Op = { kind: "get", task: s.tasks[1]! };
		assert.match(formatContent(op, s), /blockedBy: #1/);
	});

	it("list не показывает висячую ссылку в строке задачи", () => {
		const op: Op = { kind: "list", includeDeleted: false };
		const text = formatContent(op, stale);
		assert.ok(!text.includes("⛓"), `шум от удалённого блокировщика в list: ${text}`);
	});
});
