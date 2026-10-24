import type { Item, ScopeResult } from "./model";
import type { ApplyResult, Budget } from "./store";

/** What a collector unit gets: the budget of its invocation, the store, and a place for notes. */
export interface UnitCtx {
	env: Env;
	budget: Budget;
	/** Applies a listing. `budget` limits the loads of this listing further (it must draw on the unit budget). */
	apply(r: ScopeResult, budget?: Budget): Promise<ApplyResult>;
	note(s: string): void;
	/** D1 rows this unit may still write today (Free plan daily limit). */
	writesLeft(): number;
}

export type Unit = (ctx: UnitCtx, arg?: string) => Promise<void>;

export function item(source: string, key: string, title: string, url: string, content: Item["content"], html?: string): Item {
	return { key, source, title: title || key, url, content, ...(html ? { html } : {}) };
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A budget of at most `max` loads inside the budget of the unit. */
export function capBudget(b: Budget, max: number): Budget {
	let n = 0;
	return {
		canLoad: () => n < max && b.canLoad(),
		loaded: () => {
			n++;
			b.loaded();
		},
		used: () => b.used(),
	};
}
