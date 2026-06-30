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
      <div class="tabs">
        <button class="tab active" data-st="pending" onclick="setTab('pending')">Pendentes</button>
        <button class="tab" data-st="approved" onclick="setTab('approved')">Aprovados</button>
        <button class="tab" data-st="rejected" onclick="setTab('rejected')">Recusados</button>
      </div>
      <div id="list" class="grid"></div>
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
  function showApp(){ document.getElementById('loginView').classList.add('hide'); document.getElementById('appView').classList.remove('hide'); load(); }
  function setTab(st){ TAB=st; var ts=document.querySelectorAll('.tab[data-st]'); for(var i=0;i<ts.length;i++){ ts[i].classList.toggle('active', ts[i].getAttribute('data-st')===st); } load(); }

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
      .then(function(j){ if(j&&j.ok){ load(); } else { alert((j&&j.message)||'Falhou.'); } })
      .catch(function(){ alert('Erro de ligação.'); });
  }

  if(KEY){ showApp(); }
</script>
</body>
</html>`;
