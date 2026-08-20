import { Netmask } from "netmask";

let localPhone: Deno.NetAddr | null = null;

export function getLocalPhone(): Deno.NetAddr | null {
	return localPhone;
}

export function setLocalPhone(addr: Deno.NetAddr) {
	localPhone = addr;
}

export function resolveIp(user: string, subnet: string): string | undefined {
	const num = Number(user);
	if (!Number.isInteger(num)) return undefined;

	const block = new Netmask(`${subnet}/24`);
	const prefix = block.base.split(".").slice(0, 3).join(".");
	const ip = `${prefix}.${num}`;

	return block.contains(ip) ? ip : undefined;
}
