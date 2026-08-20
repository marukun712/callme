import { config } from "./config.ts";
import { handleMessage } from "./src/handler.ts";
import { log, logError } from "./src/logger.ts";
import { resolveIp } from "./src/routing.ts";

async function main() {
	const wg = resolveIp(String(config.number), config.subnet);
	if (!wg) {
		console.error(
			`内線番号 ${config.number} はサブネット ${config.subnet}/24 の範囲外です`,
		);
		Deno.exit(1);
	}

	const socket = Deno.listenDatagram({
		hostname: "0.0.0.0",
		port: config.port,
		transport: "udp",
	});
	log(
		`SIPサーバー起動 udp/${config.port} で待受中 (サブネット:${config.subnet}/24, 内線番号:${config.number})`,
	);

	for await (const [data, remoteAddr] of socket) {
		const raw = new TextDecoder().decode(data);
		handleMessage(
			raw,
			remoteAddr as Deno.NetAddr,
			socket,
			{ wg, lan: config.lan },
			config.subnet,
		).catch((e) => logError(String(e)));
	}
}

main();
