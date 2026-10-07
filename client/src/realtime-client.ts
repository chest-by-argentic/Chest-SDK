// The browser's side of a tool's live updates: the one module of the SDK
// that runs in a page (no node: import, nothing read from the environment).
// A page of the tool's private part (/chest) connects to the Chest on its
// own host — the member's session is the identity, no token —, joins the
// channels its tool declares and hears what reaches them: the rows of its
// feeds as they are committed, the tool's events, the other pages' ephemeral
// sends, who is present. The connection is the Chest's: the tool may sleep
// meanwhile.
//
//   import { connect } from "@argentic/chest-sdk/realtime/client";
//   const live = connect();
//   const room = live.channel("room:42");
//   room.on("messages.insert", row => show(row));
//   room.on("typing", (_, from) => showTyping(from));
//   room.on("joined", ({ replayed }) => replayed || refetchAfter(lastId));  // joined: fetch, unless what was missed came again
//   room.on("resync", () => refetchAfter(lastId));  // what was missed is not all kept: ask the tool
//   room.send("typing");
//   room.presence.track({ active: true });
//   room.presence.on(list => showOnline(list));
//   live.on("closed", reason => reason === "access_removed" ? showAccessRemoved() : location.reload());
//
// It reconnects by itself, unseen: a cut is told (status false) only once
// it lasts 3 s; it tries again 0.5 s to 30 s apart — at once when the page
// comes back to the foreground, from the cache or to the network, never
// while the browser is offline, and no sooner than the Chest asks when it
// is full —, joins its channels again with where each stood, and the Chest
// gives what was missed however long the page was away: the tool's events
// of the last 2 minutes, the feeds' rows of the last 7 days — or says
// resync. While connected it renews the member's session every 5 minutes.
// It stops for good when access was removed (closed "access_removed") or
// the session ended (closed "signed_out": a reload signs in again, silently
// while the provider's session lasts). Content is the tool's: render it as
// text, never as HTML.

// The subprotocol of the Chest's realtime, and where it is.
const protocol = "chest-realtime.v1";
const path = "/_chest/realtime";
// The rhythm: the backoff's first and last delay; the ping that finds a
// dead network, how long its answer may take, and how long when the page
// wakes; how often the session is renewed; how long a cut stays untold.
const firstDelay = 500, lastDelay = 30000, pingEvery = 25000, pingWait = 10000, wakeWait = 5000, renewEvery = 300000, quietFor = 3000;

// Someone present in a channel, and the state their page tracks.
export type Present = { id: string; state: Record<string, unknown> };
// Why a connection ended for good.
export type ClosedReason = "access_removed" | "signed_out";
// A listener of a channel's event: its payload, who sent it (an ephemeral
// send of another page; undefined for the tool's and the feeds'), and
// whether it is a row too long to be carried whole (partial: its key only).
export type Listener = (payload: unknown, from: string | undefined, partial: boolean) => void;

export interface Channel {
  // on listens to an event of the channel ("messages.insert", "typing"…),
  // or to what the Chest says of it: "joined" (again, after a reconnect):
  // what reaches it from now on is heard — fetch what the page shows then,
  // unless its payload says { replayed: true }: what was missed came again;
  // "resync": what the page missed is not all kept, fetch it again;
  // "kicked": the member was taken out of it; "refused": the join was, its
  // code the payload ("forbidden", "invalid_channel", "unavailable"…). It
  // returns what stops listening.
  on(event: "joined", listener: (joined: { replayed: boolean }) => void): () => void;
  on(event: string, listener: Listener): () => void;
  // send sends an ephemeral event to the other pages of the channel — a
  // channel whose rule lets it send —, 4 KiB of JSON at most; nothing is
  // sent while disconnected.
  send(event: string, payload?: unknown): void;
  presence: {
    // track sets the member present in the channel, with a state (a JSON
    // object, 1 KiB at most), kept across reconnects.
    track(state: Record<string, unknown>): void;
    // list is who is present now, the member's own pages included once
    // they track.
    list(): Present[];
    // on listens to every change of who is present.
    on(listener: (list: Present[]) => void): () => void;
  };
  leave(): void;
}

export interface Live {
  // channel joins a channel, once: the same name is the same channel.
  channel(name: string): Channel;
  // on listens to the tool's direct events (realtime.send), to "status"
  // (true once connected; false only when a cut lasts 3 s, then true when
  // connected again) and to "closed" (for good).
  on(event: "direct", listener: (event: string, payload: unknown) => void): () => void;
  on(event: "status", listener: (connected: boolean) => void): () => void;
  on(event: "closed", listener: (reason: ClosedReason) => void): () => void;
  // member is the member the Chest connected the page as, once it did.
  readonly member: string | undefined;
  close(): void;
}

// What the page offers, where it runs in a browser.
type Listening = {
  addEventListener(type: string, listener: (event: { persisted?: boolean }) => void): void;
  removeEventListener(type: string, listener: (event: { persisted?: boolean }) => void): void;
};
type Page = Partial<Listening> & {
  location?: { protocol: string; host: string };
  document?: Listening & { visibilityState?: string };
  navigator?: { onLine?: boolean };
};

type ChannelState = {
  name: string;
  listeners: Map<string, Set<Listener>>;
  presenceListeners: Set<(list: Present[]) => void>;
  present: Map<string, Record<string, unknown>>;
  tracked?: Record<string, unknown>;
  // Where the page stands, what a re-join asks to be given from: the
  // Chest's epoch and the last number seen in it (its memory), and the
  // highest position of a feed's row seen (the tool's change log; 0 for
  // none). epoch is undefined until joined once.
  epoch: string | undefined;
  seq: number;
  pos: number;
  joined: boolean;
  kicked: boolean;
};

// connect connects the page to the Chest — on its own host, or url (a
// test's) —, and stays connected until closed.
export function connect(options: { url?: string } = {}): Live {
  const page = globalThis as unknown as Page;
  const url = options.url ?? (page.location ? (page.location.protocol === "https:" ? "wss://" : "ws://") + page.location.host + path : "");
  if (!url) throw new Error("connect runs in a page of the tool, or is given a url");
  const channels = new Map<string, ChannelState>();
  const direct = new Set<(event: string, payload: unknown) => void>();
  const status = new Set<(connected: boolean) => void>();
  const closed = new Set<(reason: ClosedReason) => void>();
  const answers = new Map<number, (m: Record<string, unknown>) => void>();
  // connected: the Chest said hello on the socket; asking: a question before
  // connecting is on its way; told: the status the page was last told.
  let socket: WebSocket | undefined, ref = 0, attempts = 0, ended = false, connected = false, asking = false;
  let epoch: string | undefined, member: string | undefined, told: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, quiet: ReturnType<typeof setTimeout> | undefined, silence: ReturnType<typeof setTimeout> | undefined;
  let pinger: ReturnType<typeof setInterval> | undefined, renewer: ReturnType<typeof setInterval> | undefined;

  const emit = <T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T) => {
    for (const listener of [...listeners]) {
      try { listener(...args); } catch (error) { setTimeout(() => { throw error; }); }
    }
  };
  const fire = (ch: ChannelState, event: string, payload: unknown, from?: string, partial = false) => {
    const listeners = ch.listeners.get(event);
    if (listeners) emit(listeners, payload, from, partial);
  };
  const tell = (up: boolean) => {
    told = up;
    emit(status, up);
  };
  const presenceChanged = (ch: ChannelState) => emit(ch.presenceListeners, [...ch.present].map(([id, state]) => ({ id, state })));
  const write = (message: Record<string, unknown>, answer?: (m: Record<string, unknown>) => void): boolean => {
    if (!socket || socket.readyState !== 1) return false;
    if (answer) {
      ref = ref % 0xffffffff + 1;
      message["ref"] = ref;
      answers.set(ref, answer);
    }
    socket.send(JSON.stringify(message));
    return true;
  };

  // join joins a channel — again, from where it stood: the Chest gives
  // what was missed, then what comes; or says resync.
  const join = (ch: ChannelState) => {
    const since = ch.epoch === undefined ? undefined : { epoch: ch.epoch, seq: ch.seq, ...(ch.pos > 0 ? { pos: ch.pos } : {}) };
    write({ op: "join", ch: ch.name, ...(since ? { since } : {}) }, answer => {
      if (answer["op"] !== "ok") {
        ch.joined = false;
        fire(ch, "refused", answer["code"]);
        return;
      }
      ch.joined = true;
      const replayed = since !== undefined && answer["resync"] !== true;
      // Replayed in the same epoch, the numbers go on from the page's own;
      // otherwise from the Chest's.
      if (!replayed || since.epoch !== epoch) ch.seq = answer["seq"] as number;
      ch.epoch = epoch;
      if (typeof answer["pos"] === "number") ch.pos = answer["pos"];
      ch.present = new Map((Array.isArray(answer["presence"]) ? answer["presence"] as Present[] : []).map(p => [p.id, p.state]));
      if (ch.tracked && member !== undefined) ch.present.set(member, ch.tracked);
      if (ch.tracked) write({ op: "track", ch: ch.name, state: ch.tracked });
      if (answer["presence"] !== undefined || since !== undefined) presenceChanged(ch);
      fire(ch, "joined", { replayed });
      if (answer["resync"] === true) fire(ch, "resync", undefined);
    });
  };

  const receive = (m: Record<string, unknown>) => {
    const answer = typeof m["ref"] === "number" ? answers.get(m["ref"]) : undefined;
    if (answer) {
      answers.delete(m["ref"] as number);
      answer(m);
      return;
    }
    const ch = typeof m["ch"] === "string" ? channels.get(m["ch"]) : undefined;
    switch (m["op"]) {
      case "hello":
        epoch = m["epoch"] as string;
        member = m["member"] as string;
        attempts = 0;
        connected = true;
        clearTimeout(quiet);
        quiet = undefined;
        if (told !== true) tell(true);
        pinger = setInterval(() => check(pingWait), pingEvery);
        renewer = setInterval(() => void ask(), renewEvery);
        for (const c of channels.values()) if (!c.kicked) join(c);
        return;
      case "msg":
        if (!ch || !ch.joined) return;
        // A feed's row: its position in the tool's change log says whether
        // the page has it already (given again by a replay).
        if (typeof m["pos"] === "number") {
          if (m["pos"] <= ch.pos) return;
          ch.pos = m["pos"];
        }
        if (typeof m["seq"] === "number") ch.seq = m["seq"];
        fire(ch, m["event"] as string, m["payload"], m["from"] as string | undefined, m["partial"] === true);
        return;
      case "presence":
        if (!ch) return;
        for (const p of (m["joins"] as Present[]) ?? []) ch.present.set(p.id, p.state);
        for (const id of (m["leaves"] as string[]) ?? []) ch.present.delete(id);
        presenceChanged(ch);
        return;
      case "kicked":
        if (!ch) return;
        ch.joined = false;
        ch.kicked = true;
        fire(ch, "kicked", undefined);
        return;
      case "direct":
        emit(direct, m["event"] as string, m["payload"]);
    }
  };

  // check pings the Chest: no answer within wait, the connection is dead
  // and another is opened at once.
  const check = (wait: number) => {
    const s = socket;
    if (!s || !connected) return;
    clearTimeout(silence);
    silence = setTimeout(() => lost(s, true), wait);
    write({ op: "ping" }, () => clearTimeout(silence));
  };
  // unwatch stops what runs while connected.
  const unwatch = () => {
    clearInterval(pinger);
    clearInterval(renewer);
    clearTimeout(silence);
  };
  // lost forgets a connection that closed or went silent, tells the page
  // only if no other comes within quietFor, and connects again: at once, or
  // after the backoff.
  const lost = (s: WebSocket, now: boolean) => {
    if (socket !== s) return;
    socket = undefined;
    connected = false;
    unwatch();
    if (s.readyState <= 1) s.close(4000);
    answers.clear();
    for (const c of channels.values()) c.joined = false;
    if (told === true && quiet === undefined) quiet = setTimeout(() => { quiet = undefined; tell(false); }, quietFor);
    reconnect(now ? 0 : backoff());
  };
  // stop stops everything, for good.
  const stop = () => {
    ended = true;
    unwatch();
    clearTimeout(timer);
    clearTimeout(quiet);
    if (socket && socket.readyState <= 1) socket.close(1000);
    socket = undefined;
    page.removeEventListener?.("online", wake);
    page.removeEventListener?.("pageshow", restored);
    page.document?.removeEventListener("visibilitychange", visible);
  };
  // end ends for good, and says why.
  const end = (reason: ClosedReason) => {
    if (ended) return;
    stop();
    emit(closed, reason);
  };

  // backoff is the wait before the next attempt, the longer the more failed.
  const backoff = () => Math.random() * Math.min(lastDelay, firstDelay * 2 ** attempts++);
  // reconnect attempts again after delay (none: at once), unless an
  // attempt is already on its way.
  const reconnect = (delay: number) => {
    if (ended || socket || asking || timer !== undefined) return;
    if (delay === 0) return void attempt();
    timer = setTimeout(attempt, delay);
  };
  // attempt asks the Chest before opening: whether the member still may
  // connect, and whether it has room — when full, it waits as long as the
  // Chest asks. Offline, it waits for the network ("online").
  const attempt = async () => {
    timer = undefined;
    if (page.navigator?.onLine === false) return;
    asking = true;
    const answer = await ask();
    asking = false;
    if (ended || socket) return;
    if (answer?.status === 503) return reconnect(Math.max(backoff(), answer.retryAfter * 1000));
    open();
  };
  // ask asks the Chest over HTTPS, without upgrading, whether the member
  // may connect — which renews their session: 401 ends as signed out, 403
  // as access removed, 503 says when there is room again (Retry-After, in
  // seconds). A network down gives no answer.
  const ask = async (): Promise<{ status: number; retryAfter: number } | undefined> => {
    try {
      const answer = await fetch(url.replace(/^ws/u, "http"), { credentials: "same-origin", cache: "no-store" });
      await answer.body?.cancel();
      if (answer.status === 401) end("signed_out");
      if (answer.status === 403) end("access_removed");
      return { status: answer.status, retryAfter: Number(answer.headers.get("Retry-After")) || 0 };
    } catch {
      return undefined;
    }
  };

  const open = () => {
    const s = new WebSocket(url, protocol);
    socket = s;
    s.onmessage = event => {
      let m: unknown;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m !== null && typeof m === "object" && !Array.isArray(m)) receive(m as Record<string, unknown>);
    };
    // Every close but access removed is a cut: a session that ended
    // (1008 session_ended) is told by the question before connecting again.
    s.onclose = event => {
      if (socket === s && event.code === 1008 && event.reason === "access_removed") return end("access_removed");
      lost(s, false);
    };
  };

  // wake: the page is back — in the foreground, on the network, from the
  // browser's cache. A connection is checked at once; without one, one is
  // opened at once.
  const wake = () => {
    if (ended) return;
    if (connected) return check(wakeWait);
    if (socket || asking) return;
    clearTimeout(timer);
    timer = undefined;
    attempts = 0;
    reconnect(0);
  };
  const visible = () => { if (page.document?.visibilityState === "visible") wake(); };
  const restored = (event: { persisted?: boolean }) => { if (event.persisted) wake(); };
  page.addEventListener?.("online", wake);
  page.addEventListener?.("pageshow", restored);
  page.document?.addEventListener("visibilitychange", visible);
  open();

  return {
    get member() { return member; },
    channel(name: string): Channel {
      let ch = channels.get(name);
      if (!ch) {
        ch = { name, listeners: new Map(), presenceListeners: new Set(), present: new Map(), epoch: undefined, seq: 0, pos: 0, joined: false, kicked: false };
        channels.set(name, ch);
        if (connected) join(ch);
      }
      const state = ch;
      return {
        on(event: string, listener: Listener | ((joined: { replayed: boolean }) => void)) {
          let set = state.listeners.get(event);
          if (!set) state.listeners.set(event, set = new Set());
          const kept = listener as Listener;
          set.add(kept);
          return () => { set.delete(kept); };
        },
        send(event, payload) {
          if (state.joined) write({ op: "send", ch: state.name, event, payload: payload ?? null });
        },
        presence: {
          track(value) {
            state.tracked = value;
            if (member !== undefined) {
              state.present.set(member, value);
              presenceChanged(state);
            }
            if (state.joined) write({ op: "track", ch: state.name, state: value });
          },
          list: () => [...state.present].map(([id, value]) => ({ id, state: value })),
          on(listener) {
            state.presenceListeners.add(listener);
            return () => { state.presenceListeners.delete(listener); };
          },
        },
        leave() {
          channels.delete(state.name);
          if (state.joined) write({ op: "leave", ch: state.name });
          state.joined = false;
        },
      };
    },
    on(event: "direct" | "status" | "closed", listener: never): () => void {
      const set = (event === "direct" ? direct : event === "status" ? status : closed) as Set<unknown>;
      set.add(listener);
      return () => { set.delete(listener); };
    },
    close: stop,
  };
}
