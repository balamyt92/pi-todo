/**
 * Тесты виджета: переключение режима и авто-сворачивание.
 *
 * UI заглушается: важно не как нарисовано, а какие решения принимает
 * TodoOverlay по смене состояния.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { TodoOverlay } from "../overlay.ts";
import { commitState, setUiSession, __resetState } from "../store.ts";
import type { Task, TaskState } from "../types.ts";

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

interface FakeWidget {
	render(width: number): string[];
}

function fakeUI() {
	let component: FakeWidget | null = null;
	let lastContent: unknown = null;
	const tui = { requestRender: () => {} };
	const ui = {
		setWidget(_key: string, content: unknown, _opts?: unknown) {
			lastContent = content;
			if (typeof content === "function") {
				component = (content as (t: unknown, th: Theme) => FakeWidget)(tui, plainTheme());
			} else {
				component = null;
			}
		},
	} as unknown as ExtensionUIContext;
	return { ui, getComponent: () => component, getLast: () => lastContent };
}

function makeTasks(specs: Task["status"][]): TaskState {
	return {
		tasks: specs.map((status, i) => ({ id: i + 1, subject: `Задача ${i + 1}`, status })),
		nextId: specs.length + 1,
	};
}

/** Сессия, под которой тесты держат состояние (виджет читает UI-сессию). */
const SESSION = "test-session";

function overlayWith(specs: Task["status"][]) {
	__resetState();
	setUiSession(SESSION);
	const { ui, getComponent, getLast } = fakeUI();
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	commitState(SESSION, makeTasks(specs));
	overlay.update();
	return { overlay, getComponent, getLast };
}

describe("режим виджета", () => {
	it("старт — развёрнутый", () => {
		const { overlay } = overlayWith(["pending", "pending"]);
		assert.equal(overlay.getMode(), "expanded");
	});

	it("toggle() переводит в свёрнутый и обратно", () => {
		const { overlay } = overlayWith(["pending", "pending"]);
		assert.equal(overlay.toggle(), "collapsed");
		assert.equal(overlay.toggle(), "expanded");
	});

	it("в свёрнутом режиме ровно одна строка", () => {
		__resetState();
		setUiSession(SESSION);
		const { ui, getComponent } = fakeUI();
		const overlay = new TodoOverlay();
		overlay.setUICtx(ui);
		commitState(SESSION, makeTasks(["pending", "in_progress", "completed"]));
		overlay.update();
		assert.equal(getComponent()!.render(100).length, 4, "развёрнуто: заголовок + 3 задачи");
		overlay.setMode("collapsed");
		assert.equal(getComponent()!.render(100).length, 1, "свёрнуто: одна строка");
	});

	it("в развёрнутом режиме есть заголовок и строки задач", () => {
		const { getComponent } = overlayWith(["pending", "in_progress", "completed"]);
		const lines = getComponent()!.render(100);
		assert.ok(lines.length >= 4, `ожидали заголовок + 3 задачи, получили ${lines.length}`);
		assert.match(lines[0]!, /Задачи \(1\/3\)/);
	});
});

describe("авто-сворачивание", () => {
	it("все задачи выполнены → свёрнуто", () => {
		const { overlay } = overlayWith(["completed", "completed"]);
		assert.equal(overlay.getMode(), "collapsed");
	});

	it("не все выполнены → остаётся развёрнутым", () => {
		const { overlay } = overlayWith(["completed", "pending"]);
		assert.equal(overlay.getMode(), "expanded");
	});

	it("после ручного разворачивания не захлопывается обратно", () => {
		const { overlay } = overlayWith(["completed"]);
		assert.equal(overlay.getMode(), "collapsed");
		overlay.setMode("expanded");
		overlay.update();
		assert.equal(overlay.getMode(), "expanded");
	});

	it("после появления новой незавершённой задачи авто-сворачивание снова вооружено", () => {
		const { overlay } = overlayWith(["completed"]);
		assert.equal(overlay.getMode(), "collapsed");
		overlay.setMode("expanded");
		// новая незавершённая задача снимает «замок»
		commitState(SESSION, makeTasks(["completed", "pending"]));
		overlay.update();
		assert.equal(overlay.getMode(), "expanded");
		// и на закрытии всей новой порогa снова сворачивается
		commitState(SESSION, makeTasks(["completed", "completed"]));
		overlay.update();
		assert.equal(overlay.getMode(), "collapsed");
	});
});

describe("пустой список", () => {
	it("задач нет — виджет снимается", () => {
		const { getLast } = overlayWith([]);
		assert.equal(getLast(), undefined);
	});
});
