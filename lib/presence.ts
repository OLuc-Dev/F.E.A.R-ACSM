// Whether you're at the computer, from the webcam: a face in view or not. The
// camera is only ever asked "is there a face?" a couple of times a second, on
// this machine; no picture is kept or sent anywhere.

const PREFERENCE_KEY = "fear.presence";

// A face in this many glances in a row counts as you (a poster or a passing
// reflection rarely holds that long; a real person sitting down does).
export const ARRIVE_AFTER_GLANCES = 3;
// No face for this long and you've left (looking down at the phone, reaching for
// something or turning to talk to someone doesn't count).
export const LEAVE_AFTER_MS = 45_000;
// Away at least this long and F.E.A.R. says hello when you're back; a quicker
// trip (the kitchen, the door) passes in silence.
export const GREET_AFTER_MS = 3 * 60_000;

export type PresenceState = "unknown" | "here" | "away";

export type PresenceEvent =
  | { type: "arrived"; awayMs: number; greet: boolean }
  | { type: "left"; at: number };

/**
 * Glances in, events out. The first sighting after switching it on isn't an
 * arrival (you were already here); after that, coming back from "away" is.
 */
export class PresenceWatcher {
  state: PresenceState = "unknown";
  private streak = 0;
  private lastSeen: number | null = null;
  private leftAt: number | null = null;

  constructor(
    private readonly leaveAfterMs = LEAVE_AFTER_MS,
    private readonly greetAfterMs = GREET_AFTER_MS,
  ) {}

  update(t: number, face: boolean): PresenceEvent | null {
    if (face) {
      this.streak++;
      this.lastSeen = t;
      if (this.state === "here" || this.streak < ARRIVE_AFTER_GLANCES) return null;
      const wasAway = this.state === "away";
      this.state = "here";
      if (!wasAway || this.leftAt === null) return null;
      const awayMs = t - this.leftAt;
      this.leftAt = null;
      return { type: "arrived", awayMs, greet: awayMs >= this.greetAfterMs };
    }
    this.streak = 0;
    // Never seen since switching on: nobody to say goodbye to yet, but a first
    // face from here on is still "already here", not an arrival.
    if (this.state !== "here" || this.lastSeen === null) return null;
    if (t - this.lastSeen < this.leaveAfterMs) return null;
    this.state = "away";
    this.leftAt = this.lastSeen;
    return { type: "left", at: this.lastSeen };
  }

  /** The camera stopped (window hidden, switched off): start over on return. */
  reset(): void {
    this.state = "unknown";
    this.streak = 0;
    this.lastSeen = null;
    this.leftAt = null;
  }
}

/**
 * The name to greet you by, from the account's e-mail: its longest word
 * ("lucas.silva7@…" → "Lucas", "ext_lucas@…" → "Lucas"), or none.
 */
export function greetingName(email: string): string {
  const words = (email.split("@")[0] ?? "").split(/[._\-+\d]+/).filter((part) => part.length >= 3);
  const name = words.reduce((best, word) => (word.length > best.length ? word : best), "");
  return name ? name[0].toUpperCase() + name.slice(1).toLowerCase() : "";
}

/** "uns 10 minutos", "1 hora", "umas 3 horas": how long you were gone, spoken. */
export function awayFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 55) {
    const rounded = Math.max(5, Math.round(minutes / 5) * 5);
    return `uns ${rounded} minutos`;
  }
  const hours = Math.round(minutes / 60);
  return hours <= 1 ? "1 hora" : `umas ${hours} horas`;
}

function partOfDay(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

/** What F.E.A.R. says when you're back, in its own short, dry way. */
export function welcomeBack(
  awayMs: number,
  name: string,
  now: Date = new Date(),
  pick = Math.random,
): string {
  const you = name ? `, ${name}` : "";
  // Gone for hours (or since another part of the day): a proper hello.
  if (awayMs >= 2 * 60 * 60_000) return `${partOfDay(now)}${you}. Faz ${awayFor(awayMs)} que você saiu.`;
  const lines =
    awayMs >= 20 * 60_000
      ? [
          `De volta${you}. Foram ${awayFor(awayMs)}.`,
          `Bem-vindo de volta${you}. Você sumiu por ${awayFor(awayMs)}.`,
        ]
      : [`De volta${you}.`, `Voltou${you}. Estou aqui.`, `Bem-vindo de volta${you}.`];
  return lines[Math.floor(pick() * lines.length) % lines.length];
}

/** Whether you left presence on last time (it starts off). */
export function loadPresencePreference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === "on";
  } catch {
    return false;
  }
}

export function savePresencePreference(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(PREFERENCE_KEY, "on");
    else window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}
