/**
 * Per-chat status + serialization.
 *
 * For every chat we track:
 *   - active: number of in-flight or queued operations
 *   - tail:   a Promise that resolves when the last queued op finishes
 *
 * `withLock(chatId, fn)` waits for the previous op on the same chat to finish
 * before running `fn`, so requests are serialized per chat. While anything is
 * in flight, the chat is reported as "working".
 *
 * State is in-memory: it dies with the process, which is fine because any
 * in-flight fetch dies with it too.
 */

type ChatState = 'working' | 'idle';

interface Entry {
  active: number;
  tail: Promise<void>;
}

const map = new Map<number, Entry>();

export const chatStatus = {
  get(chatId: number): ChatState {
    const e = map.get(chatId);
    return e && e.active > 0 ? 'working' : 'idle';
  },

  workingIds(): number[] {
    const ids: number[] = [];
    for (const [id, e] of map) {
      if (e.active > 0) ids.push(id);
    }
    return ids;
  },

  async withLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const cur = map.get(chatId) ?? { active: 0, tail: Promise.resolve() };
    const previous = cur.tail;
    cur.active += 1;

    let release!: () => void;
    cur.tail = new Promise<void>((res) => {
      release = res;
    });
    map.set(chatId, cur);

    try {
      await previous;
      return await fn();
    } finally {
      release();
      cur.active -= 1;
      if (cur.active === 0) map.delete(chatId);
    }
  },
};
