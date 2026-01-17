function formatTimestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
		date.getHours()
	)}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function buildRecordingStartMarker(date: Date): string {
	return `--- Recording started ${formatTimestamp(date)} ---`;
}

export function buildRecordingStopMarker(date: Date, startedAt: Date | null): string {
	if (!startedAt) {
		return `--- Recording stopped ${formatTimestamp(date)} ---`;
	}
	const duration = formatDuration(date.getTime() - startedAt.getTime());
	return `--- Recording stopped ${formatTimestamp(date)} (duration ${duration}) ---`;
}
