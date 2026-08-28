import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const USAGE_FEATURES = Object.freeze(['imageGenerate', 'imageEdit', 'vision', 'chat', 'audio']);

const emptyCounts = () => ({ imageGenerate: 0, imageEdit: 0, vision: 0, chat: 0, audio: 0 });
const normalizedCounts = value => Object.fromEntries(USAGE_FEATURES.map(feature => [feature, nonNegativeInteger(value?.[feature])]));
const withDerived = value => {
  const counts = normalizedCounts(value);
  return {
    ...counts,
    images: counts.imageGenerate + counts.imageEdit,
    overall: USAGE_FEATURES.reduce((sum, feature) => sum + counts[feature], 0),
  };
};

export class UsageStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, totals: emptyCounts(), actors: {} };
    this.tail = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.data = {
        version: 1,
        totals: normalizedCounts(parsed?.totals),
        actors: Object.fromEntries(Object.entries(parsed?.actors || {}).map(([id, counts]) => [id, normalizedCounts(counts)])),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  record(actorId, feature) {
    if (typeof actorId !== 'string' || !actorId || !USAGE_FEATURES.includes(feature)) return Promise.resolve(false);
    const run = this.tail.then(async () => {
      const actor = this.data.actors[actorId] ||= emptyCounts();
      actor[feature] += 1;
      this.data.totals[feature] += 1;
      await this.save();
      return true;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async report(users = []) {
    await this.tail;
    return {
      totals: withDerived(this.data.totals),
      users: users.map(user => ({
        userId: user.id,
        email: user.email,
        label: user.label || '',
        ...withDerived(this.data.actors[`user:${user.id}`]),
      })),
    };
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async close() { await this.tail; }
}

function nonNegativeInteger(value) {
  value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
