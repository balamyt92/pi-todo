/**
 * store.ts — живая ячейка состояния, изолированная по сессиям.
 *
 * Субагенты (`@tintinweb/pi-subagents`) исполняются в том же процессе, что
 * основная сессия, и модуль расширения им общий. Одна ячейка состояния на
 * процесс означала бы, что задачи субагентов попадают в виджет основной
 * сессии, а `clear` субагента уничтожает список через границу сессий.
 * Поэтому состояние хранится в `Map` под ключом `sessionManager.getSessionId()`.
 *
 * UI (виджет, слэш-команды) читает состояние «своей» сессии через
 * `getUiState()` — сессии, которой принадлежит TUI. Указатель на неё
 * выставляется на `session_start` при `hasUI`.
 *
 * Точки записи: `commitState()` (после редьюсера), `replaceState()` (после
 * replay из ветки сессии), `forgetSession()` (при shutdown дочерней сессии,
 * чтобы Map не рос на каждый спавн).
 */

import type { TaskState } from "./types.ts";
import { EMPTY_STATE } from "./types.ts";

const sessions = new Map<string, TaskState>();

/** Сессия, которой принадлежит UI (основная TUI-сессия). */
let uiSessionId: string | undefined;

function emptyState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

/**
 * Состояние целиком для данной сессии. `readonly` наружу, чтобы читатели не
 * мутировали ячейку. Для неизвестной сессии — пустой список.
 */
export function getState(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? emptyState();
}

/** Публикация нового канонического состояния сессии после редьюсера. */
export function commitState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/** Замена состояния целиком — используется replay'ем на старте/компакте сессии. */
export function replaceState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/** Идентификатор UI-сессии (та, чей список показывает виджет). */
export function getUiSessionId(): string | undefined {
	return uiSessionId;
}

/** Запомнить UI-сессию — вызывается на `session_start` с `hasUI`. */
export function setUiSession(sessionId: string): void {
	uiSessionId = sessionId;
}

/**
 * Состояние UI-сессии — что показывают виджет и `/todos`.
 * Пока UI-сессия не выбрана, пустой список.
 */
export function getUiState(): TaskState {
	return uiSessionId === undefined ? emptyState() : getState(uiSessionId);
}

/** Забыть состояние сессии (shutdown дочерней сессии — чтобы Map не рос). */
export function forgetSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/**
 * Сбросить указатель UI-сессии, если он всё ещё указывает на `sessionId`.
 * Нужен при shutdown UI-сессии, чтобы не оставить висячий указатель на
 * уже удалённую запись до следующего `session_start`.
 */
export function clearUiSessionIfMatches(sessionId: string): void {
	if (uiSessionId === sessionId) uiSessionId = undefined;
}

/** Полный сброс (тесты). */
export function __resetState(): void {
	sessions.clear();
	uiSessionId = undefined;
}
