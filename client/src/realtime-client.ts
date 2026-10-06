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
//   room.on("joined", () => refetchAfter(lastId));  // joined: fetch what the page shows from now on
//   room.on("resync", () => refetchAfter(lastId));  // what was missed is not all kept: ask the tool
//   room.send("typing");
//   room.presence.track({ active: true });
//   room.presence.on(list => showOnline(list));
//   live.on("closed", reason => reason === "access_removed" ? showAccessRemoved() : location.reload());
//
// It reconnects by itself — at once when the page comes back to the
// foreground or the network returns, then 0.5 s to 30 s apart —, joins its
// channels again with the last number each saw, and the Chest replays what
// was missed, or says resync. It stops for good when access was removed
// (closed "access_removed") or the session ended (closed "signed_out": a
// reload signs in again, silently while the provider's session lasts).
// Content is the tool's: render it as text, never as HTML.

// The subprotocol of the Chest's realtime, and where it is.
const protocol = "chest-realtime.v1";
const path = "/_chest/realtime";
// The rhythm: the backoff's first and last delay, the ping that finds a
// dead network, how long its answer may take.
const firstDelay = 500, lastDelay = 30000, pingEvery = 25000, pingWait = 10000;

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
  // what reaches it from now on is heard — fetch what the page shows then;
  // "resync": what the page missed is not all kept, fetch it again;
  // "kicked": the member was taken out of it; "refused": the join was, its
  // code the payload ("forbidden", "invalid_channel", "unavailable"…). It
  // returns what stops listening.
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
  // (connected or not) and to "closed" (for good).
  on(event: "direct", listener: (event: string, payload: unknown) => void): () => void;
  on(event: "status", listener: (connected: boolean) => void): () => void;
  on(event: "closed", listener: (reason: ClosedReason) => void): () => void;
  // member is the member the Chest connected the page as, once it did.
  readonly member: string | undefined;
  close(): void;
}

// What the page offers, where it runs in a browser.
type Page = {
  location?: { protocol: string; host: string };
  document?: { visibilityState?: string; addEventListener(type: string, listener: () => void): void };
  addEventListener?(type: string, listener: () => void): void;
};

type ChannelState = {
  name: string;
  listeners: Map<string, Set<Listener>>;
  presenceListeners: Set<(list: Present[]) => void>;
  present: Map<string, Record<string, unknown>>;
  tracked?: Record<string, unknown>;
  // seq is the last number seen, epoch the Chest's then: what a re-join
  // asks to be replayed from.
  seq: number | undefined;
  epoch: string | undefined;
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
  let socket: WebSocket | undefined, ref = 0, attempts = 0, ended = false;
  let epoch: string | undefined, member: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, pinger: ReturnType<typeof setInterval> | undefined;

  const emit = <T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T) => {
    for (const listener of [...listeners]) {
      try { listener(...args); } catch (error) { setTimeout(() => { throw error; }); }
    }
  };
  const fire = (ch: ChannelState, event: string, payload: unknown, from?: string, partial = false) => {
    const listeners = ch.listeners.get(event);
    if (listeners) emit(listeners, payload, from, partial);
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

  const join = (ch: ChannelState) => {
    const since = ch.seq !== undefined && ch.epoch !== undefined ? { since: { epoch: ch.epoch, seq: ch.seq } } : {};
    const seen = ch.seq;
    write({ op: "join", ch: ch.name, ...since }, answer => {
      if (answer["op"] !== "ok") {
        ch.joined = false;
        fire(ch, "refused", answer["code"]);
        return;
      }
      ch.joined = true;
      ch.epoch = epoch;
      const replayed = since.since !== undefined && answer["resync"] !== true;
      ch.seq = replayed ? seen : answer["seq"] as number;
      ch.present = new Map((Array.isArray(answer["presence"]) ? answer["presence"] as Present[] : []).map(p => [p.id, p.state]));
      if (ch.tracked && member !== undefined) ch.present.set(member, ch.tracked);
      if (ch.tracked) write({ op: "track", ch: ch.name, state: ch.tracked });
      if (answer["presence"] !== undefined || since.since !== undefined) presenceChanged(ch);
      fire(ch, "joined", undefined);
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
        emit(status, true);
        for (const c of channels.values()) if (!c.kicked) join(c);
        return;
      case "msg":
        if (!ch || !ch.joined) return;
        if (typeof m["seq"] === "number") {
          if (ch.seq !== undefined && m["seq"] <= ch.seq) return;
          const gap = ch.seq !== undefined && m["seq"] !== ch.seq + 1;
          ch.seq = m["seq"];
          if (gap) fire(ch, "resync", undefined);
        }
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

  // end ends for good, and says why.
  const end = (reason: ClosedReason) => {
    if (ended) return;
    ended = true;
    stop();
    emit(closed, reason);
  };
  const stop = () => {
    clearTimeout(timer);
    clearInterval(pinger);
    if (socket && socket.readyState <= 1) socket.close(1000);
    socket = undefined;
  };

  // reconnect waits, the longer the more attempts failed — none when the
  // page or the network comes back —, then opens again; a connection that
  // never opened asks the Chest whether the session still holds.
  const reconnect = (now = false) => {
    if (ended || timer !== undefined) return;
    const delay = now ? 0 : Math.random() * Math.min(lastDelay, firstDelay * 2 ** attempts);
    attempts++;
    timer = setTimeout(async () => {
      timer = undefined;
      if (attempts > 2 && await signedOut()) return;
      open();
    }, delay);
  };
  // signedOut asks the Chest, without upgrading, whether the member still
  // may connect: 401 ends as signed out, 403 as access removed.
  const signedOut = async (): Promise<boolean> => {
    try {
      const answer = await fetch(url.replace(/^ws/u, "http"), { credentials: "same-origin", cache: "no-store" });
      if (answer.status === 401) end("signed_out");
      if (answer.status === 403) end("access_removed");
    } catch {
      // The network is down: try again later.
    }
    return ended;
  };

  const open = () => {
    if (ended) return;
    const s = new WebSocket(url, protocol);
    socket = s;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    s.onmessage = event => {
      let m: unknown;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m !== null && typeof m === "object" && !Array.isArray(m)) receive(m as Record<string, unknown>);
    };
    s.onopen = () => {
      clearInterval(pinger);
      pinger = setInterval(() => {
        clearTimeout(waiting);
        waiting = setTimeout(() => s.close(4000), pingWait);
        write({ op: "ping" }, () => clearTimeout(waiting));
      }, pingEvery);
    };
    s.onclose = event => {
      clearInterval(pinger);
      clearTimeout(waiting);
      if (socket !== s) return;
      socket = undefined;
      answers.clear();
      for (const c of channels.values()) c.joined = false;
      emit(status, false);
      if (event.code === 1008 && event.reason === "access_removed") return end("access_removed");
      if (event.code === 1008 && event.reason === "session_ended") return end("signed_out");
      reconnect();
    };
  };

  const back = () => {
    if (!ended && !socket) {
      clearTimeout(timer);
      timer = undefined;
      reconnect(true);
    }
  };
  page.addEventListener?.("online", back);
  page.document?.addEventListener("visibilitychange", () => {
    if (page.document?.visibilityState === "visible") back();
  });
  open();

  return {
    get member() { return member; },
    channel(name: string): Channel {
      let ch = channels.get(name);
      if (!ch) {
        ch = { name, listeners: new Map(), presenceListeners: new Set(), present: new Map(), seq: undefined, epoch: undefined, joined: false, kicked: false };
        channels.set(name, ch);
        if (member !== undefined) join(ch);
      }
      const state = ch;
      return {
        on(event, listener) {
          let set = state.listeners.get(event);
          if (!set) state.listeners.set(event, set = new Set());
          set.add(listener);
          return () => { set.delete(listener); };
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
    close() {
      ended = true;
      stop();
    },
  };
}
