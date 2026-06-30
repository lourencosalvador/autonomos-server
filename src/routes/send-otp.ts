import { Request, Response } from 'express';
import { sendEmailOTP } from '../services/emailService.js';
import { saveOTP } from '../services/otpService.js';
import { sendSMSOTP } from '../services/smsService.js';

export async function sendOTPRoute(req: Request, res: Response) {
  try {
    const { type, value } = req.body;

    if (!type || !value) {
      return res.status(400).json({
        success: false,
        message: 'Tipo e valor são obrigatórios'
      });
    }

    if (type !== 'email' && type !== 'sms') {
      return res.status(400).json({
        success: false,
        message: 'Tipo inválido. Use "email" ou "sms"'
      });
    }

    const code = saveOTP(value, type, value);

    if (type === 'email') {
      await sendEmailOTP({ email: value, code });
    } else {
      await sendSMSOTP({ phone: value, code });
    }

    return res.json({
      success: true,
      message: 'Código enviado com sucesso!'
    });
  } catch (error: any) {
    console.error('Erro ao enviar OTP:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao enviar código: ' + error.message
    });
  }
}

