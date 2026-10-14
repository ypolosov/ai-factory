// Судья согласования (сверщик): сверяет новое утверждение - стори, требование - со знанием
// проекта и отвечает, есть ли противоречие, с цитатами и источниками. Модель - через шлюз
// фабрики; ответ модели проверяется: противоречие без отрывка-источника не принимается.
import type { Passage } from '../ports/ports.ts';

export interface Conflict {
  source: string;
  url: string;
  quote: string;
  why: string;
}

export interface Judgement {
  verdict: 'ok' | 'conflict';
  summary: string;
  conflicts: Conflict[];
  checked: Passage[]; // отрывки, с которыми сверяли
}

export interface Statement {
  issue: string;
  title: string;
  body: string;
}

export interface Judge {
  check(s: Statement, passages: Passage[]): Promise<Judgement>;
}

export interface GatewayJudgeConfig {
  url: string; // адрес шлюза
  key(): string; // ключ шлюза - читается на каждый запрос
  model: string;
}

export function prompt(s: Statement, passages: Passage[]): string {
  const list = passages.map((p, i) => `[${i + 1}] ${p.source} - ${p.title}\n${p.text}`).join('\n\n');
  return `Ты - сверщик знаний проекта. Сверь новое требование с правилами и решениями проекта.
Противоречие - когда выполнить требование нельзя, не нарушив правило или решение из отрывков.
Если требования отрывков не касаются - противоречия нет.

Новое требование (${s.issue}): ${s.title}
${s.body}

Отрывки знаний:
${list || '(нет отрывков)'}

Ответь только JSON без пояснений вокруг:
{"verdict": "ok" | "conflict", "summary": "одно-два предложения по-русски",
 "conflicts": [{"passage": номер отрывка, "quote": "точная цитата из отрывка", "why": "почему противоречит"}]}`;
}

const flat = (t: string) => t.replace(/\s+/g, ' ').trim();

// Ответ модели -> решение. Противоречие без существующего отрывка отбрасывается; если
// противоречий не осталось, решение - "ok".
export function parseJudgement(content: string, passages: Passage[]): Judgement {
  const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  const raw = JSON.parse(json) as { verdict?: string; summary?: string; conflicts?: { passage?: number; quote?: string; why?: string }[] };
  const conflicts: Conflict[] = [];
  for (const c of raw.conflicts ?? []) {
    const p = passages[Number(c.passage) - 1];
    if (!p) continue;
    const quote = String(c.quote ?? '').trim();
    // Цитата сверяется без учёта переносов строк: модель склеивает строки списка.
    const exact = quote && flat(p.text).includes(flat(quote));
    conflicts.push({
      source: p.source,
      url: p.url,
      quote: exact ? quote : `(пересказ) ${quote}`,
      why: String(c.why ?? ''),
    });
  }
  const verdict = raw.verdict === 'conflict' && conflicts.length ? 'conflict' : 'ok';
  return { verdict, summary: String(raw.summary ?? ''), conflicts: verdict === 'conflict' ? conflicts : [], checked: passages };
}

export function gatewayJudge(cfg: GatewayJudgeConfig): Judge {
  return {
    async check(s, passages) {
      const r = await fetch(`${cfg.url.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        // Номер задачи - в журнал шлюза для учёта.
        headers: { 'content-type': 'application/json', 'x-gateway-key': cfg.key(), 'x-task-id': `${s.issue}-check` },
        body: JSON.stringify({ model: cfg.model, temperature: 0, messages: [{ role: 'user', content: prompt(s, passages) }] }),
      });
      if (!r.ok) throw new Error(`шлюз моделей: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      return parseJudgement(data.choices?.[0]?.message?.content ?? '', passages);
    },
  };
}
