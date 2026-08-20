import { parse, stringify } from "sip-parser";
import { log, logError } from "./logger.ts";
import { getLocalPhone, resolveIp, setLocalPhone } from "./routing.ts";
import {
	allocateRtpPort,
	type RtpSession,
	relayRtp,
	rtpSessions,
} from "./rtp.ts";
import { rewriteSdpContent } from "./sdp.ts";
import {
	buildResponse,
	filterHeaders,
	findHeader,
	type Header,
	hasSdpContent,
	insertVia,
	removeFirstVia,
	type SIPRequest,
	updateContentLength,
	viaToAddr,
} from "./sip.ts";

async function send(
	socket: Deno.DatagramConn,
	message: string,
	addr: Deno.NetAddr,
) {
	await socket.send(new TextEncoder().encode(message), addr);
}

async function handleRegister(
	req: SIPRequest,
	remoteAddr: Deno.NetAddr,
	socket: Deno.DatagramConn,
) {
	setLocalPhone(remoteAddr);
	const from = `${remoteAddr.hostname}:${remoteAddr.port}`;
	log("REPLY", `${from} を電話機として登録、200 OK を返送`);
	await send(socket, buildResponse(200, "OK", req), remoteAddr);
}

async function handleOptions(
	req: SIPRequest,
	remoteAddr: Deno.NetAddr,
	socket: Deno.DatagramConn,
) {
	const from = `${remoteAddr.hostname}:${remoteAddr.port}`;
	log("REPLY", `${from} へ 200 OK (OPTIONS応答)`);
	await send(socket, buildResponse(200, "OK", req), remoteAddr);
}

// phone1, callme1 = 自分
// phone2, callme2 = 相手

// phone2 -> callme2 -> callme1 -> phone1
async function handleIncoming(
	req: SIPRequest,
	remoteAddr: Deno.NetAddr,
	socket: Deno.DatagramConn,
	ownIp: string,
	callId: string,
) {
	const localPhone = getLocalPhone();
	if (!localPhone) {
		logError("ROUTE", "電話機が未登録のため転送できません");
		await send(
			socket,
			buildResponse(480, "Temporarily Unavailable", req),
			remoteAddr,
		);
		return;
	}

	let content = req.content;
	let headers = insertVia(req.headers, ownIp);

	// SDP転送(callme2 ip -> callme1 ip)
	if (req.method === "INVITE" && hasSdpContent(req.headers, content)) {
		headers = setupRtpSession(callId, headers);
		const session = rtpSessions.get(callId);
		if (session) {
			const result = rewriteSdpContent(content, ownIp, session.localPort);
			if (result) {
				session.nearAddr = result.originalAddr;
				content = result.content;
				headers = updateContentLength(headers, content);
			}
		}
	}

	log(
		"ROUTE",
		`${req.method} をphone1 (${localPhone.hostname}:${localPhone.port}) へ転送`,
	);
	await send(
		socket,
		stringify({
			method: req.method,
			requestUri: req.requestUri,
			version: req.version,
			headers,
			content,
		}),
		localPhone,
	);
}

// phone1 -> callme1 -> callme2 -> phone2
async function handleOutgoing(
	req: SIPRequest,
	socket: Deno.DatagramConn,
	ownIp: string,
	callId: string,
	targetUser: string,
	targetIp: string,
) {
	const forwardAddr: Deno.NetAddr = {
		transport: "udp",
		hostname: targetIp,
		port: 5060,
	};

	let content = req.content;
	let headers = insertVia(req.headers, ownIp);

	// SDP転送(phone1 ip -> callme1 ip)
	if (req.method === "INVITE" && hasSdpContent(req.headers, content)) {
		headers = setupRtpSession(callId, headers);
		const session = rtpSessions.get(callId);
		if (session) {
			const result = rewriteSdpContent(content, ownIp, session.localPort);
			if (result) {
				session.nearAddr = result.originalAddr;
				content = result.content;
				headers = updateContentLength(headers, content);
			}
		}
	}

	log(
		"ROUTE",
		`${req.method} を ${targetUser} (${forwardAddr.hostname}:${forwardAddr.port}) へ転送`,
	);
	await send(
		socket,
		stringify({
			method: req.method,
			requestUri: req.requestUri,
			version: req.version,
			headers,
			content,
		}),
		forwardAddr,
	);
}

// phone1 -> callme1(発信)またはcallme2 -> callme1(着信)を処理
async function handleRequest(
	req: SIPRequest,
	remoteAddr: Deno.NetAddr,
	socket: Deno.DatagramConn,
	ownIp: string,
	subnet: string,
) {
	const { method, requestUri } = req;
	const callId = findHeader(req.headers, "call-id")?.fieldValue ?? "";

	if (method === "BYE") {
		const session = rtpSessions.get(callId);
		if (session) {
			session.socket.close();
			rtpSessions.delete(callId);
			log("RTP", `セッション ${callId} を終了`);
		}
	}

	const targetUser = requestUri.user;
	if (!targetUser) {
		await send(socket, buildResponse(404, "Not Found", req), remoteAddr);
		return;
	}

	const targetIp = resolveIp(targetUser, subnet);
	if (!targetIp) {
		logError("ROUTE", `番号 "${targetUser}" は解決できません -> 404 Not Found`);
		await send(socket, buildResponse(404, "Not Found", req), remoteAddr);
		return;
	}

	if (targetIp === ownIp) {
		// 着信
		await handleIncoming(req, remoteAddr, socket, ownIp, callId);
	} else {
		// 発信
		await handleOutgoing(req, socket, ownIp, callId, targetUser, targetIp);
	}
}

// phone1 -> callme1(着信応答)またはcallme2 -> callme1(発信応答)を処理
async function handleResponse(
	msg: ReturnType<typeof parse>,
	socket: Deno.DatagramConn,
	ownIp: string,
) {
	if ("method" in msg) return;

	const vias = filterHeaders(msg.headers, "via");
	if (vias.length < 2) {
		logError("ROUTE", "応答のViaが1つしかなく転送先が不明なため破棄");
		return;
	}
	const addr = viaToAddr(vias[1]);
	if (!addr) {
		logError("ROUTE", "Viaヘッダーからアドレスをパースできないため破棄");
		return;
	}

	let content = msg.content;
	let headers = removeFirstVia(msg.headers);

	// SDP転送(phone1 ip -> callme1 ip or callme2 -> callme1 ip)
	if (hasSdpContent(msg.headers, content)) {
		const callId = findHeader(msg.headers, "call-id")?.fieldValue ?? "";
		const session = rtpSessions.get(callId);
		if (session) {
			const result = rewriteSdpContent(content, ownIp, session.localPort);
			if (result) {
				session.farAddr = result.originalAddr;
				content = result.content;
				headers = updateContentLength(headers, content);
			}
		}
	}

	log(
		"RECV",
		`応答 ${msg.statusCode} ${msg.reason} -> ${addr.hostname}:${addr.port} へ転送`,
	);
	await send(
		socket,
		stringify({
			version: msg.version,
			statusCode: msg.statusCode,
			reason: msg.reason,
			headers,
			content,
		}),
		addr,
	);
}

function setupRtpSession(callId: string, headers: Header[]): Header[] {
	if (!rtpSessions.has(callId)) {
		const localPort = allocateRtpPort();
		const rtpSocket = Deno.listenDatagram({
			hostname: "0.0.0.0",
			port: localPort,
			transport: "udp",
		});
		const session: RtpSession = {
			socket: rtpSocket,
			localPort,
			nearAddr: null,
			farAddr: null,
		};
		rtpSessions.set(callId, session);
		relayRtp(session).catch((e) => logError("RTP", String(e)));
	}
	return headers;
}

export async function handleMessage(
	raw: string,
	remoteAddr: Deno.NetAddr,
	socket: Deno.DatagramConn,
	ownIp: string,
	subnet: string,
) {
	const from = `${remoteAddr.hostname}:${remoteAddr.port}`;

	let msg: ReturnType<typeof parse>;
	try {
		msg = parse(raw);
	} catch {
		logError("PARSE", `${from} からの不正なSIPメッセージを破棄`);
		return;
	}

	if (!("method" in msg)) {
		await handleResponse(msg, socket, ownIp);
		return;
	}

	const req = msg;
	const callId = findHeader(req.headers, "call-id")?.fieldValue ?? "";
	log(
		"RECV",
		`${from} -> ${req.method} sip:${req.requestUri.user}@${req.requestUri.host} (Call-ID: ${callId})`,
	);

	if (
		req.method === "INVITE" ||
		req.method === "ACK" ||
		req.method === "BYE" ||
		req.method === "CANCEL"
	) {
		await handleRequest(req, remoteAddr, socket, ownIp, subnet);
		return;
	}

	if (req.method === "OPTIONS") {
		await handleOptions(req, remoteAddr, socket);
		return;
	}

	if (req.method === "REGISTER") {
		await handleRegister(req, remoteAddr, socket);
		return;
	}
}
