// ============================================================================
// Chez Nous — application de tâches partagées
// Modèle "créneaux par période" : chaque tâche a une fréquence (X fois par
// jour/semaine/quinzaine/3 semaines/mois) et un compteur qui se réinitialise
// automatiquement à chaque nouvelle période.
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

// ----- Tâches par défaut (premier lancement) --------------------------------
var DEF = [
  {titre:'Vider le lave-vaisselle', cat:'cuisine', freq:{per:'daily',nb:1},   mode:'rot', debut:'gaetan'},
  {titre:'Sortir les poubelles',     cat:'menage',  freq:{per:'weekly',nb:1},  mode:'rot', debut:'gaetan'},
  {titre:'Aspirer le sol',           cat:'menage',  freq:{per:'weekly',nb:3},  mode:'rot', debut:'amandine'},
  {titre:'Faire les courses',        cat:'courses', freq:{per:'weekly',nb:1},  mode:'rot', debut:'amandine'},
  {titre:'Faire une lessive',        cat:'linge',   freq:{per:'weekly',nb:2},  mode:'rot', debut:'gaetan'}
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
var localDirty = 0;          // timestamp dernière modif locale
var saving = false;          // PUT en cours ?
var draft = null;            // brouillon du drawer

// ============================================================================
// UTILITAIRES DATE / PÉRIODES (locale, pas UTC)
// ============================================================================

function pad(n){ return n<10 ? '0'+n : ''+n; }

function dateLocal(d){
  d = d || new Date();
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
}

function todayLocal(){ return dateLocal(new Date()); }

// Numéro de semaine ISO (lundi = début)
function isoWeek(d){
  var dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Jeudi de la semaine en cours détermine l'année
  dt.setDate(dt.getDate() + 3 - ((dt.getDay()+6) % 7));
  var week1 = new Date(dt.getFullYear(), 0, 4);
  var diff = (dt - week1) / 86400000;
  var w = 1 + Math.round((diff - 3 + ((week1.getDay()+6) % 7)) / 7);
  return {year: dt.getFullYear(), week: w};
}

// Indice "absolu" de semaine depuis epoch (pour quinzaine / 3 semaines)
function weekIndex(d){
  // Lundi de la semaine de d
  var dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var dow = (dt.getDay()+6) % 7; // 0 = lundi
  dt.setDate(dt.getDate() - dow);
  // Lundi 5 jan 1970 = epoch + 4 jours
  var monday0 = new Date(1970,0,5);
  return Math.floor((dt - monday0) / (7*86400000));
}

function periodKey(per, d){
  d = d || new Date();
  if(per==='daily')   return 'D-' + dateLocal(d);
  if(per==='weekly'){ var w = isoWeek(d); return 'W-' + w.year + '-' + pad(w.week); }
  if(per==='biweekly') return 'B-' + Math.floor(weekIndex(d)/2);
  if(per==='triweekly') return 'T-' + Math.floor(weekIndex(d)/3);
  if(per==='monthly') return 'M-' + d.getFullYear() + '-' + pad(d.getMonth()+1);
  return 'D-' + dateLocal(d);
}

// Date de fin de période courante (Date object, 23:59:59)
function periodEnd(per, d){
  d = d || new Date();
  if(per==='daily'){
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
  }
  if(per==='weekly' || per==='biweekly' || per==='triweekly'){
    // Fin = dimanche de la fin de période
    var dow = (d.getDay()+6) % 7;
    var endOffset;
    if(per==='weekly'){ endOffset = 6 - dow; }
    else if(per==='biweekly'){
      var bw = weekIndex(d) % 2;
      endOffset = (1-bw)*7 + (6 - dow);
    } else {
      var tw = weekIndex(d) % 3;
      endOffset = (2-tw)*7 + (6 - dow);
    }
    var end = new Date(d.getFullYear(), d.getMonth(), d.getDate()+endOffset, 23, 59, 59);
    return end;
  }
  if(per==='monthly'){
    return new Date(d.getFullYear(), d.getMonth()+1, 0, 23, 59, 59);
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
}

// Libellé court "Jusqu'à dim." / "Aujourd'hui" etc.
function periodEndLabel(per){
  var end = periodEnd(per);
  var now = new Date();
  var jours = ['dim.','lun.','mar.','mer.','jeu.','ven.','sam.'];
  var diff = Math.ceil((end - now) / 86400000);
  if(per==='daily') return "aujourd'hui";
  if(per==='monthly'){
    var mois = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
    return 'jusqu\'au ' + end.getDate() + ' ' + mois[end.getMonth()];
  }
  return 'jusqu\'à ' + jours[end.getDay()] + (diff<=1 ? '' : ' (' + diff + 'j)');
}

// Combien de jours restant dans la période (pour avertir)
function daysLeft(per){
  var end = periodEnd(per);
  return Math.ceil((end - new Date()) / 86400000);
}

// ----- Fréquence : libellé humain ------------------------------------------
function freqLabel(f){
  if(!f) return '';
  var nb = f.nb || 1;
  var pl = nb>1 ? ' fois' : ' fois';
  if(f.per==='daily')      return nb + pl + ' par jour';
  if(f.per==='weekly')     return nb + pl + ' par semaine';
  if(f.per==='biweekly')   return nb + pl + ' toutes les 2 semaines';
  if(f.per==='triweekly')  return nb + pl + ' toutes les 3 semaines';
  if(f.per==='monthly')    return nb + pl + ' par mois';
  return '';
}

function freqLabelShort(f){
  if(!f) return '';
  var nb = f.nb || 1;
  if(f.per==='daily')     return nb+'×/jour';
  if(f.per==='weekly')    return nb+'×/sem.';
  if(f.per==='biweekly')  return nb+'×/2sem.';
  if(f.per==='triweekly') return nb+'×/3sem.';
  if(f.per==='monthly')   return nb+'×/mois';
  return '';
}

// ============================================================================
// MIGRATION ANCIEN MODÈLE -> NOUVEAU
// ============================================================================
function migrateTask(t){
  if(t.freq && typeof t.freq === 'object' && t.freq.per) return t; // déjà migré
  // Ancien : freq = "1x_daily", "3x_weekly", "1x_biweekly", "1x_triweekly", "1x_monthly"
  var per = 'weekly'; var nb = 1;
  if(typeof t.freq === 'string'){
    var m = t.freq.match(/^(\d+)x_(.+)$/);
    if(m){ nb = parseInt(m[1],10) || 1; per = m[2]; }
  }
  var qui = t.qui || t.debut || 'gaetan';
  if(qui==='les2') qui = 'gaetan';
  var debut = t.debut || qui;
  if(debut==='les2') debut = 'gaetan';
  // Si la tâche venait d'être cochée dans l'ancien modèle, on conserve cet état
  // dans la période courante (sinon rolloverTasks remettrait doneCount à 0).
  var pk = periodKey(per);
  return {
    id: t.id || ('t_' + Date.now() + '_' + Math.random().toString(36).slice(2,7)),
    titre: t.titre || 'Tâche',
    cat: t.cat || 'menage',
    freq: {per:per, nb:nb},
    mode: t.mode || 'fix',
    qui: qui,
    debut: debut,
    periodKey: pk,
    doneCount: t.fait ? 1 : 0,
    lastDoneAt: t.fait ? new Date().toISOString() : null,
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

// ============================================================================
// ROLLOVER : reset des compteurs en début de période, rotation auto
// ============================================================================
function autre(q){ return q==='gaetan' ? 'amandine' : 'gaetan'; }

function rolloverTasks(){
  taches = taches.map(function(t){
    var pk = periodKey(t.freq.per);
    if(t.periodKey !== pk){
      var newQui = t.mode==='rot' ? (t.qui ? autre(t.qui) : t.debut) : t.qui;
      // Première initialisation : on garde t.debut
      if(!t.periodKey) newQui = t.qui || t.debut;
      return Object.assign({}, t, {
        periodKey: pk,
        doneCount: 0,
        lastDoneAt: null,
        qui: newQui
      });
    }
    return t;
  });
}

// ============================================================================
// FIREBASE I/O
// ============================================================================
function sync(s){
  var dot = document.getElementById('sdot');
  var txt = document.getElementById('stxt');
  if(!dot) return;
  dot.className = 'sdot' + (s ? ' '+s : '');
  txt.textContent = s==='L' ? 'Sync…' : s==='E' ? 'Hors ligne' : 'Sync';
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
      rolloverTasks();
      await sauver();
    } else {
      var m = migrateAll(j);
      taches = m.taches;
      hist = m.hist;
      rolloverTasks();
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

// Polling périodique : ne récupère que si pas de modif locale récente
async function poll(){
  if(saving) return;
  if(Date.now() - localDirty < 15000) return; // 15 s de garde anti-écrasement
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
      rolloverTasks();
      afficher();
    }
    sync('');
  } catch(e){ sync('E'); }
}

// ============================================================================
// AFFICHAGE
// ============================================================================
function afficher(){
  rolloverTasks(); // au cas où on a changé de période depuis le dernier render
  greet();
  banner();
  catPills();
  liste();
  listeHist();
  document.getElementById('tcH').textContent = hist.length>99 ? '99+' : hist.length;
}

function courtU(u){ return u==='gaetan' ? 'Gaetan' : 'Amandine'; }

function greet(){
  var now = new Date();
  var jours = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  var mois = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  document.getElementById('gdate').textContent = jours[now.getDay()]+' '+now.getDate()+' '+mois[now.getMonth()];
  var h = now.getHours();
  var sal = h<6?'Bonne nuit':h<12?'Bonjour':h<18?'Bon après-midi':'Bonsoir';
  // Tâches restant à faire pour moi sur la période en cours
  var p = taches.filter(function(t){ return t.qui===moi && t.doneCount < t.freq.nb; }).length;
  var nom = moi ? courtU(moi) : '';
  var el = document.getElementById('gtxt');
  if(!moi){
    el.textContent = 'Bienvenue chez nous';
  } else if(p===0){
    el.innerHTML = '<em>Bravo '+nom+' !</em> Tout est à jour';
  } else {
    el.innerHTML = sal+' <em>'+nom+'</em> — '+p+' tâche'+(p>1?'s':'')+' pour vous';
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
  for(var ri=0;ri<8;ri++){ var el=document.getElementById('r'+ri); if(el) el.style.transform='rotate('+ri*45+'deg) translateX(-50%)'; }

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

  // Calculs : créneaux totaux, faits, restants par personne
  var totalSlots = 0, doneSlots = 0, restG = 0, restA = 0, lateCount = 0;
  taches.forEach(function(t){
    var nb = t.freq.nb, dc = t.doneCount;
    totalSlots += nb;
    doneSlots += Math.min(dc, nb);
    var rest = Math.max(0, nb - dc);
    if(t.qui==='gaetan') restG += rest; else restA += rest;
    if(rest>0 && daysLeft(t.freq.per) <= 1) lateCount += rest;
  });
  var pct = totalSlots>0 ? Math.round(doneSlots/totalSlots*100) : 0;

  var titre;
  if(totalSlots===0){ titre = 'Pas encore de <em>tâches</em>'; }
  else if(pct===100){ titre = 'Tout est fait ! 🎉'; }
  else if(pct>=75){ titre = 'Presque <em>terminé</em>'; }
  else if(lateCount>0){ titre = lateCount+' tâche'+(lateCount>1?'s':'')+' urgentes'; }
  else if(pct>=50){ titre = 'Bonne <em>progression</em>'; }
  else if(pct>0){ titre = 'En cours…'; }
  else { titre = 'Nouvelle <em>période</em>'; }

  document.getElementById('banTitre').innerHTML = titre;
  document.getElementById('banFill').style.width = pct + '%';
  document.getElementById('banFaites').textContent = doneSlots;
  document.getElementById('banG').textContent = restG;
  document.getElementById('banA').textContent = restA;
}

function catPills(){
  var vis = taches.filter(function(t){ return filtreWho==='all' || t.qui===filtreWho; });
  var cnt = {};
  vis.forEach(function(t){ cnt[t.cat] = (cnt[t.cat]||0)+1; });
  var used = Object.keys(CATS).filter(function(c){ return cnt[c]; });
  var html = '<div class="cp on-all cp'+(filtreCat==='all'?' on':'')+'" data-action="set-category" data-value="all">✦ Tout<span class="cpn">'+vis.length+'</span></div>';
  used.forEach(function(c){
    var info = CATS[c];
    html += '<div class="cp'+(filtreCat===c?' on':'')+'" data-action="set-category" data-value="'+c+'">'+info.e+' '+info.n+'<span class="cpn">'+(cnt[c]||0)+'</span></div>';
  });
  document.getElementById('catRow').innerHTML = html;
}

// ----- Carte tâche ---------------------------------------------------------
function progressRing(done, total, klass){
  var pct = total>0 ? Math.min(1, done/total) : 0;
  var R = 18, C = 2*Math.PI*R;
  var off = C * (1-pct);
  var color = klass==='g' ? '#9E6B45' : '#8FB05A';
  return ''
    + '<svg class="ring" width="46" height="46" viewBox="0 0 46 46">'
    +   '<circle class="ring-bg" cx="23" cy="23" r="'+R+'" fill="none" stroke-width="4"/>'
    +   '<circle class="ring-fill" cx="23" cy="23" r="'+R+'" fill="none" stroke="'+color+'" stroke-width="4" stroke-linecap="round" stroke-dasharray="'+C.toFixed(2)+'" stroke-dashoffset="'+off.toFixed(2)+'"/>'
    + '</svg>';
}

function carteHtml(t){
  var qcls = t.qui==='gaetan' ? 'g' : 'a';
  var full = t.doneCount >= t.freq.nb;
  var dleft = daysLeft(t.freq.per);
  var rest = Math.max(0, t.freq.nb - t.doneCount);
  var warn = !full && rest>0 && dleft<=1;
  var late = !full && rest>0 && dleft<0;

  var classes = 'tc-card '+qcls;
  if(full) classes += ' full';
  else if(late) classes += ' late';
  else if(warn) classes += ' warn';

  var info = CATS[t.cat] || {n:'',e:'•'};
  var nbLabel = t.doneCount + '/' + t.freq.nb;

  // Chip d'échéance
  var chipDeadline;
  if(full){
    chipDeadline = '<span class="chip chip-ok">✓ Terminé</span>';
  } else if(late){
    chipDeadline = '<span class="chip chip-late">⚠ Période finie</span>';
  } else if(dleft<=1){
    chipDeadline = '<span class="chip chip-warn">⏰ '+periodEndLabel(t.freq.per)+'</span>';
  } else {
    chipDeadline = '<span class="chip chip-freq">📅 '+periodEndLabel(t.freq.per)+'</span>';
  }

  return '<div class="'+classes+'" data-action="check-task" data-id="'+t.id+'">'
    + '<div class="tc-strip"></div>'
    + '<div class="tc-inner">'
    +   '<button class="tc-check" data-action="check-task" data-id="'+t.id+'" aria-label="Cocher">'
    +     progressRing(t.doneCount, t.freq.nb, qcls)
    +     '<span class="ring-num">'+nbLabel+'</span>'
    +   '</button>'
    +   '<div class="tc-body">'
    +     '<div class="tc-title">'+escapeHtml(t.titre)+'</div>'
    +     '<div class="chips">'
    +       '<span class="chip chip-'+qcls+'">'+(qcls==='g'?'🤎':'💚')+' '+courtU(t.qui)+'</span>'
    +       '<span class="chip chip-cat">'+info.e+' '+info.n+'</span>'
    +       '<span class="chip chip-freq">🔁 '+freqLabelShort(t.freq)+'</span>'
    +       chipDeadline
    +     '</div>'
    +   '</div>'
    +   '<div class="tc-actions">'
    +     '<button class="menu-btn" data-action="open-menu" data-id="'+t.id+'" aria-label="Menu">⋯</button>'
    +   '</div>'
    + '</div>'
  + '</div>';
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
  var actives = vis.filter(function(t){ return t.doneCount < t.freq.nb; });
  var dones   = vis.filter(function(t){ return t.doneCount >= t.freq.nb; });

  // Tri actives : urgence (jours restants asc) puis titre
  actives.sort(function(a,b){
    var da = daysLeft(a.freq.per), db = daysLeft(b.freq.per);
    if(da !== db) return da - db;
    return a.titre.localeCompare(b.titre, 'fr');
  });
  dones.sort(function(a,b){ return (b.lastDoneAt||'').localeCompare(a.lastDoneAt||''); });

  document.getElementById('tcT').textContent = actives.length;
  document.getElementById('cntActive').textContent = actives.length;
  document.getElementById('cntDone').textContent = dones.length;

  var listA = document.getElementById('listActive');
  if(actives.length===0){
    var emptyMsg = vis.length===0
      ? '<div class="empty"><div class="empty-icon">✨</div><div class="empty-title">Rien ici</div><div class="empty-sub">Touchez le bouton + en bas à droite pour ajouter une tâche.</div></div>'
      : '<div class="empty"><div class="empty-icon">🎉</div><div class="empty-title">Tout est fait !</div><div class="empty-sub">Belle équipe. Profitez de votre temps libre.</div></div>';
    listA.innerHTML = emptyMsg;
  } else {
    listA.innerHTML = actives.map(carteHtml).join('');
  }

  var sd = document.getElementById('secDone');
  if(dones.length===0){
    sd.classList.add('is-hidden');
  } else {
    sd.classList.remove('is-hidden');
    document.getElementById('listDone').innerHTML = dones.map(carteHtml).join('');
  }
}

// ----- Historique ---------------------------------------------------------
function listeHist(){
  var el = document.getElementById('listHist');
  if(hist.length===0){
    el.innerHTML = '<div class="empty"><div class="empty-icon">📜</div><div class="empty-title">Pas d\'historique</div><div class="empty-sub">Vos tâches terminées apparaîtront ici.</div></div>';
    return;
  }
  // Trier par date desc et grouper par jour
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
    if(k===today) label = "Aujourd'hui";
    html += '<div class="h-day"><div class="h-day-hd">'+label+'</div>';
    groups[k].forEach(function(h){
      var qcls = h.qui==='gaetan' ? 'g' : 'a';
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
  if(t.doneCount >= t.freq.nb){
    toast("Déjà terminée pour cette période");
    return;
  }
  t.doneCount += 1;
  t.lastDoneAt = new Date().toISOString();
  hist.unshift({
    id: 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    titre: t.titre, qui: t.qui, cat: t.cat,
    at: new Date().toISOString(),
    taskId: t.id
  });
  if(hist.length > 500) hist = hist.slice(0, 500);
  localDirty = Date.now();
  if(t.doneCount >= t.freq.nb){
    confetti(t.qui);
    toast(t.titre + ' — terminé !');
  }
  afficher();
  sauver();
}

function decrementTask(id){
  var t = findTask(id);
  if(!t || t.doneCount<=0){ toast("Rien à annuler"); return; }
  t.doneCount -= 1;
  // Retirer la dernière entrée d'historique correspondant à cette tâche
  for(var i=0;i<hist.length;i++){
    if(hist[i].taskId === id){ hist.splice(i,1); break; }
  }
  t.lastDoneAt = null;
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

// ----- Drawer (ajout / édition) -------------------------------------------
function defaultDraft(){
  return {
    id: null,
    titre: '',
    cat: 'menage',
    freq: {per:'weekly', nb:1},
    mode: 'rot',
    debut: 'gaetan'
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
      freq: {per: t.freq.per, nb: t.freq.nb},
      mode: t.mode,
      debut: t.debut || t.qui
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
    eg += '<button class="ebtn'+(draft.cat===c?' on':'')+'" data-action="set-cat" data-value="'+c+'"><span class="ei">'+info.e+'</span>'+info.n+'</button>';
  });
  document.getElementById('egrid').innerHTML = eg;

  // Période
  var pers = [
    {k:'daily',     l:'Chaque jour'},
    {k:'weekly',    l:'Chaque semaine'},
    {k:'biweekly',  l:'2 semaines'},
    {k:'triweekly', l:'3 semaines'},
    {k:'monthly',   l:'Chaque mois'}
  ];
  var fr = '';
  pers.forEach(function(p){
    fr += '<button class="fqbtn'+(draft.freq.per===p.k?' on':'')+'" data-action="set-per" data-value="'+p.k+'">'+p.l+'</button>';
  });
  document.getElementById('fqrow').innerHTML = fr;

  // Nb
  var maxNb = draft.freq.per==='daily' ? 6 : draft.freq.per==='monthly' ? 10 : 7;
  var fc = '';
  for(var i=1;i<=maxNb;i++){
    fc += '<button class="fqcbtn'+(draft.freq.nb===i?' on':'')+'" data-action="set-nb" data-value="'+i+'">'+i+'</button>';
  }
  document.getElementById('fqcbtns').innerHTML = fc;
  document.getElementById('fqsum').textContent = freqLabel(draft.freq);

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

  if(editingId){
    var t = findTask(editingId);
    if(t){
      var oldQui = t.qui;
      t.titre = draft.titre;
      t.cat = draft.cat;
      t.freq = draft.freq;
      t.mode = draft.mode;
      t.debut = draft.debut;
      // Si on change la personne assignée et mode fix : appliquer
      if(t.mode==='fix') t.qui = draft.debut;
      // Reset périodKey pour forcer un recalcul (au cas où la période a changé)
      var pk = periodKey(t.freq.per);
      if(t.periodKey !== pk){
        t.periodKey = pk; t.doneCount = 0; t.lastDoneAt = null;
      }
      // Plafonner doneCount si on a baissé nb
      if(t.doneCount > t.freq.nb) t.doneCount = t.freq.nb;
    }
  } else {
    var nt = {
      id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      titre: draft.titre,
      cat: draft.cat,
      freq: draft.freq,
      mode: draft.mode,
      debut: draft.debut,
      qui: draft.debut,
      periodKey: periodKey(draft.freq.per),
      doneCount: 0,
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

// ----- Menu contextuel ---------------------------------------------------
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

// ----- Toast & confettis -------------------------------------------------
var toastTimer = null;
function toast(msg){
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 2200);
}

function confetti(qui){
  var colors = qui==='gaetan'
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
      morning:    s.morning    !== false,
      morningTime:s.morningTime || '09:00',
      deadline:   s.deadline   !== false
    };
  } catch(e){ return {morning:true, morningTime:'09:00', deadline:true}; }
}

function saveSettings(s){
  localStorage.setItem('chez_nous_settings', JSON.stringify(s));
}

var notifTimers = [];
function clearNotifTimers(){
  notifTimers.forEach(function(t){ clearTimeout(t); });
  notifTimers = [];
}

function scheduleNotifications(){
  clearNotifTimers();
  if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  var s = getSettings();

  // Rappel du matin
  if(s.morning){
    var mt = (s.morningTime || '09:00').split(':');
    var hh = parseInt(mt[0],10)||9, mm = parseInt(mt[1],10)||0;
    var next = new Date();
    next.setHours(hh, mm, 0, 0);
    if(next <= new Date()) next.setDate(next.getDate()+1);
    var ms = next - new Date();
    notifTimers.push(setTimeout(function(){
      var rest = taches.filter(function(t){ return t.qui===moi && t.doneCount < t.freq.nb; });
      if(rest.length > 0){
        showNotif('Bonjour ' + courtU(moi||'gaetan'),
                  rest.length + ' tâche'+(rest.length>1?'s':'')+' vous attend'+(rest.length>1?'ent':'')+' aujourd\'hui');
      }
      scheduleNotifications();
    }, Math.min(ms, 2147483000)));
  }

  // Rappel de fin de période — chaque tâche dont la période finit aujourd'hui
  if(s.deadline){
    var deadline = new Date();
    deadline.setHours(18,0,0,0);
    if(deadline > new Date()){
      notifTimers.push(setTimeout(function(){
        var urgents = taches.filter(function(t){
          return t.qui===moi && t.doneCount < t.freq.nb && daysLeft(t.freq.per) <= 0;
        });
        if(urgents.length>0){
          showNotif('⏰ Fin de période',
                    urgents.length + ' tâche'+(urgents.length>1?'s':'')+' à terminer avant ce soir');
        }
        scheduleNotifications();
      }, deadline - new Date()));
    }
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
      toast('Rappels désactivés (vous pouvez les réactiver dans ⚙️ Réglages)');
    }
  });
}

// ----- Settings UI --------------------------------------------------------
function openSettings(){
  var s = getSettings();
  document.getElementById('setMorning').checked = s.morning;
  document.getElementById('setMorningTime').value = s.morningTime;
  document.getElementById('setDeadline').checked = s.deadline;
  document.getElementById('settingsBg').style.display = 'flex';
}
function closeSettings(){ document.getElementById('settingsBg').style.display = 'none'; }
function persistSettings(){
  var s = {
    morning: document.getElementById('setMorning').checked,
    morningTime: document.getElementById('setMorningTime').value || '09:00',
    deadline: document.getElementById('setDeadline').checked
  };
  saveSettings(s);
  if(typeof Notification !== 'undefined' && Notification.permission !== 'granted'){
    Notification.requestPermission().then(function(p){
      if(p==='granted') scheduleNotifications();
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
}
function showWelcome(){
  document.getElementById('welcome').style.display = 'flex';
}
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

    switch(a){
      case 'choose-profile': chooseProfile(v); break;
      case 'show-welcome': showWelcome(); break;
      case 'install-app': installerApp(); break;
      case 'enable-notifications': activerNotif(); break;
      case 'set-tab': setTab(v); break;
      case 'set-user-filter': setUserFilter(v); break;
      case 'set-category': setCategory(v); break;
      case 'check-task':
        // Évite de déclencher 2x (clic sur card + clic sur bouton interne)
        ev.stopPropagation();
        checkTask(id || btn.closest('.tc-card').dataset.id);
        break;
      case 'open-menu':
        ev.stopPropagation();
        openMenu(id);
        break;
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
      case 'set-per':
        draft.freq.per = v;
        var maxNb = v==='daily'?6:v==='monthly'?10:7;
        if(draft.freq.nb > maxNb) draft.freq.nb = maxNb;
        renderDrawer(); break;
      case 'set-nb': draft.freq.nb = parseInt(v,10) || 1; renderDrawer(); break;
      case 'set-mode': draft.mode = v; renderDrawer(); break;
      case 'set-start': draft.debut = v; renderDrawer(); break;
      case 'open-settings': openSettings(); break;
      case 'close-settings': closeSettings(); break;
      case 'save-settings': persistSettings(); break;
    }
  });

  // Fermer overlays en cliquant en dehors
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

// ----- Notifications banner -----------------------------------------------
// On n'affiche la bannière que si le navigateur supporte ET que l'utilisateur
// n'a pas encore choisi (state 'default'). Sur 'denied' ou 'granted' on cache.
if(typeof Notification !== 'undefined' && Notification.permission === 'default'){
  document.getElementById('notif').classList.remove('is-hidden');
}

// ----- Polling + rollover horaire -----------------------------------------
setInterval(poll, 20000);
// Rollover toutes les 5 minutes au cas où la période change pendant que l'app est ouverte
setInterval(function(){
  var changed = taches.some(function(t){ return t.periodKey !== periodKey(t.freq.per); });
  if(changed){ rolloverTasks(); afficher(); }
}, 5*60*1000);

// ----- Bootstrap ----------------------------------------------------------
bindEvents();
charger();
