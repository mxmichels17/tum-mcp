// Minimal types for node:async_hooks (available in Workers with nodejs_compat). @types/node is not installed.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		getStore(): T | undefined;
		run<R>(store: T, fn: () => R): R;
	}
}
