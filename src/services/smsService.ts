import twilio from 'twilio';

interface SendSMSOTPParams {
  phone: string;
  code: string;
}

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    throw new Error('Credenciais do Twilio não configuradas no .env');
  }
  
  return twilio(accountSid, authToken);
}

export async function sendSMSOTP({ phone, code }: SendSMSOTPParams) {
  try {
    const client = getTwilioClient();
    const verifySid = process.env.TWILIO_VERIFY_SID;
    
    if (!verifySid) {
      throw new Error('TWILIO_VERIFY_SID não configurado no .env');
    }
    let formattedPhone = phone.trim().replace(/\s+/g, '');
    
    if (!formattedPhone.startsWith('+')) {
      if (formattedPhone.startsWith('244')) {
        formattedPhone = '+' + formattedPhone;
      } else if (formattedPhone.length === 9) {
        formattedPhone = '+244' + formattedPhone;
      } else {
        throw new Error('Formato de número inválido');
      }
    }

    console.log(`📱 Enviando SMS para: ${formattedPhone} com código: ${code}`);

    const verification = await client.verify.v2
      .services(verifySid!)
      .verifications.create({
        to: formattedPhone,
        channel: 'sms',
        customCode: code,
        locale: 'pt',
      });

    console.log('✅ SMS enviado com sucesso. Status:', verification.status);

    return { 
      success: true, 
      status: verification.status,
      to: verification.to 
    };
  } catch (error: any) {
    console.error('❌ Erro ao enviar SMS:', error);
    throw new Error('Falha ao enviar SMS: ' + error.message);
  }
}

