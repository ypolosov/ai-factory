// Перезапуск CI цели по просьбе QA (!ci [номер PR]): прогоны коммита - головы PR или ветки по
// умолчанию - перезапускаются на платформе цели; итог каждого - в канал, откуда попросили.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Forge, TargetCi } from '../ports/ports.ts';
import { message } from './errors.ts';

export interface CiRerunDeps {
  ci: TargetCi;
  forge: Forge;
  post(channel: string, text: string): Promise<void>;
  stateFile: string;
  log(message: string): void;
}

// Ждём попытку больше, чем была до перезапуска: так старый итог не выдаётся за новый.
type Pending = { id: string; attempt: number; channel: string; what: string }[];

export function ciRerun(d: CiRerunDeps) {
  const load = (): Pending => (existsSync(d.stateFile) ? (JSON.parse(readFileSync(d.stateFile, 'utf8')) as Pending) : []);
  const save = (p: Pending) => writeFileSync(d.stateFile, JSON.stringify(p));
  let busy = false;
  return {
    async request(channel: string, pr?: number): Promise<string> {
      let sha: string | undefined;
      let what: string;
      if (pr) {
        const p = await d.forge.getPull(pr);
        sha = p.headSha;
        what = `PR ${pr}`;
      } else {
        const branch = (await d.forge.repo()).defaultBranch;
        sha = await d.forge.branchHead(branch);
        what = branch;
      }
      if (!sha) return 'Нет коммита для перезапуска CI.';
      const runs = await d.ci.runs(sha);
      if (!runs.length) return `У ${what} (${sha.slice(0, 7)}) нет прогонов CI.`;
      const pending = load();
      const started: string[] = [];
      const busyRuns: string[] = [];
      for (const r of runs) {
        if (r.state === 'pending' || r.state === 'running') {
          busyRuns.push(`${r.name} ${r.url}`);
          continue;
        }
        await d.ci.rerun(r.id);
        pending.push({ id: r.id, attempt: r.attempt, channel, what: `${what}, ${r.name}` });
        started.push(`${r.name} ${r.url}`);
      }
      save(pending);
      return [
        started.length ? `Перезапустил CI ${what} (${sha.slice(0, 7)}): ${started.join('; ')}` : '',
        busyRuns.length ? `Уже идут: ${busyRuns.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
    async tick() {
      if (busy) return;
      busy = true;
      try {
        const left: Pending = [];
        for (const p of load()) {
          const r = await d.ci.run(p.id);
          if (r.attempt <= p.attempt || r.state === 'pending' || r.state === 'running') {
            left.push(p);
            continue;
          }
          const word = r.state === 'success' ? 'зелёный' : r.state === 'cancelled' ? 'отменён' : 'красный';
          await d.post(p.channel, `CI ${p.what}: ${word} (попытка ${r.attempt}). ${r.url}`);
        }
        save(left);
      } catch (e) {
        d.log(`перезапуск CI: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
