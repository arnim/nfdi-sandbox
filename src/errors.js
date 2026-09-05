export class SandboxError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.details = details;
  }
}
