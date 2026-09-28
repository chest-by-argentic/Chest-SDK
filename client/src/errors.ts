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

// The call would take the tool beyond what its Chest gives it: for files,
// their total (1 GiB unless its manifest asks more) or their count (10,000
// objects); for notifications, 1,000 recipients an hour, 100 items per member
// a day or 600 badge writes a minute. A refused call changes nothing.
export class QuotaExceeded extends ChestError {
  constructor() {
    super("quota_exceeded", 429, "the Chest refused: the tool's quota would be exceeded");
  }
}

// The tool called the Chest's API more often than its bound (600 calls a
// minute for its members): it waits before calling again.
export class RateLimited extends ChestError {
  constructor() {
    super("rate_limited", 429, "the Chest refused: too many calls, wait a minute");
  }
}

// One object is beyond the bound of one (for a file, the tool's largest
// object: 32 MiB unless its manifest asks more, 512 MiB at most).
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
