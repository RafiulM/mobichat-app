export function renderGB(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb.toFixed(2)
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return ''
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}

export function formatETA(remainingBytes: number, speed: number): string {
  if (speed <= 0 || remainingBytes <= 0) return ''
  const seconds = Math.ceil(remainingBytes / speed)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}
