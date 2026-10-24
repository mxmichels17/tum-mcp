// TCP sockets via cloudflare:sockets. Kept separate so the protocol code can be unit tested in Node.
// Docs: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

import { connect } from "cloudflare:sockets";
import type { Duplex } from "./bytes";

/** Called on every new socket. The watcher counts sockets per invocation with it. */
export const socketHooks: { onConnect?: () => void } = {};

function toDuplex(socket: Socket): Duplex {
	return {
		readable: socket.readable,
		writable: socket.writable,
		close: () => socket.close(),
	};
}

/** Implicit TLS, e.g. IMAPS on port 993. */
export function connectTls(hostname: string, port: number): Duplex {
	socketHooks.onConnect?.();
	return toDuplex(connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false }));
}

/** Plain connection that can be upgraded once with STARTTLS, e.g. SMTP submission on port 587. */
export function connectStartTls(hostname: string, port: number): { io: Duplex; startTls: () => Duplex } {
	socketHooks.onConnect?.();
	const socket = connect({ hostname, port }, { secureTransport: "starttls", allowHalfOpen: false });
	return { io: toDuplex(socket), startTls: () => toDuplex(socket.startTls()) };
}
