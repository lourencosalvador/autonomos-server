import crypto from 'crypto';

// GPay Angola — Multicaixa Express + Pagamento por Referência.
// Endpoint: POST {baseUrl}/api/pay  (mesmo payload; muda só payment_method)
const baseUrl = (process.env.GPAY_BASE_URL || 'https://pays.gpayangola.com').trim().replace(/\/$/, '');
const apiKey = (process.env.GPAY_API_KEY || '').trim(); // opcional (se a conta exigir Bearer)
const redirectUrl = (process.env.GPAY_REDIRECT_URL || 'https://yhanko.com').trim();
const webhookSecret = (process.env.GPAY_WEBHOOK_SECRET || '').trim();
// Em teste o GPay só aceita montantes de 100 a 200 Kz. Ligado por padrão; em produção, GPAY_TEST_MODE=false.
const testMode = String(process.env.GPAY_TEST_MODE ?? 'true').toLowerCase() !== 'false';

export const isGpayConfigured = !!baseUrl;

export const gpay = { baseUrl, apiKey, redirectUrl, webhookSecret, testMode };

/** Em modo teste, força o montante para 100 Kz (mínimo aceite pelo GPay sandbox). */
export function gpayChargeAmount(amountKz: number) {
  if (!testMode) return amountKz;
  return 100;
}

export function gpayHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) {
    h['gpay-x-api'] = `Bearer ${apiKey}`;
  }
  return h;
}

/** transaction_id aleatório no padrão "YV9U4Y8O6" (9 caracteres A-Z/0-9). */
export function randomTransactionId(len = 9) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}
