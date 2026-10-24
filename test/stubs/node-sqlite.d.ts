// Minimal types for node:sqlite (Node 22), used by the collector tests as a stand-in for D1. @types/node is not installed.
declare module "node:sqlite" {
	interface StatementSync {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	}
	export class DatabaseSync {
		constructor(path: string);
		prepare(sql: string): StatementSync;
		exec(sql: string): void;
	}
}
