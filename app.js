
const SEED_INV=[];
const SEED_REFS=[];

// On conserve volontairement les clés V2 : une personne qui met à jour
// l'application garde ses prix / ajouts / sorties déjà enregistrés.
const KI='ma-cave-configurable-v1-inv',
      KR='ma-cave-configurable-v1-refs',
      KC='ma-cave-configurable-v1-consumed',
      KCFG='ma-cave-configurable-v1-config';

const DEFAULT_CONFIG={casiers:3,lignes:15,positions:5};

let config=load(KCFG,null);
let inv=load(KI,SEED_INV);
let refs=load(KR,SEED_REFS);
let consumed=load(KC,[]);
if(!Array.isArray(consumed)) consumed=[];
consumed.forEach(e=>{
  if(!['good','bad','neutral'].includes(e.rating)) e.rating='neutral';
});
let activeCasier=1;
let selected=null;
let pendingAddRefId='';
let editScope=null; // 'single' | 'all' | 'new'
let selectedEmptyKeys=new Set();
let addTargets=[];
let emptyTapTimers=new Map();
let voiceRecognition=null;
let voiceExactRefId='';
let voiceSimilarRefId='';
let dialogHistory=false;

config=normalizeConfig(config);
if(config){
  inv=buildInventory(config,inv);
}

const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
const ref=id=>refs.find(r=>r.id===id);

function load(key,seed){
  try{
    const x=JSON.parse(localStorage.getItem(key)||'null');
    if(!x) return structuredClone(seed);
    return x;
  }catch(e){ return structuredClone(seed); }
}

function normalizeConfig(raw){
  if(!raw) return null;
  const c={
    casiers:Number(raw.casiers),
    lignes:Number(raw.lignes),
    positions:Number(raw.positions)
  };
  if(
    !Number.isInteger(c.casiers) || c.casiers<1 || c.casiers>20 ||
    !Number.isInteger(c.lignes) || c.lignes<1 || c.lignes>50 ||
    !Number.isInteger(c.positions) || c.positions<1 || c.positions>12
  ) return null;
  return c;
}

function positionKey(c,l,p){
  return `${c}-${l}-${p}`;
}

function buildInventory(cfg,oldInv=[]){
  const oldMap=new Map(
    (Array.isArray(oldInv)?oldInv:[]).map(x=>[
      positionKey(Number(x.casier),Number(x.ligne),Number(x.position)),
      x
    ])
  );

  const fresh=[];
  for(let c=1;c<=cfg.casiers;c++){
    for(let l=1;l<=cfg.lignes;l++){
      for(let p=1;p<=cfg.positions;p++){
        const old=oldMap.get(positionKey(c,l,p));
        fresh.push({
          casier:c,
          ligne:l,
          position:p,
          emplacement:`C${c}-L${l}-P${p}`,
          refId:old?.refId||null
        });
      }
    }
  }
  return fresh;
}

function configCapacity(cfg){
  return cfg.casiers*cfg.lignes*cfg.positions;
}

function readConfigForm(){
  return normalizeConfig({
    casiers:Number($('#cfgCasiers').value),
    lignes:Number($('#cfgLignes').value),
    positions:Number($('#cfgPositions').value)
  });
}

function updateConfigCapacityPreview(){
  const c=readConfigForm();
  $('#configCapacity').textContent=c
    ? `${c.casiers} casier${c.casiers>1?'s':''} × ${c.lignes} ligne${c.lignes>1?'s':''} × ${c.positions} bouteille${c.positions>1?'s':''} = ${configCapacity(c)} emplacements`
    : 'Valeurs autorisées : 1–20 casiers, 1–50 lignes, 1–12 bouteilles par ligne.';
}

function openConfigDialog(firstRun=false){
  const c=config||DEFAULT_CONFIG;
  $('#configTitle').textContent=firstRun ? 'Configurer ma cave' : '⚙️ Configuration de la cave';
  $('#cfgCasiers').value=c.casiers;
  $('#cfgLignes').value=c.lignes;
  $('#cfgPositions').value=c.positions;
  $('#configError').hidden=true;
  $('#configError').innerHTML='';
  $('#configCancel').hidden=firstRun;
  updateConfigCapacityPreview();

  if(firstRun){
    $('#configDialog').showModal();
  }else{
    showDialog($('#configDialog'));
  }
}

function applyConfiguration(){
  const next=readConfigForm();
  if(!next){
    $('#configError').hidden=false;
    $('#configError').textContent='Vérifie les trois nombres indiqués.';
    return;
  }

  if(config){
    const blocked=inv.filter(x=>
      x.refId && (
        x.casier>next.casiers ||
        x.ligne>next.lignes ||
        x.position>next.positions
      )
    );

    if(blocked.length){
      const shown=blocked.slice(0,8).map(x=>x.emplacement).join(' · ');
      $('#configError').hidden=false;
      $('#configError').innerHTML=
        `<b>Réduction impossible.</b><br>
         ${blocked.length} bouteille${blocked.length>1?'s seraient':' serait'} supprimée${blocked.length>1?'s':''} de la structure.<br>
         Déplace d’abord : ${esc(shown)}${blocked.length>8?'…':''}`;
      return;
    }
  }

  const oldCapacity=config ? configCapacity(config) : 0;
  config=next;
  inv=buildInventory(config,inv);
  activeCasier=Math.min(Math.max(1,activeCasier),config.casiers);
  clearEmptySelection();
  addTargets=[];
  pendingAddRefId='';
  editScope=null;
  persist();
  render();
  refreshPhotoButtons();

  const newCapacity=configCapacity(config);
  const message=oldCapacity
    ? `Configuration enregistrée : ${newCapacity} emplacements.`
    : `Cave créée : ${newCapacity} emplacements.`;

  if($('#configDialog').open){
    if(dialogHistory) requestClose($('#configDialog'));
    else $('#configDialog').close();
  }
  setTimeout(()=>alert(message),80);
}

function deriveConfigFromInventory(data){
  if(!Array.isArray(data) || !data.length) return null;
  const c=Math.max(...data.map(x=>Number(x.casier)||0));
  const l=Math.max(...data.map(x=>Number(x.ligne)||0));
  const p=Math.max(...data.map(x=>Number(x.position)||0));
  return normalizeConfig({casiers:c,lignes:l,positions:p});
}

// Migration douce V2 -> V3
refs.forEach(r=>{
  if(r.maturiteDebut===undefined) r.maturiteDebut='';
  if(r.maturiteFin===undefined) r.maturiteFin='';
});


function persist(){
  if(config) localStorage.setItem(KCFG,JSON.stringify(config));
  localStorage.setItem(KI,JSON.stringify(inv));
  localStorage.setItem(KR,JSON.stringify(refs));
  localStorage.setItem(KC,JSON.stringify(consumed));
}
function save(){ persist(); render(); }

function esc(s){
  return String(s??'').replace(/[&<>"']/g,m=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}
function euro(v){
  return Number(v||0).toLocaleString('fr-FR',{style:'currency',currency:'EUR'});
}
function wineClass(c){
  c=normalizeSearchText ? normalizeSearchText(c||'') : String(c||'').toLowerCase();
  if(c.includes('blanc')) return 'white';
  if(c.includes('rose')) return 'rose';
  if(
    c.includes('efferv') ||
    c.includes('petill') ||
    c.includes('mousseux') ||
    c.includes('champagne') ||
    c.includes('cremant') ||
    c.includes('spark')
  ) return 'spark';
  return 'red';
}
function currentDecimalYear(){
  const d=new Date(), y=d.getFullYear();
  const start=new Date(y,0,1), end=new Date(y+1,0,1);
  return y + (d-start)/(end-start);
}

const AGE_COLORS = [
  '#1F5F2E',
  '#3E7A36',
  '#7E9836',
  '#C9A936',
  '#D98632',
  '#C65B3A',
  '#B33A3A',
  '#8D2D42',
  '#74263A',
  '#5F2132',
  '#4D1C29',
  '#3E1721'
];

function wineAge(y){
  const year=Number(y);
  if(!year || !Number.isFinite(year)) return null;
  return Math.max(0,new Date().getFullYear()-year);
}

function couleurPourAge(y){
  const age=wineAge(y);
  if(age===null) return '#777777';

  if(age < AGE_COLORS.length) return AGE_COLORS[age];

  const extra=Math.min(20,age-(AGE_COLORS.length-1));
  const light=Math.max(6,16-extra*0.45);
  return `hsl(340 43% ${light}%)`;
}

function ageClass(y){
  const age=wineAge(y);
  if(age===null) return 'ageUnknown';
  return `age${Math.min(31,age)}`;
}


function maturityInfo(r){
  const s=Number(r?.maturiteDebut);
  const e=Number(r?.maturiteFin);
  const now=currentDecimalYear();

  if(!s && !e){
    return {known:false,zone:0,label:'Maturité non renseignée',cursor:0};
  }

  // Les données de la cave sont saisies à l'année près.
  // Une année de fin est donc INCLUSIVE :
  // ex. fin 2027 = surmaturité seulement à partir du 01/01/2028.
  const start=s || Number(r?.millesime) || Math.floor(now);
  const end=e || start;
  const endExclusive=end+1;

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  // 1. JEUNE : avant l'année de début de maturité.
  // Le curseur reste exclusivement dans le quart vert (0–25 %).
  if(now < start){
    const vintage=Number(r?.millesime);
    const youngStart=(vintage && vintage<start) ? vintage : start-1;
    const progress=clamp((now-youngStart)/Math.max(1,start-youngStart),0,1);
    const cursor=2 + progress*21; // 2–23 %
    return {
      known:true,
      zone:1,
      label:`Jeune · maturité à partir de ${start}`,
      cursor
    };
  }

  // 2. À BOIRE : de l'année de début jusqu'à l'année PRÉCÉDANT
  // la dernière année de maturité.
  // Le curseur reste exclusivement dans le quart jaune (25–50 %).
  if(now < end){
    const progress=clamp((now-start)/Math.max(1,end-start),0,1);
    const cursor=27 + progress*21; // 27–48 %
    return {
      known:true,
      zone:2,
      label:`À boire · ${start}–${end}`,
      cursor
    };
  }

  // 3. FIN DE MATURITÉ : toute la dernière année indiquée.
  // Ex. maturiteFin=2027 => du 01/01/2027 au 31/12/2027.
  // Le curseur reste exclusivement dans le quart orange (50–75 %).
  if(now < endExclusive){
    const progress=clamp(now-end,0,1);
    const cursor=52 + progress*21; // 52–73 %
    return {
      known:true,
      zone:3,
      label:`Fin de maturité · dernière année ${end}`,
      cursor
    };
  }

  // 4. SURMATURITÉ : uniquement APRÈS la fin complète de l'année limite.
  // Le curseur reste exclusivement dans le quart rouge (75–100 %).
  const yearsOver=now-endExclusive;
  const progress=clamp(yearsOver/3,0,1);
  const cursor=77 + progress*21; // 77–98 %
  return {
    known:true,
    zone:4,
    label:`Surmaturité · depuis ${end+1}`,
    cursor
  };
}
function allOccupied(){
  return inv.filter(x=>x.refId && ref(x.refId));
}
function statsData(){
  const occ=allOccupied();
  const byCasier={};
  const byYear={};
  const valueCasier={};

  for(let c=1;c<=(config?.casiers||0);c++){
    byCasier[c]=0;
    valueCasier[c]=0;
  }

  occ.forEach(x=>{
    const r=ref(x.refId);
    byCasier[x.casier]=(byCasier[x.casier]||0)+1;
    valueCasier[x.casier]=(valueCasier[x.casier]||0)+(Number(r?.prix)||0);
    const y=String(r?.millesime||'Sans année');
    byYear[y]=(byYear[y]||0)+1;
  });
  return {occ,byCasier,byYear,valueCasier};
}

function renderCasierTabs(s){
  const tabs=$('#casierTabs');
  if(!tabs || !config) return;

  tabs.innerHTML=Array.from({length:config.casiers},(_,i)=>{
    const c=i+1;
    return `<button class="tab ${c===activeCasier?'active':''}" data-c="${c}">
      <b>Casier ${c}</b><small>${s.byCasier[c]||0} bt</small>
    </button>`;
  }).join('');
}

function renderStats(){
  const s=statsData();
  $('#count').textContent=s.occ.length;
  $('#free').textContent=inv.length-s.occ.length;
  renderCasierTabs(s);

  const maturityCounts={0:0,1:0,2:0,3:0,4:0};
  s.occ.forEach(x=>{
    const r=ref(x.refId);
    const mi=maturityInfo(r);
    const z=mi.known ? mi.zone : 0;
    if(maturityCounts[z]!==undefined){
      maturityCounts[z]++;
    }
  });
  [1,2,3,4,0].forEach(z=>{
    const el=$('#matCount'+z);
    if(el) el.textContent=`${maturityCounts[z]} bt`;
  });

  const years=Object.entries(s.byYear).sort((a,b)=>{
    if(a[0]==='Sans année') return 1;
    if(b[0]==='Sans année') return -1;
    return Number(b[0])-Number(a[0]);
  });
  $('#yearStats').innerHTML=years.map(([y,n])=>{
    const ac=ageClass(y==='Sans année'?'':y);
    return `<button type="button" class="year-chip" data-year="${esc(y)}">
      <span class="year-chip-fill age-color ${ac}">
        <b>${esc(y)}</b><small>${n} bt</small>
      </span>
    </button>`;
  }).join('');
  $$('#yearStats .year-chip').forEach(btn=>btn.addEventListener('click',()=>showVintageResults(btn.dataset.year)));

  $('#valueByCasier').innerHTML=Array.from({length:config.casiers},(_,i)=>{
    const c=i+1;
    return `<div><span>Casier ${c}</span><b>${euro(s.valueCasier[c]||0)}</b></div>`;
  }).join('');

  $('#valueTotal').textContent=euro(
    s.occ.reduce((sum,x)=>sum+(Number(ref(x.refId)?.prix)||0),0)
  );
}


function maturityGaugeHtml(r){
  if(!r) return '';
  const mi=maturityInfo(r);
  if(!mi.known) return '';
  return `
    <span class="maturity-gauge" title="${esc(mi.label)}" aria-label="${esc(mi.label)}">
      <i class="z1"></i>
      <i class="z2"></i>
      <i class="z3"></i>
      <i class="z4"></i>
      <b class="maturity-cursor ${mi.known?'':'unknown-cursor'}" style="left:${mi.known?Math.max(0,Math.min(100,mi.cursor)):0}%"></b>
    </span>`;
}

function refsWithLocations(filterFn){
  const out=[];
  inv.forEach(p=>{
    if(!p.refId) return;
    const r=ref(p.refId);
    if(r && filterFn(r,p)) out.push({r,p});
  });
  return out.sort((a,b)=>
    a.p.casier-b.p.casier ||
    a.p.ligne-b.p.ligne ||
    a.p.position-b.p.position
  );
}
function showResultPanel(title,items){
  const panel=$('#resultPanel'),list=$('#resultList');
  $('#resultTitle').textContent=title; list.innerHTML='';
  if(!items.length) list.innerHTML='<div class="muted">Aucune bouteille trouvée.</div>';
  items.forEach(({r,p})=>{
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='result-item';
    const wc=wineClass(r.couleur);
    const ac=ageClass(r.millesime);
    const isMagnum=/magnum|150\s*cl|1[.,]5\s*l/i.test(String(r.format||''));
    btn.innerHTML=`
      <span class="result-year-zone age-color ${ac}">${esc(r.millesime||'Sans année')}</span>
      <span class="result-main wine-color ${wc}">
        <b>${esc(r.vin)}${isMagnum?' · Magnum':''}</b>
        ${r.domaine?`<span class="result-domain">${esc(r.domaine)}</span>`:''}
        <small>${r._searchLocations?esc(r._searchLocations):`Casier ${p.casier} · Ligne ${p.ligne} · Position ${p.position}`}</small>
        <span class="result-gauge">${maturityGaugeHtml(r)}</span>
      </span>
    `;
    btn.addEventListener('click',()=>{
      activeCasier=p.casier; render(); refreshPhotoButtons();
      const target=[...document.querySelectorAll('#grid .slot')].find(el=>el.dataset.line==p.ligne&&el.dataset.pos==p.position);
      if(target){ target.scrollIntoView({behavior:'smooth',block:'center'}); setTimeout(()=>target.click(),250); }
    });
    list.appendChild(btn);
  });
  panel.hidden=false;
}
function hideResultPanel(){ $('#resultPanel').hidden=true; $('#resultList').innerHTML=''; }
function normalizeSearchText(value){
  return String(value||'')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase();
}
function groupedResultItems(matches){
  const grouped=new Map();

  matches.forEach(({r,p})=>{
    const key=r.id || [
      r.vin||'',
      r.domaine||r.producteur||'',
      r.appellation||'',
      r.millesime||'',
      r.format||''
    ].join('|');

    if(!grouped.has(key)){
      grouped.set(key,{r,positions:[]});
    }
    grouped.get(key).positions.push(p);
  });

  const items=[];

  grouped.forEach(({r,positions})=>{
    positions.sort((a,b)=>
      a.casier-b.casier ||
      a.ligne-b.ligne ||
      a.position-b.position
    );

    const first=positions[0];
    const locations=positions
      .map(p=>`C${p.casier}-L${p.ligne}-P${p.position}`)
      .join(' · ');

    items.push({
      r:{
        ...r,
        vin:`${r.vin} ×${positions.length}`,
        _searchLocations:locations
      },
      p:first
    });
  });

  return items;
}

function clearYearFilter(){
  $$('#yearStats .year-chip').forEach(b=>b.classList.remove('active'));
}

function clearMaturityFilter(){
  $$('.maturity-filter').forEach(b=>b.classList.remove('active'));
}

function showMaturityResults(zone){
  zone=Number(zone);
  $('#search').value='';
  clearYearFilter();
  clearMaturityFilter();

  const active=$$('.maturity-filter').find(b=>Number(b.dataset.zone)===zone);
  if(active) active.classList.add('active');

  const labels={
    0:'Non renseigné',
    1:'Jeune',
    2:'À boire',
    3:'Fin maturité',
    4:'Surmaturité'
  };

  const matches=refsWithLocations(r=>{
    const mi=maturityInfo(r);
    if(zone===0) return !mi.known;
    return mi.known && mi.zone===zone;
  });

  const items=groupedResultItems(matches);

  showResultPanel(
    `${labels[zone]} · ${items.length} vin${items.length>1?'s':''} · ${matches.length} bouteille${matches.length>1?'s':''}`,
    items
  );

  $('#resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function showSearchResults(){
  clearMaturityFilter();
  clearYearFilter();
  const raw=$('#search').value.trim();
  const q=normalizeSearchText(raw);
  if(!q){hideResultPanel();return;}

  const matches=refsWithLocations((r,p)=>{
    const hay=[
      r.vin,r.domaine,r.producteur,r.appellation,r.millesime,
      r.couleur,r.format,p.emplacement,
      `casier ${p.casier}`,`ligne ${p.ligne}`,`position ${p.position}`
    ].join(' ');
    return normalizeSearchText(hay).includes(q);
  });

  const items=groupedResultItems(matches);

  showResultPanel(
    `${items.length} vin${items.length>1?'s':''} · ${matches.length} bouteille${matches.length>1?'s':''} dans ${config.casiers} casier${config.casiers>1?'s':''} pour « ${raw} »`,
    items
  );
}
function showVintageResults(year){
  clearMaturityFilter();
  clearYearFilter();
  $('#search').value='';
  const y=String(year);

  const activeYear=$$('#yearStats .year-chip').find(b=>String(b.dataset.year)===y);
  if(activeYear) activeYear.classList.add('active');
  const matches=refsWithLocations(r=>String(r.millesime||'Sans année')===y);

  const items=groupedResultItems(matches);

  showResultPanel(
    `${y} · ${items.length} vin${items.length>1?'s':''} · ${matches.length} bouteille${matches.length>1?'s':''}`,
    items
  );
  $('#resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}


function consumedSnapshot(x,r){
  return {
    id:`c${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    drunkAt:new Date().toISOString(),
    refId:r.id||'',
    vin:r.vin||'',
    domaine:r.domaine||'',
    millesime:r.millesime||'',
    couleur:r.couleur||'',
    format:r.format||'',
    prix:Number(r.prix)||0,
    maturiteDebut:r.maturiteDebut||'',
    maturiteFin:r.maturiteFin||'',
    emplacement:x.emplacement||`C${x.casier}-L${x.ligne}-P${x.position}`,
    casier:Number(x.casier)||0,
    ligne:Number(x.ligne)||0,
    position:Number(x.position)||0,
    rating:'neutral'
  };
}

function localMonthValue(d=new Date()){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  return `${y}-${m}`;
}

function consumptionRange(){
  const mode=$('#consumptionPeriod')?.value||'current';
  const now=new Date();
  let start=null,end=null;

  if(mode==='all') return {start:null,end:null};

  if(mode==='custom'){
    const from=$('#consumptionFrom').value;
    const to=$('#consumptionTo').value;
    if(!from || !to) return {start:null,end:null,invalid:true};

    let [fy,fm]=from.split('-').map(Number);
    let [ty,tm]=to.split('-').map(Number);
    let a=new Date(fy,fm-1,1);
    let b=new Date(ty,tm,1);

    if(a>b){
      const tmp=a;
      a=new Date(ty,tm-1,1);
      b=new Date(fy,fm,1);
    }
    return {start:a,end:b};
  }

  const firstThisMonth=new Date(now.getFullYear(),now.getMonth(),1);
  const firstNextMonth=new Date(now.getFullYear(),now.getMonth()+1,1);

  if(mode==='current'){
    start=firstThisMonth;
    end=firstNextMonth;
  }else if(mode==='previous'){
    start=new Date(now.getFullYear(),now.getMonth()-1,1);
    end=firstThisMonth;
  }else{
    const months=Math.max(1,Number(mode)||1);
    start=new Date(now.getFullYear(),now.getMonth()-(months-1),1);
    end=firstNextMonth;
  }
  return {start,end};
}

function filteredConsumed(){
  const range=consumptionRange();
  if(range.invalid) return [];
  return consumed.filter(item=>{
    const d=new Date(item.drunkAt);
    if(Number.isNaN(d.getTime())) return false;
    if(range.start && d<range.start) return false;
    if(range.end && d>=range.end) return false;
    return true;
  }).sort((a,b)=>new Date(b.drunkAt)-new Date(a.drunkAt));
}

function consumedGroupKey(e){
  return [
    e.refId||'',
    e.vin||'',
    e.domaine||'',
    e.millesime||'',
    e.format||'',
    e.couleur||''
  ].join('|');
}

function ratingIcon(rating){
  if(rating==='good') return '<span class="rating-icon" title="Très bon">👍</span>';
  if(rating==='bad') return '<span class="rating-icon" title="Pas bon">👎</span>';
  return '';
}

function setConsumedRating(id,rating){
  const entry=consumed.find(e=>e.id===id);
  if(!entry) return;
  entry.rating=['good','bad'].includes(rating)?rating:'neutral';
  persist();
  renderConsumption();
}

function consumptionPeriodLabel(){
  const mode=$('#consumptionPeriod')?.value||'current';
  const labels={
    current:'Ce mois',
    previous:'Mois précédent',
    '3':'3 derniers mois',
    '6':'6 derniers mois',
    '12':'12 derniers mois',
    all:'Tout l’historique',
    custom:'Période personnalisée'
  };

  if(mode!=='custom') return labels[mode]||'Historique';

  const from=$('#consumptionFrom').value;
  const to=$('#consumptionTo').value;
  if(from && to) return `${from} → ${to}`;
  return 'Période personnalisée';
}

function consumedRankingData(){
  const items=consumed
    .slice()
    .sort((a,b)=>new Date(b.drunkAt)-new Date(a.drunkAt));
  const groups=new Map();

  items.forEach(e=>{
    const key=consumedGroupKey(e);
    if(!groups.has(key)){
      groups.set(key,{
        sample:e,
        total:0,
        good:0,
        bad:0,
        neutral:0
      });
    }

    const g=groups.get(key);
    g.total++;

    const rating=['good','bad'].includes(e.rating)?e.rating:'neutral';
    if(rating==='good') g.good++;
    else if(rating==='bad') g.bad++;
    else g.neutral++;
  });

  return [...groups.values()].map(g=>{
    const raw=g.good-g.bad;
    const score=g.total ? (raw/g.total)*100 : 0;
    return {...g,raw,score};
  }).sort((a,b)=>{
    if(b.score!==a.score) return b.score-a.score;
    if(b.good!==a.good) return b.good-a.good;
    if(a.bad!==b.bad) return a.bad-b.bad;
    if(b.total!==a.total) return b.total-a.total;
    return String(a.sample.vin).localeCompare(String(b.sample.vin),'fr');
  });
}

function renderConsumedRanking(){
  const list=$('#rankingList');
  if(!list) return;

  $('#rankingPeriodLabel').textContent='Tout l’historique';
  const data=consumedRankingData();

  if(!data.length){
    list.innerHTML='<div class="ranking-empty">Aucune bouteille bue sur cette période.</div>';
    return;
  }

  list.innerHTML=data.map((g,index)=>{
    const e=g.sample;
    const score=Math.round(g.score);
    const scoreClass=score>0?'positive':score<0?'negative':'neutral';
    const mill=e.millesime ? ` · ${esc(e.millesime)}` : '';
    const isMagnum=/magnum|150\s*cl|1[.,]5\s*l/i.test(String(e.format||''));
    const format=isMagnum ? ' · Magnum' : '';

    return `
      <article class="ranking-card">
        <div class="ranking-position">#${index+1}</div>
        <div class="ranking-main wine-color ${wineClass(e.couleur)}">
          <b>${esc(e.vin)}${mill}${format}</b>
          ${e.domaine?`<span class="ranking-domain">${esc(e.domaine)}</span>`:''}
          <span class="ranking-counts">
            ${g.total} bue${g.total>1?'s':''} · 👍 ${g.good} · 👎 ${g.bad} · neutre ${g.neutral}
          </span>
        </div>
        <div class="ranking-score ${scoreClass}">
          <b>${score>0?'+':''}${score}%</b>
          <span>score</span>
        </div>
      </article>
    `;
  }).join('');
}

function renderConsumption(){
  if(!$('#consumptionList')) return;

  const items=filteredConsumed();
  $('#consumptionCount').textContent=items.length;
  $('#consumptionValue').textContent=euro(items.reduce((s,e)=>s+(Number(e.prix)||0),0));

  const typeCounts={red:0,white:0,rose:0,spark:0};
  items.forEach(e=>{
    const wc=wineClass(e.couleur);
    if(typeCounts[wc]!==undefined) typeCounts[wc]++;
  });

  $('#consumptionTypes').innerHTML=`
    <span class="consumption-type red">Rouge<small>${typeCounts.red}</small></span>
    <span class="consumption-type white">Blanc<small>${typeCounts.white}</small></span>
    <span class="consumption-type rose">Rosé<small>${typeCounts.rose}</small></span>
    <span class="consumption-type spark">Effervescent<small>${typeCounts.spark}</small></span>
  `;

  const list=$('#consumptionList');
  if(!items.length){
    list.innerHTML='<div class="consumption-empty">Aucune bouteille enregistrée comme bue sur cette période.</div>';
    return;
  }

  const groups=new Map();
  items.forEach(e=>{
    const key=consumedGroupKey(e);
    if(!groups.has(key)) groups.set(key,{sample:e,entries:[]});
    groups.get(key).entries.push(e);
  });

  const sorted=[...groups.values()].sort((a,b)=>
    new Date(b.entries[0].drunkAt)-new Date(a.entries[0].drunkAt)
  );

  list.innerHTML=sorted.map(({sample,entries})=>{
    const wc=wineClass(sample.couleur);
    const isMagnum=/magnum|150\s*cl|1[.,]5\s*l/i.test(String(sample.format||''));
    const vintage=sample.millesime ? ` · ${esc(sample.millesime)}` : '';
    const format=isMagnum ? ' · Magnum' : '';
    const groupValue=entries.reduce((s,e)=>s+(Number(e.prix)||0),0);

    return `
      <article class="consumed-card">
        <div class="consumed-card-head wine-color ${wc}">
          <b>${esc(sample.vin)} ×${entries.length}${vintage}${format}</b>
          ${sample.domaine?`<span class="consumed-domain">${esc(sample.domaine)}</span>`:''}
          <span class="consumed-meta">${euro(groupValue)}</span>
        </div>
        <div class="consumed-dates">
          ${entries.map(e=>`
            <div class="consumed-entry">
              <div class="consumed-entry-info">
                <b>${new Date(e.drunkAt).toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'})}${ratingIcon(e.rating||'neutral')}</b>
                <small>${esc(e.emplacement||'Emplacement inconnu')} · ${euro(e.prix)}</small>
              </div>
              <div class="consumed-entry-actions">
                <div class="vote-wrap">
                  <button type="button" class="vote-open" data-vote-open="${esc(e.id)}">
                    Voter${ratingIcon(e.rating||'neutral')}
                  </button>
                  <div class="consumed-rating-edit" data-vote-choices="${esc(e.id)}" hidden>
                    <button type="button" class="${(e.rating||'neutral')==='bad'?'active bad':''}" data-rating-id="${esc(e.id)}" data-rating-value="bad" title="Nul">👎</button>
                    <button type="button" class="${(e.rating||'neutral')==='neutral'?'active neutral':''}" data-rating-id="${esc(e.id)}" data-rating-value="neutral" title="Neutre">•</button>
                    <button type="button" class="${(e.rating||'neutral')==='good'?'active good':''}" data-rating-id="${esc(e.id)}" data-rating-value="good" title="Très bon">👍</button>
                  </div>
                </div>
                <button type="button" class="restore-consumed" data-consumed-id="${esc(e.id)}" title="Remettre en cave">↩</button>
              </div>
            </div>
          `).join('')}
        </div>
      </article>
    `;
  }).join('');
}

function ensureRefForConsumed(entry){
  if(entry.refId && ref(entry.refId)) return entry.refId;

  const id=`r${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  refs.push({
    id,
    vin:entry.vin||'Vin restauré',
    domaine:entry.domaine||'',
    millesime:entry.millesime||'',
    couleur:entry.couleur||'Rouge',
    format:entry.format||'75 cl',
    prix:Number(entry.prix)||0,
    maturiteDebut:entry.maturiteDebut||'',
    maturiteFin:entry.maturiteFin||''
  });
  return id;
}

function restoreConsumedBottle(id){
  const entry=consumed.find(e=>e.id===id);
  if(!entry) return;

  const original=inv.find(x=>
    x.casier===entry.casier &&
    x.ligne===entry.ligne &&
    x.position===entry.position
  );

  let target=(original && !original.refId) ? original : null;
  if(!target){
    target=inv.find(x=>x.casier===entry.casier && !x.refId);
  }
  if(!target){
    target=inv.find(x=>!x.refId);
  }
  if(!target){
    alert('Aucune place libre pour remettre cette bouteille dans la cave.');
    return;
  }

  const message=target===original
    ? `Remettre cette bouteille dans ${target.emplacement} ?`
    : `L’emplacement d’origine ${entry.emplacement} n’est plus libre.\nRemettre la bouteille dans ${target.emplacement} ?`;

  if(!confirm(message)) return;

  target.refId=ensureRefForConsumed(entry);
  consumed=consumed.filter(e=>e.id!==id);
  activeCasier=target.casier;
  persist();
  render();
  refreshPhotoButtons();
  alert(`Bouteille remise en cave : ${target.emplacement}.`);
}

function initConsumptionPeriod(){
  const nowMonth=localMonthValue();
  if($('#consumptionFrom') && !$('#consumptionFrom').value) $('#consumptionFrom').value=nowMonth;
  if($('#consumptionTo') && !$('#consumptionTo').value) $('#consumptionTo').value=nowMonth;

  const custom=$('#consumptionPeriod')?.value==='custom';
  if($('#consumptionCustom')) $('#consumptionCustom').hidden=!custom;
}

function slotKey(x){
  return `${x.casier}-${x.ligne}-${x.position}`;
}

function emptyTargetsFromSelection(){
  return inv.filter(x=>selectedEmptyKeys.has(slotKey(x)) && !x.refId);
}

function clearEmptySelection(){
  selectedEmptyKeys.clear();
  emptyTapTimers.forEach(t=>clearTimeout(t));
  emptyTapTimers.clear();
}

function toggleEmptySelection(x){
  if(x.refId) return;
  const key=slotKey(x);
  if(selectedEmptyKeys.has(key)) selectedEmptyKeys.delete(key);
  else selectedEmptyKeys.add(key);
  render();
}

function handleEmptySlotClick(x){
  const key=slotKey(x);
  const existingTimer=emptyTapTimers.get(key);

  if(existingTimer){
    clearTimeout(existingTimer);
    emptyTapTimers.delete(key);
    toggleEmptySelection(x);
    return;
  }

  const timer=setTimeout(()=>{
    emptyTapTimers.delete(key);
    chooseAdd(x);
  },280);

  emptyTapTimers.set(key,timer);
}

function prepareAddTargets(x){
  const key=slotKey(x);
  const selectedTargets=emptyTargetsFromSelection();

  if(selectedEmptyKeys.has(key) && selectedTargets.length){
    addTargets=selectedTargets;
  }else{
    addTargets=[x];
  }

  selected=x;

  if($('#addHint')){
    $('#addHint').textContent=addTargets.length>1
      ? `${addTargets.length} emplacements sélectionnés : le même vin sera ajouté dans chacun.`
      : 'Recherche un vin déjà présent dans ta base ou crée une nouvelle référence.';
  }
}

function applyRefToAddTargets(refId){
  const targets=addTargets.length ? addTargets : (selected ? [selected] : []);
  let count=0;

  targets.forEach(x=>{
    if(x && !x.refId){
      x.refId=refId;
      count++;
    }
  });

  clearEmptySelection();
  addTargets=[];
  return count;
}

function render(){
  if(!config) return;

  selectedEmptyKeys.forEach(key=>{
    const x=inv.find(p=>slotKey(p)===key);
    if(!x || x.refId) selectedEmptyKeys.delete(key);
  });

  renderStats();
  const q=$('#search').value.trim().toLowerCase();
  const g=$('#grid');
  g.style.setProperty('--bpl',config.positions);
  g.innerHTML='';
  inv.filter(x=>x.casier===activeCasier).forEach(x=>{
    const r=ref(x.refId);
    const hay=r?[r.vin,r.domaine,r.millesime,r.couleur,r.format,x.emplacement].join(' ').toLowerCase():'';
    const b=document.createElement('button');
    b.type='button';
    b.dataset.line=x.ligne; b.dataset.pos=x.position;
    const isMultiSelected=!r && selectedEmptyKeys.has(slotKey(x));
    b.className=`slot ${r?'occupied':'empty'}${isMultiSelected?' multi-selected':''}`;
    if(r){
      const wc=wineClass(r.couleur);
      const ac=ageClass(r.millesime);
      b.innerHTML=`
        <span class="vintage-strip age-color ${ac}">${esc(r.millesime||'Sans année')}</span>
        <span class="slot-main wine-color ${wc}">
          <span class="pos">L${x.ligne}·P${x.position}</span>
          <span class="name">${esc(r.vin)}</span>
          ${r.domaine?`<span class="domain">${esc(r.domaine)}</span>`:''}
          ${maturityGaugeHtml(r)}
        </span>
      `;
    }else{
      b.innerHTML=`
        <span class="pos">L${x.ligne}·P${x.position}</span>
        <span class="name">${isMultiSelected?'✓ Sélectionnée':'＋ Vide'}</span>
      `;
    }
    b.addEventListener('click',()=>r?editRef(x,r):handleEmptySlotClick(x));
    g.appendChild(b);
  });
  $$('.tab').forEach(b=>b.classList.toggle('active',Number(b.dataset.c)===activeCasier));
  renderConsumption();
}

function pushDialogHistory(){
  if(dialogHistory) return;
  history.pushState({wineDialog:true},'');
  dialogHistory=true;
}
function showDialog(d){
  pushDialogHistory();
  d.showModal();
}
function closeDialogsFromPop(){
  [$('#dialog'),$('#addDialog'),$('#voiceDialog'),$('#rankingDialog'),$('#photoDialog'),$('#configDialog')].forEach(d=>{ if(d.open) d.close(); });
  dialogHistory=false;
  selected=null;
  pendingAddRefId='';
  editScope=null;
  addTargets=[];
  voiceExactRefId='';
  voiceSimilarRefId='';
  if(voiceRecognition){
    try{ voiceRecognition.abort(); }catch(e){}
    voiceRecognition=null;
  }
}
window.addEventListener('popstate',closeDialogsFromPop);

function requestClose(d){
  if(!d.open) return;
  if(dialogHistory){
    history.back(); // le popstate ferme réellement la fenêtre
  }else{
    d.close();
  }
}
function backdropClose(e){
  const d=e.currentTarget;
  if(e.target!==d) return;
  const r=d.getBoundingClientRect();
  const inside=e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom;
  if(!inside) requestClose(d);
}
$('#dialog').addEventListener('click',backdropClose);
$('#addDialog').addEventListener('click',backdropClose);
$('#voiceDialog').addEventListener('click',backdropClose);

function fill(r){
  ['vin','domaine','millesime','couleur','format','prix','maturiteDebut','maturiteFin'].forEach(k=>{
    $('#f_'+k).value=r?.[k]??'';
  });
  updateMaturityPreview();
}

function updateMaturityPreview(){
  const draft={
    millesime:$('#f_millesime').value,
    maturiteDebut:$('#f_maturiteDebut').value,
    maturiteFin:$('#f_maturiteFin').value
  };
  const mi=maturityInfo(draft);
  $('#maturityStatus').textContent=mi.label;
  $('#maturityBar').className='maturity-bar four-zone';
  $('#maturityBar').innerHTML=mi.known ? `
    <i class="z1"></i>
    <i class="z2"></i>
    <i class="z3"></i>
    <i class="z4"></i>
    <b class="maturity-cursor" style="left:${Math.max(0,Math.min(100,mi.cursor))}%"></b>` : '';
}

function fillBottleView(r){
  $('#v_vin').textContent=r?.vin||'—';
  $('#v_domaine').textContent=r?.domaine||'—';
  $('#v_millesime').textContent=r?.millesime||'Sans année';
  $('#v_couleur').textContent=r?.couleur||'—';
  $('#v_format').textContent=r?.format||'—';
  $('#v_prix').textContent=euro(Number(r?.prix)||0);

  const mi=maturityInfo(r);
  $('#viewMaturity').hidden=!mi.known;

  if(mi.known){
    $('#v_maturiteDebut').textContent=r.maturiteDebut||'—';
    $('#v_maturiteFin').textContent=r.maturiteFin||'—';
    $('#viewMaturityStatus').textContent=mi.label;
    $('#viewMaturityBar').innerHTML=`
      <i class="z1"></i>
      <i class="z2"></i>
      <i class="z3"></i>
      <i class="z4"></i>
      <b class="maturity-cursor" style="left:${Math.max(0,Math.min(100,mi.cursor))}%"></b>`;
  }else{
    $('#viewMaturityBar').innerHTML='';
  }
}

function showBottleView(r){
  editScope=null;
  fillBottleView(r);
  $('#dialogTitle').textContent=r.vin;
  $('#where').textContent=selected.emplacement;

  const sameCount=inv.filter(p=>p.refId===r.id).length;
  $('#editAllBottles').hidden=sameCount<2;
  $('#editAllBottles').textContent=`✏️ Toutes les bouteilles (×${sameCount})`;

  $('#bottleView').hidden=false;
  $('#bottleEdit').hidden=true;
  $('#viewActions').hidden=false;
  $('#editActions').hidden=true;
}

function showBottleEdit(r,scope='all'){
  editScope=scope;
  fill(r);

  const sameCount=inv.filter(p=>p.refId===r.id).length;
  if(scope==='single'){
    $('#where').textContent=selected.emplacement+' · modification de cette bouteille uniquement';
    $('#save').textContent='Enregistrer cette bouteille';
  }else{
    $('#where').textContent=selected.emplacement+` · modification de ${sameCount} bouteille${sameCount>1?'s':''}`;
    $('#save').textContent=sameCount>1
      ? `Enregistrer les ${sameCount} bouteilles`
      : 'Enregistrer la bouteille';
  }

  $('#bottleView').hidden=true;
  $('#bottleEdit').hidden=false;
  $('#viewActions').hidden=true;
  $('#editActions').hidden=false;
}

function editRef(x,r){
  selected=x;
  showBottleView(r);
  showDialog($('#dialog'));
}

function addReferenceSearchText(r){
  return normalizeSearchText([
    r.vin||'',
    r.domaine||'',
    r.millesime||'',
    r.couleur||'',
    r.format||''
  ].join(' '));
}

function renderPickResults(){
  const q=normalizeSearchText($('#pickSearch').value.trim());

  const matches=refs
    .filter(r=>!q || addReferenceSearchText(r).includes(q))
    .slice()
    .sort((a,b)=>{
      const byWine=String(a.vin||'').localeCompare(String(b.vin||''),'fr',{sensitivity:'base'});
      if(byWine) return byWine;
      return String(b.millesime||'').localeCompare(String(a.millesime||''),'fr');
    });

  const list=$('#pickResults');

  if(!matches.length){
    list.innerHTML='<div class="pick-empty">Aucun vin trouvé dans ta base.</div>';
    $('#useRef').disabled=true;
    return;
  }

  list.innerHTML=matches.map(r=>{
    const usedCount=inv.filter(p=>p.refId===r.id).length;
    const consumedCount=consumed.filter(e=>e.refId===r.id).length;
    const canDelete=usedCount===0 && consumedCount===0;

    return `
      <div class="pick-result-row${canDelete?'':' no-delete'}">
        <button type="button"
                class="pick-result wine-color ${wineClass(r.couleur)} ${r.id===pendingAddRefId?'active':''}"
                data-pick-id="${esc(r.id)}">
          <b>${esc(r.vin)}${r.millesime?` · ${esc(r.millesime)}`:''}</b>
          <span>${esc(r.domaine||'Domaine non renseigné')}${r.format?` · ${esc(r.format)}`:''}</span>
          <small>
            ${usedCount} bouteille${usedCount>1?'s':''} en cave
            ${consumedCount?` · ${consumedCount} bue${consumedCount>1?'s':''}`:''}
          </small>
        </button>

        ${canDelete?`
          <button type="button"
                  class="delete-ref"
                  data-delete-ref="${esc(r.id)}"
                  title="Supprimer cette référence"
                  aria-label="Supprimer cette référence">🗑️</button>
        `:''}
      </div>
    `;
  }).join('');

  $('#useRef').disabled=!pendingAddRefId;
}

function clearVoiceForm(){
  voiceExactRefId='';
  voiceSimilarRefId='';
  $('#voiceTranscript').textContent='—';
  $('#voiceDomaine').value='';
  $('#voiceCuvee').value='';
  $('#voiceYear').value='';
  $('#voicePrice').value='';
  $('#voiceMatch').hidden=true;
  $('#voiceMatch').className='voice-match';
  $('#voiceMatch').innerHTML='';
  $('#voiceContinue').disabled=true;
  $('#voiceStatus').textContent='Appuyez sur le micro puis dictez les 4 informations.';
  $('#voiceStart').classList.remove('listening');
}

function normalizeVoiceNumber(value){
  return String(value||'')
    .replace(/\s/g,'')
    .replace(',','.')
    .replace(/[^\d.]/g,'');
}

function parseVoiceBottle(text){
  const original=String(text||'').trim();
  if(!original) return null;

  // On travaille sans accents et en minuscules pour reconnaître les mots-clés.
  // La transcription vocale peut produire des variantes comme "cuvee", "cuve",
  // "cuvéguy" ou coller légèrement le mot-clé au contenu.
  let norm=normalizeSearchText(original)
    .replace(/[€]/g,' euros ')
    .replace(/\s+/g,' ')
    .trim();

  // Variantes tolérées des mots-clés.
  // "cuve" / "cuvee" / "cuvé" sont acceptés.
  const domaineRe=/\bdomaine\b/i;
  const cuveeRe=/\b(?:cuvee|cuve|cuvee?|cuvee)\b/i;
  const yearRe=/\b(?:annee|millesime)\b/i;
  const priceRe=/\bprix\b/i;

  const dMatch=domaineRe.exec(norm);
  const yMatch=yearRe.exec(norm);
  const pMatch=priceRe.exec(norm);

  if(!dMatch || !yMatch || !pMatch) return null;

  // Chercher "cuvée" entre Domaine et Année.
  const betweenDomainAndYear=norm.slice(dMatch.index+dMatch[0].length,yMatch.index).trim();

  let cuveeIndex=-1;
  let cuveeLen=0;

  const candidates=[
    'cuvee','cuve','cuvé','cuvee'
  ];

  for(const key of candidates){
    const idx=betweenDomainAndYear.indexOf(key);
    if(idx>=0 && (cuveeIndex<0 || idx<cuveeIndex)){
      cuveeIndex=idx;
      cuveeLen=key.length;
    }
  }

  // Cas fréquent de transcription collée : "cuvéguy", "cuveeguy".
  // On accepte un début de mot "cuve..." et on considère la suite comme la cuvée.
  if(cuveeIndex<0){
    const loose=betweenDomainAndYear.match(/\bcuve(?:e)?([a-z0-9].*)$/i);
    if(loose){
      cuveeIndex=betweenDomainAndYear.indexOf(loose[0]);
      cuveeLen=loose[0].length-loose[1].length;
    }
  }

  if(cuveeIndex<0) return null;

  const domaine=betweenDomainAndYear.slice(0,cuveeIndex).trim()
    .replace(/[,:;-]+$/,'')
    .trim();

  let cuvee=betweenDomainAndYear.slice(cuveeIndex+cuveeLen).trim()
    .replace(/^[,:;-]+/,'')
    .trim();

  // Si Chrome colle le nom directement après "cuve/cuvee", on récupère la suite.
  if(!cuvee){
    const loose=betweenDomainAndYear.match(/\bcuve(?:e)?([a-z0-9].*)$/i);
    if(loose) cuvee=loose[1].trim();
  }

  const afterYear=norm.slice(yMatch.index+yMatch[0].length,pMatch.index).trim();
  const yearMatch=afterYear.match(/\b(19|20)\d{2}\b/);
  if(!yearMatch) return null;

  const afterPrice=norm.slice(pMatch.index+pMatch[0].length).trim();
  const priceMatch=afterPrice.match(/(\d+(?:[.,]\d+)?)/);
  if(!priceMatch) return null;

  const price=normalizeVoiceNumber(priceMatch[1]);

  if(!domaine || !cuvee || !yearMatch[0] || !price) return null;

  return {
    domaine,
    cuvee,
    year:yearMatch[0],
    price
  };
}

function repairVoiceCuveeToken(text){
  const original=String(text||'').trim();
  const norm=normalizeSearchText(original);

  // Exemple : "domaine Mathurin cuveguy annee 1983 prix 500"
  const m=norm.match(
    /\bdomaine\s+(.+?)\s+cuve(?:e)?([a-z0-9][a-z0-9 '\-]*)\s+(?:annee|millesime)\s+((?:19|20)\d{2})\s+prix\s+(\d+(?:[.,]\d+)?)/i
  );
  if(!m) return null;

  return {
    domaine:m[1].trim(),
    cuvee:m[2].trim(),
    year:m[3],
    price:normalizeVoiceNumber(m[4])
  };
}

function voiceBottleKey(v){
  return {
    domaine:normalizeSearchText(v.domaine||'').trim(),
    cuvee:normalizeSearchText(v.cuvee||v.vin||'').trim(),
    year:String(v.year||v.millesime||'').trim()
  };
}

function analyzeVoiceBottle(){
  const data={
    domaine:$('#voiceDomaine').value.trim(),
    cuvee:$('#voiceCuvee').value.trim(),
    year:$('#voiceYear').value.trim(),
    price:normalizeVoiceNumber($('#voicePrice').value)
  };

  $('#voicePrice').value=data.price;

  const ready=!!(data.domaine && data.cuvee && /^\d{4}$/.test(data.year) && data.price);
  $('#voiceContinue').disabled=!ready;
  voiceExactRefId='';
  voiceSimilarRefId='';

  if(!ready){
    $('#voiceMatch').hidden=true;
    return;
  }

  const key=voiceBottleKey(data);

  const exact=refs.find(r=>{
    const rk=voiceBottleKey(r);
    return rk.domaine===key.domaine && rk.cuvee===key.cuvee && rk.year===key.year;
  });

  const similar=refs.find(r=>{
    const rk=voiceBottleKey(r);
    return rk.domaine===key.domaine && rk.cuvee===key.cuvee;
  });

  const box=$('#voiceMatch');
  box.hidden=false;

  if(exact){
    voiceExactRefId=exact.id;
    box.className='voice-match exact';
    box.innerHTML=`<b>✓ Référence déjà présente</b><br>
      ${esc(exact.vin)} ${esc(exact.millesime||'')} · ${esc(exact.domaine||'')}<br>
      <small>Continuer ajoutera directement cette référence à l’emplacement choisi.</small>`;
  }else if(similar){
    voiceSimilarRefId=similar.id;
    box.className='voice-match similar';
    box.innerHTML=`<b>Référence proche trouvée</b><br>
      ${esc(similar.vin)} ${esc(similar.millesime||'')} · ${esc(similar.domaine||'')}<br>
      <small>Ses autres informations serviront de modèle pour le nouveau millésime.</small>`;
  }else{
    box.className='voice-match';
    box.innerHTML='<b>Nouvelle référence</b><br><small>Une fiche préremplie sera créée.</small>';
  }
}

function openVoiceAdd(){
  clearVoiceForm();

  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRecognition){
    $('#voiceStatus').textContent='La dictée vocale n’est pas disponible dans ce navigateur. Vous pouvez saisir les 4 champs manuellement.';
    $('#voiceStart').disabled=true;
  }else{
    $('#voiceStart').disabled=false;
  }

  $('#addDialog').close();
  showDialog($('#voiceDialog'));
}

function startVoiceRecognition(){
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRecognition){
    $('#voiceStatus').textContent='Reconnaissance vocale indisponible dans ce navigateur.';
    return;
  }

  if(voiceRecognition){
    try{ voiceRecognition.abort(); }catch(e){}
  }

  const recognition=new SpeechRecognition();
  voiceRecognition=recognition;
  recognition.lang='fr-FR';
  recognition.continuous=false;
  recognition.interimResults=false;
  recognition.maxAlternatives=1;

  $('#voiceStatus').textContent='Écoute en cours… Domaine, cuvée, année, prix.';
  $('#voiceStart').classList.add('listening');

  recognition.onresult=e=>{
    const transcript=e.results?.[0]?.[0]?.transcript||'';
    $('#voiceTranscript').textContent=transcript||'—';

    const parsed=parseVoiceBottle(transcript) || repairVoiceCuveeToken(transcript);

    if(parsed){
      $('#voiceDomaine').value=parsed.domaine;
      $('#voiceCuvee').value=parsed.cuvee;
      $('#voiceYear').value=parsed.year;
      $('#voicePrice').value=parsed.price;
      $('#voiceStatus').textContent='Dictée comprise. Vérifiez les 4 informations ci-dessous.';
      analyzeVoiceBottle();
    }else{
      $('#voiceStatus').textContent='Je n’ai pas pu séparer correctement les 4 informations. Vous pouvez corriger les champs ou recommencer.';
    }
  };

  recognition.onerror=e=>{
    const messages={
      'not-allowed':'Autorisation du microphone refusée.',
      'audio-capture':'Microphone indisponible.',
      'no-speech':'Aucune parole détectée.',
      'network':'La reconnaissance vocale n’a pas pu se connecter.'
    };
    $('#voiceStatus').textContent=messages[e.error]||'La dictée a échoué. Vous pouvez recommencer.';
  };

  recognition.onend=()=>{
    $('#voiceStart').classList.remove('listening');
    voiceRecognition=null;
  };

  try{
    recognition.start();
  }catch(e){
    $('#voiceStatus').textContent='Impossible de démarrer la dictée. Réessayez.';
    $('#voiceStart').classList.remove('listening');
  }
}

function continueVoiceBottle(){
  analyzeVoiceBottle();
  if($('#voiceContinue').disabled) return;

  const domaine=$('#voiceDomaine').value.trim();
  const cuvee=$('#voiceCuvee').value.trim();
  const year=$('#voiceYear').value.trim();
  const price=Number(normalizeVoiceNumber($('#voicePrice').value))||0;

  if(voiceExactRefId){
    // Référence exacte : on l'ajoute à tous les emplacements préparés.
    const count=applyRefToAddTargets(voiceExactRefId);
    const r=ref(voiceExactRefId);
    if(r && price>0 && !Number(r.prix)){
      r.prix=price;
    }
    persist();
    render();
    requestClose($('#voiceDialog'));

    if(count>1){
      setTimeout(()=>alert(`${count} bouteilles identiques ajoutées.`),120);
    }
    return;
  }

  // Nouvelle année / nouvelle référence.
  let baseRef=voiceSimilarRefId ? ref(voiceSimilarRefId) : null;

  const draft=baseRef ? {
    ...baseRef,
    id:'',
    domaine,
    vin:cuvee,
    millesime:year,
    prix:price
  } : {
    id:'',
    domaine,
    vin:cuvee,
    millesime:year,
    couleur:'Rouge',
    format:'75 cl',
    prix:price,
    maturiteDebut:'',
    maturiteFin:''
  };

  editScope='new';
  $('#dialogTitle').textContent='Nouveau vin';
  $('#where').textContent=selected.emplacement+' · nouvelle référence';
  fill(draft);
  $('#bottleView').hidden=true;
  $('#bottleEdit').hidden=false;
  $('#viewActions').hidden=true;
  $('#editActions').hidden=false;

  $('#voiceDialog').close();
  $('#dialog').showModal();
}

function deleteReference(id){
  const r=ref(id);
  if(!r) return;

  const usedCount=inv.filter(p=>p.refId===id).length;
  const consumedCount=consumed.filter(e=>e.refId===id).length;

  if(usedCount>0 || consumedCount>0){
    const details=[];
    if(usedCount>0) details.push(`${usedCount} en cave`);
    if(consumedCount>0) details.push(`${consumedCount} dans l’historique`);
    alert(`Impossible de supprimer cette référence : ${details.join(' · ')}.`);
    return;
  }

  const label=[r.vin,r.millesime,r.domaine].filter(Boolean).join(' · ');
  if(!confirm(`Supprimer définitivement la référence « ${label} » ?\n\nCette action ne supprime pas les anciennes entrées déjà enregistrées dans l’historique des bouteilles bues.`)){
    return;
  }

  refs=refs.filter(x=>x.id!==id);

  if(pendingAddRefId===id){
    pendingAddRefId='';
  }

  if(voiceExactRefId===id) voiceExactRefId='';
  if(voiceSimilarRefId===id) voiceSimilarRefId='';

  persist();
  renderPickResults();
  render();

  alert('Référence supprimée.');
}

function chooseAdd(x){
  prepareAddTargets(x);
  pendingAddRefId='';
  $('#pickSearch').value='';
  renderPickResults();
  showDialog($('#addDialog'));
}

$('#pickSearch').addEventListener('input',()=>{
  pendingAddRefId='';
  renderPickResults();
});

$('#pickResults').addEventListener('click',e=>{
  const del=e.target.closest('[data-delete-ref]');
  if(del){
    deleteReference(del.dataset.deleteRef);
    return;
  }

  const btn=e.target.closest('[data-pick-id]');
  if(!btn) return;
  pendingAddRefId=btn.dataset.pickId;
  renderPickResults();
});

$('#useRef').addEventListener('click',()=>{
  const id=pendingAddRefId;
  if(!id) return alert('Choisis un vin dans les résultats.');

  const count=applyRefToAddTargets(id);
  pendingAddRefId='';
  persist();
  render();
  requestClose($('#addDialog'));

  if(count>1){
    setTimeout(()=>alert(`${count} bouteilles identiques ajoutées.`),120);
  }
});
$('#voiceAdd').addEventListener('click',openVoiceAdd);
$('#voiceStart').addEventListener('click',startVoiceRecognition);
$('#voiceContinue').addEventListener('click',continueVoiceBottle);
$('#voiceCancel').addEventListener('click',()=>{
  if(voiceRecognition){
    try{ voiceRecognition.abort(); }catch(e){}
    voiceRecognition=null;
  }
  requestClose($('#voiceDialog'));
});
['voiceDomaine','voiceCuvee','voiceYear','voicePrice'].forEach(id=>{
  $('#'+id).addEventListener('input',analyzeVoiceBottle);
});

$('#newRef').addEventListener('click',()=>{
  // On ferme "Ajouter", puis on ouvre directement l'édition d'une nouvelle référence.
  $('#addDialog').close();
  pendingAddRefId='';
  editScope='new';
  $('#dialogTitle').textContent='Nouveau vin';
  $('#where').textContent=selected.emplacement+' · nouvelle référence';
  fill(null);
  $('#bottleView').hidden=true;
  $('#bottleEdit').hidden=false;
  $('#viewActions').hidden=true;
  $('#editActions').hidden=false;
  $('#dialog').showModal();
});
$('#save').addEventListener('click',()=>{
  const vals={};
  ['vin','domaine','millesime','couleur','format','maturiteDebut','maturiteFin'].forEach(k=>vals[k]=$('#f_'+k).value.trim());
  const p=parseFloat($('#f_prix').value.replace(',','.'));
  vals.prix=Number.isFinite(p)?p:0;

  if(!vals.vin) return alert('Indique la cuvée.');
  if(vals.maturiteDebut && vals.maturiteFin && Number(vals.maturiteFin)<Number(vals.maturiteDebut)){
    return alert('La fin de maturité doit être après le début.');
  }

  const existed=!!selected.refId;

  if(existed){
    const originalId=selected.refId;
    const original=ref(originalId);
    const sameCount=inv.filter(p=>p.refId===originalId).length;

    if(editScope==='single' && sameCount>1){
      // Dupliquer la référence : seule cette bouteille reçoit les nouvelles informations.
      const clone={
        ...original,
        ...vals,
        id:`r${Date.now()}_${Math.random().toString(36).slice(2,6)}`
      };
      refs.push(clone);
      selected.refId=clone.id;
    }else{
      // Une seule bouteille utilise cette référence, ou l'utilisateur a choisi "toutes".
      Object.assign(original,vals);
    }
  }else{
    vals.id='r'+Date.now();
    refs.push(vals);

    if(editScope==='new' && addTargets.length){
      applyRefToAddTargets(vals.id);
    }else{
      selected.refId=vals.id;
    }
  }

  persist();
  render();

  if(existed){
    const updated=ref(selected.refId);
    showBottleView(updated);
  }else{
    editScope=null;
    requestClose($('#dialog'));
  }
});
$('#editOneBottle').addEventListener('click',()=>{
  if(!selected || !selected.refId) return;
  const r=ref(selected.refId);
  if(r) showBottleEdit(r,'single');
});

$('#editAllBottles').addEventListener('click',()=>{
  if(!selected || !selected.refId) return;
  const r=ref(selected.refId);
  if(r) showBottleEdit(r,'all');
});

$('#cancelEdit').addEventListener('click',()=>{
  editScope=null;
  if(selected?.refId){
    const r=ref(selected.refId);
    if(r) showBottleView(r);
  }else{
    requestClose($('#dialog'));
  }
});

$('#consumed').addEventListener('click',()=>{
  if(!selected || !selected.refId) return;
  const r=ref(selected.refId);
  if(!r) return;
  if(!confirm(`Marquer « ${r.vin} » comme bue aujourd’hui ?`)) return;

  const snap=consumedSnapshot(selected,r);
  snap.rating='neutral';
  consumed.push(snap);
  selected.refId=null;
  persist();
  render();
  requestClose($('#dialog'));
});

$('#remove').addEventListener('click',()=>{
  if(!selected || !confirm('Sortir cette bouteille de la cave ?')) return;
  selected.refId=null;
  persist(); render();
  requestClose($('#dialog'));
});
$('#cancel').addEventListener('click',()=>requestClose($('#dialog')));
$('#cancelAdd').addEventListener('click',()=>requestClose($('#addDialog')));
['f_millesime','f_maturiteDebut','f_maturiteFin'].forEach(id=>$('#'+id).addEventListener('input',updateMaturityPreview));

$('#openConfig').addEventListener('click',()=>openConfigDialog(false));
$('#configSave').addEventListener('click',applyConfiguration);
$('#configCancel').addEventListener('click',()=>{
  if(config) requestClose($('#configDialog'));
});
['cfgCasiers','cfgLignes','cfgPositions'].forEach(id=>{
  $('#'+id).addEventListener('input',()=>{
    $('#configError').hidden=true;
    updateConfigCapacityPreview();
  });
});

$('#search').addEventListener('input',showSearchResults);
$$('.maturity-filter').forEach(b=>b.addEventListener('click',()=>{
  const zone=Number(b.dataset.zone);

  if(b.classList.contains('active')){
    clearMaturityFilter();
    clearYearFilter();
    hideResultPanel();
    return;
  }

  showMaturityResults(zone);
}));

$('#casierTabs').addEventListener('click',async e=>{
  const b=e.target.closest('.tab');
  if(!b) return;
  activeCasier=Number(b.dataset.c);
  $('#search').value='';
  clearMaturityFilter();
  clearYearFilter();
  hideResultPanel();
  render();
  await refreshPhotoButtons();
});

$('#openConsumedRanking').addEventListener('click',()=>{
  renderConsumedRanking();
  showDialog($('#rankingDialog'));
});
$('#rankingClose').addEventListener('click',()=>requestClose($('#rankingDialog')));
$('#rankingDialog').addEventListener('click',backdropClose);

$('#consumptionPeriod').addEventListener('change',()=>{
  initConsumptionPeriod();
  renderConsumption();
});
$('#consumptionFrom').addEventListener('change',renderConsumption);
$('#consumptionTo').addEventListener('change',renderConsumption);
$('#consumptionList').addEventListener('click',e=>{
  const voteOpen=e.target.closest('[data-vote-open]');
  if(voteOpen){
    const id=voteOpen.dataset.voteOpen;
    const choices=$(`[data-vote-choices="${id}"]`);
    const willOpen=choices.hidden;

    $$('[data-vote-choices]').forEach(el=>el.hidden=true);
    choices.hidden=!willOpen;
    return;
  }

  const ratingBtn=e.target.closest('[data-rating-id]');
  if(ratingBtn){
    setConsumedRating(ratingBtn.dataset.ratingId,ratingBtn.dataset.ratingValue);
    return;
  }

  const btn=e.target.closest('.restore-consumed');
  if(!btn) return;
  restoreConsumedBottle(btn.dataset.consumedId);
});

$('#export').addEventListener('click',()=>{
  const payload={
    version:5,
    app:'ma-cave-configurable',
    exportedAt:new Date().toISOString(),
    config,inv,refs,consumed
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='sauvegarde-ma-cave-configurable-v1.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});
$('#import').addEventListener('change',async e=>{
  const f=e.target.files?.[0]; if(!f) return;
  try{
    const d=JSON.parse(await f.text());
    if(!Array.isArray(d.inv)||!Array.isArray(d.refs)) throw new Error();

    const restoredConfig=normalizeConfig(d.config)||deriveConfigFromInventory(d.inv);
    if(!restoredConfig) throw new Error();

    config=restoredConfig;
    inv=buildInventory(config,d.inv);
    refs=d.refs;
    consumed=Array.isArray(d.consumed)?d.consumed:[];

    consumed.forEach(e=>{
      if(!['good','bad','neutral'].includes(e.rating)) e.rating='neutral';
    });
    refs.forEach(r=>{
      if(r.maturiteDebut===undefined) r.maturiteDebut='';
      if(r.maturiteFin===undefined) r.maturiteFin='';
    });

    activeCasier=1;
    clearEmptySelection();
    persist();
    render();
    refreshPhotoButtons();
    alert('Sauvegarde restaurée avec la configuration de la cave.');
  }catch(err){ alert('Sauvegarde invalide.'); }
  e.target.value='';
});


// ---- Photos des casiers : 2 photos maximum par casier (actuelle + précédente) ----
const PHOTO_DB='ma-cave-configurable-photos-v1';
const PHOTO_STORE='photos';

function openPhotoDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(PHOTO_DB,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function photoGet(key){
  const db=await openPhotoDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(PHOTO_STORE,'readonly');
    const req=tx.objectStore(PHOTO_STORE).get(key);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>reject(req.error);
  });
}
async function photoSet(key,val){
  const db=await openPhotoDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(PHOTO_STORE,'readwrite');
    tx.objectStore(PHOTO_STORE).put(val,key);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
async function photoDelete(key){
  const db=await openPhotoDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(PHOTO_STORE,'readwrite');
    tx.objectStore(PHOTO_STORE).delete(key);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
function photoKey(casier,slot){ return `c${casier}-${slot}`; }

async function refreshPhotoButtons(){
  $('#photoCasier').textContent=activeCasier;
  const cur=await photoGet(photoKey(activeCasier,'current'));
  const prev=await photoGet(photoKey(activeCasier,'previous'));
  const set=(btn,obj,label)=>{
    btn.classList.toggle('has-photo',!!obj);
    btn.querySelector('.photo-state').textContent=obj ? `${label} · ${new Date(obj.date).toLocaleDateString('fr-FR')}` : 'Aucune photo';
  };
  set($('#photoCurrent'),cur,'Voir');
  set($('#photoPrevious'),prev,'Voir');
}
async function saveNewPhoto(file){
  if(!file) return;
  if(!file.type.startsWith('image/')) return alert('Choisis une image.');
  try{
    const cur=await photoGet(photoKey(activeCasier,'current'));
    if(cur) await photoSet(photoKey(activeCasier,'previous'),cur);
    const blob=file;
    await photoSet(photoKey(activeCasier,'current'),{
      blob,
      name:file.name||'photo',
      type:file.type,
      date:new Date().toISOString()
    });
    await refreshPhotoButtons();
    alert(`Photo du casier ${activeCasier} enregistrée.`);
  }catch(e){
    console.error(e);
    alert("Impossible d'enregistrer la photo. L'espace de stockage du navigateur est peut-être insuffisant.");
  }
}
async function showPhoto(slot){
  const obj=await photoGet(photoKey(activeCasier,slot));
  if(!obj) return alert(slot==='current'?'Aucune photo actuelle.':'Aucune photo précédente.');
  const url=URL.createObjectURL(obj.blob);
  const img=$('#photoViewerImg');
  const cleanup=()=>{
    if(img.dataset.url){ URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
  };
  cleanup();
  img.src=url;
  img.dataset.url=url;
  $('#photoViewerTitle').textContent=`Casier ${activeCasier} · ${slot==='current'?'Photo actuelle':'Photo précédente'}`;
  $('#photoViewerDate').textContent=new Date(obj.date).toLocaleString('fr-FR');
  showDialog($('#photoDialog'));
}
$('#photoInput').addEventListener('change',async e=>{
  const f=e.target.files?.[0];
  if(f) await saveNewPhoto(f);
  e.target.value='';
});
$('#photoCurrent').addEventListener('click',()=>showPhoto('current'));
$('#photoPrevious').addEventListener('click',()=>showPhoto('previous'));
$('#photoClose').addEventListener('click',()=>requestClose($('#photoDialog')));
$('#photoDialog').addEventListener('click',backdropClose);
$('#photoDialog').addEventListener('close',()=>{
  const img=$('#photoViewerImg');
  if(img.dataset.url){ URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
  img.removeAttribute('src');
});


let swipeStartX=null,swipeStartY=null;
$('#grid').addEventListener('touchstart',e=>{
  if(e.touches.length!==1)return;
  swipeStartX=e.touches[0].clientX; swipeStartY=e.touches[0].clientY;
},{passive:true});
$('#grid').addEventListener('touchend',e=>{
  if(swipeStartX===null||!e.changedTouches.length)return;
  const dx=e.changedTouches[0].clientX-swipeStartX,dy=e.changedTouches[0].clientY-swipeStartY;
  swipeStartX=swipeStartY=null;
  if(Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.35)return;
  if(dx<0&&config&&activeCasier<config.casiers) activeCasier++;
  else if(dx>0&&activeCasier>1) activeCasier--;
  else return;
  render(); refreshPhotoButtons();
  document.querySelector('.tabs').scrollIntoView({behavior:'smooth',block:'start'});
},{passive:true});

if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
initConsumptionPeriod();

if(config){
  inv=buildInventory(config,inv);
  persist();
  render();
  refreshPhotoButtons();
}else{
  $('#count').textContent='0';
  $('#free').textContent='—';
  openConfigDialog(true);
}
