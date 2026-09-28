export type ProviderErrorCode =
  | "invalid_scheme"
  | "invalid_endpoint"
  | "remote_endpoint_denied"
  | "invalid_url"
  | "missing_model"
  | "missing_key"
  | "request_too_large"
  | "provider"
  | "invalid_response"
  | "unauthorized"
  | "rate_limited"
  | "network"
  | "unsupported_provider";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}
