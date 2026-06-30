# 🚀 Como Rodar o Backend

## 1. Entre na pasta do servidor

```bash
cd server
```

## 2. Instale as dependências

```bash
npm install
```

## 3. Rode o servidor em desenvolvimento

```bash
npm run dev
```

O servidor vai rodar em `http://localhost:8081`.

## 3.1 Variáveis de ambiente (obrigatório)

Crie um arquivo `.env` dentro da pasta `server/`:

```bash
PORT=8081
RESEND_API_KEY=re_xxx
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_VERIFY_SID=VAxxx
STREAM_API_KEY=xxx
STREAM_API_SECRET=xxx
```

## 4. No app mobile, as requisições vão automaticamente para essa URL!

O frontend já está configurado para usar `http://localhost:8081` quando em desenvolvimento.

---

## ✅ Verificação

Se tudo estiver OK, você verá no console:

```
🚀 Servidor rodando em http://localhost:8081
📧 Resend configurado: ✅
📱 Twilio configurado: ✅
```

---

## 🧪 Testar manualmente

### Enviar OTP por e-mail:
```bash
curl -X POST http://localhost:8081/api/send-otp \
  -H "Content-Type: application/json" \
  -d '{"type":"email","value":"seu@email.com"}'
```

### Enviar OTP por SMS:
```bash
curl -X POST http://localhost:8081/api/send-otp \
  -H "Content-Type: application/json" \
  -d '{"type":"sms","value":"912345678"}'
```

### Verificar OTP:
```bash
curl -X POST http://localhost:8081/api/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"type":"email","value":"seu@email.com","code":"12345"}'
```

