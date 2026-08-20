function timestamp(): string {
	return new Date().toISOString().slice(11, 23);
}

export function log(label: string, message: string) {
	console.log(`[${timestamp()}] [${label}] ${message}`);
}

export function logError(label: string, message: string) {
	console.error(`[${timestamp()}] [${label}] ${message}`);
}
