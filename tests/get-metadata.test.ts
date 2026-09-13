/**
 * Репро бага: get должен возвращать metadata задачи в текстовом ответе модели.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTaskMutation } from "../reducer.ts";
import { buildToolResult, formatContent } from "../response.ts";
import { EMPTY_STATE } from "../types.ts";

describe("get: metadata в ответе модели", () => {
	it("get показывает metadata задачи", () => {
		const created = applyTaskMutation(EMPTY_STATE, "create", {
			subject: "Задача с метаданными",
			metadata: { priority: "high", tags: ["a", "b"] },
		});
		const got = applyTaskMutation(created.state, "get", { id: 1 });
		assert.equal(got.op.kind, "get");
		const text = formatContent(got.op, got.state);
		assert.ok(
			text.includes("priority"),
			`ожидали metadata в выводе get, получили:\n${text}`,
		);
	});

	it("buildToolResult для get содержит metadata в content", () => {
		const created = applyTaskMutation(EMPTY_STATE, "create", {
			subject: "Задача",
			metadata: { owner_team: "backend" },
		});
		const got = applyTaskMutation(created.state, "get", { id: 1 });
		const res = buildToolResult("get", { id: 1 }, got.state, got.op);
		const text = res.content[0]?.text ?? "";
		assert.ok(text.includes("owner_team"), `text:\n${text}`);
	});
});
