export class CompanionHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "CompanionHttpError"; this.status = status; }
}

export function isTransientCompanionError(error: unknown) {
  return error instanceof TypeError || error instanceof DOMException && ["TimeoutError", "NetworkError"].includes(error.name)
    || error instanceof CompanionHttpError && [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(error.status);
}

export function isHlsSource(url: string, filename = "", contentType = "") {
  return /\.m3u8(?:[?#\s]|$)/i.test(`${url} ${filename}`)
    || /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)(?:;|$)/i.test(contentType.trim());
}

/** Network stalls must not drive the codec ladder into expensive video conversion. */
export function shouldEscalateStall(hasPlayed: boolean, mediaErrorCode?: number) {
  return !hasPlayed || mediaErrorCode === 3 || mediaErrorCode === 4;
}
