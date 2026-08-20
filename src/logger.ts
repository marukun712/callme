function timestamp(): string {
	return new Date().toISOString().slice(11, 23);
}

export function log(message: string) {
	console.log(`[${timestamp()}] ${message}`);
}

export function logError(message: string) {
	console.error(`[${timestamp()}] ${message}`);
}
