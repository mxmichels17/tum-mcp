// Modified UTF-7 for IMAP mailbox names (RFC 3501, section 5.1.3).

function toB64(bytes: number[]): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/=+$/, "").replace(/\//g, ",");
}

function fromB64(s: string): number[] {
	let b64 = s.replace(/,/g, "/");
	while (b64.length % 4) b64 += "=";
	const bin = atob(b64);
	const out: number[] = [];
	for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
	return out;
}

export function encodeMailboxName(name: string): string {
	let out = "";
	let pending: number[] = [];
	const flush = () => {
		if (pending.length) {
			out += `&${toB64(pending)}-`;
			pending = [];
		}
	};
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i);
		if (code >= 0x20 && code <= 0x7e) {
			flush();
			out += code === 0x26 ? "&-" : name[i];
		} else {
			pending.push(code >> 8, code & 0xff);
		}
	}
	flush();
	return out;
}

export function decodeMailboxName(name: string): string {
	return name.replace(/&([^-]*)-/g, (_m, b64: string) => {
		if (b64 === "") return "&";
		const bytes = fromB64(b64);
		let s = "";
		for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
		return s;
	});
}
