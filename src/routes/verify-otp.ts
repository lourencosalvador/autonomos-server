import { Request, Response } from 'express';
import { verifyOTP } from '../services/otpService.js';

export async function verifyOTPRoute(req: Request, res: Response) {
  try {
    const { type, value, code } = req.body;

    if (!type || !value || !code) {
      return res.status(400).json({
        success: false,
        message: 'Todos os campos são obrigatórios'
      });
    }

    if (code.length !== 5) {
      return res.status(400).json({
        success: false,
        message: 'O código deve ter exatamente 5 dígitos'
      });
    }

    const result = verifyOTP(value, code);

    if (result.valid) {
      return res.json({
        success: true,
        message: 'Código verificado com sucesso!'
      });
    } else {
      return res.status(400).json({
        success: false,
        message: result.message
      });
    }
  } catch (error: any) {
    console.error('Erro ao verificar OTP:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao verificar código: ' + error.message
    });
  }
}

