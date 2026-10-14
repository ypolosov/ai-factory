// Модель через шлюз фабрики (формат OpenAI chat completions): один вопрос - один ответ.
// Номер задачи уходит в журнал шлюза для учёта.
export interface GatewayModelConfig {
  url: string;
  key(): string;
  model: string;
}

export type Ask = (prompt: string, taskId: string) => Promise<string>;

export function gatewayAsk(cfg: GatewayModelConfig): Ask {
  return async (prompt, taskId) => {
    const r = await fetch(`${cfg.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gateway-key': cfg.key(), 'x-task-id': taskId },
      body: JSON.stringify({ model: cfg.model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`шлюз моделей: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  };
}
