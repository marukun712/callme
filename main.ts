import * as TID from "@atcute/tid";
import { parse, stringify, type types } from "sip-parser";

type SIPMessage = types.SIPMessage;
type SIPRequest = types.SIPRequest;
type Header = types.Header;

function resolveIp(user: string): string | undefined {
	const num = Number(user);
	if (!Number.isInteger(num) || num < 1 || num > 255) return undefined;
	return `10.0.10.${num}`;
}

let localPhone: Deno.NetAddr | null = null;

function timestamp(): string {
	return new Date().toISOString().slice(11, 23);
}

function log(label: string, message: string) {
	console.log(`[${timestamp()}] [${label}] ${message}`);
}

function logError(label: string, message: string) {
	console.error(`[${timestamp()}] [${label}] ${message}`);
}

function findHeader(headers: Header[], name: string): Header | undefined {
	return headers.find((h) => h.fieldName.toLowerCase() === name);
}

function filterHeaders(headers: Header[], name: string): Header[] {
	return headers.filter((h) => h.fieldName.toLowerCase() === name);
}

function viaToAddr(via: Header): Deno.NetAddr | null {
	const parts = via.fieldValue.trim().split(/\s+/);
	if (parts.length < 2) return null;
	const hostPort = parts[1].split(";")[0];
	const colonIdx = hostPort.lastIndexOf(":");
	const hostname = colonIdx !== -1 ? hostPort.slice(0, colonIdx) : hostPort;
	const portStr = colonIdx !== -1 ? hostPort.slice(colonIdx + 1) : "5060";

	return {
		transport: "udp",
		hostname: hostname,
		port: Number(portStr) || 5060,
	};
}

function insertVia(headers: Header[], ownIp: string): Header[] {
	const branch = `z9hG4bK${TID.now()}`;
	const via: Header = {
		fieldName: "Via",
		fieldValue: `SIP/2.0/UDP ${ownIp}:5060;branch=${branch}`,
	};
	return [via, ...headers];
}

function removeFirstVia(headers: Header[]): Header[] {
	return headers.slice(1);
}

function buildResponse(
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

async function handleMessage(
	raw: string,
	remoteAddr: Deno.NetAddr,
	socket: Deno.DatagramConn,
	ownIp: string,
) {
	const from = `${remoteAddr.hostname}:${remoteAddr.port}`;

	let msg: SIPMessage;
	try {
		msg = parse(raw);
	} catch {
		logError("PARSE", `${from} からの不正なSIPメッセージを破棄`);
		return;
	}

	if (!("method" in msg)) {
		const vias = filterHeaders(msg.headers, "via");
		if (vias.length < 2) {
			logError("ROUTE", "応答のViaが1つしかなく転送先が不明なため破棄");
			return;
		}
		const nextVia = vias[1];
		const addr = viaToAddr(nextVia);
		if (!addr) {
			logError("ROUTE", "Viaヘッダーからアドレスをパースできないため破棄");
			return;
		}
		log(
			"RECV",
			`${from} <- 応答 ${msg.statusCode} ${msg.reason} -> ${addr.hostname}:${addr.port} へ転送`,
		);
		const forwarded = stringify({
			version: msg.version,
			statusCode: msg.statusCode,
			reason: msg.reason,
			headers: removeFirstVia(msg.headers),
			content: msg.content,
		});
		await socket.send(new TextEncoder().encode(forwarded), addr);
		return;
	}

	const req = msg;
	const { method, requestUri } = req;
	const callId = findHeader(req.headers, "call-id")?.fieldValue ?? "";
	log(
		"RECV",
		`${from} -> ${method} sip:${requestUri.user}@${requestUri.host} (Call-ID: ${callId})`,
	);

	if (
		method === "INVITE" ||
		method === "ACK" ||
		method === "BYE" ||
		method === "CANCEL"
	) {
		const targetUser = requestUri.user;
		const targetIp = targetUser ? resolveIp(targetUser) : undefined;

		if (!targetIp) {
			logError(
				"ROUTE",
				`番号 "${targetUser ?? "不明"}" は解決できません -> 404 Not Found`,
			);
			await socket.send(
				new TextEncoder().encode(buildResponse(404, "Not Found", req)),
				remoteAddr,
			);
			return;
		}

		let forwardAddr: Deno.NetAddr;
		if (targetIp === ownIp) {
			if (!localPhone) {
				logError("ROUTE", "電話機が未登録のため転送できません");
				await socket.send(
					new TextEncoder().encode(
						buildResponse(480, "Temporarily Unavailable", req),
					),
					remoteAddr,
				);
				return;
			}
			forwardAddr = localPhone;
		} else {
			forwardAddr = { transport: "udp", hostname: targetIp, port: 5060 };
		}

		log(
			"ROUTE",
			`${method} を ${targetUser} (${forwardAddr.hostname}:${forwardAddr.port}) へ転送`,
		);
		const forwarded = stringify({
			method: req.method,
			requestUri: req.requestUri,
			version: req.version,
			headers: insertVia(req.headers, ownIp),
			content: req.content,
		});
		await socket.send(new TextEncoder().encode(forwarded), forwardAddr);
		return;
	}

	if (method === "OPTIONS") {
		log("REPLY", `${from} へ 200 OK (OPTIONS応答)`);
		await socket.send(
			new TextEncoder().encode(buildResponse(200, "OK", req)),
			remoteAddr,
		);
		return;
	}

	if (method === "REGISTER") {
		localPhone = remoteAddr;
		log("REPLY", `${from} を電話機として登録、200 OK を返送`);
		await socket.send(
			new TextEncoder().encode(buildResponse(200, "OK", req)),
			remoteAddr,
		);
		return;
	}
}

async function main() {
	const num = Number(Deno.args[0]);
	if (!Deno.args[0] || !Number.isInteger(num) || num < 1 || num > 255) {
		console.error("使用方法: deno task dev <内線番号 1-255>");
		Deno.exit(1);
	}
	const ownIp = `10.0.10.${num}`;

	const socket = Deno.listenDatagram({
		hostname: "0.0.0.0",
		port: 5060,
		transport: "udp",
	});
	log("BOOT", `SIPサーバー起動 udp/5060 で待受中 (自IP: ${ownIp})`);

	for await (const [data, remoteAddr] of socket) {
		const raw = new TextDecoder().decode(data);
		handleMessage(raw, remoteAddr as Deno.NetAddr, socket, ownIp).catch((e) =>
			logError("ERROR", String(e)),
		);
	}
}

main();
