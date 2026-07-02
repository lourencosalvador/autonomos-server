import cors from 'cors';
import express from 'express';
import './env.js';
import { isStripeConfigured, stripeMode } from './lib/stripe.js';
import { isGpayConfigured } from './lib/gpay.js';
import { isSupabaseAdminConfigured, supabaseHost } from './lib/supabaseAdmin.js';
import { gpayPayRoute } from './routes/gpay-pay.js';
import { gpayWebhookRoute } from './routes/gpay-webhook.js';
import { sendOTPRoute } from './routes/send-otp.js';
import { streamTokenRoute } from './routes/stream-token.js';
import { stripeConfirmPaymentRoute } from './routes/stripe-confirm-payment.js';
import { stripeConnectOnboardRoute } from './routes/stripe-connect-onboard.js';
import { stripeCreatePaymentIntentRoute } from './routes/stripe-create-payment-intent.js';
import { stripeWebhookRoute } from './routes/stripe-webhook.js';
import { escrowReleaseRoute } from './routes/escrow-release.js';
import { withdrawalRequestRoute } from './routes/withdrawal-request.js';
import { adminApplicationsRoute, adminCreateProviderRoute, adminDashboardRoute, adminDecisionRoute, adminLoginRoute, adminStatsRoute } from './routes/admin.js';
import { verifyOTPRoute } from './routes/verify-otp.js';
import { aiAssistantRoute } from './routes/ai-assistant.js';
import { isOpenAIConfigured } from './lib/openai.js';

const app = express();
// Expo/Metro normalmente usa 8081. Para não conflitar, o backend usa 8082 por padrão.
const PORT = process.env.PORT || 8082;
const HOST = process.env.HOST || '0.0.0.0';
 
app.use(cors());

// Stripe webhook precisa do body RAW para validar assinatura
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookRoute);
// JSON para o resto das rotas. Limite maior para uploads base64 (BI/certificados no admin).
app.use(express.json({ limit: '20mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Autonomos Backend is running',
    stripeConfigured: isStripeConfigured,
    stripeMode,
    gpayConfigured: isGpayConfigured,
    aiConfigured: isOpenAIConfigured,
    supabaseAdminConfigured: isSupabaseAdminConfigured,
    supabaseHost,
  });
});

app.post('/api/send-otp', sendOTPRoute);
app.post('/api/verify-otp', verifyOTPRoute);
app.post('/api/stream/token', streamTokenRoute);
app.post('/api/stripe/payment-intent', stripeCreatePaymentIntentRoute);
app.post('/api/stripe/confirm', stripeConfirmPaymentRoute);
app.post('/api/gpay/pay', gpayPayRoute);
app.post('/api/gpay/webhook', gpayWebhookRoute);
app.post('/api/stripe/connect/onboard', stripeConnectOnboardRoute);
app.post('/api/escrow/release', escrowReleaseRoute);
app.post('/api/withdrawals/request', withdrawalRequestRoute);
app.post('/api/ai/assistant', aiAssistantRoute);

// Painel de aprovações (web)
app.get('/admin', adminDashboardRoute);
app.post('/api/admin/login', adminLoginRoute);
app.get('/api/admin/applications', adminApplicationsRoute);
app.post('/api/admin/decision', adminDecisionRoute);
app.get('/api/admin/stats', adminStatsRoute);
app.post('/api/admin/create-provider', adminCreateProviderRoute);

app.listen(Number(PORT), HOST, () => {
  console.log(`🚀 Servidor rodando em http://${HOST}:${PORT}`);
  console.log(`📧 Resend configurado: ${process.env.RESEND_API_KEY ? '✅' : '❌'}`);
  console.log(`📱 Twilio configurado: ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '❌'}`);
  console.log(`💬 Stream configurado: ${process.env.STREAM_API_KEY && process.env.STREAM_API_SECRET ? '✅' : '❌'}`);
  console.log(`💳 Stripe configurado: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`🟢 GPay (Multicaixa/Referência) ativo: ${isGpayConfigured ? '✅' : '❌'}`);
  console.log(`🤖 OpenAI (assistente IA) configurado: ${isOpenAIConfigured ? '✅' : '❌'}`);

  // Keep-alive: o plano free do Render hiberna após ~15 min de inatividade, e o 1º request
  // depois disso leva ~50s+ (cold start), estourando o tempo do pagamento. Este auto-ping
  // mantém o serviço acordado. RENDER_EXTERNAL_URL é injetada automaticamente pelo Render.
  const selfUrl = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production' && selfUrl) {
    const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 min (Render dorme com ~15 min de inatividade)
    setInterval(() => {
      fetch(`${selfUrl}/health`).catch(() => {});
    }, PING_INTERVAL_MS);
    console.log(`⏰ Keep-alive ativo: auto-ping em ${selfUrl}/health a cada 10min`);
  }
});

