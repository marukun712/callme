let localPhone: Deno.NetAddr | null = null;

export function getLocalPhone(): Deno.NetAddr | null {
	return localPhone;
}

export function setLocalPhone(addr: Deno.NetAddr) {
	localPhone = addr;
}

export function resolveIp(user: string): string | undefined {
	const num = Number(user);
	if (!Number.isInteger(num) || num < 1 || num > 255) return undefined;
	return `10.0.10.${num}`;
}
