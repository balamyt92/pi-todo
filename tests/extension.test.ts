/**
 * Смоук-тест точки входа: проверяем, что расширение регистрирует ровно то,
 * что обещает, и что обработчики событий отрабатывают без падения.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { __resetState } from "../store.ts";
import { LIST_COMMAND_NAME, TOGGLE_COMMAND_NAME, TOGGLE_SHORTCUT, TOOL_NAME } from "../types.ts";

type Handler = (event: any, ctx: any) => Promise<void>;

interface Recorded {
	tools: string[];
	commands: Map<string, any>;
	shortcuts: Array<{ key: string; handler: (ctx: any) => Promise<void> }>;
	handlers: Map<string, Handler>;
}

function fakePi(): { pi: ExtensionAPI; rec: Recorded } {
	const rec: Recorded = {
		tools: [],
		commands: new Map(),
		shortcuts: [],
		handlers: new Map(),
	};
	const pi = {
		registerTool(def: { name: string }) {
			rec.tools.push(def.name);
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
		const handler = rec.handlers.get("session_start")!;
		await handler({}, { hasUI: false, sessionManager: { getBranch: () => [] } });
	});

	it("session_start с UI восстанавливает состояние из ветки", async () => {
		const rec = await load();
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						action: "create",
						params: {},
						tasks: [{ id: 1, subject: "Восстановленная", status: "completed" }],
						nextId: 2,
					},
				},
			},
		];
		const widget: unknown[] = [];
		const ctx = {
			hasUI: true,
			sessionManager: { getBranch: () => branch },
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
	});

	it("/todo-toggle переключает режим и не падает без задач", async () => {
		__resetState();
		const rec = await load();
		const toggle = rec.commands.get(TOGGLE_COMMAND_NAME)!;
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { setWidget: () => {}, notify: (m: string) => notices.push(m) },
		};
		await toggle.handler("", ctx);
		assert.ok(notices.length > 0, "без задач должно быть уведомление");
		await toggle.handler("expand", ctx);
		await toggle.handler("collapse", ctx);
	});

	it("хоткей переключает режим", async () => {
		const rec = await load();
		const shortcut = rec.shortcuts[0]!;
		await shortcut.handler({
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { setWidget: () => {}, notify: () => {} },
		});
	});
});
