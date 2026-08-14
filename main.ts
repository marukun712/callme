import { z } from "zod";

const SipMethod = z.enum([
	"INVITE",
	"ACK",
	"BYE",
	"CANCEL",
	"OPTIONS",
	"REGISTER",
]);

const SipRequestLineSchema = z.object({
	type: z.literal("request"),
	method: SipMethod,
	uri: z.string(),
	version: z.string(),
});

const SipStatusLineSchema = z.object({
	type: z.literal("response"),
	version: z.string(),
	statusCode: z.coerce.number().int().min(100).max(699),
	reasonPhrase: z.string(),
});

const SipHeadersSchema = z.object({
	via: z.array(z.string()).min(1),
	from: z.string(),
	to: z.string(),
	callId: z.string(),
	cseq: z.string(),
	contact: z.string().optional(),
	maxForwards: z.string().optional(),
	contentLength: z.string().optional(),
	contentType: z.string().optional(),
	extra: z.record(z.string(), z.array(z.string())),
});

const SipMessageSchema = z.object({
	startLine: z.discriminatedUnion("type", [
		SipRequestLineSchema,
		SipStatusLineSchema,
	]),
	headers: SipHeadersSchema,
	body: z.string(),
});

type SipMessage = z.infer<typeof SipMessageSchema>;

function parseSipMessage(raw: string): unknown {
	const [headerPart, ...bodyParts] = raw.split("\r\n\r\n");
	const body = bodyParts.join("\r\n\r\n");
	const lines = headerPart.split("\r\n").filter((l) => l.length > 0);
	if (lines.length === 0) return null;

	const first = lines[0];
	let startLine: unknown;

	if (first.startsWith("SIP/")) {
		const firstSpace = first.indexOf(" ");
		if (firstSpace === -1) return null;
		const version = first.slice(0, firstSpace);
		const rest = first.slice(firstSpace + 1);
		const secondSpace = rest.indexOf(" ");
		if (secondSpace === -1) return null;
		const statusCode = rest.slice(0, secondSpace);
		const reasonPhrase = rest.slice(secondSpace + 1);
		startLine = { type: "response", version, statusCode, reasonPhrase };
	} else {
		const parts = first.split(" ").filter((p) => p.length > 0);
		if (parts.length !== 3) return null;
		const [method, uri, version] = parts;
		if (!version.startsWith("SIP/")) return null;
		startLine = { type: "request", method, uri, version };
	}

	const via: string[] = [];
	let from = "";
	let to = "";
	let callId = "";
	let cseq = "";
	let contact: string | undefined;
	let maxForwards: string | undefined;
	let contentLength: string | undefined;
	let contentType: string | undefined;
	const extra: Record<string, string[]> = {};

	for (const line of lines.slice(1)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const name = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();

		switch (name) {
			case "via":
			case "v":
				via.push(value);
				break;
			case "from":
			case "f":
				from = value;
				break;
			case "to":
			case "t":
				to = value;
				break;
			case "call-id":
			case "i":
				callId = value;
				break;
			case "cseq":
				cseq = value;
				break;
			case "contact":
			case "m":
				contact = value;
				break;
			case "max-forwards":
				maxForwards = value;
				break;
			case "content-length":
			case "l":
				contentLength = value;
				break;
			case "content-type":
			case "c":
				contentType = value;
				break;
			default:
				if (!extra[name]) extra[name] = [];
				extra[name].push(value);
		}
	}

	return {
		startLine,
		headers: {
			via,
			from,
			to,
			callId,
			cseq,
			contact,
			maxForwards,
			contentLength,
			contentType,
			extra,
		},
		body,
	};
}

const numberToIp = new Map<string, string>([
	["1001", "10.0.10.1"],
	["1002", "10.0.10.2"],
]);

function timestamp(): string {
	return new Date().toISOString().slice(11, 23);
}

function log(label: string, message: string) {
	console.log(`[${timestamp()}] [${label}] ${message}`);
}

function logError(label: string, message: string) {
	console.error(`[${timestamp()}] [${label}] ${message}`);
}

function extractUser(uri: string): string | null {
	const sipIdx = uri.indexOf("sip:");
	if (sipIdx === -1) return null;
	const afterScheme = uri.slice(sipIdx + 4);
	const atIdx = afterScheme.indexOf("@");
	if (atIdx === -1) return null;
	let user = afterScheme.slice(0, atIdx);
	const semiIdx = user.indexOf(";");
	if (semiIdx !== -1) user = user.slice(0, semiIdx);
	const gtIdx = user.indexOf(">");
	if (gtIdx !== -1) user = user.slice(0, gtIdx);
	return user.length > 0 ? user : null;
}

function buildResponse(
	statusCode: number,
	reasonPhrase: string,
	msg: SipMessage,
): string {
	const lines: string[] = [`SIP/2.0 ${statusCode} ${reasonPhrase}`];
	for (const v of msg.headers.via) lines.push(`Via: ${v}`);
	lines.push(`From: ${msg.headers.from}`);
	lines.push(`To: ${msg.headers.to}`);
	lines.push(`Call-ID: ${msg.headers.callId}`);
	lines.push(`CSeq: ${msg.headers.cseq}`);
	lines.push(`Content-Length: 0`);
	lines.push("");
	lines.push("");
	return lines.join("\r\n");
}

async function handleMessage(
	raw: string,
	remoteAddr: Deno.NetAddr,
	socket: Deno.DatagramConn,
) {
	const from = `${remoteAddr.hostname}:${remoteAddr.port}`;
	const parsed = parseSipMessage(raw);
	const result = SipMessageSchema.safeParse(parsed);

	if (!result.success) {
		logError("PARSE", `${from} からの不正なSIPメッセージを破棄`);
		for (const issue of result.error.issues) {
			logError("PARSE", `  - ${issue.path.join(".")}: ${issue.message}`);
		}
		return;
	}

	const msg = result.data;

	if (msg.startLine.type !== "request") {
		log(
			"RECV",
			`${from} <- 応答 ${msg.startLine.statusCode} ${msg.startLine.reasonPhrase} (無視)`,
		);
		return;
	}

	const method = msg.startLine.method;
	log(
		"RECV",
		`${from} -> ${method} ${msg.startLine.uri} (Call-ID: ${msg.headers.callId})`,
	);

	if (
		method === "INVITE" ||
		method === "ACK" ||
		method === "BYE" ||
		method === "CANCEL"
	) {
		const targetUser = extractUser(msg.startLine.uri);
		const targetIp = targetUser ? numberToIp.get(targetUser) : undefined;

		if (!targetIp) {
			logError(
				"ROUTE",
				`番号 "${
					targetUser ?? "不明"
				}" はテーブルに存在しません -> 404 Not Found`,
			);
			const res = buildResponse(404, "Not Found", msg);
			await socket.send(new TextEncoder().encode(res), remoteAddr);
			return;
		}

		const forwardAddr: Deno.NetAddr = {
			transport: "udp",
			hostname: targetIp,
			port: 5060,
		};
		log("ROUTE", `${method} を 番号 ${targetUser} (${targetIp}) へ転送`);
		await socket.send(new TextEncoder().encode(raw), forwardAddr);
		return;
	}

	if (method === "OPTIONS") {
		log("REPLY", `${from} へ 200 OK (OPTIONS応答)`);
		const res = buildResponse(200, "OK", msg);
		await socket.send(new TextEncoder().encode(res), remoteAddr);
		return;
	}

	if (method === "REGISTER") {
		log("REPLY", `${from} へ 200 OK (REGISTER応答、テーブルへの追加なし)`);
		const res = buildResponse(200, "OK", msg);
		await socket.send(new TextEncoder().encode(res), remoteAddr);
		return;
	}
}

async function main() {
	const socket = Deno.listenDatagram({
		hostname: "0.0.0.0",
		port: 5060,
		transport: "udp",
	});
	log("BOOT", "SIPサーバー起動 udp/5060 で待受中");
	log("BOOT", `登録済み番号: ${[...numberToIp.keys()].join(", ")}`);

	for await (const [data, remoteAddr] of socket) {
		const raw = new TextDecoder().decode(data);
		handleMessage(raw, remoteAddr as Deno.NetAddr, socket).catch((e) =>
			logError("ERROR", String(e)),
		);
	}
}

main();
