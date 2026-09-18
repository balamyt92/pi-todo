/**
 * Смоук-тест точки входа: проверяем, что расширение регистрирует ровно то,
 * что обещает, и что обработчики событий отрабатывают без падения.
 *
 * Плюс регрессия на изоляцию состояний по сессиям: субагенты
 * (`@tintinweb/pi-subagents`) исполняются в том же процессе и не должны
 * влиять на состояние UI-сессии.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { __resetState, commitState, getState, getUiSessionId, getUiState } from "../store.ts";
import { LIST_COMMAND_NAME, TOGGLE_COMMAND_NAME, TOGGLE_SHORTCUT, TOOL_NAME } from "../types.ts";

type Handler = (event: any, ctx: any) => Promise<void>;

interface Recorded {
	tools: string[];
	toolDefs: Map<string, any>;
	commands: Map<string, any>;
	shortcuts: Array<{ key: string; handler: (ctx: any) => Promise<void> }>;
	handlers: Map<string, Handler>;
}

function fakePi(): { pi: ExtensionAPI; rec: Recorded } {
	const rec: Recorded = {
		tools: [],
		toolDefs: new Map(),
		commands: new Map(),
		shortcuts: [],
		handlers: new Map(),
	};
	const pi = {
		registerTool(def: { name: string }) {
			rec.tools.push(def.name);
			rec.toolDefs.set(def.name, def);
		},
		registerCommand(name: string, opts: any) {
			rec.commands.set(name, opts);
		},
		registerShortcut(key: string, opts: { handler: (ctx: any) => Promise<void> }) {
			rec.shortcuts.push({ key, handler: opts.handler });
		},
		on(event: string, handler: Handler) {
			rec.handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, rec };
}

/** Фейковый контекст сессии с заданным id, веткой и наличием UI. */
function fakeSession(sessionId: string, branch: unknown[] = [], hasUI = false) {
	const notices: string[] = [];
	const ctx = {
		hasUI,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		ui: {
			setWidget: (_key: string, _content: unknown, _opts?: unknown) => {},
			notify: (m: string) => notices.push(m),
		},
	};
	return { ctx, notices };
}

/** Запись `todo`-toolResult в ветке сессии. */
function todoEntry(id: number, subject: string, status: string, nextId = id + 1) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: {
				action: "create",
				params: {},
				tasks: [{ id, subject, status }],
				nextId,
			},
		},
	};
}

async function load() {
	const { default: activate } = await import("../index.ts");
	const { pi, rec } = fakePi();
	activate(pi);
	return rec;
}

describe("точка входа", () => {
	it("регистрирует тул, обе команды и хоткей", async () => {
		const rec = await load();
		assert.deepEqual(rec.tools, [TOOL_NAME]);
		assert.deepEqual([...rec.commands.keys()].sort(), [LIST_COMMAND_NAME, TOGGLE_COMMAND_NAME].sort());
		assert.deepEqual(rec.shortcuts.map((s) => s.key), [TOGGLE_SHORTCUT]);
	});

	it("подписывается на нужные события сессии", async () => {
		const rec = await load();
		for (const expected of [
			"session_start",
			"session_compact",
			"session_tree",
			"session_shutdown",
			"tool_execution_end",
			"agent_start",
		]) {
			assert.ok(rec.handlers.has(expected), `нет подписки на ${expected}`);
		}
	});

	it("session_start без UI не роняет расширение", async () => {
		const rec = await load();
		await rec.handlers.get("session_start")!({}, fakeSession("s1").ctx);
	});

	it("session_start с UI восстанавливает состояние из ветки", async () => {
		__resetState();
		const rec = await load();
		const widget: unknown[] = [];
		const ctx = {
			hasUI: true,
			sessionManager: {
				getSessionId: () => "main",
				getBranch: () => [todoEntry(1, "Восстановленная задача", "completed")],
			},
			ui: {
				setWidget: (_key: string, content: unknown) => {
					widget.push(content);
				},
				notify: () => {},
			},
		};
		await rec.handlers.get("session_start")!({}, ctx);
		// Одна выполненная задача → авто-сворачивание, панель показана.
		assert.ok(widget.length > 0, "виджет должен быть установлен");
		const content = widget[widget.length - 1];
		assert.equal(typeof content, "function");
		assert.equal(getUiSessionId(), "main");
	});

	it("/todos-toggle-widget переключает режим и не падает без задач", async () => {
		__resetState();
		const rec = await load();
		const toggle = rec.commands.get(TOGGLE_COMMAND_NAME)!;
		const { ctx, notices } = fakeSession("main", [], true);
		await toggle.handler("", ctx);
		assert.ok(notices.length > 0, "без задач должно быть уведомление");
		await toggle.handler("expand", ctx);
		await toggle.handler("collapse", ctx);
	});

	it("хоткей переключает режим", async () => {
		const rec = await load();
		const shortcut = rec.shortcuts[0]!;
		await shortcut.handler(fakeSession("main", [], true).ctx);
	});
});

describe("регрессия: изоляция состояний по сессиям (субагенты)", () => {
	it("session_start дочерней сессии не трогает UI-состояние родителя", async () => {
		__resetState();
		const rec = await load();
		const parent = fakeSession("parent", [todoEntry(1, "Родительская задача", "pending")], true);
		await rec.handlers.get("session_start")!({ reason: "startup" }, parent.ctx);
		assert.equal(getUiSessionId(), "parent");
		assert.equal(getUiState().tasks.length, 1);

		// Спавн субагента: дочерняя сессия с пустой веткой и без UI.
		await rec.handlers.get("session_start")!({ reason: "startup" }, fakeSession("child-1").ctx);

		assert.equal(getUiState().tasks.length, 1, "UI-список не должен измениться");
		assert.equal(getUiSessionId(), "parent", "UI-сессия осталась родительской");
		assert.equal(getState("child-1").tasks.length, 0, "у дочерней сессии свой пустой список");
	});

	it("вызов todo субагентом изолирован: у каждой сессии свой список", async () => {
		__resetState();
		const rec = await load();
		const parent = fakeSession("parent", [], true);
		await rec.handlers.get("session_start")!({ reason: "startup" }, parent.ctx);
		const tool = rec.toolDefs.get(TOOL_NAME)!;

		await tool.execute(
			"tc1",
			{ action: "create", subject: "Задача субагента" },
			undefined,
			undefined,
			fakeSession("child").ctx,
		);
		await tool.execute(
			"tc2",
			{ action: "create", subject: "Задача родителя" },
			undefined,
			undefined,
			parent.ctx,
		);

		assert.equal(getState("child").tasks.length, 1);
		assert.equal(getUiState().tasks.length, 1);
		assert.equal(getUiState().tasks[0]!.subject, "Задача родителя");
	});

	it("clear субагента не уничтожает список родителя", async () => {
		__resetState();
		const rec = await load();
		const parent = fakeSession("parent", [], true);
		await rec.handlers.get("session_start")!({ reason: "startup" }, parent.ctx);
		const tool = rec.toolDefs.get(TOOL_NAME)!;

		await tool.execute(
			"tc1",
			{ action: "create", subject: "Задача родителя" },
			undefined,
			undefined,
			parent.ctx,
		);
		await tool.execute(
			"tc2",
			{ action: "create", subject: "Задача субагента" },
			undefined,
			undefined,
			fakeSession("child").ctx,
		);
		await tool.execute("tc3", { action: "clear" }, undefined, undefined, fakeSession("child").ctx);

		assert.equal(getState("child").tasks.length, 0);
		assert.equal(getUiState().tasks.length, 1, "список родителя цел после clear у ребёнка");
	});

	it("shutdown дочерней сессии удаляет её ключ из store", async () => {
		__resetState();
		const rec = await load();
		const parent = fakeSession("parent", [], true);
		await rec.handlers.get("session_start")!({ reason: "startup" }, parent.ctx);
		commitState("child", { tasks: [{ id: 1, subject: "Хвост", status: "pending" }], nextId: 2 });

		await rec.handlers.get("session_shutdown")!({}, fakeSession("child").ctx);

		assert.equal(getState("child").tasks.length, 0, "ключ дочерней сессии удалён");
		assert.equal(getUiSessionId(), "parent", "UI родителя не удалён");
	});

	it("переход на новую сессию (reason new) переключает UI на её пустой список", async () => {
		__resetState();
		const rec = await load();
		const old = fakeSession("old", [], true);
		await rec.handlers.get("session_start")!({ reason: "startup" }, old.ctx);
		commitState("old", { tasks: [{ id: 1, subject: "Старая", status: "pending" }], nextId: 2 });

		await rec.handlers.get("session_start")!(
			{ reason: "new", previousSessionFile: "/x.jsonl" },
			fakeSession("fresh", [], true).ctx,
		);

		assert.equal(getUiSessionId(), "fresh");
		assert.equal(getUiState().tasks.length, 0, "переключение на новую сессию очищает видимый список");
	});

	it("компакция с пустой веткой не затирает живой список той же сессии", async () => {
		__resetState();
		const rec = await load();
		const main = fakeSession("main", [], true);
		await rec.handlers.get("session_start")!({ reason: "startup" }, main.ctx);
		commitState("main", { tasks: [{ id: 1, subject: "Живая задача", status: "pending" }], nextId: 2 });

		// После компакции ветка пуста (запись `todo` ушла в сводку).
		await rec.handlers.get("session_compact")!({}, fakeSession("main", [], true).ctx);

		assert.equal(getUiState().tasks.length, 1, "живой список сохранён при пустом replay");
	});

	it("startup с непустой веткой применяет восстановленный список", async () => {
		__resetState();
		const rec = await load();
		await rec.handlers.get("session_start")!(
			{ reason: "startup" },
			fakeSession("resumed", [todoEntry(1, "Восстановленная", "pending")], true).ctx,
		);
		assert.equal(getUiState().tasks.length, 1);
	});
});
