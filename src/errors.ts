export class AsrError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export function cancelled(): AsrError {
  return new AsrError("cancelled", "Transcription cancelled", 499);
}
