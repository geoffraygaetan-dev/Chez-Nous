// ============================================================================
// Chez Nous — application de tâches partagées
// Modèle "tous les N jours" : chaque tâche a un intervalle en jours et une
// date de dernière exécution. La prochaine échéance = lastDoneAt + N jours.
// ============================================================================

'use strict';

// ----- Config Firebase ------------------------------------------------------
var FIREBASE_URL = (window.APP_CONFIG && window.APP_CONFIG.FIREBASE_URL) || '';

// ----- Catégories -----------------------------------------------------------
var CATS = {
  cuisine:  {n:'Cuisine',   e:'🍳'},
  menage:   {n:'Ménage',    e:'🧹'},
  linge:    {n:'Linge',     e:'👕'},
  courses:  {n:'Courses',   e:'🛒'},
  jardin:   {n:'Jardin',    e:'🌿'},
  bricolage:{n:'Bricolage', e:'🔧'},
  animaux:  {n:'Animaux',   e:'🐾'},
  admin:    {n:'Admin',     e:'📋'}
};

// Presets de récurrence (en jours)
var PRESETS = [
  {n:1,  l:'Chaque jour'},
  {n:2,  l:'Tous les 2 jours'},
  {n:3,  l:'Tous les 3 jours'},
  {n:7,  l:'Chaque semaine'},
  {n:10, l:'Tous les 10 jours'},
  {n:15, l:'Tous les 15 jours'},
  {n:21, l:'Tous les 21 jours'},
  {n:30, l:'Chaque mois'},
  {n:60, l:'Tous les 2 mois'}
];

// ----- Tâches par défaut (premier lancement) --------------------------------
var DEF = [
  {titre:'Vider le lave-vaisselle', cat:'cuisine', tousLesNJours:1,  mode:'rot', debut:'gaetan'},
  {titre:'Sortir les poubelles',     cat:'menage',  tousLesNJours:7,  mode:'rot', debut:'gaetan'},
  {titre:'Aspirer le sol',           cat:'menage',  tousLesNJours:2,  mode:'rot', debut:'amandine'},
  {titre:'Faire les courses',        cat:'courses', tousLesNJours:7,  mode:'rot', debut:'amandine'},
  {titre:'Faire une lessive',        cat:'linge',   tousLesNJours:3,  mode:'rot', debut:'gaetan'}
];

// ----- État global ----------------------------------------------------------
var taches = [];
var hist = [];
var moi = localStorage.getItem('moi') || '';
var filtreWho = 'all';
var filtreCat = 'all';
var pendingDeleteId = null;
var pendingMenuId = null;
var editingId = null;
var localDirty = 0;
var saving = false;
var draft = null;

// ============================================================================
// UTILITAIRES DATE
// ============================================================================
function pad(n){ return n<10 ? '0'+n : ''+n; }
function startOfDay(d){ d = d || new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dateLocal(d){ d = d || new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function todayLocal(){ return dateLocal(); }

// Date d'échéance : lastDoneAt + N jours, ou aujourd'hui si jamais faite
function dueDate(t){
  if(!t.lastDoneAt) return startOfDay();
  var last = new Date(t.lastDoneAt);
  var d = new Date(last.getFullYear(), last.getMonth(), last.getDate());
  d.setDate(d.getDate() + (t.tousLesNJours || 1));
  return d;
}

// Jours jusqu'à l'échéance : >0 = à venir, =0 = aujourd'hui, <0 = en retard
function daysUntilDue(t){
  var due = dueDate(t);
  var today = startOfDay();
  return Math.round((due - today) / 86400000);
}

function isLate(t){    return daysUntilDue(t) <  0; }
function isToday(t){   return daysUntilDue(t) === 0; }
function isUpcoming(t){return daysUntilDue(t) >  0; }

function nJoursLabel(n){
  for(var i=0;i<PRESETS.length;i++) if(PRESETS[i].n === n) return PRESETS[i].l;
  return 'Tous les ' + n + ' jours';
}

function nJoursLabelShort(n){
  if(n===1) return 'chaque jour';
  if(n===7) return 'chaque sem.';
  if(n===14) return 'chaque 2 sem.';
  if(n===15) return 'chaque 15 j';
  if(n===21) return 'chaque 3 sem.';
  if(n===30) return 'chaque mois';
  if(n===60) return 'chaque 2 mois';
  return 'tous les ' + n + ' j';
}

// Libellé d'échéance pour la chip
function dueLabel(t){
  var d = daysUntilDue(t);
  if(d < 0){
    var n = -d;
    return n === 1 ? '1 jour de retard' : n + ' jours de retard';
  }
  if(d === 0) return "À faire aujourd'hui";
  if(d === 1) return 'Demain';
  if(d <= 7) return 'Dans ' + d + ' jours';
  // Sinon : date courte
  var due = dueDate(t);
  var jours = ['dim.','lun.','mar.','mer.','jeu.','ven.','sam.'];
  var mois = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  return jours[due.getDay()] + ' ' + due.getDate() + ' ' + mois[due.getMonth()];
}

// ============================================================================
// MIGRATION ANCIENS MODÈLES -> NOUVEAU
// ============================================================================
function freqToDays(per, nb){
  nb = nb || 1;
  // Approximation : N jours entre exécutions = (durée période en jours) / nb
  if(per === 'daily')      return Math.max(1, Math.round(1 / nb));
  if(per === 'weekly')     return Math.max(1, Math.round(7 / nb));
  if(per === 'biweekly')   return Math.max(1, Math.round(14 / nb));
  if(per === 'triweekly')  return Math.max(1, Math.round(21 / nb));
  if(per === 'monthly')    return Math.max(1, Math.round(30 / nb));
  return 7;
}

function migrateTask(t){
  // Si déjà au nouveau format
  if(typeof t.tousLesNJours === 'number' && t.tousLesNJours > 0){
    return Object.assign({}, t, {
      mode: t.mode || 'fix',
      qui: t.qui || t.debut || 'gaetan',
      debut: t.debut || t.qui || 'gaetan',
      lastDoneAt: t.lastDoneAt || null,
      createdAt: t.createdAt || new Date().toISOString()
    });
  }

  // Format intermédiaire {freq:{per,nb}}
  var n = 7;
  if(t.freq && typeof t.freq === 'object' && t.freq.per){
    n = freqToDays(t.freq.per, t.freq.nb);
  }
  // Ancien format string "3x_weekly"
  else if(typeof t.freq === 'string'){
    var m = t.freq.match(/^(\d+)x_(.+)$/);
    if(m){ n = freqToDays(m[2], parseInt(m[1],10) || 1); }
  }

  var qui = t.qui || t.debut || 'gaetan';
  if(qui === 'les2') qui = 'gaetan';
  var debut = t.debut || qui;
  if(debut === 'les2') debut = 'gaetan';

  // Catégorie : si inconnue, retombe sur menage
  var cat = t.cat;
  if(!cat || !CATS[cat]) cat = 'menage';

  // Si la tâche était déjà faite (ancien fait:true), mettre lastDoneAt à maintenant
  // Sinon, lastDoneAt nul = due aujourd'hui
  var lastDoneAt = t.lastDoneAt || null;
  if(t.fait && !lastDoneAt) lastDoneAt = new Date().toISOString();

  return {
    id: t.id || ('t_' + Date.now() + '_' + Math.random().toString(36).slice(2,7)),
    titre: t.titre || 'Tâche',
    cat: cat,
    tousLesNJours: n,
    mode: t.mode || 'fix',
    qui: qui,
    debut: debut,
    lastDoneAt: lastDoneAt,
    createdAt: t.createdAt || new Date().toISOString()
  };
}

function migrateAll(j){
  var out = {taches:[], hist:[]};
  if(j && Array.isArray(j.taches)){
    out.taches = j.taches.map(migrateTask);
  }
  if(j && Array.isArray(j.hist)){
    out.hist = j.hist.map(function(h){
      return {
        id: h.id || ('h_' + Math.random().toString(36).slice(2,9)),
        titre: h.titre || h.t || 'Tâche',
        qui: h.qui || h.q || 'gaetan',
        cat: h.cat || h.c || 'menage',
        at: h.at || h.d || new Date().toISOString(),
        taskId: h.taskId || null
      };
    });
  }
  return out;
}

function autre(q){ return q === 'gaetan' ? 'amandine' : 'gaetan'; }

// ============================================================================
// FIREBASE I/O
// ============================================================================
function sync(s){
  var dot = document.getElementById('sdot');
  var txt = document.getElementById('stxt');
  if(!dot) return;
  dot.className = 'sdot' + (s ? ' '+s : '');
  txt.textContent = s === 'L' ? 'Sync…' : s === 'E' ? 'Hors ligne' : 'Sync';
}

async function charger(){
  if(!moi){ document.getElementById('welcome').style.display = 'flex'; }
  sync('L');
  if(!FIREBASE_URL){ sync('E'); return; }
  try{
    var r = await fetch(FIREBASE_URL + '/data.json');
    var j = await r.json();
    if(j === null){
      taches = DEF.map(migrateTask);
      hist = [];
      await sauver();
    } else {
      var m = migrateAll(j);
      taches = m.taches;
      hist = m.hist;
    }
    sync('');
  } catch(e){
    console.warn('Firebase load error', e);
    sync('E');
  }
  afficher();
  scheduleNotifications();
}

async function sauver(){
  if(!FIREBASE_URL) return;
  saving = true;
  sync('L');
  try{
    await fetch(FIREBASE_URL + '/data.json', {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({taches:taches, hist:hist, updatedAt: Date.now()})
    });
    sync('');
  } catch(e){
    sync('E');
  } finally {
    saving = false;
  }
}

async function poll(){
  if(saving) return;
  if(Date.now() - localDirty < 15000) return;
  try{
    var r = await fetch(FIREBASE_URL + '/data.json');
    var j = await r.json();
    if(!j) return;
    var serialized = JSON.stringify({taches:taches, hist:hist});
    var m = migrateAll(j);
    var serializedNew = JSON.stringify({taches:m.taches, hist:m.hist});
    if(serializedNew !== serialized){
      taches = m.taches;
      hist = m.hist;
      afficher();
    }
    sync('');
  } catch(e){ sync('E'); }
}

// ============================================================================
// AFFICHAGE
// ============================================================================
function afficher(){
  greet();
  banner();
  catPills();
  liste();
  listeHist();
  document.getElementById('tcH').textContent = hist.length > 99 ? '99+' : hist.length;
}

function courtU(u){ return u === 'gaetan' ? 'Gaetan' : 'Amandine'; }

function greet(){
  var now = new Date();
  var jours = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  var mois = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  document.getElementById('gdate').textContent = jours[now.getDay()]+' '+now.getDate()+' '+mois[now.getMonth()];
  var h = now.getHours();
  var sal = h<6 ? 'Bonne nuit' : h<12 ? 'Bonjour' : h<18 ? 'Bon après-midi' : 'Bonsoir';
  var mesTaches = taches.filter(function(t){ return t.qui === moi; });
  var lateMine = mesTaches.filter(isLate).length;
  var todayMine = mesTaches.filter(isToday).length;
  var aFaire = lateMine + todayMine;
  var nom = moi ? courtU(moi) : '';
  var el = document.getElementById('gtxt');
  if(!moi){
    el.textContent = 'Bienvenue chez nous';
  } else if(aFaire === 0){
    el.innerHTML = '<em>Bravo '+nom+' !</em> Rien d\'urgent';
  } else if(lateMine > 0){
    el.innerHTML = sal + ' <em>' + nom + '</em> — ' + lateMine + ' en retard, ' + todayMine + ' aujourd\'hui';
  } else {
    el.innerHTML = sal + ' <em>' + nom + '</em> — ' + todayMine + ' à faire aujourd\'hui';
  }
}

function banner(){
  var now = new Date();
  var jours = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  var mois = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  var h = now.getHours();

  var bn = document.getElementById('banner');
  var core = document.getElementById('astroCore');
  var shadow = document.getElementById('astroShadow');
  var ring = document.getElementById('astroRing');
  for(var ri=0;ri<8;ri++){ var elr = document.getElementById('r'+ri); if(elr) elr.style.transform='rotate('+ri*45+'deg) translateX(-50%)'; }

  var dateBase = jours[now.getDay()]+' '+now.getDate()+' '+mois[now.getMonth()];
  var prefix = '';

  if(h>=6 && h<12){
    bn.style.background='linear-gradient(135deg,#3A1A0A 0%,#6B2A10 35%,#C45A20 65%,#E8903A 100%)';
    core.style.background='radial-gradient(circle,#FFE0A0,#FF9040)';
    core.style.boxShadow='0 0 20px rgba(255,160,64,.5),0 0 40px rgba(255,120,40,.2)';
    shadow.style.display='none';
    ring.style.borderColor='rgba(255,180,80,.3)';
    for(var ri2=0;ri2<8;ri2++){ var e2=document.getElementById('r'+ri2); if(e2){e2.style.background='rgba(255,190,80,.5)';e2.style.display='block';} }
    prefix = '🌅 Matin · ';
  } else if(h>=12 && h<18){
    bn.style.background='linear-gradient(135deg,#2C1A0E 0%,#4A2E18 40%,#6B3F22 70%,#8B5A30 100%)';
    core.style.background='radial-gradient(circle,#FFE88A,#FFB347)';
    core.style.boxShadow='0 0 24px rgba(255,200,70,.55),0 0 48px rgba(255,160,48,.2)';
    shadow.style.display='none';
    ring.style.borderColor='rgba(255,210,80,.35)';
    for(var ri3=0;ri3<8;ri3++){ var e3=document.getElementById('r'+ri3); if(e3){e3.style.background='rgba(255,210,80,.55)';e3.style.display='block';} }
    prefix = '☀️ Après-midi · ';
  } else if(h>=18 && h<22){
    bn.style.background='linear-gradient(135deg,#1A0A1A 0%,#3A1A2A 30%,#7A2A10 65%,#B84020 100%)';
    core.style.background='radial-gradient(circle,#FFCC80,#FF7020)';
    core.style.boxShadow='0 0 22px rgba(255,130,32,.5),0 0 44px rgba(200,80,20,.25)';
    shadow.style.display='none';
    ring.style.borderColor='rgba(255,160,60,.3)';
    for(var ri4=0;ri4<8;ri4++){ var e4=document.getElementById('r'+ri4); if(e4){e4.style.background='rgba(255,150,60,.4)';e4.style.display='block';} }
    prefix = '🌆 Soir · ';
  } else {
    bn.style.background='linear-gradient(135deg,#0A0A18 0%,#101828 40%,#1A2430 70%,#1E2A1A 100%)';
    core.style.background='linear-gradient(135deg,#FFE8A0,#FFD060)';
    core.style.boxShadow='0 0 18px rgba(255,220,80,.25)';
    shadow.style.display='block';
    shadow.style.background='#101828';
    ring.style.borderColor='rgba(200,220,255,.12)';
    for(var ri5=0;ri5<8;ri5++){ var e5=document.getElementById('r'+ri5); if(e5){e5.style.display='none';} }
    prefix = '🌙 Nuit · ';
  }
  document.getElementById('banDate').textContent = prefix + dateBase;

  var lateAll  = taches.filter(isLate).length;
  var todayAll = taches.filter(isToday).length;
  var lateG  = taches.filter(function(t){ return t.qui==='gaetan' && (isLate(t) || isToday(t)); }).length;
  var lateA  = taches.filter(function(t){ return t.qui==='amandine' && (isLate(t) || isToday(t)); }).length;
  var totalActives = lateAll + todayAll;

  var titre;
  if(taches.length === 0){ titre = 'Pas encore de <em>tâches</em>'; }
  else if(totalActives === 0){ titre = 'Tout est <em>à jour</em> ! 🎉'; }
  else if(lateAll > 0){ titre = '⚠ ' + lateAll + ' tâche' + (lateAll>1?'s':'') + ' en <em>retard</em>'; }
  else if(todayAll > 0){ titre = todayAll + ' tâche' + (todayAll>1?'s':'') + ' à faire <em>aujourd\'hui</em>'; }
  else { titre = 'Bonne <em>journée</em>'; }

  document.getElementById('banTitre').innerHTML = titre;
  // Barre de progression : ratio à jour / total
  var pct = taches.length > 0 ? Math.round(((taches.length - totalActives) / taches.length) * 100) : 100;
  document.getElementById('banFill').style.width = pct + '%';
  document.getElementById('banFaites').textContent = lateAll;
  document.getElementById('banG').textContent = lateG;
  document.getElementById('banA').textContent = lateA;
  // Mettre à jour les libellés du banner
  var lblFaites = document.getElementById('banLblFaites');
  if(lblFaites) lblFaites.textContent = 'EN RETARD';
}

function catPills(){
  var vis = taches.filter(function(t){ return filtreWho==='all' || t.qui===filtreWho; });
  var cnt = {};
  vis.forEach(function(t){ cnt[t.cat] = (cnt[t.cat]||0)+1; });
  var used = Object.keys(CATS).filter(function(c){ return cnt[c]; });
  var html = '<button type="button" class="cp on-all'+(filtreCat==='all'?' on':'')+'" data-action="set-category" data-value="all">✦ Tout<span class="cpn">'+vis.length+'</span></button>';
  used.forEach(function(c){
    var info = CATS[c];
    html += '<button type="button" class="cp'+(filtreCat===c?' on':'')+'" data-action="set-category" data-value="'+c+'">'+info.e+' '+info.n+'<span class="cpn">'+(cnt[c]||0)+'</span></button>';
  });
  document.getElementById('catRow').innerHTML = html;
}

// ----- Carte tâche ---------------------------------------------------------
function carteHtml(t){
  var qcls = t.qui === 'gaetan' ? 'g' : 'a';
  var d = daysUntilDue(t);
  var late = d < 0;
  var today = d === 0;

  var classes = 'tc-card ' + qcls;
  if(late) classes += ' late';
  else if(today) classes += ' today';
  else classes += ' upcoming';

  var info = CATS[t.cat] || {n:'Ménage',e:'🧹'};
  var R = 18, C = 2*Math.PI*R;
  var color = qcls === 'g' ? '#9E6B45' : '#8FB05A';
  // Anneau plein si due ou en retard, vide sinon
  var fillRatio = (late || today) ? 1 : 0;
  var off = C * (1 - fillRatio);

  var chipDeadline;
  if(late){
    chipDeadline = '<span class="chip chip-late">⚠ ' + dueLabel(t) + '</span>';
  } else if(today){
    chipDeadline = '<span class="chip chip-today">⏰ ' + dueLabel(t) + '</span>';
  } else {
    chipDeadline = '<span class="chip chip-soon">📅 ' + dueLabel(t) + '</span>';
  }

  var dot = late ? '<span class="late-dot" aria-hidden="true"></span>' : '';

  return '<article class="'+classes+'" data-id="'+t.id+'">'
    + '<div class="tc-strip"></div>'
    + dot
    + '<div class="tc-inner">'
    +   '<button type="button" class="tc-check" data-action="check-task" data-id="'+t.id+'" aria-label="Valider la tâche">'
    +     '<svg class="ring" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">'
    +       '<circle class="ring-bg" cx="28" cy="28" r="22" fill="none" stroke-width="4"/>'
    +       '<circle class="ring-fill" cx="28" cy="28" r="22" fill="none" stroke="'+color+'" stroke-width="4" stroke-linecap="round" stroke-dasharray="'+(2*Math.PI*22).toFixed(2)+'" stroke-dashoffset="'+(2*Math.PI*22*(1-fillRatio)).toFixed(2)+'" transform="rotate(-90 28 28)"/>'
    +     '</svg>'
    +     '<span class="ring-icon">' + (late ? '!' : today ? '✓' : '·') + '</span>'
    +   '</button>'
    +   '<div class="tc-body">'
    +     '<div class="tc-title">'+escapeHtml(t.titre)+'</div>'
    +     '<div class="chips">'
    +       '<span class="chip chip-'+qcls+'">'+(qcls==='g'?'🤎':'💚')+' '+courtU(t.qui)+'</span>'
    +       '<span class="chip chip-cat">'+info.e+' '+info.n+'</span>'
    +       '<span class="chip chip-freq">🔁 '+nJoursLabelShort(t.tousLesNJours)+'</span>'
    +       chipDeadline
    +     '</div>'
    +   '</div>'
    +   '<div class="tc-actions">'
    +     '<button type="button" class="menu-btn" data-action="open-menu" data-id="'+t.id+'" aria-label="Menu">⋯</button>'
    +   '</div>'
    + '</div>'
  + '</article>';
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function liste(){
  var vis = taches.filter(function(t){
    if(filtreWho!=='all' && t.qui!==filtreWho) return false;
    if(filtreCat!=='all' && t.cat!==filtreCat) return false;
    return true;
  });
  var late     = vis.filter(isLate);
  var todayArr = vis.filter(isToday);
  var upcoming = vis.filter(isUpcoming);

  late.sort(function(a,b){ return daysUntilDue(a) - daysUntilDue(b); }); // plus en retard d'abord
  todayArr.sort(function(a,b){ return a.titre.localeCompare(b.titre,'fr'); });
  upcoming.sort(function(a,b){ return daysUntilDue(a) - daysUntilDue(b); });

  document.getElementById('tcT').textContent = late.length + todayArr.length;
  var tcCnt = document.getElementById('tcT');
  if(tcCnt) tcCnt.classList.toggle('has-late', late.length > 0);

  var html = '';
  if(late.length){
    html += '<div class="shd shd-late">🔴 En retard <span class="sbadge sbadge-late">'+late.length+'</span></div>';
    html += late.map(carteHtml).join('');
  }
  if(todayArr.length){
    html += '<div class="shd">🟡 Aujourd\'hui <span class="sbadge sbadge-today">'+todayArr.length+'</span></div>';
    html += todayArr.map(carteHtml).join('');
  }
  if(upcoming.length){
    html += '<div class="shd">⚪ À venir <span class="sbadge sbadge-upcoming">'+upcoming.length+'</span></div>';
    html += upcoming.map(carteHtml).join('');
  }
  if(vis.length === 0){
    html = '<div class="empty"><div class="empty-icon">✨</div><div class="empty-title">Rien ici</div><div class="empty-sub">Touchez le bouton + en bas à droite pour ajouter une tâche.</div></div>';
  } else if(late.length === 0 && todayArr.length === 0){
    html = '<div class="empty"><div class="empty-icon">🎉</div><div class="empty-title">Tout est à jour !</div><div class="empty-sub">Belle équipe. Profitez de votre temps libre.</div></div>' + html;
  }

  document.getElementById('listMain').innerHTML = html;
}

function listeHist(){
  var el = document.getElementById('listHist');
  if(hist.length === 0){
    el.innerHTML = '<div class="empty"><div class="empty-icon">📜</div><div class="empty-title">Pas d\'historique</div><div class="empty-sub">Vos tâches terminées apparaîtront ici.</div></div>';
    return;
  }
  var sorted = hist.slice().sort(function(a,b){ return (b.at||'').localeCompare(a.at||''); }).slice(0, 200);
  var groups = {};
  sorted.forEach(function(h){
    var d = (h.at || '').slice(0,10);
    if(!groups[d]) groups[d] = [];
    groups[d].push(h);
  });
  var keys = Object.keys(groups).sort().reverse();
  var jours = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  var mois = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  var today = todayLocal();
  var html = '';
  keys.forEach(function(k){
    var dt = new Date(k+'T12:00:00');
    var label = jours[dt.getDay()]+' '+dt.getDate()+' '+mois[dt.getMonth()];
    if(k === today) label = "Aujourd'hui";
    html += '<div class="h-day"><div class="h-day-hd">'+label+'</div>';
    groups[k].forEach(function(h){
      var qcls = h.qui === 'gaetan' ? 'g' : 'a';
      var t = new Date(h.at);
      var heure = pad(t.getHours())+':'+pad(t.getMinutes());
      var info = CATS[h.cat] || {n:'',e:'•'};
      html += '<div class="hcard '+qcls+'">'
        + '<div><div class="hcard-title">'+escapeHtml(h.titre)+'</div>'
        + '<div class="hcard-meta">'+info.e+' '+info.n+' · '+heure+'</div></div>'
        + '<div class="hcard-user '+qcls+'">'+(qcls==='g'?'🤎':'💚')+' '+courtU(h.qui)+'</div>'
        + '</div>';
    });
    html += '</div>';
  });
  el.innerHTML = html;
}

// ============================================================================
// ACTIONS
// ============================================================================
function findTask(id){ for(var i=0;i<taches.length;i++) if(taches[i].id===id) return taches[i]; return null; }

function checkTask(id){
  var t = findTask(id);
  if(!t) return;
  var quiAvant = t.qui;
  t.lastDoneAt = new Date().toISOString();
  hist.unshift({
    id: 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    titre: t.titre, qui: quiAvant, cat: t.cat,
    at: new Date().toISOString(),
    taskId: t.id
  });
  if(hist.length > 500) hist = hist.slice(0, 500);
  // Rotation : la prochaine fois c'est l'autre
  if(t.mode === 'rot') t.qui = autre(quiAvant);
  localDirty = Date.now();
  confetti(quiAvant);
  toast(t.titre + ' — fait !');
  afficher();
  sauver();
}

function decrementTask(id){
  var t = findTask(id);
  if(!t){ toast("Tâche introuvable"); return; }
  // Trouver la dernière entrée d'historique pour cette tâche
  var idx = -1;
  for(var i=0;i<hist.length;i++){ if(hist[i].taskId===id){ idx = i; break; } }
  if(idx < 0){ toast("Rien à annuler"); return; }
  var entry = hist[idx];
  hist.splice(idx, 1);
  // Trouver l'entrée précédente (s'il y en a une) pour restaurer lastDoneAt
  var prevAt = null;
  for(var j=0;j<hist.length;j++){ if(hist[j].taskId===id){ prevAt = hist[j].at; break; } }
  t.lastDoneAt = prevAt;
  // Inverser la rotation : remettre le qui qui avait fait l'action annulée
  if(t.mode === 'rot') t.qui = entry.qui;
  localDirty = Date.now();
  toast("Annulé");
  afficher();
  sauver();
}

function deleteTask(id){
  taches = taches.filter(function(t){ return t.id !== id; });
  localDirty = Date.now();
  afficher();
  sauver();
}

// ----- Drawer -------------------------------------------------------------
function defaultDraft(){
  return {
    id: null,
    titre: '',
    cat: 'menage',
    tousLesNJours: 7,
    mode: 'rot',
    debut: 'gaetan',
    customN: 7
  };
}

function openDrawer(taskId){
  editingId = taskId || null;
  if(taskId){
    var t = findTask(taskId);
    if(!t) return;
    draft = {
      id: t.id,
      titre: t.titre,
      cat: t.cat,
      tousLesNJours: t.tousLesNJours,
      mode: t.mode,
      debut: t.debut || t.qui,
      customN: t.tousLesNJours
    };
    document.getElementById('drawerTitle').textContent = 'Modifier la tâche';
    document.getElementById('addTaskBtn').textContent = 'Enregistrer';
  } else {
    draft = defaultDraft();
    document.getElementById('drawerTitle').textContent = 'Nouvelle tâche';
    document.getElementById('addTaskBtn').textContent = 'Ajouter →';
  }
  document.getElementById('fTitre').value = draft.titre;
  renderDrawer();
  document.getElementById('drawerBg').style.display = 'flex';
  setTimeout(function(){ document.getElementById('fTitre').focus(); }, 250);
}

function closeDrawer(){
  document.getElementById('drawerBg').style.display = 'none';
  editingId = null;
  draft = null;
}

function renderDrawer(){
  if(!draft) return;
  // Catégories
  var eg = '';
  Object.keys(CATS).forEach(function(c){
    var info = CATS[c];
    eg += '<button type="button" class="ebtn'+(draft.cat===c?' on':'')+'" data-action="set-cat" data-value="'+c+'"><span class="ei">'+info.e+'</span>'+info.n+'</button>';
  });
  document.getElementById('egrid').innerHTML = eg;

  // Récurrence presets + custom
  var fr = '';
  PRESETS.forEach(function(p){
    fr += '<button type="button" class="fqbtn'+(draft.tousLesNJours===p.n?' on':'')+'" data-action="set-recur" data-value="'+p.n+'">'+p.l+'</button>';
  });
  // Bouton custom
  var isCustom = !PRESETS.some(function(p){ return p.n === draft.tousLesNJours; });
  fr += '<button type="button" class="fqbtn'+(isCustom?' on':'')+'" data-action="set-recur-custom">Personnalisé…</button>';
  document.getElementById('fqrow').innerHTML = fr;

  // Champ custom
  var customWrap = document.getElementById('customWrap');
  if(isCustom){
    customWrap.classList.remove('is-hidden');
    document.getElementById('fCustomN').value = draft.tousLesNJours;
  } else {
    customWrap.classList.add('is-hidden');
  }
  document.getElementById('fqsum').textContent = nJoursLabel(draft.tousLesNJours);

  // Mode
  document.getElementById('btnRot').className = 'tbtn' + (draft.mode==='rot' ? ' on-dark' : '');
  document.getElementById('btnFix').className = 'tbtn' + (draft.mode==='fix' ? ' on-dark' : '');
  // Assigné
  document.getElementById('btnG').className = 'tbtn' + (draft.debut==='gaetan' ? ' on-g' : '');
  document.getElementById('btnA').className = 'tbtn' + (draft.debut==='amandine' ? ' on-a' : '');
}

function saveTask(){
  if(!draft) return;
  var titre = (document.getElementById('fTitre').value || '').trim();
  if(!titre){ toast("Donnez un titre à la tâche"); return; }
  draft.titre = titre;

  // Si on est en mode custom, prendre la valeur du champ
  var isCustom = !PRESETS.some(function(p){ return p.n === draft.tousLesNJours; });
  if(isCustom){
    var n = parseInt(document.getElementById('fCustomN').value, 10);
    if(!n || n < 1 || n > 365){ toast("Choisissez entre 1 et 365 jours"); return; }
    draft.tousLesNJours = n;
  }

  if(editingId){
    var t = findTask(editingId);
    if(t){
      t.titre = draft.titre;
      t.cat = draft.cat;
      t.tousLesNJours = draft.tousLesNJours;
      t.mode = draft.mode;
      t.debut = draft.debut;
      if(t.mode === 'fix') t.qui = draft.debut;
    }
  } else {
    var nt = {
      id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      titre: draft.titre,
      cat: draft.cat,
      tousLesNJours: draft.tousLesNJours,
      mode: draft.mode,
      debut: draft.debut,
      qui: draft.debut,
      lastDoneAt: null,
      createdAt: new Date().toISOString()
    };
    taches.push(nt);
  }
  localDirty = Date.now();
  closeDrawer();
  afficher();
  sauver();
  toast(editingId ? 'Tâche modifiée' : 'Tâche ajoutée');
}

// ----- Menu et confirm ----------------------------------------------------
function openMenu(id){
  pendingMenuId = id;
  document.getElementById('menuOv').style.display = 'flex';
}
function closeMenu(){
  document.getElementById('menuOv').style.display = 'none';
  pendingMenuId = null;
}
function askDelete(id){
  pendingDeleteId = id;
  var t = findTask(id);
  document.getElementById('confirmTxt').textContent = t ? '« '+t.titre+' »' : '';
  document.getElementById('confirmOv').style.display = 'flex';
}
function closeConfirm(){
  document.getElementById('confirmOv').style.display = 'none';
  pendingDeleteId = null;
}

// ----- Toast & confettis --------------------------------------------------
var toastTimer = null;
function toast(msg){
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 2200);
}

function confetti(qui){
  var colors = qui === 'gaetan'
    ? ['#9E6B45','#C28A5E','#FFD09A','#F5F0E8']
    : ['#8FB05A','#A8C97A','#C8E8A0','#F5F0E8'];
  for(var i=0;i<24;i++){
    var c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = (10 + Math.random()*80) + '%';
    c.style.top = '-20px';
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = (Math.random()*0.3) + 's';
    c.style.transform = 'rotate('+(Math.random()*360)+'deg)';
    document.body.appendChild(c);
    setTimeout((function(el){ return function(){ el.remove(); }; })(c), 1800);
  }
}

// ============================================================================
// NOTIFICATIONS / RAPPELS
// ============================================================================
function getSettings(){
  try{
    var s = JSON.parse(localStorage.getItem('chez_nous_settings') || '{}');
    return {
      morning:     s.morning     !== false,
      morningTime: s.morningTime || '09:00',
      evening:     s.evening     !== false,
      eveningTime: s.eveningTime || '19:00',
      visualAlert: s.visualAlert !== false
    };
  } catch(e){ return {morning:true, morningTime:'09:00', evening:true, eveningTime:'19:00', visualAlert:true}; }
}

function saveSettings(s){
  localStorage.setItem('chez_nous_settings', JSON.stringify(s));
}

var notifTimers = [];
function clearNotifTimers(){
  notifTimers.forEach(function(t){ clearTimeout(t); });
  notifTimers = [];
}

function nextOccurrence(timeStr){
  var parts = (timeStr || '09:00').split(':');
  var hh = parseInt(parts[0],10) || 9;
  var mm = parseInt(parts[1],10) || 0;
  var next = new Date();
  next.setHours(hh, mm, 0, 0);
  if(next <= new Date()) next.setDate(next.getDate()+1);
  return next;
}

function rappelTexte(prefix){
  var mesTaches = taches.filter(function(t){ return t.qui === moi; });
  var late = mesTaches.filter(isLate);
  var today = mesTaches.filter(isToday);
  if(late.length === 0 && today.length === 0) return null;
  var parts = [];
  if(late.length) parts.push(late.length + ' en retard');
  if(today.length) parts.push(today.length + ' aujourd\'hui');
  return prefix + ' : ' + parts.join(', ');
}

function scheduleNotifications(){
  clearNotifTimers();
  if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  var s = getSettings();

  if(s.morning){
    var nm = nextOccurrence(s.morningTime);
    notifTimers.push(setTimeout(function(){
      var msg = rappelTexte('Bonjour ' + courtU(moi || 'gaetan'));
      if(msg) showNotif('☀️ Rappel du matin', msg);
      scheduleNotifications();
    }, Math.min(nm - new Date(), 2147483000)));
  }
  if(s.evening){
    var ne = nextOccurrence(s.eveningTime);
    notifTimers.push(setTimeout(function(){
      var msg = rappelTexte('Bonsoir ' + courtU(moi || 'gaetan'));
      if(msg) showNotif('🌆 Rappel du soir', msg);
      scheduleNotifications();
    }, Math.min(ne - new Date(), 2147483000)));
  }
}

function showNotif(title, body){
  try{
    if(navigator.serviceWorker && navigator.serviceWorker.ready){
      navigator.serviceWorker.ready.then(function(reg){
        reg.showNotification(title, {
          body: body,
          icon: 'icon.png',
          badge: 'icon.png',
          tag: 'cheznous-' + Date.now()
        });
      });
    } else {
      new Notification(title, {body: body, icon: 'icon.png'});
    }
  } catch(e){ console.warn(e); }
}

function activerNotif(){
  if(typeof Notification === 'undefined'){
    toast('Notifications non supportées sur ce navigateur');
    return;
  }
  Notification.requestPermission().then(function(p){
    document.getElementById('notif').classList.add('is-hidden');
    if(p === 'granted'){
      scheduleNotifications();
      toast('Rappels activés ✓');
    } else {
      toast('Rappels désactivés (réactivable dans ⚙️ Réglages)');
    }
  });
}

// ----- Settings UI --------------------------------------------------------
function openSettings(){
  var s = getSettings();
  document.getElementById('setMorning').checked = s.morning;
  document.getElementById('setMorningTime').value = s.morningTime;
  document.getElementById('setEvening').checked = s.evening;
  document.getElementById('setEveningTime').value = s.eveningTime;
  document.getElementById('setVisual').checked = s.visualAlert;
  document.getElementById('settingsBg').style.display = 'flex';
}
function closeSettings(){ document.getElementById('settingsBg').style.display = 'none'; }
function persistSettings(){
  var s = {
    morning: document.getElementById('setMorning').checked,
    morningTime: document.getElementById('setMorningTime').value || '09:00',
    evening: document.getElementById('setEvening').checked,
    eveningTime: document.getElementById('setEveningTime').value || '19:00',
    visualAlert: document.getElementById('setVisual').checked
  };
  saveSettings(s);
  // Appliquer indicateur visuel
  document.body.classList.toggle('no-late-dot', !s.visualAlert);
  if(typeof Notification !== 'undefined' && Notification.permission !== 'granted' && (s.morning || s.evening)){
    Notification.requestPermission().then(function(p){
      if(p === 'granted') scheduleNotifications();
    });
  } else {
    scheduleNotifications();
  }
  closeSettings();
  toast('Réglages enregistrés');
}

// ============================================================================
// EVENTS / NAVIGATION
// ============================================================================
function chooseProfile(p){
  moi = p;
  localStorage.setItem('moi', p);
  document.getElementById('welcome').style.display = 'none';
  afficher();
  scheduleNotifications();
}
function showWelcome(){ document.getElementById('welcome').style.display = 'flex'; }
function setTab(v){
  document.getElementById('tabT').classList.toggle('on', v==='t');
  document.getElementById('tabH').classList.toggle('on', v==='h');
  document.getElementById('panT').classList.toggle('is-hidden', v!=='t');
  document.getElementById('panH').classList.toggle('is-hidden', v!=='h');
}
function setUserFilter(v){
  filtreWho = v;
  filtreCat = 'all';
  document.getElementById('ufAll').className = 'ufb' + (v==='all' ? ' on-all' : '');
  document.getElementById('ufG').className = 'ufb' + (v==='gaetan' ? ' on-g' : '');
  document.getElementById('ufA').className = 'ufb' + (v==='amandine' ? ' on-a' : '');
  afficher();
}
function setCategory(v){ filtreCat = v; afficher(); }

function bindEvents(){
  document.body.addEventListener('click', function(ev){
    var btn = ev.target.closest('[data-action]');
    if(!btn) return;
    var a = btn.dataset.action;
    var v = btn.dataset.value;
    var id = btn.dataset.id;
    ev.preventDefault();

    switch(a){
      case 'choose-profile': chooseProfile(v); break;
      case 'show-welcome': showWelcome(); break;
      case 'install-app': installerApp(); break;
      case 'enable-notifications': activerNotif(); break;
      case 'set-tab': setTab(v); break;
      case 'set-user-filter': setUserFilter(v); break;
      case 'set-category': setCategory(v); break;
      case 'check-task': checkTask(id); break;
      case 'open-menu': openMenu(id); break;
      case 'close-menu': closeMenu(); break;
      case 'menu-edit':   { var mid = pendingMenuId; closeMenu(); openDrawer(mid); break; }
      case 'menu-undo':   { var mid2 = pendingMenuId; closeMenu(); decrementTask(mid2); break; }
      case 'menu-delete': { var mid3 = pendingMenuId; closeMenu(); askDelete(mid3); break; }
      case 'close-confirm': closeConfirm(); break;
      case 'confirm-delete': if(pendingDeleteId){ deleteTask(pendingDeleteId); closeConfirm(); toast('Tâche supprimée'); } break;
      case 'open-drawer': openDrawer(null); break;
      case 'close-drawer': closeDrawer(); break;
      case 'save-task': saveTask(); break;
      case 'set-cat': draft.cat = v; renderDrawer(); break;
      case 'set-recur':
        draft.tousLesNJours = parseInt(v,10) || 7;
        renderDrawer();
        break;
      case 'set-recur-custom':
        // Bascule en mode custom : on initialise avec une valeur non-preset
        if(PRESETS.some(function(p){ return p.n === draft.tousLesNJours; })){
          draft.tousLesNJours = draft.customN && !PRESETS.some(function(p){ return p.n === draft.customN; })
            ? draft.customN
            : 5;
        }
        renderDrawer();
        setTimeout(function(){ var f=document.getElementById('fCustomN'); if(f) f.focus(); }, 50);
        break;
      case 'set-mode': draft.mode = v; renderDrawer(); break;
      case 'set-start': draft.debut = v; renderDrawer(); break;
      case 'open-settings': openSettings(); break;
      case 'close-settings': closeSettings(); break;
      case 'save-settings': persistSettings(); break;
    }
  });

  // Champ custom : MàJ live de la valeur
  document.body.addEventListener('input', function(ev){
    if(ev.target && ev.target.id === 'fCustomN'){
      var n = parseInt(ev.target.value, 10);
      if(n >= 1 && n <= 365){
        draft.tousLesNJours = n;
        document.getElementById('fqsum').textContent = nJoursLabel(n);
      }
    }
  });

  document.getElementById('drawerBg').addEventListener('click', function(e){
    if(e.target.id === 'drawerBg') closeDrawer();
  });
  document.getElementById('settingsBg').addEventListener('click', function(e){
    if(e.target.id === 'settingsBg') closeSettings();
  });
  document.getElementById('menuOv').addEventListener('click', function(e){
    if(e.target.id === 'menuOv') closeMenu();
  });
  document.getElementById('confirmOv').addEventListener('click', function(e){
    if(e.target.id === 'confirmOv') closeConfirm();
  });
}

// ----- PWA install --------------------------------------------------------
var deferredPrompt = null;
window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('installBtn').classList.remove('is-hidden');
});
function installerApp(){
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(function(){
    deferredPrompt = null;
    document.getElementById('installBtn').classList.add('is-hidden');
  });
}
window.addEventListener('appinstalled', function(){
  document.getElementById('installBtn').classList.add('is-hidden');
});

// ----- Service worker -----------------------------------------------------
if('serviceWorker' in navigator){
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('sw.js').catch(function(err){
      console.warn('SW registration failed', err);
    });
  });
}

// ----- Notif banner -------------------------------------------------------
if(typeof Notification !== 'undefined' && Notification.permission === 'default'){
  document.getElementById('notif').classList.remove('is-hidden');
}

// Indicateur visuel : appliquer le réglage au chargement
(function(){
  var s = getSettings();
  document.body.classList.toggle('no-late-dot', !s.visualAlert);
})();

// ----- Polling + refresh quotidien ----------------------------------------
setInterval(poll, 20000);
// Re-render toutes les minutes pour rafraîchir les chips d'échéance et basculer
// les tâches d'une section à l'autre quand on franchit minuit.
setInterval(afficher, 60000);

// ----- Bootstrap ----------------------------------------------------------
bindEvents();
charger();
