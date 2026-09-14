/**
 * store.ts — живая ячейка состояния модуля.
 *
 * Всё чтение из UI (виджет, команды) идёт через `getState()`. Единственные
 * точки записи — `commitState()` (после редьюсера) и `replaceState()`
 * (после replay из ветки сессии).
 */

import type { TaskState } from "./types.ts";
import { EMPTY_STATE } from "./types.ts";

let state: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };

/** Состояние целиком. `readonly` наружу, чтобы читатели не мутировали ячейку. */
export function getState(): TaskState {
	return state;
}

/** Публикация нового канонического состояния после редьюсера. */
export function commitState(next: TaskState): void {
	state = next;
}

/** Замена состояния целиком — используется replay'ем на старте/компакте сессии. */
export function replaceState(next: TaskState): void {
	state = next;
}

/** Полный сброс (тесты, `clear`). */
export function __resetState(): void {
	state = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}
