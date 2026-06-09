/**
 * Per-chat lock + status tracking.
 *
 * For each chat we keep:
 *   - active:   number of in-flight or queued operations
 *   - tail:     a Promise that resolves when the last queued op finishes
 *   - activity: the most recent activity (status / tool / lifecycle / generating)
 *
 * `withLock(chatId, fn)` serializes operations per chat. While anything is
 * in-flight the chat is reported as "working" via workingIds(). `activity`
 * is what we surface to the UI: a label describing *what* is happening right
 * now (e.g. "Running command…"). It lets a reloaded page render a sensible
 * placeholder for an in-flight turn instead of looking idle.
 */

export type ChatActivity =
  | { kind: 'thinking'; label: string }
  | { kind: 'tool'; name: string; label: string; detail?: string | undefined }
  | { kind: 'lifecycle'; phase: string; label: string }
  | { kind: 'generating'; label: string };

interface Entry {
  active: number;
  tail: Promise<void>;
  activity?: ChatActivity | undefined;
}

const map = new Map<number, Entry>();

function getOrInit(chatId: number): Entry {
  let e = map.get(chatId);
  if (!e) {
    e = { active: 0, tail: Promise.resolve() };
    map.set(chatId, e);
  }
  return e;
}

export const chatStatus = {
  isWorking(chatId: number): boolean {
    const e = map.get(chatId);
    return Boolean(e && e.active > 0);
  },

  workingIds(): number[] {
    const ids: number[] = [];
    for (const [id, e] of map) {
      if (e.active > 0) ids.push(id);
    }
    return ids;
  },

  /** Snapshot of every working chat with its current activity. */
  snapshot(): Array<{ id: number; activity?: ChatActivity | undefined }> {
    const out: Array<{ id: number; activity?: ChatActivity | undefined }> = [];
    for (const [id, e] of map) {
      if (e.active > 0) out.push({ id, activity: e.activity });
    }
    return out;
  },

  getActivity(chatId: number): ChatActivity | undefined {
    return map.get(chatId)?.activity;
  },

  /** Only writes activity if the chat is currently working. */
  setActivity(chatId: number, activity: ChatActivity | null): void {
    const e = map.get(chatId);
    if (!e || e.active === 0) return;
    e.activity = activity ?? undefined;
  },

  /**
   * Force a chat out of the "working" state. Used by manual recovery
   * (POST /chats/:id/unstick) when something hung and the lock never
   * released. Any consumer still awaiting `tail` will continue waiting
   * — but new consumers will see active === 0 and proceed.
   *
   * Returns true if state was modified.
   */
  forceClear(chatId: number): boolean {
    const e = map.get(chatId);
    if (!e) return false;
    map.delete(chatId);
    return true;
  },

  async withLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const cur = getOrInit(chatId);
    const previous = cur.tail;
    cur.active += 1;

    let release!: () => void;
    cur.tail = new Promise<void>((res) => {
      release = res;
    });

    try {
      await previous;
      return await fn();
    } finally {
      release();
      cur.active -= 1;
      if (cur.active === 0) {
        // last consumer left — drop the whole entry (including activity)
        map.delete(chatId);
      }
    }
  },
};
