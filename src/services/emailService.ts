import { Resend } from 'resend';

interface SendEmailOTPParams {
  email: string;
  code: string;
}

function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY não configurada no .env');
  }
  return new Resend(process.env.RESEND_API_KEY);
}

export async function sendEmailOTP({ email, code }: SendEmailOTPParams) {
  try {
    const resend = getResendClient();
    const { data, error } = await resend.emails.send({
      from: 'Autonomos <onboarding@resend.dev>',
      to: [email],
      subject: 'Seu código de acesso - Autonomos',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background-color: #f3f4f6;
                margin: 0;
                padding: 20px;
              }
              .container {
                max-width: 600px;
                margin: 0 auto;
                background-color: white;
                border-radius: 16px;
                padding: 40px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
              }
              .logo {
                text-align: center;
                font-size: 32px;
                font-weight: bold;
                color: #111827;
                margin-bottom: 30px;
              }
              .title {
                font-size: 24px;
                font-weight: bold;
                color: #111827;
                margin-bottom: 16px;
                text-align: center;
              }
              .message {
                font-size: 16px;
                color: #6b7280;
                margin-bottom: 32px;
                text-align: center;
                line-height: 1.5;
              }
              .code-box {
                background: linear-gradient(135deg, #00E7FF 0%, #00B8D4 100%);
                border-radius: 12px;
                padding: 24px;
                margin: 32px 0;
                text-align: center;
              }
              .code {
                font-size: 48px;
                font-weight: bold;
                color: white;
                letter-spacing: 8px;
                margin: 0;
              }
              .expiry {
                font-size: 14px;
                color: #ef4444;
                text-align: center;
                margin-top: 24px;
                font-weight: 600;
              }
              .footer {
                margin-top: 40px;
                padding-top: 24px;
                border-top: 1px solid #e5e7eb;
                font-size: 12px;
                color: #9ca3af;
                text-align: center;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="logo">Autonomos</div>
              <h1 class="title">Seu Código de Verificação</h1>
              <p class="message">
                Use o código abaixo para completar a recuperação da sua senha.
              </p>
              <div class="code-box">
                <p class="code">${code}</p>
              </div>
              <p class="expiry">⏱ Este código expira em 5 minutos</p>
              <div class="footer">
                <p>Se você não solicitou este código, ignore este e-mail.</p>
                <p style="margin-top: 8px;">© 2025 Autonomos. Todos os direitos reservados.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    if (error) {
      throw new Error(error.message);
    }

    console.log('✅ E-mail enviado com sucesso para:', email);
    return { success: true, data };
  } catch (error: any) {
    console.error('❌ Erro ao enviar e-mail:', error);
    throw new Error('Falha ao enviar e-mail: ' + error.message);
  }
}

