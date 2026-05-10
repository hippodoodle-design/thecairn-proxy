export class MediaPipelineError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'MediaPipelineError';
    if (cause) this.cause = cause;
  }
}

export class SourceUnavailableError extends MediaPipelineError {
  constructor(sourceUrl, { cause } = {}) {
    super(`Source unavailable: ${sourceUrl}`, { cause });
    this.name = 'SourceUnavailableError';
    this.sourceUrl = sourceUrl;
  }
}

export class AccessDeniedError extends MediaPipelineError {
  constructor(sourceUrl, reason, { cause } = {}) {
    super(`Access denied for ${sourceUrl}: ${reason}`, { cause });
    this.name = 'AccessDeniedError';
    this.sourceUrl = sourceUrl;
    this.reason = reason;
  }
}

export class TooLongError extends MediaPipelineError {
  constructor(sourceUrl, durationSeconds, capSeconds) {
    super(`Source too long: ${durationSeconds}s exceeds cap ${capSeconds}s`);
    this.name = 'TooLongError';
    this.sourceUrl = sourceUrl;
    this.durationSeconds = durationSeconds;
    this.capSeconds = capSeconds;
  }
}

export class TranscriptionError extends MediaPipelineError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'TranscriptionError';
  }
}

export class UnderstandingError extends MediaPipelineError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'UnderstandingError';
  }
}

export class StorageError extends MediaPipelineError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'StorageError';
  }
}

export class HarvestError extends MediaPipelineError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'HarvestError';
  }
}

export class EmbeddingError extends MediaPipelineError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'EmbeddingError';
  }
}

/**
 * SafetyError carries a classification field so callers can branch on the
 * specific reason (csam_match, etc.). 'csam-detected' is the canonical
 * message for the IWF-match path; the structured `details` object lets the
 * worker insert an incidents row without re-deriving fields.
 */
export class SafetyError extends MediaPipelineError {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : {});
    this.name = 'SafetyError';
    this.classification = options.classification ?? 'unknown';
    this.details = options.details ?? null;
  }
}
