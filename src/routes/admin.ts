import type { Request, Response } from 'express';
import { isSupabaseAdminConfigured, supabaseAdmin } from '../lib/supabaseAdmin.js';

const ADMIN_KEY = (process.env.ADMIN_KEY || 'autonomos-admin').trim();

function checkAdmin(req: Request, res: Response): boolean {
  const key = String(req.headers['x-admin-key'] || (req.query.key as string) || (req.body && (req.body as any).key) || '').trim();
  if (!key || key !== ADMIN_KEY) {
    res.status(401).json({ ok: false, message: 'Acesso negado.' });
    return false;
  }
  return true;
}

export async function adminLoginRoute(req: Request, res: Response) {
  const key = String((req.body as any)?.key || '').trim();
  if (key && key === ADMIN_KEY) return res.json({ ok: true });
  return res.status(401).json({ ok: false, message: 'Senha de admin inválida.' });
}

export async function adminApplicationsRoute(req: Request, res: Response) {
  if (!checkAdmin(req, res)) return;
  if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false, message: 'Supabase admin não configurado.' });

  const status = String(req.query.status || 'pending');
  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, name, avatar_url, work_area, bio, work_description, experience_time, availability, approval_status, approval_requested_at, approval_reviewed_at, approval_note, created_at')
    .eq('role', 'professional')
    .eq('approval_status', status)
    .order('approval_requested_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, message: error.message });

  const ids = (profiles || []).map((p: any) => p.id);
  const certsByProvider: Record<string, any[]> = {};
  if (ids.length) {
    const { data: certs } = await supabaseAdmin.from('provider_certificates').select('provider_id, name, file_url').in('provider_id', ids);
    (certs || []).forEach((c: any) => {
      (certsByProvider[c.provider_id] = certsByProvider[c.provider_id] || []).push(c);
    });
  }
  const profileApps = (profiles || []).map((p: any) => ({ ...p, source: 'profile', certificates: certsByProvider[p.id] || [] }));

  // Candidaturas vindas do SITE (tabela provider_applications). Graceful se a tabela ainda não existir.
  let websiteApps: any[] = [];
  try {
    const { data: webApps } = await supabaseAdmin
      .from('provider_applications')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });
    websiteApps = (webApps || []).map((w: any) => ({
      id: w.id,
      source: 'website',
      name: w.name,
      avatar_url: w.photo_url || null,
      work_area: w.work_area,
      specialty: w.specialty || null,
      city: w.city || null,
      phone: w.phone || null,
      email: w.email || null,
      bio: w.description || null,
      experience_time: null,
      experience_years: typeof w.experience_years === 'number' ? w.experience_years : null,
      id_document_url: w.id_document_url || null,
      approval_note: w.note || null,
      approval_requested_at: w.created_at,
      certificates: [],
    }));
  } catch {
    // tabela ainda não criada — ignora
  }

  return res.json({ ok: true, applications: [...websiteApps, ...profileApps] });
}

export async function adminDecisionRoute(req: Request, res: Response) {
  if (!checkAdmin(req, res)) return;
  if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false, message: 'Supabase admin não configurado.' });

  const providerId = String((req.body as any)?.providerId || '').trim();
  const decision = String((req.body as any)?.decision || '').trim();
  const note = String((req.body as any)?.note || '').trim() || null;
  const source = String((req.body as any)?.source || 'profile').trim();
  if (!providerId || (decision !== 'approved' && decision !== 'rejected')) {
    return res.status(400).json({ ok: false, message: 'Dados inválidos.' });
  }

  // Candidatura do site → atualiza a tabela provider_applications.
  if (source === 'website') {
    const { error } = await supabaseAdmin
      .from('provider_applications')
      .update({ status: decision, note, reviewed_at: new Date().toISOString() } as any)
      .eq('id', providerId);
    if (error) return res.status(500).json({ ok: false, message: error.message });
    return res.json({ ok: true });
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ approval_status: decision, approval_note: note, approval_reviewed_at: new Date().toISOString() } as any)
    .eq('id', providerId);
  if (error) return res.status(500).json({ ok: false, message: error.message });
  return res.json({ ok: true });
}

/** Totais da plataforma (clientes, prestadores, aprovados, pendentes). */
export async function adminStatsRoute(req: Request, res: Response) {
  if (!checkAdmin(req, res)) return;
  if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false, message: 'Supabase admin não configurado.' });
  const db = supabaseAdmin;

  const count = async (filter: Record<string, string>) => {
    let q = db.from('profiles').select('*', { count: 'exact', head: true });
    for (const k of Object.keys(filter)) q = q.eq(k, filter[k]);
    const { count } = await q;
    return count || 0;
  };

  try {
    const [clients, providers, providersApproved, providersPending] = await Promise.all([
      count({ role: 'client' }),
      count({ role: 'professional' }),
      count({ role: 'professional', approval_status: 'approved' }),
      count({ role: 'professional', approval_status: 'pending' }),
    ]);
    return res.json({ ok: true, clients, providers, providersApproved, providersPending });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || 'Erro ao obter estatísticas.' });
  }
}

const PROVIDER_DOCS_BUCKET = 'provider-docs';

async function ensureBucket(db: any, id: string) {
  try {
    await db.storage.createBucket(id, { public: true });
  } catch {
    // já existe — ignora
  }
}

/** Upload de um data URL (base64) para o Storage → devolve o URL público. */
async function uploadDataUrl(db: any, folder: string, dataUrl: string): Promise<string | null> {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  const contentType = m[1];
  const buffer = Buffer.from(m[2], 'base64');
  const ext = (contentType.split('/')[1] || 'bin').split('+')[0];
  const path = `${folder}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;
  const { error } = await db.storage.from(PROVIDER_DOCS_BUCKET).upload(path, buffer, { contentType, upsert: false });
  if (error) throw error;
  const { data } = db.storage.from(PROVIDER_DOCS_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

/**
 * Cria um prestador COMPLETO diretamente pelo admin: conta auth confirmada + perfil
 * aprovado com onboarding concluído (bio, experiência, disponibilidade, foto, BI e
 * certificados) — para não precisar de passar pela tela de configuração no app.
 */
export async function adminCreateProviderRoute(req: Request, res: Response) {
  if (!checkAdmin(req, res)) return;
  if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false, message: 'Supabase admin não configurado.' });
  const db = supabaseAdmin;

  const b: any = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '').trim();
  const phone = String(b.phone || '').trim() || null;
  const workArea = String(b.workArea || '').trim() || null;
  const gender = String(b.gender || '').trim() || null;
  const bio = String(b.bio || '').trim() || null;
  const workDescription = String(b.workDescription || '').trim() || null;
  const experienceTime = String(b.experienceTime || '').trim() || null;
  const availability = b.availability && typeof b.availability === 'object' ? b.availability : null;

  if (!name || !email || password.length < 6) {
    return res.status(400).json({ ok: false, message: 'Nome, email e senha (mín. 6 caracteres) são obrigatórios.' });
  }

  // 1) Conta auth já confirmada.
  const { data: created, error: cErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (cErr || !created?.user) {
    const msg = String(cErr?.message || 'Falha ao criar utilizador.');
    const dup = /already|exists|registered|duplicate/i.test(msg);
    return res.status(400).json({ ok: false, message: dup ? 'Já existe uma conta com este email.' : msg });
  }
  const id = created.user.id;

  // 2) Uploads opcionais (foto, BI, certificados).
  let avatarUrl: string | null = null;
  let idDocUrl: string | null = null;
  const certUrls: { name: string; file_url: string }[] = [];
  try {
    const hasUpload = b.avatar || b.idDocument || (Array.isArray(b.certificates) && b.certificates.length);
    if (hasUpload) await ensureBucket(db, PROVIDER_DOCS_BUCKET);
    if (b.avatar) avatarUrl = await uploadDataUrl(db, `${id}/avatar`, b.avatar);
    if (b.idDocument) idDocUrl = await uploadDataUrl(db, `${id}/bi`, b.idDocument);
    if (Array.isArray(b.certificates)) {
      for (const c of b.certificates.slice(0, 10)) {
        if (!c?.dataUrl) continue;
        const url = await uploadDataUrl(db, `${id}/certs`, c.dataUrl);
        if (url) certUrls.push({ name: String(c.name || 'Certificado'), file_url: url });
      }
    }
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: 'Conta criada, mas o upload falhou: ' + (e?.message || '') });
  }

  // 3) Perfil prestador APROVADO + onboarding CONCLUÍDO (resiliente a colunas em falta).
  const full: any = {
    id,
    role: 'professional',
    name,
    phone,
    work_area: workArea,
    gender,
    bio,
    work_description: workDescription,
    experience_time: experienceTime,
    availability,
    approval_status: 'approved',
    onboarding_completed: true,
  };
  if (avatarUrl) full.avatar_url = avatarUrl;
  if (idDocUrl) full.id_document_url = idDocUrl;

  let { error: pErr } = await db.from('profiles').upsert(full, { onConflict: 'id' });
  for (let i = 0; i < 6 && pErr; i++) {
    const m = /could not find the '(\w+)' column/i.exec(String((pErr as any)?.message || ''));
    if (!m || !(m[1] in full)) break;
    delete full[m[1]];
    ({ error: pErr } = await db.from('profiles').upsert(full, { onConflict: 'id' }));
  }
  if (pErr) return res.status(500).json({ ok: false, message: 'Conta criada, mas o perfil falhou: ' + pErr.message });

  // 4) Certificados na tabela.
  if (certUrls.length) {
    await db.from('provider_certificates').insert(certUrls.map((c) => ({ provider_id: id, name: c.name, file_url: c.file_url })) as any);
  }

  return res.json({ ok: true, id, email });
}

export function adminDashboardRoute(_req: Request, res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Autónomos · Painel de Aprovações</title>
<style>
  :root{--cyan:#00C2DE;--deep:#034660;--ink:#0f172a;--muted:#64748b;--line:#e8eef3;--bg:#f4f8fb;}
  *{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
  body{margin:0;background:var(--bg);color:var(--ink);}
  .top{background:linear-gradient(120deg,var(--deep),var(--cyan));color:#fff;padding:22px 28px;display:flex;align-items:center;justify-content:space-between;}
  .top h1{font-size:18px;margin:0;font-weight:800;letter-spacing:.3px;}
  .top .sub{font-size:12px;opacity:.85;margin-top:2px;}
  .wrap{max-width:1080px;margin:0 auto;padding:24px;}
  .tabs{display:flex;gap:8px;margin-bottom:20px;}
  .tab{border:none;background:#fff;color:var(--muted);font-weight:700;font-size:13px;padding:9px 16px;border-radius:999px;cursor:pointer;border:1px solid var(--line);}
  .tab.active{background:var(--deep);color:#fff;border-color:var(--deep);}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:16px;}
  .card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 6px 20px rgba(3,70,96,.05);}
  .head{display:flex;gap:12px;align-items:center;}
  .av{width:54px;height:54px;border-radius:14px;object-fit:cover;background:#e2e8f0;}
  .name{font-weight:800;font-size:15px;}
  .area{color:var(--muted);font-size:12px;font-weight:600;margin-top:2px;}
  .badge{font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;}
  .b-pending{background:#fff7e6;color:#b45309;}
  .b-approved{background:#ecfdf5;color:#047857;}
  .b-rejected{background:#fef2f2;color:#b91c1c;}
  .row{margin-top:14px;}
  .lbl{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;}
  .val{font-size:13px;margin-top:3px;line-height:1.5;color:#334155;}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}
  .chip{background:#f1f5f9;border-radius:8px;padding:5px 9px;font-size:12px;font-weight:600;color:#334155;text-decoration:none;}
  .acts{display:flex;gap:10px;margin-top:18px;}
  .btn{flex:1;border:none;border-radius:12px;padding:11px;font-weight:800;font-size:13px;cursor:pointer;}
  .approve{background:var(--cyan);color:#fff;}
  .reject{background:#fff;color:#b91c1c;border:1.5px solid #fecaca;}
  .empty{text-align:center;color:var(--muted);padding:60px 0;font-weight:600;}
  .login{max-width:380px;margin:80px auto;background:#fff;border:1px solid var(--line);border-radius:20px;padding:28px;text-align:center;box-shadow:0 10px 30px rgba(3,70,96,.08);}
  .login h2{margin:6px 0 4px;font-size:20px;}
  .login p{color:var(--muted);font-size:13px;margin:0 0 18px;}
  .inp{width:100%;border:1px solid var(--line);border-radius:12px;padding:13px;font-size:14px;margin-bottom:12px;}
  .full{width:100%;background:linear-gradient(120deg,var(--deep),var(--cyan));color:#fff;border:none;border-radius:12px;padding:13px;font-weight:800;cursor:pointer;font-size:14px;}
  .err{color:#b91c1c;font-size:12px;font-weight:700;min-height:16px;margin-top:4px;}
  .hide{display:none;}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
  .stat{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:0 6px 20px rgba(3,70,96,.05);position:relative;overflow:hidden;}
  .stat::after{content:'';position:absolute;right:-18px;top:-18px;width:60px;height:60px;border-radius:50%;background:linear-gradient(120deg,var(--cyan),transparent);opacity:.12;}
  .stat span{font-size:12px;font-weight:700;color:var(--muted);}
  .stat b{display:block;font-size:30px;font-weight:800;color:var(--deep);margin-top:4px;line-height:1;}
  .tab-add{background:#ecfeff;color:var(--deep);border-color:#a5f3fc;}
  .form{background:#fff;border:1px solid var(--line);border-radius:18px;padding:24px;max-width:660px;box-shadow:0 6px 20px rgba(3,70,96,.05);}
  .form h3{margin:0 0 4px;font-size:19px;}
  .formsub{color:var(--muted);font-size:13px;margin:0 0 20px;}
  .formGrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px;}
  .field label{display:block;font-size:12px;font-weight:800;color:var(--muted);margin-bottom:6px;}
  .field .inp{margin-bottom:0;}
  .ok{color:#047857;font-size:13px;font-weight:800;min-height:16px;margin-top:10px;}
  .ta{width:100%;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:14px;font-family:inherit;min-height:80px;resize:vertical;box-sizing:border-box;}
  .file{width:100%;border:1px dashed #a5f3fc;border-radius:12px;padding:11px;font-size:13px;background:#f0fdff;box-sizing:border-box;}
  .sect{font-size:12px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:22px 0 12px;border-top:1px solid var(--line);padding-top:18px;}
  .days{display:flex;flex-wrap:wrap;gap:8px;}
  .day{width:44px;height:40px;border-radius:12px;border:1px solid var(--line);background:#f4f6f8;color:#9ca3af;font-weight:800;font-size:12px;cursor:pointer;}
  .day.on{background:var(--cyan);color:#fff;border-color:var(--cyan);}
  @media(max-width:560px){.stats{grid-template-columns:repeat(2,1fr);}.formGrid{grid-template-columns:1fr;}}
</style>
</head>
<body>
  <div id="loginView">
    <div class="login">
      <div style="font-size:34px">🔐</div>
      <h2>Painel de Aprovações</h2>
      <p>Autónomos · acesso restrito</p>
      <input id="key" class="inp" type="password" placeholder="Senha de admin" />
      <button class="full" onclick="doLogin()">Entrar</button>
      <div id="loginErr" class="err"></div>
    </div>
  </div>

  <div id="appView" class="hide">
    <div class="top">
      <div><h1>Autónomos · Painel de Aprovações</h1><div class="sub">Gestão de candidaturas de prestadores</div></div>
      <button class="tab" onclick="logout()">Sair</button>
    </div>
    <div class="wrap">
      <div class="stats">
        <div class="stat"><span>Clientes</span><b id="stClients">—</b></div>
        <div class="stat"><span>Prestadores</span><b id="stProviders">—</b></div>
        <div class="stat"><span>Aprovados</span><b id="stApproved">—</b></div>
        <div class="stat"><span>Pendentes</span><b id="stPending">—</b></div>
      </div>
      <div class="tabs">
        <button class="tab active" data-st="pending" onclick="setTab('pending')">Pendentes</button>
        <button class="tab" data-st="approved" onclick="setTab('approved')">Aprovados</button>
        <button class="tab" data-st="rejected" onclick="setTab('rejected')">Recusados</button>
        <button class="tab tab-add" data-st="cadastrar" onclick="setTab('cadastrar')">+ Cadastrar</button>
      </div>
      <div id="list" class="grid"></div>
      <div id="registerForm" class="hide">
        <div class="form">
          <h3>Cadastrar prestador</h3>
          <p class="formsub">Cria uma conta de prestador já aprovada. A pessoa entra na app com este email e senha.</p>
          <div class="formGrid">
            <div class="field"><label>Nome</label><input id="fName" class="inp" placeholder="Ex: Edson Pintor" /></div>
            <div class="field"><label>Email</label><input id="fEmail" class="inp" type="email" placeholder="email@exemplo.com" /></div>
            <div class="field"><label>Senha</label><input id="fPass" class="inp" type="text" placeholder="mín. 6 caracteres" /></div>
            <div class="field"><label>Telefone</label><input id="fPhone" class="inp" placeholder="9XX XXX XXX" /></div>
            <div class="field"><label>Área de trabalho</label><select id="fArea" class="inp">
              <option value="">Selecionar…</option>
              <option>Pintura</option><option>Canalização</option><option>Eletricista</option><option>Limpeza</option>
              <option>Make Up</option><option>Manicure &amp; Pedicure</option><option>Barbeiro</option><option>Cabeleireiro</option>
              <option>Cocktail</option><option>Decoração de Eventos</option><option>Personal Trainer</option><option>Design Gráfico</option>
              <option>Fotografia</option><option>Suporte Técnico</option><option>Explicações</option><option>Fisioterapia</option>
              <option>Nutrição</option><option>Pastelaria</option><option>Costura</option>
            </select></div>
            <div class="field"><label>Género</label><select id="fGender" class="inp">
              <option value="">—</option><option>Masculino</option><option>Feminino</option><option>Outro</option>
            </select></div>
          </div>

          <div class="sect">Perfil profissional (para saltar o onboarding)</div>
          <div class="field" style="margin-bottom:14px"><label>Biografia</label><textarea id="fBio" class="ta" placeholder="História profissional do prestador…"></textarea></div>
          <div class="field" style="margin-bottom:14px"><label>Descrição do trabalho</label><textarea id="fWork" class="ta" placeholder="Que serviços oferece, diferenciais…"></textarea></div>
          <div class="formGrid">
            <div class="field"><label>Experiência</label><select id="fExp" class="inp">
              <option value="">—</option><option value="lt1">Menos de 1 ano</option><option value="2">2 anos</option><option value="3plus">3 anos ou mais</option>
            </select></div>
            <div class="field"><label>Horário</label>
              <div style="display:flex;gap:8px;">
                <input id="fStart" class="inp" value="08:00" placeholder="08:00" style="margin-bottom:0" />
                <input id="fEnd" class="inp" value="18:00" placeholder="18:00" style="margin-bottom:0" />
              </div>
            </div>
          </div>
          <div class="field" style="margin-top:14px"><label>Dias disponíveis</label>
            <div class="days" id="fDays">
              <button type="button" class="day on" data-d="1" onclick="this.classList.toggle('on')">Seg</button>
              <button type="button" class="day on" data-d="2" onclick="this.classList.toggle('on')">Ter</button>
              <button type="button" class="day on" data-d="3" onclick="this.classList.toggle('on')">Qua</button>
              <button type="button" class="day on" data-d="4" onclick="this.classList.toggle('on')">Qui</button>
              <button type="button" class="day on" data-d="5" onclick="this.classList.toggle('on')">Sex</button>
              <button type="button" class="day" data-d="6" onclick="this.classList.toggle('on')">Sáb</button>
              <button type="button" class="day" data-d="7" onclick="this.classList.toggle('on')">Dom</button>
            </div>
          </div>

          <div class="sect">Documentos</div>
          <div class="field" style="margin-bottom:14px"><label>Foto de perfil (imagem)</label><input id="fPhoto" class="file" type="file" accept="image/*" /></div>
          <div class="field" style="margin-bottom:14px"><label>Bilhete de Identidade (imagem ou PDF)</label><input id="fBI" class="file" type="file" accept="image/*,application/pdf" /></div>
          <div class="field" style="margin-bottom:6px"><label>Certificados (pode escolher vários)</label><input id="fCerts" class="file" type="file" accept="image/*,application/pdf" multiple /></div>

          <button class="full" style="margin-top:16px" onclick="createProvider()">Criar prestador</button>
          <div id="formMsg" class="err"></div>
        </div>
      </div>
    </div>
  </div>

<script>
  var KEY = sessionStorage.getItem('adminKey') || '';
  var TAB = 'pending';
  var EXP = { lt1:'Menos de 1 ano', '2':'2 anos', '3plus':'3 anos ou mais' };
  var DAYS = ['','Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];

  function fmtAvail(a){
    if(!a || !a.days || !a.days.length) return 'Não definido';
    var d = a.days.slice().sort(function(x,y){return x-y;});
    var contiguous = true;
    for(var i=1;i<d.length;i++){ if(d[i]!==d[i-1]+1){contiguous=false;break;} }
    var dt = d.length===7 ? 'Todos os dias' : (contiguous && d.length>1 ? DAYS[d[0]]+'–'+DAYS[d[d.length-1]] : d.map(function(n){return DAYS[n];}).join(', '));
    var tm = (a.start && a.end) ? '  ·  '+a.start+'–'+a.end : '';
    return dt+tm;
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

  function doLogin(){
    var k = document.getElementById('key').value.trim();
    fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j && j.ok){ KEY=k; sessionStorage.setItem('adminKey',k); showApp(); }
        else document.getElementById('loginErr').textContent = (j&&j.message)||'Falhou.';
      })
      .catch(function(){ document.getElementById('loginErr').textContent='Erro de ligação.'; });
  }
  function logout(){ sessionStorage.removeItem('adminKey'); KEY=''; document.getElementById('appView').classList.add('hide'); document.getElementById('loginView').classList.remove('hide'); }
  function showApp(){ document.getElementById('loginView').classList.add('hide'); document.getElementById('appView').classList.remove('hide'); loadStats(); load(); }
  function setTab(st){ TAB=st; var ts=document.querySelectorAll('.tab[data-st]'); for(var i=0;i<ts.length;i++){ ts[i].classList.toggle('active', ts[i].getAttribute('data-st')===st); }
    var isReg = (st==='cadastrar');
    document.getElementById('list').classList.toggle('hide', isReg);
    document.getElementById('registerForm').classList.toggle('hide', !isReg);
    if(!isReg) load();
  }

  function setStat(id,v){ var e=document.getElementById(id); if(e) e.textContent = (v==null?'—':String(v)); }
  function loadStats(){
    fetch('/api/admin/stats',{headers:{'x-admin-key':KEY}})
      .then(function(r){ return r.json(); })
      .then(function(j){ if(!j||!j.ok) return; setStat('stClients',j.clients); setStat('stProviders',j.providers); setStat('stApproved',j.providersApproved); setStat('stPending',j.providersPending); })
      .catch(function(){});
  }

  function val(id){ return (document.getElementById(id).value||'').trim(); }
  function fileToDataUrl(file){ return new Promise(function(resolve){ if(!file){ resolve(null); return; } var r=new FileReader(); r.onload=function(){ resolve(r.result); }; r.onerror=function(){ resolve(null); }; r.readAsDataURL(file); }); }
  function resetForm(){
    ['fName','fEmail','fPass','fPhone','fBio','fWork'].forEach(function(id){ document.getElementById(id).value=''; });
    ['fArea','fGender','fExp'].forEach(function(id){ document.getElementById(id).value=''; });
    ['fPhoto','fBI','fCerts'].forEach(function(id){ document.getElementById(id).value=''; });
  }
  function createProvider(){
    var msg = document.getElementById('formMsg'); msg.className='err'; msg.textContent='A criar…';
    var em = val('fEmail');
    var days=[]; var ds=document.querySelectorAll('#fDays .day.on');
    for(var i=0;i<ds.length;i++){ days.push(parseInt(ds[i].getAttribute('data-d'),10)); }
    var photo=document.getElementById('fPhoto').files[0];
    var bi=document.getElementById('fBI').files[0];
    var certFiles=document.getElementById('fCerts').files;
    var certPromises=[].map.call(certFiles,function(f){ return fileToDataUrl(f).then(function(d){ return { name:f.name, dataUrl:d }; }); });

    Promise.all([ fileToDataUrl(photo), fileToDataUrl(bi), Promise.all(certPromises) ])
      .then(function(all){
        var body = {
          name:val('fName'), email:em, password:val('fPass'), phone:val('fPhone'),
          workArea:val('fArea'), gender:val('fGender'),
          bio:val('fBio'), workDescription:val('fWork'), experienceTime:val('fExp'),
          availability: days.length ? { days:days, start:val('fStart'), end:val('fEnd') } : null,
          avatar: all[0], idDocument: all[1], certificates: all[2]
        };
        return fetch('/api/admin/create-provider',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':KEY},body:JSON.stringify(body)});
      })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(j&&j.ok){ msg.className='ok'; msg.textContent='✅ Prestador criado: '+em; resetForm(); loadStats(); }
        else { msg.className='err'; msg.textContent=(j&&j.message)||'Falhou.'; }
      })
      .catch(function(){ msg.className='err'; msg.textContent='Erro de ligação (ficheiros muito grandes?).'; });
  }

  function load(){
    document.getElementById('list').innerHTML = '<div class="empty">A carregar…</div>';
    fetch('/api/admin/applications?status='+TAB,{headers:{'x-admin-key':KEY}})
      .then(function(r){ if(r.status===401){ logout(); throw new Error('401'); } return r.json(); })
      .then(function(j){ render((j&&j.applications)||[]); })
      .catch(function(){});
  }

  function render(apps){
    var el = document.getElementById('list');
    if(!apps.length){ el.innerHTML = '<div class="empty">Nada por aqui.</div>'; return; }
    var html = '';
    for(var i=0;i<apps.length;i++){
      var a = apps[i];
      var badge = TAB==='approved'?'b-approved':(TAB==='rejected'?'b-rejected':'b-pending');
      var badgeTxt = TAB==='approved'?'Aprovado':(TAB==='rejected'?'Recusado':'Pendente');
      var certs = (a.certificates||[]).map(function(c){ return '<a class="chip" target="_blank" href="'+esc(c.file_url)+'">📄 '+esc(c.name||'Certificado')+'</a>'; }).join('');
      html += '<div class="card">'
        + '<div class="head">'
        + '<img class="av" src="'+esc(a.avatar_url||'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120')+'" />'
        + '<div style="flex:1"><div class="name">'+esc(a.name||'Prestador')+'</div><div class="area">'+esc(a.work_area||'—')+(a.source==='website'?'  ·  via site':'')+'</div></div>'
        + '<span class="badge '+badge+'">'+badgeTxt+'</span>'
        + '</div>'
        + '<div class="row"><div class="lbl">'+(a.source==='website'?'Descrição':'Biografia')+'</div><div class="val">'+esc(a.bio||'—')+'</div></div>'
        + (a.work_description ? '<div class="row"><div class="lbl">Descrição do trabalho</div><div class="val">'+esc(a.work_description)+'</div></div>' : '')
        + (a.specialty ? '<div class="row"><div class="lbl">Especialidade</div><div class="val">'+esc(a.specialty)+'</div></div>' : '')
        + (a.city ? '<div class="row"><div class="lbl">Cidade</div><div class="val">'+esc(a.city)+'</div></div>' : '')
        + ((a.phone||a.email) ? '<div class="row"><div class="lbl">Contacto</div><div class="val">'+esc([a.phone,a.email].filter(Boolean).join('  ·  '))+'</div></div>' : '')
        + '<div class="row"><div class="lbl">Experiência</div><div class="val">'+esc(a.experience_time?(EXP[a.experience_time]||'—'):(a.experience_years!=null?(a.experience_years+' ano'+(a.experience_years===1?'':'s')):'—'))+'</div></div>'
        + (a.source==='website' ? '' : '<div class="row"><div class="lbl">Disponibilidade</div><div class="val">'+esc(fmtAvail(a.availability))+'</div></div>')
        + (a.id_document_url ? '<div class="row"><div class="lbl">Bilhete de Identidade</div><div class="chips"><a class="chip" target="_blank" href="'+esc(a.id_document_url)+'">🪪 Ver BI</a></div></div>' : '')
        + (certs ? '<div class="row"><div class="lbl">Certificados</div><div class="chips">'+certs+'</div></div>' : '')
        + (a.approval_note ? '<div class="row"><div class="lbl">Nota</div><div class="val">'+esc(a.approval_note)+'</div></div>' : '')
        + (TAB==='pending' ? '<div class="acts"><button class="btn approve" onclick="decide(\\''+a.id+'\\',\\'approved\\',\\''+a.source+'\\')">Aprovar</button><button class="btn reject" onclick="decide(\\''+a.id+'\\',\\'rejected\\',\\''+a.source+'\\')">Recusar</button></div>' : '')
        + '</div>';
    }
    el.innerHTML = html;
  }

  function decide(id, decision, source){
    var note = null;
    if(decision==='rejected'){ note = prompt('Motivo da recusa (opcional):')||''; }
    fetch('/api/admin/decision',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':KEY},body:JSON.stringify({providerId:id,decision:decision,note:note,source:source})})
      .then(function(r){return r.json();})
      .then(function(j){ if(j&&j.ok){ load(); loadStats(); } else { alert((j&&j.message)||'Falhou.'); } })
      .catch(function(){ alert('Erro de ligação.'); });
  }

  if(KEY){ showApp(); }
</script>
</body>
</html>`;
