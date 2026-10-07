// The browser's side of a tool's live updates: the one module of the SDK
// that runs in a page (no node: import, nothing read from the environment).
// A page of the tool's private part (/chest) connects to the Chest on its
// own host — the member's session is the identity, no token —, joins the
// channels its tool declares and hears what reaches them: the rows of its
// feeds as they are committed and the tool's events (on), the other
// members' ephemeral messages (peers, never mixed with the Chest's), who is
// present. The connection is the Chest's: the tool may sleep meanwhile.
//
//   import { connect } from "@argentic/chest-sdk/realtime/client";
//   const live = connect();
//   const room = live.channel("room:42");
//   room.on("messages.insert", row => show(row));
//   room.onJoined(({ replayed }) => replayed || refetchAfter(lastId));  // joined: fetch, unless what was missed came again
//   room.onResync(() => refetchAfter(lastId));  // what was missed is not all kept: ask the tool
//   room.peers.on("typing", (_, from) => showTyping(from));
//   room.peers.send("typing");
//   room.presence.track({ active: true });
//   room.presence.on(list => showOnline(list));
//   live.focus("room:42");  // the conversation on screen: the tool notifies those not watching it
//   live.on("closed", reason => reason === "access_removed" ? showAccessRemoved() : location.reload());
//
// It reconnects by itself, unseen: a cut is told (status false) only once
// it lasts 3 s; it tries again 0.5 s to 30 s apart — at once when the page
// comes back to the foreground, from the cache or to the network, never
// while the browser is offline (going offline drops the connection at
// once), and no sooner than the Chest asks when it is full —, joins its channels again with where each stood, and the Chest
// gives what was missed however long the page was away: the tool's events
// of the last 2 minutes, the feeds' rows of the last 7 days — or says
// resync. A join the Chest has no room for is tried again with the same
// backoff, unseen. While connected it renews the member's session every 5
// minutes.
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
// What the Chest says of an event besides its payload: a feed's row has its
// position in the tool's change log, and is partial when too long to be
// carried whole (its first column only).
export type EventInfo = { pos?: number; partial?: true };
// A listener of the Chest's events on a channel: the feeds' rows and the
// tool's publishes.
export type Listener = (payload: unknown, info: EventInfo) => void;
// A listener of the other members' messages on a channel: who sent it is
// the Chest's word.
export type PeerListener = (payload: unknown, from: string) => void;
// Why a join was refused for good: "forbidden", "invalid_channel",
// "unavailable"…
export type RefusedListener = (code: string) => void;

// The grammar of a member's message: 1 to 64 of a-z 0-9 _ -, never a dot —
// dotted names are the tool's and the feeds' ("messages.insert",
// "rooms.changed"), so a member never speaks as them.
export const peerEventPattern = /^[a-z0-9_-]{1,64}$/u;

export interface Channel {
  // on listens to an event the Chest delivers on the channel: a feed's row
  // ("messages.insert") or what the tool publishes ("rooms.changed") —
  // never a member's message, whatever its name. Each on… returns what
  // stops listening.
  on(event: string, listener: Listener): () => void;
  // onJoined: joined (again, after a reconnect): what reaches the channel
  // from now on is heard — fetch what the page shows then, unless replayed:
  // what was missed came again.
  onJoined(listener: (joined: { replayed: boolean }) => void): () => void;
  // onResync: what the page missed is not all kept, fetch it again.
  onResync(listener: () => void): () => void;
  // onKicked: the member was taken out of the channel.
  onKicked(listener: () => void): () => void;
  // onRefused: the join was refused, and why.
  onRefused(listener: RefusedListener): () => void;
  // peers are the other members' ephemeral messages on the channel (typing,
  // cursors) — a channel whose rule lets them send.
  peers: {
    // on listens to a member's message, and who sent it.
    on(event: string, listener: PeerListener): () => void;
    // send sends a message to the other pages of the channel, 4 KiB of JSON
    // at most; nothing is sent while disconnected. A name the Chest refuses
    // (a dot, an uppercase letter) throws a TypeError "invalid_event": a
    // fault of the page's code.
    send(event: string, payload?: unknown): void;
  };
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
  // focus says which joined channel the member has on screen (a
  // conversation open), null for none: kept by the Chest for the tool alone
  // (realtime.online's watching), never shown to other members — and none
  // while the page is hidden.
  focus(name: string | null): void;
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
  peerListeners: Map<string, Set<PeerListener>>;
  joinedListeners: Set<(joined: { replayed: boolean }) => void>;
  resyncListeners: Set<() => void>;
  kickedListeners: Set<() => void>;
  refusedListeners: Set<RefusedListener>;
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
  // A join the Chest had no room for: how many in a row, and the next try.
  full: number;
  retry: ReturnType<typeof setTimeout> | undefined;
};

// listen adds a listener to a set, and returns what removes it.
function listen<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => { set.delete(listener); };
}
// listenTo adds a listener of one event.
function listenTo<T>(map: Map<string, Set<T>>, event: string, listener: T): () => void {
  let set = map.get(event);
  if (!set) map.set(event, set = new Set());
  return listen(set, listener);
}

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
  // connecting is on its way; told: the status the page was last told;
  // focused: the channel the page has on screen, focusSent what the Chest
  // was last told of it on this connection ("" none).
  let socket: WebSocket | undefined, ref = 0, attempts = 0, ended = false, connected = false, asking = false;
  let epoch: string | undefined, member: string | undefined, told: boolean | undefined, focused: string | null = null, focusSent = "";
  let timer: ReturnType<typeof setTimeout> | undefined, quiet: ReturnType<typeof setTimeout> | undefined, silence: ReturnType<typeof setTimeout> | undefined;
  let pinger: ReturnType<typeof setInterval> | undefined, renewer: ReturnType<typeof setInterval> | undefined;

  const emit = <T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T) => {
    for (const listener of [...listeners]) {
      try { listener(...args); } catch (error) { setTimeout(() => { throw error; }); }
    }
  };
  const fire = <T extends unknown[]>(listeners: Map<string, Set<(...args: T) => void>>, event: string, ...args: T) => {
    const set = listeners.get(event);
    if (set) emit(set, ...args);
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

  // shown: the page is in the foreground (always, without a document).
  const shown = () => (page.document?.visibilityState ?? "visible") === "visible";
  // tellFocus tells the Chest the channel the page has on screen: the one
  // focused once joined and while shown, none otherwise — only when it
  // changes.
  const tellFocus = () => {
    const ch = focused === null ? undefined : channels.get(focused);
    const now = ch?.joined && shown() ? ch.name : "";
    if (now !== focusSent && write({ op: "focus", ch: now }, () => {})) focusSent = now;
  };

  // join joins a channel — again, from where it stood: the Chest gives
  // what was missed, then what comes; or says resync. A Chest without room
  // for it is asked again after the backoff, unseen.
  const join = (ch: ChannelState) => {
    const since = ch.epoch === undefined ? undefined : { epoch: ch.epoch, seq: ch.seq, ...(ch.pos > 0 ? { pos: ch.pos } : {}) };
    write({ op: "join", ch: ch.name, ...(since ? { since } : {}) }, answer => {
      if (answer["code"] === "full") {
        ch.retry = setTimeout(() => {
          ch.retry = undefined;
          if (connected && channels.get(ch.name) === ch) join(ch);
        }, delay(ch.full++));
        return;
      }
      if (answer["op"] !== "ok") {
        ch.joined = false;
        emit(ch.refusedListeners, String(answer["code"]));
        return;
      }
      ch.joined = true;
      ch.full = 0;
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
      tellFocus();
      emit(ch.joinedListeners, { replayed });
      if (answer["resync"] === true) emit(ch.resyncListeners);
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
        focusSent = "";
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
        fire(ch.listeners, m["event"] as string, m["payload"], { ...(typeof m["pos"] === "number" ? { pos: m["pos"] } : {}), ...(m["partial"] === true ? { partial: true as const } : {}) });
        return;
      case "peer":
        if (ch?.joined) fire(ch.peerListeners, m["event"] as string, m["payload"], m["from"] as string);
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
        if (focusSent === ch.name) focusSent = "";
        emit(ch.kickedListeners);
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
    for (const c of channels.values()) {
      c.joined = false;
      clearTimeout(c.retry);
      c.retry = undefined;
    }
    if (told === true && quiet === undefined) quiet = setTimeout(() => { quiet = undefined; tell(false); }, quietFor);
    reconnect(now ? 0 : backoff());
  };
  // stop stops everything, for good.
  const stop = () => {
    ended = true;
    unwatch();
    clearTimeout(timer);
    clearTimeout(quiet);
    for (const c of channels.values()) clearTimeout(c.retry);
    if (socket && socket.readyState <= 1) socket.close(1000);
    socket = undefined;
    page.removeEventListener?.("online", wake);
    page.removeEventListener?.("offline", gone);
    page.removeEventListener?.("pageshow", restored);
    page.document?.removeEventListener("visibilitychange", visible);
  };
  // end ends for good, and says why.
  const end = (reason: ClosedReason) => {
    if (ended) return;
    stop();
    emit(closed, reason);
  };

  // delay is the wait before the next attempt, the longer the more failed
  // before it; backoff the wait before connecting again.
  const delay = (failed: number) => Math.random() * Math.min(lastDelay, firstDelay * 2 ** failed);
  const backoff = () => delay(attempts++);
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
  // gone: the browser says the network is gone — a Wi-Fi left, a cable
  // pulled —: the connection is dropped at once, and the page waits for it
  // to come back ("online") rather than for a ping to go unanswered.
  const gone = () => { if (!ended && socket) lost(socket, false); };
  // visibilitychange: shown, the page wakes; shown or hidden, the Chest is
  // told what it has on screen.
  const visible = () => {
    if (shown()) wake();
    tellFocus();
  };
  const restored = (event: { persisted?: boolean }) => { if (event.persisted) wake(); };
  page.addEventListener?.("online", wake);
  page.addEventListener?.("offline", gone);
  page.addEventListener?.("pageshow", restored);
  page.document?.addEventListener("visibilitychange", visible);
  open();

  return {
    get member() { return member; },
    channel(name: string): Channel {
      let ch = channels.get(name);
      if (!ch) {
        ch = { name, listeners: new Map(), peerListeners: new Map(), joinedListeners: new Set(), resyncListeners: new Set(), kickedListeners: new Set(), refusedListeners: new Set(), presenceListeners: new Set(), present: new Map(), epoch: undefined, seq: 0, pos: 0, joined: false, kicked: false, full: 0, retry: undefined };
        channels.set(name, ch);
        if (connected) join(ch);
      }
      const state = ch;
      return {
        on: (event, listener) => listenTo(state.listeners, event, listener),
        onJoined: listener => listen(state.joinedListeners, listener),
        onResync: listener => listen(state.resyncListeners, listener),
        onKicked: listener => listen(state.kickedListeners, listener),
        onRefused: listener => listen(state.refusedListeners, listener),
        peers: {
          on: (event, listener) => listenTo(state.peerListeners, event, listener),
          send(event, payload) {
            if (typeof event !== "string" || !peerEventPattern.test(event)) throw new TypeError("invalid_event: a member's message is 1 to 64 of a-z 0-9 _ -, without a dot");
            if (state.joined) write({ op: "send", ch: state.name, event, payload: payload ?? null });
          },
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
          on: listener => listen(state.presenceListeners, listener),
        },
        // leave leaves the channel: the Chest forgets the page's focus on it.
        leave() {
          channels.delete(state.name);
          clearTimeout(state.retry);
          if (state.joined) write({ op: "leave", ch: state.name });
          state.joined = false;
          if (focusSent === state.name) focusSent = "";
        },
      };
    },
    focus(name) {
      focused = name;
      tellFocus();
    },
    on(event: "direct" | "status" | "closed", listener: never): () => void {
      return listen((event === "direct" ? direct : event === "status" ? status : closed) as Set<unknown>, listener);
    },
    close: stop,
  };
}
