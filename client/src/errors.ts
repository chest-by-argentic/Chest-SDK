// What the SDK throws when the Chest does not give what a tool asks: a code
// the tool can test, and the HTTP status the Chest answers for it.
export class ChestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

// The version of the tool in service does not declare the capability in its
// chest.json ("capabilities"), or it was not approved: the Chest gives it
// nothing.
export class CapabilityNotGranted extends ChestError {
  constructor(capability: string) {
    super("capability_not_granted", 403, `the Chest did not grant the capability "${capability}" to this version of the tool`);
  }
}

// What the tool keeps would go beyond what its Chest gives it: its total
// (1 GiB of files) or its count (10,000 objects).
export class QuotaExceeded extends ChestError {
  constructor() {
    super("quota_exceeded", 429, "the Chest refused: the tool's quota would be exceeded");
  }
}

// One object is beyond the bound of one (32 MiB for a file).
export class TooLarge extends ChestError {
  constructor() {
    super("too_large", 413, "the Chest refused: the object is too large");
  }
}

// The Chest did not answer, or not as it does: nothing is known of what was
// asked — a write may or may not have happened.
export class Unavailable extends ChestError {
  constructor() {
    super("unavailable", 503, "the Chest is unavailable");
  }
}
