import { logError } from "./logger.ts";

export interface RtpSession {
	socket: Deno.DatagramConn;
	localPort: number;
	nearAddr: Deno.NetAddr | null;
	farAddr: Deno.NetAddr | null;
}

export const rtpSessions = new Map<string, RtpSession>();

let nextRtpPort = 20000;

// 20000以上の偶数番ポートを確保(偶数番はRTPの慣例)
export function allocateRtpPort(): number {
	const port = nextRtpPort;
	nextRtpPort = nextRtpPort >= 30000 ? 20000 : nextRtpPort + 2;
	return port;
}

export async function relayRtp(session: RtpSession) {
	// near = phone1 ip
	// far = callme2 ip
	try {
		for await (const [data, remoteAddr] of session.socket) {
			const src = remoteAddr as Deno.NetAddr;
			if (
				session.nearAddr &&
				src.hostname === session.nearAddr.hostname &&
				src.port === session.nearAddr.port &&
				session.farAddr
			) {
				// near -> far転送
				await session.socket.send(data, session.farAddr);
			} else if (
				session.farAddr &&
				src.hostname === session.farAddr.hostname &&
				src.port === session.farAddr.port &&
				session.nearAddr
			) {
				// far -> near転送
				await session.socket.send(data, session.nearAddr);
			}
		}
	} catch (e) {
		logError("RTP", String(e));
	}
}
