/** Thrown when the Obsidian REST API returns a non-success HTTP status. */
export class ObsidianApiError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: number | undefined;

  constructor(message: string, statusCode: number, errorCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObsidianApiError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

/** Thrown when Obsidian is unreachable (connection refused, timeout, DNS failure). */
export class ObsidianConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObsidianConnectionError";
  }
}

/** Thrown when the API key is rejected (HTTP 401/403). */
export class ObsidianAuthError extends Error {
  constructor() {
    super("Authentication failed. Check OBSIDIAN_API_KEY.");
    this.name = "ObsidianAuthError";
  }
}

interface ErrorContext {
  readonly tool: string;
  readonly path?: string;
}

/** Builds an LLM-friendly error message with actionable guidance based on error type. */
export function buildErrorMessage(error: unknown, context: ErrorContext): string {
  if (error instanceof ObsidianConnectionError) {
    return "CONNECTION ERROR: Cannot reach Obsidian. Ensure Obsidian is running with Local REST API enabled.";
  }
  if (error instanceof ObsidianAuthError) {
    return "AUTH ERROR: API key rejected. Check OBSIDIAN_API_KEY.";
  }
  if (error instanceof ObsidianApiError) {
    if (error.statusCode === 404) {
      return `NOT FOUND: ${context.path ?? "Resource"} does not exist. Use list_files_in_vault to find valid paths.`;
    }
    if (error.statusCode === 400) {
      return `BAD REQUEST: ${error.message}`;
    }
    if (error.statusCode === 405) {
      return `NOT SUPPORTED: ${error.message}. May require a specific plugin.`;
    }
    return `API ERROR (${error.statusCode}): ${error.message}`;
  }
  if (error instanceof Error) {
    return `ERROR: ${error.message}`;
  }
  return `ERROR: ${String(error)}`;
}
