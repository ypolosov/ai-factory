// Текст ошибки: Mastra отдаёт ошибку шага и как Error, и как сериализованный объект.
export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
