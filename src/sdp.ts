import { parse as parseSdp, write as writeSdp } from "sdp-transform";

export function rewriteSdpContent(
	content: string,
	ip: string,
	localPort: number,
): { content: string; originalAddr: Deno.NetAddr } | null {
	const sdp = parseSdp(content);
	const audio = sdp.media.find((m) => m.type === "audio");
	if (!audio) return null;

	const originalIp = audio.connection?.ip ?? sdp.connection?.ip ?? "";
	const originalPort = audio.port;

	sdp.origin.address = ip;
	if (sdp.connection) sdp.connection.ip = ip;
	for (const m of sdp.media) {
		if (m.connection) m.connection.ip = ip;
		if (m.type === "audio") m.port = localPort;
	}

	return {
		content: writeSdp(sdp),
		originalAddr: {
			transport: "udp",
			hostname: originalIp,
			port: originalPort,
		},
	};
}
