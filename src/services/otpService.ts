import crypto from 'crypto';

interface OTPData {
  code: string;
  expiresAt: number;
  type: 'email' | 'sms';
  value: string;
}

const otpStore = new Map<string, OTPData>();

export function generateOTP(): string {
  return crypto.randomInt(10000, 99999).toString();
}

export function saveOTP(identifier: string, type: 'email' | 'sms', value: string): string {
  const code = generateOTP();
  const expiresAt = Date.now() + (5 * 60 * 1000);
  
  otpStore.set(identifier, {
    code,
    expiresAt,
    type,
    value
  });

  console.log(`✅ OTP gerado: ${code} para ${identifier} (expira em 5 min)`);

  return code;
}

export function verifyOTP(identifier: string, code: string): { valid: boolean; message: string } {
  const otpData = otpStore.get(identifier);

  if (!otpData) {
    return { valid: false, message: 'Código não encontrado' };
  }

  if (Date.now() > otpData.expiresAt) {
    otpStore.delete(identifier);
    return { valid: false, message: 'Código expirado' };
  }

  if (otpData.code !== code) {
    return { valid: false, message: 'Código inválido' };
  }

  otpStore.delete(identifier);
  return { valid: true, message: 'Código verificado com sucesso!' };
}

export function cleanExpiredOTPs() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of otpStore.entries()) {
    if (now > value.expiresAt) {
      otpStore.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Removidos ${cleaned} códigos expirados`);
  }
}

setInterval(cleanExpiredOTPs, 60000);

