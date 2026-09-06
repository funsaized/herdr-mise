export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000)),
    minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60);
  return hours
    ? `${hours}h ${minutes % 60}m`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`;
}
