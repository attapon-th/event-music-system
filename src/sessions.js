import { randomInt, randomUUID } from "node:crypto";
import { JukeboxState } from "./state.js";

export const SESSION_TTL_MS = 60 * 60 * 1000;

export class Sessions {
  constructor(defaults, { now = Date.now, pickCode = () => randomInt(100, 1000), log = console.log } = {}) {
    this.defaults = defaults;
    this.now = now;
    this.pickCode = pickCode;
    this.log = log;
    this.rooms = new Map();
    this.tokens = new Map();
  }

  create() {
    this.prune();
    if (this.rooms.size === 900) return null;
    let code = this.pickCode();
    while (this.rooms.has(String(code))) code = code === 999 ? 100 : code + 1;
    const room = {
      code: String(code), id: randomUUID(), state: new JukeboxState(),
      ...this.defaults, primaryAdminId: null, playerToken: null, onMembersChange: () => {},
      tokens: new Set(), members: new Map(), clients: new Set(), idleSince: this.now(), lastRequestAt: new Map(),
    };
    this.rooms.set(room.code, room);
    this.event("created", room);
    return room;
  }

  get(code, id) {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (room.idleSince !== null && this.now() - room.idleSince >= SESSION_TTL_MS) {
      this.delete(room);
      return null;
    }
    return id === undefined || id === room.id ? room : null;
  }

  issue(room, role) {
    if (role === "guest" && !room.primaryAdminId) role = "admin";
    const token = randomUUID();
    const member = { room, role, token, id: randomUUID(), name: role === "player" ? "Player" : "ผู้เข้าร่วม" };
    if (role === "admin") room.primaryAdminId = member.id;
    room.tokens.add(token);
    this.tokens.set(token, member);
    room.members.set(member.id, member);
    if (role === "player") room.playerToken = token;
    room.onMembersChange();
    return member;
  }

  authenticate(token, id) {
    const member = typeof token === "string" ? this.tokens.get(token) : null;
    return member && this.get(member.room.code, id) === member.room ? member : null;
  }

  attach(ws, member) {
    this.detach(ws);
    ws.member = member;
    member.room.clients.add(ws);
    member.room.idleSince = null;
  }

  detach(ws) {
    const room = ws.member?.room;
    if (room) {
      room.clients.delete(ws);
      if (!room.clients.size && room.idleSince === null) room.idleSince = this.now();
    }
    ws.member = null;
    room?.onMembersChange();
  }

  delete(room) {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    for (const ws of [...room.clients]) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "sessionEnded", code: "ROOM_CLOSED", error: "ห้องถูกปิดแล้ว" }));
      this.detach(ws);
      ws.close(4000, "Room closed");
    }
    for (const token of room.tokens) this.tokens.delete(token);
    room.tokens.clear();
    room.members.clear();
    room.lastRequestAt.clear();
    this.event("deleted", room);
  }

  prune() {
    for (const room of this.rooms.values()) this.get(room.code);
  }

  event(event, room) {
    this.log(JSON.stringify({ event, at: new Date(this.now()).toISOString(), room: room.code, sessionId: room.id }));
  }
}
