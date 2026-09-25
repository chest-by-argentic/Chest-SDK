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
