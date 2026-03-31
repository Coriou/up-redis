let isShuttingDown = false

export function shuttingDown(): boolean {
	return isShuttingDown
}

export function setShuttingDown(): void {
	isShuttingDown = true
}
