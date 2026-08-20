import * as TID from "@atcute/tid";
import { stringify, type types } from "sip-parser";

export type SIPMessage = types.SIPMessage;
export type SIPRequest = types.SIPRequest;
export type Header = types.Header;

export function findHeader(
	headers: Header[],
	name: string,
): Header | undefined {
	return headers.find((h) => h.fieldName.toLowerCase() === name);
}

export function filterHeaders(headers: Header[], name: string): Header[] {
	return headers.filter((h) => h.fieldName.toLowerCase() === name);
}

export function viaToAddr(via: Header): Deno.NetAddr | null {
	const parts = via.fieldValue.trim().split(/\s+/);
	if (parts.length < 2) return null;
	const hostPort = parts[1].split(";")[0];
	const colonIdx = hostPort.lastIndexOf(":");
	const hostname = colonIdx !== -1 ? hostPort.slice(0, colonIdx) : hostPort;
	const portStr = colonIdx !== -1 ? hostPort.slice(colonIdx + 1) : "5060";
	return {
		transport: "udp",
		hostname,
		port: Number(portStr) || 5060,
	};
}

export function insertVia(headers: Header[], ownIp: string): Header[] {
	const branch = `z9hG4bK${TID.now()}`;
	const via: Header = {
		fieldName: "Via",
		fieldValue: `SIP/2.0/UDP ${ownIp}:5060;branch=${branch}`,
	};
	return [via, ...headers];
}

export function removeFirstVia(headers: Header[]): Header[] {
	return headers.slice(1);
}

export function buildResponse(
	statusCode: number,
	reason: string,
	req: SIPRequest,
): string {
	const headers = [
		...filterHeaders(req.headers, "via"),
		...filterHeaders(req.headers, "from"),
		...filterHeaders(req.headers, "to"),
		...filterHeaders(req.headers, "call-id"),
		...filterHeaders(req.headers, "cseq"),
		{ fieldName: "Content-Length", fieldValue: "0" },
	];
	return stringify({
		version: "2.0",
		statusCode,
		reason,
		headers,
		content: "",
	});
}

export function hasSdpContent(headers: Header[], content: string): boolean {
	return (
		content.length > 0 &&
		filterHeaders(headers, "content-type").some((h) =>
			h.fieldValue.toLowerCase().includes("sdp"),
		)
	);
}

export function updateContentLength(
	headers: Header[],
	content: string,
): Header[] {
	const len = new TextEncoder().encode(content).length;
	return headers.map((h) =>
		h.fieldName.toLowerCase() === "content-length"
			? { ...h, fieldValue: String(len) }
			: h,
	);
}
