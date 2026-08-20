import { handleMessage } from "./src/handler.ts";
import { log, logError } from "./src/logger.ts";

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
	log("BOOT", `SIPサーバー起動 udp/5060 で待受中`);

	for await (const [data, remoteAddr] of socket) {
		const raw = new TextDecoder().decode(data);
		handleMessage(raw, remoteAddr as Deno.NetAddr, socket, ownIp).catch((e) =>
			logError("ERROR", String(e)),
		);
	}
}

main();
