import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

let payload = null; // { gz: Buffer, etag: string, raw: number }

/**
 * Гайд лежит в private/guide.html как есть — его можно заменить новой версией,
 * ничего не трогая в коде. Форму обращений и аналитику вклеиваем при старте.
 * Результат жмём один раз: тело одинаковое для всех, токен клиент берёт из URL.
 */
export async function loadGuide() {
  const [html, inject] = await Promise.all([
    readFile(fileURLToPath(new URL('../private/guide.html', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('./inject.html', import.meta.url)), 'utf8'),
  ]);

  if (!html.includes('</body>')) throw new Error('В guide.html не найден </body>');

  const full = html.replace('</body>', `${inject}\n</body>`);
  const gz = zlib.gzipSync(Buffer.from(full), { level: 9 });
  const etag = `"${crypto.createHash('sha1').update(gz).digest('hex').slice(0, 20)}"`;

  payload = { gz, etag, raw: Buffer.byteLength(full) };
  return { raw: payload.raw, gzipped: gz.length };
}

export function getGuide() {
  if (!payload) throw new Error('Гайд ещё не загружен');
  return payload;
}
