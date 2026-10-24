// Minimal XML parser for the small, well-formed documents of the TUMonline web services.
// No DTDs, no namespaces handling. Enough for element trees with text and attributes.

import { decodeEntities } from "./html";

export interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	text: string;
}

export function parseXml(xml: string): XmlNode {
	const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
	const stack: XmlNode[] = [root];
	const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	for (let m = re.exec(xml); m; m = re.exec(xml)) {
		const top = stack[stack.length - 1];
		if (m[1] !== undefined) top.text += m[1];
		else if (m[2] !== undefined) {
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].name === m[2]) {
					stack.length = i;
					break;
				}
			}
		} else if (m[3] !== undefined) {
			const attrs: Record<string, string> = {};
			for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
			const node: XmlNode = { name: m[3], attrs, children: [], text: "" };
			top.children.push(node);
			if (!m[5]) stack.push(node);
		} else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
	}
	return root;
}

/** Converts an element to plain JSON: leaf elements become strings, repeated names become arrays. */
export function xmlToJson(node: XmlNode): unknown {
	if (!node.children.length) {
		const t = node.text.trim();
		return Object.keys(node.attrs).length ? { ...node.attrs, ...(t ? { _text: t } : {}) } : t;
	}
	const out: Record<string, unknown> = { ...node.attrs };
	for (const c of node.children) {
		const v = xmlToJson(c);
		if (c.name in out) {
			const prev = out[c.name];
			out[c.name] = Array.isArray(prev) ? [...prev, v] : [prev, v];
		} else out[c.name] = v;
	}
	return out;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
	return node?.children.find((c) => c.name === name);
}

export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
	return node?.children.filter((c) => c.name === name) ?? [];
}

export function textOf(node: XmlNode | undefined, name: string): string | undefined {
	const c = child(node, name);
	const t = c?.text.trim();
	return t ? t : undefined;
}

/** Depth-first search for the first element with this name. */
export function find(node: XmlNode, name: string): XmlNode | undefined {
	for (const c of node.children) {
		if (c.name === name) return c;
		const hit = find(c, name);
		if (hit) return hit;
	}
	return undefined;
}
