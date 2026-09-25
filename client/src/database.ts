import { CapabilityNotGranted } from "./errors.js";

// The address of the tool's own PostgreSQL database, as the Chest gives it
// to a server tool whose chest.json declares "capabilities": ["database"]:
// postgres://<user>:<password>@127.0.0.1:<port>/<database>?sslmode=disable,
// where the port is the tool's launcher, which relays each connection to the
// Chest (the container has no network). Hand it to a PostgreSQL client —
// postgres (porsager) or pg; the SDK carries none. PGHOST, PGPORT, PGUSER,
// PGPASSWORD and PGDATABASE say the same for a client that reads them.
//
// Throws CapabilityNotGranted when the Chest gave no database: the version
// does not declare it, or a DATABASE_URL of the tool's own is not the
// Chest's. The value is a secret: never log it, never send it to a browser.
export function databaseUrl(): string {
  const value = process.env["DATABASE_URL"];
  if (typeof value !== "string" || value.length > 1024) throw new CapabilityNotGranted("database");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapabilityNotGranted("database");
  }
  const port = Number(url.port);
  if (url.protocol !== "postgres:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535 || !/^t_[a-z][a-z0-9_]{0,47}$/u.test(url.username) || url.pathname !== "/" + url.username || url.password === "" || url.search !== "?sslmode=disable" || url.hash !== "") {
    throw new CapabilityNotGranted("database");
  }
  return value;
}
