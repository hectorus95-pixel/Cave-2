
const SEED_INV=[];
const SEED_REFS=[];

// On conserve volontairement les clés V2 : une personne qui met à jour
// l'application garde ses prix / ajouts / sorties déjà enregistrés.
const KI='ma-cave-configurable-v1-inv',
      KR='ma-cave-configurable-v1-refs',
      KC='ma-cave-configurable-v1-consumed',
      KCFG='ma-cave-configurable-v1-config',
      KSALES='ma-cave-configurable-v2-sales',
      KBULK='ma-cave-configurable-v2-bulk',
      KHIST='ma-cave-configurable-v3-history',
      KBACKUP='ma-cave-configurable-last-manual-backup',
      KINTERNALBACKUP='ma-cave-configurable-internal-backup-v1';

const DEFAULT_DIMENSIONS={casiers:3,lignes:15,positions:5};
const DEFAULT_CONFIG={
  caves:[{
    id:'cave1',
    name:'Cave 1',
    code:'C1',
    ...DEFAULT_DIMENSIONS
  }],
  modules:{sales:true,bulk:true},
  stockThresholds:{low:1,medium:6,high:12}
};

let config=load(KCFG,null);
let inv=load(KI,SEED_INV);
let refs=load(KR,SEED_REFS);
let consumed=load(KC,[]);
let sales=load(KSALES,[]);
let bulk=load(KBULK,[]);
let historyState=load(KHIST,{undo:[],redo:[]});
const HISTORY_LIMIT=20;
let historyReady=false;
if(!historyState || !Array.isArray(historyState.undo) || !Array.isArray(historyState.redo)){
  historyState={undo:[],redo:[]};
}
historyState.undo=historyState.undo.slice(-HISTORY_LIMIT);
historyState.redo=historyState.redo.slice(-HISTORY_LIMIT);

if(!Array.isArray(consumed)) consumed=[];
if(!Array.isArray(sales)) sales=[];
if(!Array.isArray(bulk)) bulk=[];
consumed.forEach(e=>{
  if(!['verygood','good','bad','verybad','neutral'].includes(e.rating)) e.rating='neutral';
  if(e.comment===undefined) e.comment='';
  e.bulk=!!e.bulk;
});
bulk=bulk.filter(e=>e&&e.refId).map((e,i)=>({
  id:String(e.id||`bulk_${Date.now()}_${i}`),
  caveId:String(e.caveId||''),
  refId:String(e.refId||''),
  locationText:e.locationText!==undefined
    ? String(e.locationText||'').trim()
    : String(e.emplacement||'').replace(/^.*?Vrac\s*·?\s*/i,'').trim(),
  addedAt:e.addedAt||new Date().toISOString(),
  bulk:true
}));
sales.forEach(e=>{
  if(e.profit===undefined){
    e.costPrice=Number(e.costPrice??e.prixAchat??0)||0;
    e.salePrice=Number(e.salePrice??e.prixVente??0)||0;
    e.costKnown=e.costKnown!==undefined ? !!e.costKnown : e.costPrice>0;
    e.profit=e.costKnown ? e.salePrice-e.costPrice : null;
  }
});

config=normalizeConfig(config);
if(config?.caves?.length){
  const cavesWithBulk=new Set(bulk.filter(x=>x&&x.refId).map(x=>x.caveId));
  config.caves.forEach(c=>{
    if(cavesWithBulk.has(c.id)) c.bulkEnabled=true;
  });
}
let activeCaveId=config?.caves?.[0]?.id||'';
let activeCasier=1;
let selected=null;
let moveSource=null; // {items:[{type:'grid'|'bulk', key|id, refId}, ...]}
let moveTargetKeys=new Set();
let pendingAddRefId='';
let editScope=null; // 'single' | 'all' | 'new'
let selectedEmptyKeys=new Set();
let selectedOccupiedKeys=new Set();
let addTargets=[];
let exitTargets=[];
let saleTargets=[];
let pendingBulkRefId='';
let bulkDraft=null;
let bulkActionIds=[];
let drinkTargets=[];
let emptyTapTimers=new Map();
let occupiedTapTimers=new Map();
let voiceRecognition=null;
let voiceExactRefId='';
let voiceSimilarRefId='';
let dialogHistory=false;

if(config){
  inv=buildInventory(config,inv);
  activeCaveId=config.caves[0].id;
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

function makeCaveId(index){
  return `cave${index+1}_${Math.random().toString(36).slice(2,6)}`;
}

function cleanCaveCode(value,index=0){
  let code=normalizeSearchText(value||'')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g,'')
    .slice(0,3);
  if(!code) code=`C${index+1}`.slice(0,3);
  return code;
}

function normalizeCave(raw,index=0){
  if(!raw) return null;
  const cave={
    id:String(raw.id||makeCaveId(index)),
    name:String(raw.name||`Cave ${index+1}`).trim()||`Cave ${index+1}`,
    code:cleanCaveCode(raw.code,index),
    casiers:Number(raw.casiers),
    lignes:Number(raw.lignes),
    positions:Number(raw.positions),
    bulkEnabled:raw.bulkEnabled!==undefined ? !!raw.bulkEnabled : true
  };
  const bulkOnly=
    cave.casiers===0 &&
    cave.lignes===0 &&
    cave.positions===0;

  if(bulkOnly) return cave;

  if(
    !Number.isInteger(cave.casiers) || cave.casiers<1 || cave.casiers>20 ||
    !Number.isInteger(cave.lignes) || cave.lignes<1 || cave.lignes>50 ||
    !Number.isInteger(cave.positions) || cave.positions<1 || cave.positions>12
  ) return null;

  return cave;
}

function normalizeStockThresholds(raw){
  const defaults={low:1,medium:6,high:12};
  if(!raw) return defaults;

  const low=Number(raw.low);
  const medium=Number(raw.medium);
  const high=Number(raw.high);

  if(
    !Number.isInteger(low) ||
    !Number.isInteger(medium) ||
    !Number.isInteger(high) ||
    low<1 ||
    low>=medium ||
    medium>=high ||
    high>999
  ){
    return defaults;
  }

  return {low,medium,high};
}

function stockThresholdValues(){
  return normalizeStockThresholds(config?.stockThresholds);
}

function stockFilterText(){
  const {low,medium,high}=stockThresholdValues();
  return {
    high:`${high+1}+ bt`,
    medium:`${medium} à ${high} bt`,
    low:`${low} à ${medium-1} bt`
  };
}

function renderStockFilterLabels(){
  const labels=stockFilterText();
  const high=$('#stockLabelHigh');
  const medium=$('#stockLabelMedium');
  const low=$('#stockLabelLow');
  if(high) high.textContent=labels.high;
  if(medium) medium.textContent=labels.medium;
  if(low) low.textContent=labels.low;
}

function normalizeConfig(raw){
  if(!raw) return null;

  // Migration automatique de la v1 : l'ancienne cave devient la Cave 1.
  if(!Array.isArray(raw.caves)){
    const legacy=normalizeCave({
      id:'cave1',
      name:'Cave 1',
      code:'C1',
      casiers:raw.casiers,
      lignes:raw.lignes,
      positions:raw.positions
    },0);
    return legacy ? {caves:[legacy],modules:{sales:true},stockThresholds:normalizeStockThresholds(raw.stockThresholds)} : null;
  }

  if(raw.caves.length<1 || raw.caves.length>12) return null;
  const legacyBulkDefault=raw.modules?.bulk!==undefined ? !!raw.modules.bulk : true;
  const caves=raw.caves.map((c,i)=>normalizeCave({
    ...c,
    bulkEnabled:c?.bulkEnabled!==undefined ? c.bulkEnabled : legacyBulkDefault
  },i));
  if(caves.some(c=>!c)) return null;

  // IDs et codes doivent être uniques.
  const ids=new Set(),codes=new Set();
  for(const c of caves){
    if(ids.has(c.id)) c.id=makeCaveId(ids.size);
    ids.add(c.id);
    if(codes.has(c.code)) return null;
    codes.add(c.code);
  }
  const modules={
    sales:raw.modules?.sales!==undefined ? !!raw.modules.sales : true
  };
  const stockThresholds=normalizeStockThresholds(raw.stockThresholds);
  return {caves,modules,stockThresholds};
}

function caveById(id){
  return config?.caves?.find(c=>c.id===id)||null;
}
function activeCave(){
  return caveById(activeCaveId)||config?.caves?.[0]||null;
}
function caveIndex(id){
  const i=config?.caves?.findIndex(c=>c.id===id);
  return i>=0?i:999;
}

function positionKey(caveId,c,l,p){
  return `${caveId}|${c}|${l}|${p}`;
}

function positionLabel(cave,c,l,p){
  return `${cave?.code||'CAV'} · C${c}-L${l}-P${p}`;
}

function buildInventory(cfg,oldInv=[]){
  const firstId=cfg.caves[0].id;
  const oldMap=new Map();
  (Array.isArray(oldInv)?oldInv:[]).forEach(x=>{
    const caveId=x.caveId||firstId;
    oldMap.set(positionKey(caveId,Number(x.casier),Number(x.ligne),Number(x.position)),x);
  });

  const fresh=[];
  cfg.caves.forEach(cave=>{
    for(let c=1;c<=cave.casiers;c++){
      for(let l=1;l<=cave.lignes;l++){
        for(let p=1;p<=cave.positions;p++){
          const old=oldMap.get(positionKey(cave.id,c,l,p));
          fresh.push({
            caveId:cave.id,
            casier:c,
            ligne:l,
            position:p,
            emplacement:positionLabel(cave,c,l,p),
            refId:old?.refId||null
          });
        }
      }
    }
  });
  return fresh;
}

function caveCapacity(cave){
  return cave.casiers*cave.lignes*cave.positions;
}
function configCapacity(cfg){
  return cfg.caves.reduce((s,c)=>s+caveCapacity(c),0);
}

function configEditorValues(){
  return $$('.cave-config-card').map((card,i)=>({
    id:card.dataset.caveId||makeCaveId(i),
    name:card.querySelector('[data-field="name"]').value,
    code:card.querySelector('[data-field="code"]').value,
    casiers:Number(card.querySelector('[data-field="casiers"]').value),
    lignes:Number(card.querySelector('[data-field="lignes"]').value),
    positions:Number(card.querySelector('[data-field="positions"]').value),
    bulkEnabled:!!card.querySelector('[data-field="bulkEnabled"]')?.checked
  }));
}

function renderConfigEditors(caves){
  $('#cfgCavesList').innerHTML=caves.map((c,i)=>`
    <section class="cave-config-card" data-cave-id="${esc(c.id||makeCaveId(i))}">
      <div class="cave-config-title">Cave ${i+1}</div>
      <div class="cave-name-row">
        <label>Nom
          <input data-field="name" maxlength="40" value="${esc(c.name||`Cave ${i+1}`)}" placeholder="Ex. Cave principale">
        </label>
        <label>Code (3 car. max)
          <input data-field="code" maxlength="3" value="${esc(c.code||`C${i+1}`)}" placeholder="CP">
        </label>
      </div>
      <div class="cave-dims-row">
        <label>Casiers<input data-field="casiers" type="number" min="0" max="20" inputmode="numeric" value="${Number.isInteger(Number(c.casiers))?Number(c.casiers):3}"></label>
        <label>Lignes<input data-field="lignes" type="number" min="0" max="50" inputmode="numeric" value="${Number.isInteger(Number(c.lignes))?Number(c.lignes):15}"></label>
        <label>Bouteilles / ligne<input data-field="positions" type="number" min="0" max="12" inputmode="numeric" value="${Number.isInteger(Number(c.positions))?Number(c.positions):5}"></label>
      </div>
      <label class="cave-bulk-toggle">
        <span><strong>📦 Vrac dans cette cave</strong><small>Activé par défaut. Désactivation possible uniquement si le Vrac de cette cave est vide.</small></span>
        <input data-field="bulkEnabled" type="checkbox" ${c.bulkEnabled!==false?'checked':''}>
      </label>
    </section>
  `).join('');
}

function syncConfigCaveCount(){
  let n=Math.max(1,Math.min(12,Number($('#cfgCaveCount').value)||1));
  $('#cfgCaveCount').value=n;
  const current=configEditorValues();
  while(current.length<n){
    const i=current.length;
    current.push({
      id:makeCaveId(i),name:`Cave ${i+1}`,code:`C${i+1}`.slice(0,3),
      ...DEFAULT_DIMENSIONS,
      bulkEnabled:true
    });
  }
  current.length=n;
  renderConfigEditors(current);
  updateConfigCapacityPreview();
}

function readConfigForm(){
  const caves=configEditorValues().map((c,i)=>normalizeCave(c,i));
  if(!caves.length || caves.some(c=>!c)) return null;
  const codes=caves.map(c=>c.code);
  if(new Set(codes).size!==codes.length) return null;

  const low=Number($('#cfgStockLow')?.value);
  const medium=Number($('#cfgStockMedium')?.value);
  const high=Number($('#cfgStockHigh')?.value);
  if(
    !Number.isInteger(low) ||
    !Number.isInteger(medium) ||
    !Number.isInteger(high) ||
    low<1 ||
    low>=medium ||
    medium>=high ||
    high>999
  ) return null;

  return {
    caves,
    modules:{
      sales:!!$('#cfgModuleSales')?.checked
    },
    stockThresholds:{low,medium,high}
  };
}

function renderStockThresholdPreview(){
  const low=Number($('#cfgStockLow')?.value);
  const medium=Number($('#cfgStockMedium')?.value);
  const high=Number($('#cfgStockHigh')?.value);
  const el=$('#stockThresholdPreview');
  if(!el) return;

  if(
    Number.isInteger(low) &&
    Number.isInteger(medium) &&
    Number.isInteger(high) &&
    low>=1 && low<medium && medium<high
  ){
    el.textContent=`${low} à ${medium-1} · ${medium} à ${high} · ${high+1}+`;
    el.classList.remove('invalid');
  }else{
    el.textContent='Seuils invalides : faible < moyen < élevé';
    el.classList.add('invalid');
  }
}

function updateConfigCapacityPreview(){
  const cfg=readConfigForm();
  if(!cfg){
    $('#configCapacity').textContent='Structure normale : valeurs supérieures à 0. Cave vrac uniquement : mets 0 / 0 / 0.';
    return;
  }
  const details=cfg.caves.map(c=>{
    const stock=c.casiers===0&&c.lignes===0&&c.positions===0
      ? '0 emplacement'
      : `${caveCapacity(c)} emplacement${caveCapacity(c)>1?'s':''}`;
    return `${c.code}: ${stock} · Vrac ${c.bulkEnabled!==false?'ON':'OFF'}`;
  }).join(' · ');
  $('#configCapacity').textContent=`${cfg.caves.length} cave${cfg.caves.length>1?'s':''} · ${details} · Total ${configCapacity(cfg)} emplacements de casier`;
}

function openConfigDialog(firstRun=false){
  const cfg=config||DEFAULT_CONFIG;
  $('#configTitle').textContent=firstRun ? 'Configurer mes caves' : '⚙️ Configuration des caves';
  $('#cfgCaveCount').value=cfg.caves.length;
  renderConfigEditors(cfg.caves);
  $('#cfgModuleSales').checked=cfg.modules?.sales!==false;
  const thresholds=normalizeStockThresholds(cfg.stockThresholds);
  $('#cfgStockLow').value=thresholds.low;
  $('#cfgStockMedium').value=thresholds.medium;
  $('#cfgStockHigh').value=thresholds.high;
  $('#configError').hidden=true;
  $('#configError').innerHTML='';
  $('#configCancel').hidden=firstRun;
  renderStockThresholdPreview();
  updateConfigCapacityPreview();

  if(firstRun) $('#configDialog').showModal();
  else showDialog($('#configDialog'));

  // Chrome/Android donne sinon automatiquement le focus au premier champ
  // ("Nombre de caves"), ce qui ouvre le clavier.
  requestAnimationFrame(()=>{
    const title=$('#configTitle');
    if(title) title.focus({preventScroll:true});
  });
}

function applyConfiguration(){
  const next=readConfigForm();
  if(!next){
    $('#configError').hidden=false;
    $('#configError').textContent='Vérifie les noms, codes, dimensions et seuils de stock. Les seuils doivent respecter : faible < moyen < élevé.';
    return;
  }

  const blockedBulkDisable=next.caves
    .filter(c=>c.bulkEnabled===false)
    .map(c=>({
      cave:c,
      count:bulk.filter(x=>x&&x.refId&&x.caveId===c.id).length
    }))
    .find(x=>x.count>0);

  if(blockedBulkDisable){
    const {cave,count}=blockedBulkDisable;
    $('#configError').hidden=false;
    $('#configError').innerHTML=`<b>Impossible de désactiver le Vrac de ${esc(cave.code)} · ${esc(cave.name)}.</b><br>${count} bouteille${count>1?'s sont':' est'} encore enregistrée${count>1?'s':''} en Vrac dans cette cave.<br>Déplace ou sors d’abord ${count>1?'ces bouteilles':'cette bouteille'}.`;
    const card=$(`.cave-config-card[data-cave-id="${CSS.escape(cave.id)}"]`);
    const checkbox=card?.querySelector('[data-field="bulkEnabled"]');
    if(checkbox) checkbox.checked=true;
    return;
  }

  if(config){
    const blocked=inv.filter(x=>{
      if(!x.refId) return false;
      const c=next.caves.find(n=>n.id===x.caveId);
      return !c || x.casier>c.casiers || x.ligne>c.lignes || x.position>c.positions;
    });
    if(blocked.length){
      const shown=blocked.slice(0,8).map(x=>x.emplacement).join(' · ');
      $('#configError').hidden=false;
      $('#configError').innerHTML=`<b>Réduction impossible.</b><br>${blocked.length} bouteille${blocked.length>1?'s seraient':' serait'} hors de la nouvelle structure.<br>Déplace d’abord : ${esc(shown)}${blocked.length>8?'…':''}`;
      return;
    }

    const removedCaveIds=config.caves.map(c=>c.id).filter(id=>!next.caves.some(n=>n.id===id));
    const blockedBulk=bulk.filter(x=>removedCaveIds.includes(x.caveId));
    if(blockedBulk.length){
      $('#configError').hidden=false;
      $('#configError').innerHTML=`<b>Suppression impossible.</b><br>${blockedBulk.length} bouteille${blockedBulk.length>1?'s sont':' est'} encore enregistrée${blockedBulk.length>1?'s':''} en vrac dans une cave que tu veux supprimer.`;
      return;
    }
  }

  const oldCapacity=config?configCapacity(config):0;
  config=next;
  inv=buildInventory(config,inv);
  if(!caveById(activeCaveId)) activeCaveId=config.caves[0].id;
  const ac=activeCave();
  activeCasier=ac.casiers===0 ? 0 : Math.min(Math.max(1,activeCasier),ac.casiers);
  clearEmptySelection();
  clearOccupiedSelection();
  addTargets=[]; exitTargets=[]; saleTargets=[];
  pendingAddRefId=''; editScope=null;
  persist('Configuration des caves modifiée'); render(); refreshPhotoButtons();

  const newCapacity=configCapacity(config);
  const message=oldCapacity?`Configuration enregistrée : ${config.caves.length} cave${config.caves.length>1?'s':''}, ${newCapacity} emplacements.`:`Caves créées : ${newCapacity} emplacements.`;
  if($('#configDialog').open){
    if(dialogHistory) requestClose($('#configDialog')); else $('#configDialog').close();
  }
  setTimeout(()=>alert(message),80);
}

function deriveConfigFromInventory(data){
  if(!Array.isArray(data)||!data.length) return null;
  const caveIds=[...new Set(data.map(x=>x.caveId||'cave1'))];
  const caves=caveIds.map((id,i)=>{
    const rows=data.filter(x=>(x.caveId||'cave1')===id);
    return normalizeCave({
      id,
      name:rows[0]?.caveName||`Cave ${i+1}`,
      code:rows[0]?.caveCode||`C${i+1}`,
      casiers:Math.max(...rows.map(x=>Number(x.casier)||1)),
      lignes:Math.max(...rows.map(x=>Number(x.ligne)||1)),
      positions:Math.max(...rows.map(x=>Number(x.position)||1))
    },i);
  });
  return normalizeConfig({caves});
}


function migrateBackupCaves(data,restoredConfig){
  const cfg=restoredConfig;
  const first=cfg.caves[0];
  const validIds=new Set(cfg.caves.map(c=>c.id));

  const caveFor=(rawId)=>{
    const id=String(rawId||'').trim();
    return id && validIds.has(id) ? id : first.id;
  };

  const caveMeta=(id)=>{
    const c=cfg.caves.find(x=>x.id===id)||first;
    return {id:c.id,name:c.name,code:c.code};
  };

  const migratedInv=(Array.isArray(data.inv)?data.inv:[]).map(x=>{
    const cave=caveMeta(caveFor(x.caveId));
    return {
      ...x,
      caveId:cave.id,
      caveName:x.caveName||cave.name,
      caveCode:x.caveCode||cave.code
    };
  });

  const migratedConsumed=(Array.isArray(data.consumed)?data.consumed:[]).map(e=>{
    const cave=caveMeta(caveFor(e.caveId));
    return {
      ...e,
      caveId:cave.id,
      caveName:e.caveName||cave.name,
      caveCode:e.caveCode||cave.code
    };
  });

  const migratedSales=(Array.isArray(data.sales)?data.sales:[]).map(e=>{
    const cave=caveMeta(caveFor(e.caveId));
    return {
      ...e,
      caveId:cave.id,
      caveName:e.caveName||cave.name,
      caveCode:e.caveCode||cave.code
    };
  });

  const migratedBulk=(Array.isArray(data.bulk)?data.bulk:[]).map(e=>{
    const cave=caveMeta(caveFor(e.caveId));
    return {
      ...e,
      caveId:cave.id,
      caveName:e.caveName||cave.name,
      caveCode:e.caveCode||cave.code
    };
  });

  return {
    inv:migratedInv,
    consumed:migratedConsumed,
    sales:migratedSales,
    bulk:migratedBulk,
    defaultedToCave1:[
      ...(Array.isArray(data.inv)?data.inv:[]),
      ...(Array.isArray(data.consumed)?data.consumed:[]),
      ...(Array.isArray(data.sales)?data.sales:[]),
      ...(Array.isArray(data.bulk)?data.bulk:[])
    ].filter(x=>!x?.caveId || !validIds.has(String(x.caveId))).length
  };
}

// Migration douce V2 -> V3
refs.forEach(r=>{
  if(r.maturiteDebut===undefined) r.maturiteDebut='';
  if(r.maturiteFin===undefined) r.maturiteFin='';
});


function cloneHistoryData(value){
  return JSON.parse(JSON.stringify(value));
}

function currentHistorySnapshot(){
  return cloneHistoryData({config,inv,refs,consumed,sales,bulk});
}

function storedHistorySnapshot(){
  try{
    const storedConfig=JSON.parse(localStorage.getItem(KCFG)||'null');
    if(!storedConfig) return null;
    return {
      config:storedConfig,
      inv:JSON.parse(localStorage.getItem(KI)||'[]'),
      refs:JSON.parse(localStorage.getItem(KR)||'[]'),
      consumed:JSON.parse(localStorage.getItem(KC)||'[]'),
      sales:JSON.parse(localStorage.getItem(KSALES)||'[]'),
      bulk:JSON.parse(localStorage.getItem(KBULK)||'[]')
    };
  }catch(e){
    return null;
  }
}

function historySignature(snapshot){
  return snapshot ? JSON.stringify(snapshot) : '';
}

function snapshotBottleCount(s){
  if(!s) return 0;
  const grid=(Array.isArray(s.inv)?s.inv:[]).filter(x=>x?.refId).length;
  const loose=(Array.isArray(s.bulk)?s.bulk:[]).filter(x=>x?.refId).length;
  return grid+loose;
}

function snapshotRefById(snapshot,id){
  return (snapshot?.refs||[]).find(r=>String(r.id)===String(id))||null;
}

function historyWineName(snapshot,refId){
  const r=snapshotRefById(snapshot,refId);
  if(!r) return 'Vin';
  return `${r.vin||'Vin'}${r.millesime?` ${r.millesime}`:''}`;
}

function historyLocation(snapshot,item){
  if(!item) return '';
  if(item.bulk){
    const cave=(snapshot?.config?.caves||[]).find(c=>c.id===item.caveId);
    const loc=String(item.locationText||'').trim();
    return `${cave?.code||'CAV'} · Vrac${loc?` · ${loc}`:''}`;
  }
  return item.emplacement||'';
}

function historyChangedGrid(before,after){
  const key=x=>`${x.caveId}|${x.casier}|${x.ligne}|${x.position}`;
  const bm=new Map((before?.inv||[]).map(x=>[key(x),x]));
  const am=new Map((after?.inv||[]).map(x=>[key(x),x]));
  const changes=[];

  new Set([...bm.keys(),...am.keys()]).forEach(k=>{
    const b=bm.get(k),a=am.get(k);
    const br=String(b?.refId||''),ar=String(a?.refId||'');
    if(br!==ar) changes.push({key:k,before:b,after:a,beforeRef:br,afterRef:ar});
  });
  return changes;
}

function historyChangedBulk(before,after){
  const bm=new Map((before?.bulk||[]).map(x=>[String(x.id),x]));
  const am=new Map((after?.bulk||[]).map(x=>[String(x.id),x]));
  const changes=[];

  new Set([...bm.keys(),...am.keys()]).forEach(k=>{
    const b=bm.get(k),a=am.get(k);
    if(JSON.stringify(b||null)!==JSON.stringify(a||null)){
      changes.push({id:k,before:b,after:a});
    }
  });
  return changes;
}

function historyListNames(entries,snapshot,limit=2){
  const names=[];
  entries.forEach(e=>{
    const name=historyWineName(snapshot,e.refId);
    if(name && !names.includes(name)) names.push(name);
  });
  if(!names.length) return '';
  const shown=names.slice(0,limit).join(', ');
  return names.length>limit ? `${shown} +${names.length-limit}` : shown;
}

function describeHistoryChange(before,after){
  if(!before||!after) return {icon:'✏️',label:'Modification',detail:''};

  const bSales=before.sales||[], aSales=after.sales||[];
  const bConsumed=before.consumed||[], aConsumed=after.consumed||[];
  const bRefs=before.refs||[], aRefs=after.refs||[];

  if(JSON.stringify(before.config)!==JSON.stringify(after.config)){
    const bc=before.config?.caves?.length||0, ac=after.config?.caves?.length||0;
    const detail=bc!==ac
      ? `${bc} → ${ac} cave${ac>1?'s':''}`
      : 'Dimensions, noms ou modules modifiés';
    return {icon:'⚙️',label:'Configuration des caves',detail};
  }

  if(aSales.length>bSales.length){
    const added=aSales.slice(bSales.length);
    const names=historyListNames(added,after);
    const client=[...new Set(added.map(e=>String(e.client||'').trim()).filter(Boolean))].join(', ');
    const n=added.length;
    return {
      icon:'💶',
      label:`Vente · ${n} bouteille${n>1?'s':''}`,
      detail:[names,client?`Client : ${client}`:''].filter(Boolean).join(' · ')
    };
  }

  if(aConsumed.length>bConsumed.length){
    const added=aConsumed.slice(bConsumed.length);
    const names=historyListNames(added,after);
    const n=added.length;
    return {
      icon:'🍷',
      label:`Bue · ${n} bouteille${n>1?'s':''}`,
      detail:names
    };
  }

  if(aConsumed.length<bConsumed.length){
    const removed=bConsumed.filter(b=>!aConsumed.some(a=>a.id===b.id));
    const names=historyListNames(removed,before);
    const n=Math.max(1,bConsumed.length-aConsumed.length);
    return {
      icon:'↩️',
      label:`Remise en cave · ${n} bouteille${n>1?'s':''}`,
      detail:names
    };
  }

  const gridChanges=historyChangedGrid(before,after);
  const bulkChanges=historyChangedBulk(before,after);

  const removedGrid=gridChanges.filter(c=>c.beforeRef&&!c.afterRef);
  const addedGrid=gridChanges.filter(c=>!c.beforeRef&&c.afterRef);
  const replacedGrid=gridChanges.filter(c=>c.beforeRef&&c.afterRef&&c.beforeRef!==c.afterRef);

  const addedBulk=bulkChanges.filter(c=>!c.before&&c.after);
  const removedBulk=bulkChanges.filter(c=>c.before&&!c.after);
  const movedBulk=bulkChanges.filter(c=>c.before&&c.after);

  // Movement: same number leaves and arrives, or a bulk entry changes location/cave.
  if(
    (removedGrid.length && addedGrid.length && removedGrid.length===addedGrid.length) ||
    (removedGrid.length && addedBulk.length) ||
    (removedBulk.length && addedGrid.length) ||
    movedBulk.length
  ){
    const n=Math.max(
      removedGrid.length,addedGrid.length,removedBulk.length,addedBulk.length,movedBulk.length,1
    );

    let from='',to='',name='';
    const rg=removedGrid[0],ag=addedGrid[0],rb=removedBulk[0],ab=addedBulk[0],mb=movedBulk[0];

    if(rg){
      from=historyLocation(before,rg.before);
      name=historyWineName(before,rg.beforeRef);
    }else if(rb){
      from=historyLocation(before,rb.before);
      name=historyWineName(before,rb.before?.refId);
    }else if(mb){
      from=historyLocation(before,{...mb.before,bulk:true});
      name=historyWineName(before,mb.before?.refId);
    }

    if(ag) to=historyLocation(after,ag.after);
    else if(ab) to=historyLocation(after,{...ab.after,bulk:true});
    else if(mb) to=historyLocation(after,{...mb.after,bulk:true});

    return {
      icon:'📦',
      label:`Déplacement · ${n} bouteille${n>1?'s':''}`,
      detail:[name,from&&to?`${from} → ${to}`:''].filter(Boolean).join(' · ')
    };
  }

  if(addedGrid.length || addedBulk.length){
    const n=addedGrid.length+addedBulk.length;
    const first=addedGrid[0];
    const bulkFirst=addedBulk[0];
    const refId=first?.afterRef||bulkFirst?.after?.refId;
    const name=historyWineName(after,refId);
    const loc=first
      ? historyLocation(after,first.after)
      : historyLocation(after,{...bulkFirst.after,bulk:true});
    return {
      icon:'➕',
      label:`Ajout · ${n} bouteille${n>1?'s':''}`,
      detail:[name,loc].filter(Boolean).join(' · ')
    };
  }

  if(removedGrid.length || removedBulk.length){
    const n=removedGrid.length+removedBulk.length;
    const first=removedGrid[0];
    const bulkFirst=removedBulk[0];
    const refId=first?.beforeRef||bulkFirst?.before?.refId;
    const name=historyWineName(before,refId);
    const loc=first
      ? historyLocation(before,first.before)
      : historyLocation(before,{...bulkFirst.before,bulk:true});
    return {
      icon:'➖',
      label:`Sortie · ${n} bouteille${n>1?'s':''}`,
      detail:[name,loc].filter(Boolean).join(' · ')
    };
  }

  if(replacedGrid.length){
    const n=replacedGrid.length;
    const first=replacedGrid[0];
    return {
      icon:'✏️',
      label:`Bouteille modifiée${n>1?'s':''}`,
      detail:`${historyWineName(before,first.beforeRef)} → ${historyWineName(after,first.afterRef)}`
    };
  }

  if(aRefs.length!==bRefs.length){
    const added=aRefs.find(a=>!bRefs.some(b=>b.id===a.id));
    const removed=bRefs.find(b=>!aRefs.some(a=>a.id===b.id));
    if(added) return {icon:'🆕',label:'Nouvelle référence',detail:`${added.vin||'Vin'}${added.millesime?` · ${added.millesime}`:''}`};
    if(removed) return {icon:'🗑️',label:'Référence supprimée',detail:`${removed.vin||'Vin'}${removed.millesime?` · ${removed.millesime}`:''}`};
  }

  if(JSON.stringify(before.refs)!==JSON.stringify(after.refs)){
    const changed=aRefs.find(a=>{
      const b=bRefs.find(x=>x.id===a.id);
      return b && JSON.stringify(b)!==JSON.stringify(a);
    });
    if(changed){
      const old=bRefs.find(x=>x.id===changed.id);
      const changedFields=[
        ['vin','cuvée'],['domaine','domaine'],['millesime','millésime'],
        ['format','format'],['prix','prix'],['maturiteDebut','début maturité'],
        ['maturiteFin','fin maturité']
      ].filter(([k])=>String(old?.[k]??'')!==String(changed?.[k]??'')).map(([,label])=>label);
      return {
        icon:'✏️',
        label:'Vin modifié',
        detail:`${changed.vin||old?.vin||'Vin'}${changed.millesime?` · ${changed.millesime}`:''}${changedFields.length?` · ${changedFields.join(', ')}`:''}`
      };
    }
  }

  if(JSON.stringify(before.consumed)!==JSON.stringify(after.consumed)){
    const changed=aConsumed.find(a=>{
      const b=bConsumed.find(x=>x.id===a.id);
      return b && JSON.stringify(b)!==JSON.stringify(a);
    });
    return {
      icon:'📝',
      label:'Note / commentaire modifié',
      detail:changed ? `${changed.vin||'Vin'}${changed.millesime?` · ${changed.millesime}`:''}` : ''
    };
  }

  if(JSON.stringify(before.sales)!==JSON.stringify(after.sales)){
    return {icon:'💶',label:'Historique des ventes modifié',detail:''};
  }

  return {icon:'✏️',label:'Modification',detail:''};
}

function inferHistoryLabel(before,after){
  return describeHistoryChange(before,after).label;
}

function saveHistoryState(){
  historyState.undo=historyState.undo.slice(-HISTORY_LIMIT);
  historyState.redo=historyState.redo.slice(-HISTORY_LIMIT);

  // Si le navigateur manque d'espace, on enlève d'abord les étapes les plus anciennes.
  while(true){
    try{
      localStorage.setItem(KHIST,JSON.stringify(historyState));
      break;
    }catch(e){
      if(historyState.undo.length>1){
        historyState.undo.shift();
        continue;
      }
      if(historyState.redo.length>1){
        historyState.redo.shift();
        continue;
      }
      console.warn('Historique non enregistrable : stockage local insuffisant.',e);
      break;
    }
  }
}

function writeHistorySnapshot(snapshot){
  if(snapshot.config) localStorage.setItem(KCFG,JSON.stringify(snapshot.config));
  localStorage.setItem(KI,JSON.stringify(snapshot.inv||[]));
  localStorage.setItem(KR,JSON.stringify(snapshot.refs||[]));
  localStorage.setItem(KC,JSON.stringify(snapshot.consumed||[]));
  localStorage.setItem(KSALES,JSON.stringify(snapshot.sales||[]));
  localStorage.setItem(KBULK,JSON.stringify(snapshot.bulk||[]));
}

function persist(actionLabel=''){
  const after=currentHistorySnapshot();

  if(historyReady){
    const before=storedHistorySnapshot();
    if(before && historySignature(before)!==historySignature(after)){
      const description=describeHistoryChange(before,after);
      historyState.undo.push({
        at:new Date().toISOString(),
        label:actionLabel||description.label,
        detail:description.detail||'',
        icon:description.icon||'✏️',
        state:before
      });
      historyState.undo=historyState.undo.slice(-HISTORY_LIMIT);

      // Une nouvelle action après un Annuler invalide le futur, comme dans un éditeur.
      historyState.redo=[];
    }
  }

  writeHistorySnapshot(after);
  saveHistoryState();
  renderHistoryControls();
  if($('#undoHistoryDialog')?.open) renderUndoHistory();
}

function normalizeSnapshotForRuntime(snapshot){
  const nextConfig=normalizeConfig(cloneHistoryData(snapshot.config));
  if(!nextConfig) return false;

  config=nextConfig;
  refs=cloneHistoryData(snapshot.refs||[]);
  consumed=cloneHistoryData(snapshot.consumed||[]);
  sales=cloneHistoryData(snapshot.sales||[]);
  bulk=cloneHistoryData(snapshot.bulk||[]);
  inv=buildInventory(config,cloneHistoryData(snapshot.inv||[]));

  refs.forEach(r=>{
    if(r.maturiteDebut===undefined) r.maturiteDebut='';
    if(r.maturiteFin===undefined) r.maturiteFin='';
  });
  consumed.forEach(e=>{
    if(!['verygood','good','bad','verybad','neutral'].includes(e.rating)) e.rating='neutral';
    if(e.comment===undefined) e.comment='';
    e.bulk=!!e.bulk;
  });
  bulk=bulk.filter(e=>e&&e.refId).map((e,i)=>({
    ...e,
    id:String(e.id||`bulk_hist_${Date.now()}_${i}`),
    caveId:String(e.caveId||config.caves[0].id),
    refId:String(e.refId),
    locationText:String(e.locationText||'').trim(),
    bulk:true
  }));

  if(!caveById(activeCaveId)) activeCaveId=config.caves[0].id;
  const cave=activeCave();
  activeCasier=cave.casiers===0 ? 0 : Math.min(Math.max(1,activeCasier||1),cave.casiers);

  selected=null;
  moveSource=null;
  moveTargetKeys.clear();
  selectedEmptyKeys.clear();
  selectedOccupiedKeys.clear();
  addTargets=[];
  exitTargets=[];
  saleTargets=[];
  pendingAddRefId='';
  pendingBulkRefId='';
  bulkDraft=null;
  bulkActionIds=[];
  drinkTargets=[];

  return true;
}

function refreshAfterHistoryRestore(){
  render();
  renderConsumption();
  if(moduleEnabled('sales')) renderSales();
  renderHistoryControls();
  if($('#undoHistoryDialog')?.open) renderUndoHistory();
  refreshPhotoButtons();
}

function undoLastAction(){
  if(!historyState.undo.length) return;

  const entry=historyState.undo.pop();
  const current=currentHistorySnapshot();

  historyState.redo.push({
    at:new Date().toISOString(),
    label:entry.label,
    detail:entry.detail||'',
    icon:entry.icon||'✏️',
    state:current
  });
  historyState.redo=historyState.redo.slice(-HISTORY_LIMIT);

  if(!normalizeSnapshotForRuntime(entry.state)){
    historyState.undo.push(entry);
    historyState.redo.pop();
    return alert('Impossible de restaurer cette étape.');
  }

  writeHistorySnapshot(currentHistorySnapshot());
  saveHistoryState();
  refreshAfterHistoryRestore();
}

function redoLastAction(){
  if(!historyState.redo.length) return;

  const entry=historyState.redo.pop();
  const current=currentHistorySnapshot();

  historyState.undo.push({
    at:new Date().toISOString(),
    label:entry.label,
    detail:entry.detail||'',
    icon:entry.icon||'✏️',
    state:current
  });
  historyState.undo=historyState.undo.slice(-HISTORY_LIMIT);

  if(!normalizeSnapshotForRuntime(entry.state)){
    historyState.redo.push(entry);
    historyState.undo.pop();
    return alert('Impossible de rétablir cette étape.');
  }

  writeHistorySnapshot(currentHistorySnapshot());
  saveHistoryState();
  refreshAfterHistoryRestore();
}

function historyTimeLabel(iso){
  const d=new Date(iso);
  if(Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR',{
    day:'2-digit',month:'2-digit',
    hour:'2-digit',minute:'2-digit'
  });
}

function historyEntryPresentation(entry){
  return {
    icon:entry?.icon||'✏️',
    label:entry?.label||'Modification',
    detail:entry?.detail||''
  };
}

function renderHistoryControls(){
  if(!$('#undoAction')) return;

  const undo=historyState.undo[historyState.undo.length-1];
  const redo=historyState.redo[historyState.redo.length-1];
  const p=historyEntryPresentation(undo);

  $('#undoAction').disabled=!undo;
  $('#redoAction').disabled=!redo;
  $('#undoAction').title=undo?`Annuler : ${p.label}`:'Rien à annuler';
  $('#redoAction').title=redo?`Rétablir : ${historyEntryPresentation(redo).label}`:'Rien à rétablir';

  $('#historyCount').textContent=`${historyState.undo.length}/${HISTORY_LIMIT}`;
  $('#historyLast').innerHTML=undo
    ? `<span class="history-last-icon">${esc(p.icon)}</span><span><b>${esc(p.label)}</b>${p.detail?`<small>${esc(p.detail)}</small>`:''}</span>`
    : '<span>Aucune modification mémorisée</span>';
}

function renderUndoHistory(){
  const list=$('#undoHistoryList');
  if(!list) return;

  const undoRows=historyState.undo.slice().reverse().map((entry,i)=>{
    const p=historyEntryPresentation(entry);
    return `
      <article class="undo-history-row">
        <div class="undo-history-icon">${esc(p.icon)}</div>
        <div class="undo-history-content">
          <div class="undo-history-title"><b>${esc(p.label)}</b><span>−${i+1}</span></div>
          ${p.detail?`<div class="undo-history-detail">${esc(p.detail)}</div>`:''}
          <small>${esc(historyTimeLabel(entry.at))}</small>
        </div>
      </article>
    `;
  }).join('');

  const redoRows=historyState.redo.slice().reverse().map((entry,i)=>{
    const p=historyEntryPresentation(entry);
    return `
      <article class="undo-history-row redo-row">
        <div class="undo-history-icon">↷</div>
        <div class="undo-history-content">
          <div class="undo-history-title"><b>${esc(p.label)}</b><span>+${i+1}</span></div>
          ${p.detail?`<div class="undo-history-detail">${esc(p.detail)}</div>`:''}
          <small>À rétablir · ${esc(historyTimeLabel(entry.at))}</small>
        </div>
      </article>
    `;
  }).join('');

  list.innerHTML=`
    <div class="undo-history-section">
      <h3>À annuler · ${historyState.undo.length}/${HISTORY_LIMIT}</h3>
      ${undoRows||'<div class="undo-history-empty">Aucune action à annuler.</div>'}
    </div>
    ${historyState.redo.length?`
      <div class="undo-history-section">
        <h3>À rétablir · ${historyState.redo.length}</h3>
        ${redoRows}
      </div>`:''}
  `;
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

function isMagnumFormat(format){
  const f=normalizeSearchText(String(format||''))
    .replace(/,/g,'.')
    .replace(/\s+/g,' ')
    .trim();

  return (
    f.includes('magnum') ||
    /(^|\D)150\s*cl(\D|$)/.test(f) ||
    /(^|\D)1\.5(?:0)?\s*l(?:itre)?s?(\D|$)/.test(f)
  );
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


function maturityYearValue(value){
  const text=String(value??'').trim();
  if(!text) return null;
  const n=Number(text);
  return Number.isFinite(n) && n>=1900 && n<=2200 ? Math.trunc(n) : null;
}

function maturityDateStartOfYear(year){
  return new Date(year,0,1,0,0,0,0);
}

function maturityDateEndOfYear(year){
  return new Date(year,11,31,23,59,59,999);
}

function maturityScale(r,now=new Date()){
  const startYear=maturityYearValue(r?.maturiteDebut);
  const endYear=maturityYearValue(r?.maturiteFin);

  if(startYear===null && endYear===null){
    return {
      known:false,
      zone:0,
      cursor:0,
      label:'Maturité non renseignée',
      startYellow:null,
      mid:null,
      endOrange:null,
      startGreen:null,
      endRed:null
    };
  }

  // Si une seule borne existe, on garde une échelle exploitable.
  const vintage=maturityYearValue(r?.millesime);
  const effectiveStartYear=startYear ?? vintage ?? endYear ?? now.getFullYear();
  const effectiveEndYear=endYear ?? effectiveStartYear;

  const startYellow=maturityDateStartOfYear(effectiveStartYear);
  const endOrange=maturityDateEndOfYear(effectiveEndYear);

  // Sécurité si des données anciennes sont inversées.
  const a=startYellow.getTime();
  const b=Math.max(a+86400000,endOrange.getTime());

  // Milieu temporel exact entre début jaune et fin orange.
  const midMs=a+(b-a)/2;
  const mid=new Date(midMs);

  // Début vert et fin rouge ne sont pas affichés.
  // On extrapole la même demi-durée de chaque côté afin que :
  // début jaune = 25 %, milieu = 50 %, fin orange = 75 %.
  const halfSpan=(b-a)/2;
  const startGreen=new Date(a-halfSpan);
  const endRed=new Date(b+halfSpan);

  const nowMs=now.getTime();
  const fullStart=startGreen.getTime();
  const fullEnd=endRed.getTime();
  const raw=((nowMs-fullStart)/(fullEnd-fullStart))*100;
  const cursor=Math.max(0,Math.min(100,raw));

  let zone,label;

  if(nowMs < a){
    zone=1;
    label=`Jeune · maturité à partir de ${effectiveStartYear}`;
  }else if(nowMs < midMs){
    zone=2;
    label=`À boire · ${effectiveStartYear}–${effectiveEndYear}`;
  }else if(nowMs <= b){
    zone=3;
    label=`Fin de maturité · ${effectiveStartYear}–${effectiveEndYear}`;
  }else{
    zone=4;
    label=`Surmaturité · depuis ${effectiveEndYear+1}`;
  }

  return {
    known:true,
    zone,
    label,
    cursor,
    startYellow,
    mid,
    endOrange,
    startGreen,
    endRed
  };
}

function maturityInfo(r){
  return maturityScale(r);
}

function maturityZone(r){
  const mi=maturityScale(r);
  return mi.known ? mi.zone : 0;
}

function maturityMatchesZone(r,zone){
  return maturityZone(r)===Number(zone);
}

function maturityEntriesByZone(zone){
  zone=Number(zone);
  return refsWithLocations(r=>maturityMatchesZone(r,zone));
}

function moduleEnabled(name){
  if(name==='sales') return config?.modules?.sales!==false;
  if(name==='bulk') return activeCave()?.bulkEnabled!==false;
  return false;
}

function applyModuleVisibility(){
  const salesOn=moduleEnabled('sales');
  const bulkOn=moduleEnabled('bulk');
  if($('#salesPanel')) $('#salesPanel').hidden=!salesOn;
  if($('#openSalesWindow')) $('#openSalesWindow').hidden=!salesOn;
  if($('#sellBottle')) $('#sellBottle').hidden=!salesOn;
  if($('#batchSell')) $('#batchSell').hidden=!salesOn;
  if($('#bulkPanel')) $('#bulkPanel').hidden=!bulkOn;
}

function bulkLocationLabel(value){
  const text=String(value||'').trim();
  return text || 'Emplacement non renseigné';
}

function bulkTarget(item){
  const cave=caveById(item.caveId);
  return {
    ...item,
    bulk:true,
    emplacement:`${cave?.code||'CAV'} · Vrac · ${bulkLocationLabel(item.locationText)}`,
    casier:0,ligne:0,position:0
  };
}

function allBulkOccupied(){
  return bulk.filter(x=>x.refId&&ref(x.refId));
}

function allOccupied(){
  return inv.filter(x=>x.refId && ref(x.refId));
}
function statsData(){
  const gridOcc=allOccupied();
  const bulkOcc=allBulkOccupied();
  const occ=[...gridOcc,...bulkOcc.map(bulkTarget)];
  const byCave={};
  const byCaveCasier={};
  const byYear={};
  const valueCave={};

  config.caves.forEach(c=>{
    byCave[c.id]=0;
    valueCave[c.id]=0;
    byCaveCasier[c.id]={};
    for(let i=1;i<=c.casiers;i++) byCaveCasier[c.id][i]=0;
  });

  gridOcc.forEach(x=>{
    const r=ref(x.refId);
    byCave[x.caveId]=(byCave[x.caveId]||0)+1;
    valueCave[x.caveId]=(valueCave[x.caveId]||0)+(Number(r?.prix)||0);
    if(!byCaveCasier[x.caveId]) byCaveCasier[x.caveId]={};
    byCaveCasier[x.caveId][x.casier]=(byCaveCasier[x.caveId][x.casier]||0)+1;
    const y=String(r?.millesime||'Sans année');
    byYear[y]=(byYear[y]||0)+1;
  });
  bulkOcc.forEach(x=>{
    const r=ref(x.refId);
    byCave[x.caveId]=(byCave[x.caveId]||0)+1;
    valueCave[x.caveId]=(valueCave[x.caveId]||0)+(Number(r?.prix)||0);
    const y=String(r?.millesime||'Sans année');
    byYear[y]=(byYear[y]||0)+1;
  });
  return {occ,gridOcc,bulkOcc,byCave,byCaveCasier,byYear,valueCave};
}

function updateTabCentering(){
  ['#caveTabs','#casierTabs'].forEach(selector=>{
    const el=$(selector);
    if(!el) return;

    // On retire d'abord le centrage pour mesurer la largeur naturelle.
    el.classList.remove('tabs-fit');

    // scrollWidth/clientWidth forcent le navigateur à calculer la mise en page.
    const fits=el.scrollWidth<=el.clientWidth+1;
    el.classList.toggle('tabs-fit',fits);

    // Quand tout tient, la rangée revient proprement au centre.
    if(fits) el.scrollLeft=0;
  });
}

function scheduleTabCentering(){
  requestAnimationFrame(updateTabCentering);
}

function renderCaveTabs(s){
  const tabs=$('#caveTabs');
  tabs.innerHTML=config.caves.map(c=>`
    <button class="cave-tab ${c.id===activeCaveId?'active':''}" data-cave-id="${esc(c.id)}" title="${esc(c.name)}">
      <b>${esc(c.code)}</b><span>${esc(c.name)}</span><small>${s.byCave[c.id]||0} bt</small>
    </button>
  `).join('');
  scheduleTabCentering();
}

function renderCasierTabs(s){
  const tabs=$('#casierTabs');
  const cave=activeCave();
  if(!tabs||!cave) return;

  if(cave.casiers===0&&cave.lignes===0&&cave.positions===0){
    tabs.innerHTML='';
    tabs.hidden=true;
    return;
  }

  tabs.hidden=false;
  const counts=s.byCaveCasier[cave.id]||{};
  tabs.innerHTML=Array.from({length:cave.casiers},(_,i)=>{
    const c=i+1;
    return `<button class="tab ${c===activeCasier?'active':''}" data-c="${c}"><b>Casier ${c}</b><small>${counts[c]||0} bt</small></button>`;
  }).join('');
  scheduleTabCentering();
}

function renderStats(){
  const s=statsData();
  renderStockFilterLabels();
  $('#count').textContent=s.occ.length;
  $('#free').textContent=inv.length-s.gridOcc.length;
  renderCaveTabs(s);
  renderCasierTabs(s);

  const maturityCounts={0:0,1:0,2:0,3:0,4:0};
  [0,1,2,3,4].forEach(z=>{
    maturityCounts[z]=maturityEntriesByZone(z).length;
  });
  [1,2,3,4,0].forEach(z=>{
    const el=$('#matCount'+z);
    if(el) el.textContent=`${maturityCounts[z]} bt`;
  });

  const years=Object.entries(s.byYear).sort((a,b)=>{
    if(a[0]==='Sans année')return 1;if(b[0]==='Sans année')return -1;return Number(b[0])-Number(a[0]);
  });
  $('#yearStats').innerHTML=years.map(([y,n])=>{
    const ac=ageClass(y==='Sans année'?'':y);
    return `<button type="button" class="year-chip" data-year="${esc(y)}"><span class="year-chip-fill age-color ${ac}"><b>${esc(y)}</b><small>${n} bt</small></span></button>`;
  }).join('');
  $$('#yearStats .year-chip').forEach(btn=>btn.addEventListener('click',()=>showVintageResults(btn.dataset.year)));

  $('#valueByCave').innerHTML=config.caves.map(c=>`
    <div><span>${esc(c.code)} · ${esc(c.name)}</span><b>${euro(s.valueCave[c.id]||0)}</b></div>
  `).join('');
  $('#valueTotal').textContent=euro(s.occ.reduce((sum,x)=>sum+(Number(ref(x.refId)?.prix)||0),0));
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
  bulk.forEach(item=>{
    if(!item.refId) return;
    const r=ref(item.refId),p=bulkTarget(item);
    if(r && filterFn(r,p)) out.push({r,p});
  });
  return out.sort((a,b)=>
    caveIndex(a.p.caveId)-caveIndex(b.p.caveId) ||
    Number(!!a.p.bulk)-Number(!!b.p.bulk) ||
    (a.p.casier||0)-(b.p.casier||0) ||
    (a.p.ligne||0)-(b.p.ligne||0) ||
    (a.p.position||0)-(b.p.position||0)
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
        <small>${r._searchLocations?esc(r._searchLocations):p.emplacement}</small>
        <span class="result-gauge">${maturityGaugeHtml(r)}</span>
      </span>
    `;
    btn.addEventListener('click',()=>{
      if(p.bulk){
        activeCaveId=p.caveId;
        render();
        openBulkGroup(p.id||p.bulkId);
        return;
      }
      activeCaveId=p.caveId; activeCasier=p.casier; render(); refreshPhotoButtons();
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
      caveIndex(a.caveId)-caveIndex(b.caveId) ||
      Number(!!a.bulk)-Number(!!b.bulk) ||
      (a.casier||0)-(b.casier||0) ||
      (a.ligne||0)-(b.ligne||0) ||
      (a.position||0)-(b.position||0)
    );

    const first=positions[0];
    const locations=positions
      .map(p=>p.emplacement)
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

function clearStockFilter(){
  $$('.stock-filter').forEach(b=>b.classList.remove('active'));
}

function stockCountByRef(){
  const counts=new Map();
  refsWithLocations(()=>true).forEach(({r})=>{
    const key=String(r.id||'');
    counts.set(key,(counts.get(key)||0)+1);
  });
  return counts;
}

function stockBucketMatches(count,bucket){
  count=Number(count)||0;
  const {low,medium,high}=stockThresholdValues();

  // Les trois catégories sont volontairement sans chevauchement :
  // faible = low .. medium-1
  // moyen  = medium .. high
  // fort   = high+1 et plus
  if(bucket==='12plus') return count>high;
  if(bucket==='6to12') return count>=medium && count<=high;
  if(bucket==='1to5') return count>=low && count<medium;
  return false;
}

function showStockResults(bucket){
  $('#search').value='';
  clearYearFilter();
  clearMaturityFilter();
  clearStockFilter();

  const active=$$('.stock-filter').find(b=>b.dataset.stock===bucket);
  if(active) active.classList.add('active');

  const counts=stockCountByRef();
  const matches=refsWithLocations(r=>stockBucketMatches(counts.get(String(r.id||''))||0,bucket));

  const items=groupedResultItems(matches)
    .map(item=>({
      ...item,
      _stockCount:counts.get(String(item.r.id||''))||0
    }))
    .sort((a,b)=>
      b._stockCount-a._stockCount ||
      normalizeSearchText(a.r.vin).localeCompare(normalizeSearchText(b.r.vin),'fr')
    );

  const t=stockFilterText();
  const labels={
    '12plus':t.high.replace(' bt',' bouteilles'),
    '6to12':t.medium.replace(' bt',' bouteilles'),
    '1to5':t.low.replace(' bt',' bouteilles')
  };

  showResultPanel(
    `${labels[bucket]} · ${items.length} vin${items.length>1?'s':''}`,
    items
  );

  $('#resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function showMaturityResults(zone){
  zone=Number(zone);
  $('#search').value='';
  clearYearFilter();
  clearMaturityFilter();
  clearStockFilter();

  const active=$$('.maturity-filter').find(b=>Number(b.dataset.zone)===zone);
  if(active) active.classList.add('active');

  const labels={
    0:'Non renseigné',
    1:'Jeune',
    2:'À boire',
    3:'Fin maturité',
    4:'Surmaturité'
  };

  const matches=maturityEntriesByZone(zone);

  const items=groupedResultItems(matches);

  const countEl=$('#matCount'+zone);
  if(countEl) countEl.textContent=`${matches.length} bt`;

  showResultPanel(
    `${labels[zone]} · ${items.length} vin${items.length>1?'s':''} · ${matches.length} bouteille${matches.length>1?'s':''}`,
    items
  );

  $('#resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function showSearchResults(){
  clearMaturityFilter();
  clearYearFilter();
  clearStockFilter();

  const raw=$('#search').value.trim();
  const q=normalizeSearchText(raw);
  if(!q){hideResultPanel();return;}

  const allCaves=!!$('#searchAllCaves')?.checked;
  const currentCave=caveById(activeCaveId);

  const matches=refsWithLocations((r,p)=>{
    if(!allCaves && p.caveId!==activeCaveId) return false;

    const hay=[
      r.vin,r.domaine,r.producteur,r.appellation,r.millesime,
      r.couleur,r.format,p.emplacement,
      caveById(p.caveId)?.name,caveById(p.caveId)?.code,
      `casier ${p.casier}`,`ligne ${p.ligne}`,`position ${p.position}`
    ].join(' ');

    return normalizeSearchText(hay).includes(q);
  });

  const items=groupedResultItems(matches);
  const scopeLabel=allCaves
    ? `${config.caves.length} cave${config.caves.length>1?'s':''}`
    : `${currentCave?.code||''}${currentCave?.name?` · ${currentCave.name}`:''}`;

  showResultPanel(
    `${items.length} vin${items.length>1?'s':''} · ${matches.length} bouteille${matches.length>1?'s':''} · ${scopeLabel} · « ${raw} »`,
    items
  );
}
function showVintageResults(year){
  clearMaturityFilter();
  clearYearFilter();
  clearStockFilter();
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
    caveId:x.caveId||activeCaveId,
    caveName:caveById(x.caveId)?.name||'',
    caveCode:caveById(x.caveId)?.code||'',
    emplacement:x.emplacement||positionLabel(caveById(x.caveId),x.casier,x.ligne,x.position),
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

  const annotatedOnly=!!$('#consumptionAnnotatedOnly')?.checked;
  const q=normalizeSearchText($('#consumptionSearch')?.value||'');

  return consumed.filter(item=>{
    const d=new Date(item.drunkAt);
    if(Number.isNaN(d.getTime())) return false;
    if(range.start && d<range.start) return false;
    if(range.end && d>=range.end) return false;
    if(annotatedOnly && !String(item.comment||'').trim()) return false;

    if(q){
      const hay=normalizeSearchText([
        item.vin,
        item.domaine,
        item.millesime,
        item.couleur,
        item.format,
        item.caveName,
        item.caveCode,
        item.emplacement,
        item.bulkLocation,
        item.comment
      ].filter(Boolean).join(' '));

      if(!hay.includes(q)) return false;
    }

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
  if(rating==='verygood') return '<span class="rating-icon" title="Excellent · +2">👍👍</span>';
  if(rating==='good') return '<span class="rating-icon" title="Bon · +1">👍</span>';
  if(rating==='bad') return '<span class="rating-icon" title="Nul · −1">👎</span>';
  if(rating==='verybad') return '<span class="rating-icon" title="Très nul · −2">👎👎</span>';
  return '';
}

function setConsumedRating(id,rating){
  const entry=consumed.find(e=>e.id===id);
  if(!entry) return;
  entry.rating=['verygood','good','bad','verybad'].includes(rating)?rating:'neutral';
  persist('Note d’un vin modifiée');
  renderConsumption();
}

function setConsumedComment(id,comment){
  const entry=consumed.find(e=>e.id===id);
  if(!entry) return;
  entry.comment=String(comment||'').trim();
  persist('Commentaire d’un vin modifié');
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
        verygood:0,
        good:0,
        bad:0,
        verybad:0,
        neutral:0
      });
    }

    const g=groups.get(key);
    g.total++;

    const rating=['verygood','good','bad','verybad'].includes(e.rating)?e.rating:'neutral';
    if(rating==='verygood') g.verygood++;
    else if(rating==='good') g.good++;
    else if(rating==='bad') g.bad++;
    else if(rating==='verybad') g.verybad++;
    else g.neutral++;
  });

  return [...groups.values()].map(g=>{
    const raw=(g.verygood*2)+g.good-g.bad-(g.verybad*2);
    const score=g.total ? (raw/g.total)*100 : 0;
    return {...g,raw,score};
  }).sort((a,b)=>{
    if(b.score!==a.score) return b.score-a.score;
    if(b.verygood!==a.verygood) return b.verygood-a.verygood;
    if(b.good!==a.good) return b.good-a.good;
    if(a.verybad!==b.verybad) return a.verybad-b.verybad;
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
            ${g.total} bue${g.total>1?'s':''} · 👍👍 ${g.verygood} · 👍 ${g.good} · 👎 ${g.bad} · 👎👎 ${g.verybad} · neutre ${g.neutral}
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

function saleRange(){
  const mode=$('#salesPeriod')?.value||'current';
  const now=new Date();
  if(mode==='all') return {start:null,end:null};
  if(mode==='custom'){
    const from=$('#salesFrom').value,to=$('#salesTo').value;
    if(!from||!to) return {start:null,end:null,invalid:true};
    let [fy,fm]=from.split('-').map(Number),[ty,tm]=to.split('-').map(Number);
    let a=new Date(fy,fm-1,1),b=new Date(ty,tm,1);
    if(a>b){const t=a;a=new Date(ty,tm-1,1);b=new Date(fy,fm,1);}
    return {start:a,end:b};
  }
  const first=new Date(now.getFullYear(),now.getMonth(),1),next=new Date(now.getFullYear(),now.getMonth()+1,1);
  if(mode==='current') return {start:first,end:next};
  if(mode==='previous') return {start:new Date(now.getFullYear(),now.getMonth()-1,1),end:first};
  const months=Math.max(1,Number(mode)||1);
  return {start:new Date(now.getFullYear(),now.getMonth()-(months-1),1),end:next};
}
function filteredSales(){
  const range=saleRange();
  if(range.invalid) return [];

  const periodItems=sales.filter(e=>{
    const d=new Date(e.soldAt);
    if(Number.isNaN(d.getTime())) return false;
    if(range.start && d<range.start) return false;
    if(range.end && d>=range.end) return false;
    return true;
  });

  const q=normalizeSearchText($('#salesSearch')?.value||'');
  if(!q){
    return periodItems.sort((a,b)=>new Date(b.soldAt)-new Date(a.soldAt));
  }

  // Si une bouteille ou le client correspond à la recherche, on conserve
  // toute la transaction afin de ne pas casser l'affichage groupé de la vente.
  const matchingTransactions=new Set();

  periodItems.forEach(e=>{
    const hay=normalizeSearchText([
      e.client,
      e.vin,
      e.domaine,
      e.millesime,
      e.couleur,
      e.format,
      e.caveName,
      e.caveCode,
      e.emplacement,
      e.bulkLocation
    ].filter(Boolean).join(' '));

    if(hay.includes(q)){
      matchingTransactions.add(e.transactionId||e.id);
    }
  });

  return periodItems
    .filter(e=>matchingTransactions.has(e.transactionId||e.id))
    .sort((a,b)=>new Date(b.soldAt)-new Date(a.soldAt));
}
function initSalesPeriod(){
  const m=localMonthValue();
  if($('#salesFrom')&&!$('#salesFrom').value)$('#salesFrom').value=m;
  if($('#salesTo')&&!$('#salesTo').value)$('#salesTo').value=m;
  if($('#salesCustom'))$('#salesCustom').hidden=$('#salesPeriod')?.value!=='custom';
}
function saleTargetsData(){
  return saleTargets.filter(x=>x?.refId&&ref(x.refId)).map(x=>({x,r:ref(x.refId)}));
}
function openSaleDialog(targets,direct=false){
  if(!moduleEnabled('sales')) return;
  saleTargets=(targets||[]).filter(x=>x?.refId&&ref(x.refId));
  if(!saleTargets.length)return;
  $('#saleClient').value='';
  $('#saleDate').value=new Date().toISOString().slice(0,10);
  $('#saleCommonPrice').value='';
  $('#saleRows').innerHTML=saleTargetsData().map(({x,r})=>`
    <div class="sale-row" data-sale-key="${esc(slotKey(x))}">
      <div class="sale-wine wine-color ${wineClass(r.couleur)}">
        <b>${esc(r.vin)}${r.millesime?` · ${esc(r.millesime)}`:''}</b>
        <span>${esc(r.domaine||'')} · ${esc(x.emplacement)}</span>
        <small>Achat : ${Number(r.prix)>0?euro(r.prix):'non renseigné'}</small>
      </div>
      <label>Vente (€)<input class="sale-price" inputmode="decimal" placeholder="0,00"></label>
    </div>
  `).join('');
  renderSalePreview();
  if(direct||dialogHistory)$('#saleDialog').showModal();else showDialog($('#saleDialog'));
}
function renderSalePreview(){
  let revenue=0,cost=0,profit=0,known=0,unknown=0;
  saleTargetsData().forEach(({r},i)=>{
    const input=$$('.sale-price')[i];
    const sp=Number(String(input?.value||'').replace(',','.'))||0;
    revenue+=sp;
    const cp=Number(r.prix)||0;
    if(cp>0){cost+=cp;profit+=sp-cp;known++;}else unknown++;
  });
  $('#salePreview').innerHTML=`<b>CA ${euro(revenue)}</b><span>Coût connu ${euro(cost)} · Bénéfice ${profit>=0?'+':''}${euro(profit)}${unknown?` · ${unknown} non calculable${unknown>1?'s':''}`:''}</span>`;
}
function confirmSale(){
  const client=$('#saleClient').value.trim();
  const date=$('#saleDate').value;
  if(!client)return alert('Indique le client.');
  if(!date)return alert('Indique la date de vente.');
  const data=saleTargetsData();
  const inputs=$$('.sale-price');
  if(inputs.length!==data.length)return;
  const prices=inputs.map(i=>{
    const raw=i.value.trim();if(raw==='')return null;
    const v=Number(raw.replace(',','.'));return Number.isFinite(v)&&v>=0?v:null;
  });
  if(prices.some(v=>v===null))return alert('Indique un prix de vente pour chaque bouteille.');

  const tx=`sale_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const soldAt=new Date(`${date}T12:00:00`).toISOString();
  const soldBulkIds=[];
  data.forEach(({x,r},i)=>{
    const cave=caveById(x.caveId),costPrice=Number(r.prix)||0,costKnown=costPrice>0,salePrice=prices[i];
    sales.push({
      id:`s${Date.now()}_${i}_${Math.random().toString(36).slice(2,5)}`,
      transactionId:tx,soldAt,client,
      refId:r.id||'',vin:r.vin||'',domaine:r.domaine||'',millesime:r.millesime||'',couleur:r.couleur||'',format:r.format||'',
      costPrice,costKnown,salePrice,profit:costKnown?salePrice-costPrice:null,
      caveId:x.caveId,caveName:cave?.name||'',caveCode:cave?.code||'',
      casier:x.casier||0,ligne:x.ligne||0,position:x.position||0,emplacement:x.emplacement,
      bulk:!!x.bulk,bulkLocation:x.locationText||''
    });
    if(x.bulk) soldBulkIds.push(x.id);
    else x.refId=null;
  });
  if(soldBulkIds.length) removeBulkIds(soldBulkIds);
  const n=data.length;
  clearOccupiedSelection();exitTargets=[];saleTargets=[];
  persist();render();renderSales();
  if($('#saleDialog').open)requestClose($('#saleDialog'));
  setTimeout(()=>alert(`${n} bouteille${n>1?'s vendues':' vendue'} à ${client}.`),100);
}
function renderSales(){
  if(!$('#salesList')||!moduleEnabled('sales'))return;

  const items=filteredSales();
  let revenue=0,cost=0,profit=0,unknown=0;

  items.forEach(e=>{
    revenue+=Number(e.salePrice)||0;
    if(e.costKnown){
      cost+=Number(e.costPrice)||0;
      profit+=Number(e.profit)||0;
    }else{
      unknown++;
    }
  });

  $('#salesCount').textContent=items.length;
  $('#salesRevenue').textContent=euro(revenue);
  $('#salesCost').textContent=euro(cost);
  $('#salesProfit').textContent=`${profit>=0?'+':''}${euro(profit)}`;
  $('#salesProfit').className=profit>0?'positive':profit<0?'negative':'neutral';

  $('#salesUnknown').textContent=unknown
    ? `${unknown} bouteille${unknown>1?'s':''} : bénéfice non calculable car le prix d’achat manque.`
    : '';

  const list=$('#salesList');
  if(!items.length){
    list.innerHTML='<div class="sales-empty">Aucune vente sur cette période.</div>';
    return;
  }

  // Une transaction = un seul bloc. Les bouteilles ne sont visibles qu'en ouvrant le détail.
  const txs=new Map();
  items.forEach(e=>{
    const key=e.transactionId||e.id;
    if(!txs.has(key)) txs.set(key,[]);
    txs.get(key).push(e);
  });

  list.innerHTML=[...txs.values()].map((entries,index)=>{
    const first=entries[0];
    const txRevenue=entries.reduce((s,e)=>s+(Number(e.salePrice)||0),0);
    const known=entries.filter(e=>e.costKnown);
    const txCost=known.reduce((s,e)=>s+(Number(e.costPrice)||0),0);
    const txProfit=known.reduce((s,e)=>s+(Number(e.profit)||0),0);
    const unknownCount=entries.length-known.length;
    const avgSale=entries.length ? txRevenue/entries.length : 0;
    const avgProfit=known.length ? txProfit/known.length : 0;
    const detailId=`saleTxDetail${index}`;
    const date=new Date(first.soldAt);
    const dateLabel=Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});

    const profitLabel=known.length===entries.length
      ? `${txProfit>=0?'+':''}${euro(txProfit)}`
      : `${txProfit>=0?'+':''}${euro(txProfit)} + ${unknownCount} non calculable${unknownCount>1?'s':''}`;

    return `<article class="sale-history-card sale-transaction-card">
      <button type="button" class="sale-transaction-summary" data-sale-tx-toggle="${detailId}">
        <div class="sale-tx-client">
          <span class="sale-tx-label">Client</span>
          <b>${esc(first.client||'Non renseigné')}</b>
          <small>${esc(dateLabel)}</small>
        </div>

        <div class="sale-tx-count">
          <span class="sale-tx-label">Quantité</span>
          <b>${entries.length}</b>
          <small>bouteille${entries.length>1?'s':''}</small>
        </div>

        <div class="sale-tx-finance">
          <div>
            <span>Montant de la vente</span>
            <b>${euro(txRevenue)}</b>
          </div>
          <div>
            <span>Bénéfice réalisé</span>
            <b class="${txProfit>0?'positive':txProfit<0?'negative':'neutral'}">${profitLabel}</b>
          </div>
        </div>

        <div class="sale-tx-open">
          <span>Voir le détail</span>
          <b>⌄</b>
        </div>
      </button>

      <div id="${detailId}" class="sale-transaction-detail" hidden>
        <div class="sale-tx-detail-summary">
          <div><span>Coût d’achat connu</span><b>${euro(txCost)}</b></div>
          <div><span>Prix moyen / bouteille</span><b>${euro(avgSale)}</b></div>
          <div><span>Bénéfice moyen*</span><b>${known.length?`${avgProfit>=0?'+':''}${euro(avgProfit)}`:'?'}</b></div>
        </div>

        <div class="sale-tx-detail-note">* calculé uniquement sur les bouteilles dont le prix d’achat est connu.</div>

        <div class="sale-history-lines">
          ${entries.map((e,i)=>`
            <div class="sale-history-line">
              <div class="sale-line-number">${i+1}</div>
              <div class="sale-line-wine">
                <b>${esc(e.vin||'Vin')}${e.millesime?` · ${esc(e.millesime)}`:''}</b>
                ${e.domaine?`<span>${esc(e.domaine)}</span>`:''}
                <small>${esc(e.caveCode||'')}${e.emplacement?` · ${esc(e.emplacement)}`:''}</small>
              </div>
              <div class="sale-line-money">
                <div><span>Vente</span><b>${euro(e.salePrice)}</b></div>
                <div><span>Achat</span><b>${e.costKnown?euro(e.costPrice):'?'}</b></div>
                <div><span>Bénéfice</span><b class="${Number(e.profit)>0?'positive':Number(e.profit)<0?'negative':'neutral'}">${e.costKnown?`${Number(e.profit)>=0?'+':''}${euro(e.profit)}`:'?'}</b></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </article>`;
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
              <div class="consumed-entry-top">
                <b class="consumed-entry-date">${new Date(e.drunkAt).toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'})}${ratingIcon(e.rating||'neutral')}</b>
                <div class="consumed-entry-actions">
                  <button type="button" class="comment-open" data-comment-open="${esc(e.id)}" title="${e.comment?'Modifier le commentaire':'Annoter'}"><span class="action-icon">📝</span><span class="action-label">${e.comment?'Modifier':'Annoter'}</span></button>
                  <div class="vote-wrap">
                    <button type="button" class="vote-open" data-vote-open="${esc(e.id)}">
                      <span class="action-label">Voter</span>${ratingIcon(e.rating||'neutral')}
                    </button>
                    <div class="consumed-rating-edit" data-vote-choices="${esc(e.id)}" hidden>
                      <button type="button" class="${(e.rating||'neutral')==='verybad'?'active verybad':''}" data-rating-id="${esc(e.id)}" data-rating-value="verybad" title="Très nul · −2">👎👎</button>
                      <button type="button" class="${(e.rating||'neutral')==='bad'?'active bad':''}" data-rating-id="${esc(e.id)}" data-rating-value="bad" title="Nul · −1">👎</button>
                      <button type="button" class="${(e.rating||'neutral')==='neutral'?'active neutral':''}" data-rating-id="${esc(e.id)}" data-rating-value="neutral" title="Neutre · 0">•</button>
                      <button type="button" class="${(e.rating||'neutral')==='good'?'active good':''}" data-rating-id="${esc(e.id)}" data-rating-value="good" title="Bon · +1">👍</button>
                      <button type="button" class="${(e.rating||'neutral')==='verygood'?'active verygood':''}" data-rating-id="${esc(e.id)}" data-rating-value="verygood" title="Excellent · +2">👍👍</button>
                    </div>
                  </div>
                  <button type="button" class="restore-consumed" data-consumed-id="${esc(e.id)}" title="Remettre en cave">↩</button>
                </div>
              </div>
              <small class="consumed-entry-meta">${esc(e.emplacement||'Emplacement inconnu')} · ${euro(e.prix)}</small>
              ${e.comment?`<span class="consumed-comment">📝 ${esc(e.comment)}</span>`:''}
              <div class="comment-editor" data-comment-editor="${esc(e.id)}" hidden>
                <textarea maxlength="500" placeholder="Commentaire de dégustation…">${esc(e.comment||'')}</textarea>
                <div><button type="button" data-comment-save="${esc(e.id)}">Enregistrer</button><button type="button" data-comment-cancel="${esc(e.id)}">Annuler</button></div>
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

  const desiredCaveId=entry.caveId||config.caves[0].id;
  if(entry.bulk){
    const rid=ensureRefForConsumed(entry);
    bulk.push({
      id:`bulk_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      caveId:desiredCaveId,
      refId:rid,
      locationText:entry.bulkLocation!==undefined
        ? String(entry.bulkLocation||'').trim()
        : String(entry.emplacement||'').replace(/^.*?Vrac\s*·?\s*/i,'').replace(/^Emplacement non renseigné$/i,'').trim(),
      addedAt:new Date().toISOString(),
      bulk:true
    });
    consumed=consumed.filter(e=>e.id!==id);
    activeCaveId=desiredCaveId;
    persist();render();
    alert(`Bouteille remise en vrac : ${bulkLocationLabel(entry.bulkLocation)}.`);
    return;
  }
  const original=inv.find(x=>
    x.caveId===desiredCaveId &&
    x.casier===entry.casier && x.ligne===entry.ligne && x.position===entry.position
  );

  let target=(original && !original.refId) ? original : null;
  if(!target) target=inv.find(x=>x.caveId===desiredCaveId && x.casier===entry.casier && !x.refId);
  if(!target) target=inv.find(x=>x.caveId===desiredCaveId && !x.refId);
  if(!target) target=inv.find(x=>!x.refId);
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
  activeCaveId=target.caveId;
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


function createBulkEntries(refId,caveId,locationText,qty){
  const n=Math.max(1,Math.min(999,Number(qty)||1));
  const loc=String(locationText||'').trim();
  for(let i=0;i<n;i++){
    bulk.push({
      id:`bulk_${Date.now()}_${i}_${Math.random().toString(36).slice(2,6)}`,
      caveId,refId,locationText:loc,addedAt:new Date().toISOString(),bulk:true
    });
  }
  return n;
}

function bulkGroupKey(x){
  return `${x.caveId}|${x.refId}|${normalizeSearchText(x.locationText||'')||'__sans_emplacement__'}`;
}

function renderBulk(){
  if(!$('#bulkList')) return;
  const panel=$('#bulkPanel');
  panel.hidden=!moduleEnabled('bulk');
  if(panel.hidden) return;
  const cave=activeCave();
  $('#bulkCaveLabel').textContent=cave?`${cave.code} · ${cave.name}`:'';

  if($('#openBulkAdd')) $('#openBulkAdd').hidden=!!moveSource?.items?.length;
  if($('#moveToBulk')) $('#moveToBulk').hidden=!moveSource?.items?.length;

  const items=bulk.filter(x=>x.caveId===activeCaveId&&x.refId&&ref(x.refId));
  const groups=new Map();
  items.forEach(x=>{
    const k=bulkGroupKey(x);
    if(!groups.has(k)) groups.set(k,{sample:x,items:[]});
    groups.get(k).items.push(x);
  });
  const list=$('#bulkList');
  if(!groups.size){
    list.innerHTML='<div class="bulk-empty">Aucune bouteille en vrac dans cette cave.</div>';
    return;
  }
  list.innerHTML=[...groups.values()].map(({sample,items})=>{
    const r=ref(sample.refId);
    return `<button type="button" class="bulk-card wine-color ${wineClass(r.couleur)}" data-bulk-open="${esc(sample.id)}">
      <span class="bulk-qty">×${items.length}</span>
      <b>${esc(r.vin)}${r.millesime?` · ${esc(r.millesime)}`:''}</b>
      ${isMagnumFormat(r.format)?'<em class="magnum-badge bulk-magnum-badge">Magnum</em>':''}
      <span>${esc(r.domaine||'')}</span>
      <small>📍 ${esc(bulkLocationLabel(sample.locationText))} · ${euro((Number(r.prix)||0)*items.length)}</small>
    </button>`;
  }).join('');
}

function renderBulkPickResults(){
  const q=normalizeSearchText($('#bulkPickSearch')?.value||'');
  const matches=refs.filter(r=>!q||addReferenceSearchText(r).includes(q)).slice().sort((a,b)=>String(a.vin||'').localeCompare(String(b.vin||''),'fr',{sensitivity:'base'}));
  const list=$('#bulkPickResults');
  if(!list) return;
  if(!matches.length){list.innerHTML='<div class="pick-empty">Aucun vin trouvé.</div>';$('#bulkUseRef').disabled=true;return;}
  list.innerHTML=matches.map(r=>`<button type="button" class="bulk-pick-result wine-color ${wineClass(r.couleur)} ${r.id===pendingBulkRefId?'active':''}" data-bulk-pick="${esc(r.id)}"><b>${esc(r.vin)}${r.millesime?` · ${esc(r.millesime)}`:''}</b><span>${esc(r.domaine||'')}</span></button>`).join('');
  $('#bulkUseRef').disabled=!pendingBulkRefId;
}

function openBulkAdd(){
  if(!moduleEnabled('bulk')) return;
  const cave=activeCave();
  pendingBulkRefId='';
  $('#bulkAddCave').textContent=`${cave.code} · ${cave.name}`;
  $('#bulkQty').value='6';
  $('#bulkLocation').value='';
  $('#bulkPickSearch').value='';
  renderBulkPickResults();
  showDialog($('#bulkAddDialog'));
}

function bulkAddValues(){
  const qty=Math.max(1,Math.min(999,Number($('#bulkQty').value)||0));
  const location=$('#bulkLocation').value.trim();
  if(!qty){alert('Indique la quantité.');return null;}
  return {qty,location,caveId:activeCaveId};
}

function openBulkVoiceAdd(){
  if(!moduleEnabled('bulk')) return;
  const v=bulkAddValues();
  if(!v) return;

  bulkDraft=v;
  pendingBulkRefId='';
  selected={
    bulk:true,
    caveId:v.caveId,
    refId:null,
    emplacement:`${caveById(v.caveId)?.code||''} · Vrac · ${bulkLocationLabel(v.location)}`,
    locationText:v.location
  };
  editScope='newbulkvoice';

  clearVoiceForm();
  $('#voiceStatus').textContent=
    `Vrac : ${v.qty} bouteille${v.qty>1?'s':''} · ${bulkLocationLabel(v.location)}. Appuyez sur le micro puis dictez les informations avec leurs mots-clés : Domaine, Cuvée, Année, Prix, Couleur, Format.`;

  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  $('#voiceStart').disabled=!SpeechRecognition;
  if(!SpeechRecognition){
    $('#voiceStatus').textContent=
      `Vrac : ${v.qty} bouteille${v.qty>1?'s':''} · ${bulkLocationLabel(v.location)}. La dictée vocale n’est pas disponible ici ; vous pouvez remplir les 6 champs manuellement.`;
  }

  $('#bulkAddDialog').close();
  showDialog($('#voiceDialog'));
}

function openBulkGroup(id){
  const seed=bulk.find(x=>x.id===id);
  if(!seed) return;
  const ids=bulk.filter(x=>bulkGroupKey(x)===bulkGroupKey(seed)).map(x=>x.id);
  bulkActionIds=ids;
  const r=ref(seed.refId),cave=caveById(seed.caveId);
  $('#bulkActionTitle').textContent=r?.vin||'Vin en vrac';
  $('#bulkActionInfo').innerHTML=`<b>${esc(r?.vin||'Vin')}${r?.millesime?` · ${esc(r.millesime)}`:''}</b>${isMagnumFormat(r?.format)?'<em class="magnum-badge bulk-magnum-badge">Magnum</em>':''}<span>${esc(r?.domaine||'')}</span><small>${esc(cave?.code||'')} · 📍 ${esc(bulkLocationLabel(seed.locationText))} · ${ids.length} bouteille${ids.length>1?'s':''}</small>`;
  $('#bulkActionQty').max=ids.length;
  $('#bulkActionQty').value=ids.length;
  $('#bulkActionSell').hidden=!moduleEnabled('sales');
  showDialog($('#bulkActionDialog'));
}

function selectedBulkActionItems(){
  const n=Math.max(1,Math.min(bulkActionIds.length,Number($('#bulkActionQty').value)||1));
  const wanted=new Set(bulkActionIds.slice(0,n));
  return bulk.filter(x=>wanted.has(x.id));
}

function removeBulkIds(ids){
  const set=new Set(ids);
  bulk=bulk.filter(x=>!set.has(x.id));
}

function openDrinkRatingDialog(targets){
  drinkTargets=(targets||[]).filter(t=>t?.item?.refId&&ref(t.item.refId));
  if(!drinkTargets.length) return;

  const firstRef=ref(drinkTargets[0].item.refId);
  const sameWine=drinkTargets.every(t=>t.item.refId===drinkTargets[0].item.refId);

  $('#drinkRatingTitle').textContent=drinkTargets.length>1
    ? `🍷 ${drinkTargets.length} bouteilles bues`
    : '🍷 Bouteille bue';

  $('#drinkRatingInfo').textContent=drinkTargets.length===1
    ? [firstRef?.vin,firstRef?.millesime,firstRef?.domaine].filter(Boolean).join(' · ')
    : (sameWine
        ? `${firstRef?.vin||'Vin'}${firstRef?.millesime?` · ${firstRef.millesime}`:''} · ${drinkTargets.length} bouteilles`
        : `${drinkTargets.length} bouteilles sélectionnées`);

  // On ferme la fiche précédente, mais on conserve l'état d'historique Android.
  if($('#dialog').open) $('#dialog').close();
  if($('#bulkActionDialog').open) $('#bulkActionDialog').close();

  if(dialogHistory) $('#drinkRatingDialog').showModal();
  else showDialog($('#drinkRatingDialog'));
}

function finalizeDrinkRating(rating='neutral'){
  if(!drinkTargets.length) return;

  const validRating=['verygood','good','bad','verybad'].includes(rating)?rating:'neutral';
  const bulkIds=[];

  drinkTargets.forEach(({item})=>{
    const r=ref(item.refId);
    if(!r) return;

    const source=item.bulk?bulkTarget(item):item;
    const snap=consumedSnapshot(source,r);
    snap.rating=validRating;
    snap.comment='';

    if(item.bulk){
      snap.bulk=true;
      snap.bulkLocation=String(item.locationText||'').trim();
      bulkIds.push(item.id);
    }

    consumed.push(snap);

    if(!item.bulk){
      item.refId=null;
    }
  });

  if(bulkIds.length) removeBulkIds(bulkIds);

  const n=drinkTargets.length;
  drinkTargets=[];
  bulkActionIds=[];
  persist();
  render();

  if($('#drinkRatingDialog').open) requestClose($('#drinkRatingDialog'));
  setTimeout(()=>alert(`${n} bouteille${n>1?'s':''} enregistrée${n>1?'s':''} comme bue${n>1?'s':''}.`),80);
}

function drinkBulkSelection(){
  const items=selectedBulkActionItems();
  if(!items.length) return;
  openDrinkRatingDialog(items.map(item=>({item})));
}

function removeBulkSelection(){
  const items=selectedBulkActionItems();
  if(!items.length) return;
  if(!confirm(`Sortir ${items.length} bouteille${items.length>1?'s':''} du stock vrac sans vente ?`)) return;
  removeBulkIds(items.map(x=>x.id));
  bulkActionIds=[];
  persist();render();
  requestClose($('#bulkActionDialog'));
}

function moveDescriptorFromItem(item){
  if(!item||!item.refId) return null;
  return item.bulk
    ? {type:'bulk',id:item.id,refId:item.refId}
    : {type:'grid',key:slotKey(item),refId:item.refId};
}

function moveSourceItems(){
  if(!moveSource?.items?.length) return [];

  return moveSource.items.map(d=>{
    if(d.type==='bulk'){
      const item=bulk.find(x=>x.id===d.id&&x.refId===d.refId);
      return item ? {descriptor:d,item,ref:ref(item.refId)} : null;
    }

    const item=inv.find(x=>slotKey(x)===d.key&&x.refId===d.refId);
    return item ? {descriptor:d,item,ref:ref(item.refId)} : null;
  }).filter(x=>x&&x.ref);
}

function moveSourceCount(){
  return moveSource?.items?.length||0;
}

function isMoveSourceGridSlot(x){
  if(!moveSource?.items?.length) return false;
  const key=slotKey(x);
  return moveSource.items.some(d=>d.type==='grid'&&d.key===key);
}

function validMoveTargets(){
  return [...moveTargetKeys]
    .map(key=>inv.find(x=>slotKey(x)===key&&!x.refId))
    .filter(Boolean);
}

function updateMoveBanner(){
  const banner=$('#moveBanner');
  if(!banner) return;

  if(!moveSource?.items?.length){
    banner.hidden=true;
    document.body.classList.remove('move-mode');
    return;
  }

  const sources=moveSourceItems();
  const needed=moveSourceCount();

  if(sources.length!==needed){
    moveSource=null;
    moveTargetKeys.clear();
    banner.hidden=true;
    document.body.classList.remove('move-mode');
    return;
  }

  // Remove destinations that became occupied while navigating.
  [...moveTargetKeys].forEach(key=>{
    const x=inv.find(p=>slotKey(p)===key);
    if(!x||x.refId) moveTargetKeys.delete(key);
  });

  const selectedCount=moveTargetKeys.size;
  const first=sources[0]?.ref;

  banner.hidden=false;
  document.body.classList.add('move-mode');

  $('#moveBannerTitle').textContent=needed===1
    ? `📦 Déplacer : ${first.vin}${first.millesime?` · ${first.millesime}`:''}`
    : `📦 Déplacer ${needed} bouteilles`;

  if(needed===1){
    $('#moveBannerText').textContent=moduleEnabled('bulk')
      ? 'Navigue entre les caves/casiers puis touche une place vide, ou choisis « Déplacer ici » dans Vrac.'
      : 'Navigue entre les caves/casiers puis touche directement une place vide.';
    $('#confirmMoveTargets').hidden=true;
  }else{
    $('#moveBannerText').textContent=selectedCount===needed
      ? `${selectedCount}/${needed} destinations choisies · retouche une destination sélectionnée pour valider.`
      : (moduleEnabled('bulk')
          ? `${selectedCount}/${needed} destinations choisies · touche des places libres dans les caves/casiers, ou déplace tout le lot vers Vrac.`
          : `${selectedCount}/${needed} destinations choisies · touche des places libres dans les caves/casiers.`);
  }
}

function finishMoveMode(message){
  moveSource=null;
  moveTargetKeys.clear();
  selected=null;
  clearEmptySelection();
  clearOccupiedSelection();
  persist();
  render();
  if(dialogHistory) history.back();
  if(message) setTimeout(()=>alert(message),80);
}

function cancelMoveMode(){
  moveSource=null;
  moveTargetKeys.clear();
  selected=null;
  clearEmptySelection();
  clearOccupiedSelection();
  render();
  if(dialogHistory) history.back();
}

function beginMoveFromItems(items,sourceDialog=null){
  const descriptors=(items||[]).map(moveDescriptorFromItem).filter(Boolean);
  if(!descriptors.length) return;

  moveSource={items:descriptors};
  moveTargetKeys.clear();

  clearEmptySelection();
  clearOccupiedSelection();
  $('#search').value='';
  clearMaturityFilter();
  clearYearFilter();
  clearStockFilter();
  hideResultPanel();

  if(sourceDialog?.open) sourceDialog.close();
  if($('#dialog').open) $('#dialog').close();

  selected=null;
  render();
}

function beginMoveBottle(){
  if(!selected||!selected.refId) return;
  beginMoveFromItems([selected],$('#dialog'));
}

function beginMoveBatch(){
  const items=exitTargets.filter(x=>x?.refId&&ref(x.refId));
  if(!items.length) return;
  exitTargets=[];
  beginMoveFromItems(items,$('#batchExitDialog'));
}

function beginMoveBulkSelection(){
  const items=selectedBulkActionItems();
  if(!items.length) return;
  bulkActionIds=[];
  beginMoveFromItems(items,$('#bulkActionDialog'));
}

function moveSourcesToGrid(targets){
  const sources=moveSourceItems();
  const needed=moveSourceCount();

  if(!needed||sources.length!==needed){
    moveSource=null;
    moveTargetKeys.clear();
    render();
    return alert('Une des bouteilles à déplacer n’est plus disponible.');
  }

  const validTargets=(targets||[]).filter(x=>x&&!x.refId);
  if(validTargets.length!==needed){
    return alert(`Choisis exactement ${needed} emplacement${needed>1?'s':''} libre${needed>1?'s':''}.`);
  }

  // Save source references before modifying either stock.
  const assignments=sources.map((s,i)=>({
    source:s,
    target:validTargets[i],
    refId:s.item.refId
  }));

  assignments.forEach(a=>{ a.target.refId=a.refId; });

  const bulkIds=[];
  assignments.forEach(a=>{
    if(a.source.descriptor.type==='bulk') bulkIds.push(a.source.item.id);
    else a.source.item.refId=null;
  });
  if(bulkIds.length) removeBulkIds(bulkIds);

  const last=validTargets[validTargets.length-1];
  activeCaveId=last.caveId;
  activeCasier=last.casier;

  finishMoveMode(
    needed===1
      ? `Bouteille déplacée vers ${last.emplacement}.`
      : `${needed} bouteilles déplacées vers les emplacements sélectionnés.`
  );
}

function completeMoveToGrid(target){
  if(!moveSource?.items?.length || !target || target.refId) return;

  const needed=moveSourceCount();

  // Single bottle keeps the fast V3.1 behavior.
  if(needed===1){
    moveSourcesToGrid([target]);
    return;
  }

  const key=slotKey(target);

  if(moveTargetKeys.has(key)){
    if(moveTargetKeys.size===needed){
      openMoveConfirmDialog();
    }else{
      alert(`${moveTargetKeys.size}/${needed} destinations choisies. Choisis encore ${needed-moveTargetKeys.size} emplacement${needed-moveTargetKeys.size>1?'s':''}.`);
    }
    return;
  }

  if(moveTargetKeys.size>=needed){
    alert(`Tu as déjà choisi ${needed} destinations. Retouche une destination sélectionnée pour valider.`);
    return;
  }

  moveTargetKeys.add(key);
  render();
}

function openMoveConfirmDialog(){
  if(!moveSource?.items?.length) return;

  const sources=moveSourceItems();
  const targets=validMoveTargets();
  const needed=moveSourceCount();

  if(sources.length!==needed || targets.length!==needed){
    return alert(`Choisis exactement ${needed} destination${needed>1?'s':''} avant de valider.`);
  }

  $('#moveConfirmCount').textContent=`${needed} bouteille${needed>1?'s':''} seront déplacée${needed>1?'s':''}.`;
  $('#moveConfirmList').innerHTML=targets.map((t,i)=>{
    const r=sources[i]?.ref;
    return `<div class="move-confirm-row">
      <span class="move-confirm-number">${i+1}</span>
      <div>
        <b>${esc(r?.vin||'Vin')}${r?.millesime?` · ${esc(r.millesime)}`:''}</b>
        <small>→ ${esc(t.emplacement)}</small>
      </div>
    </div>`;
  }).join('');

  $('#moveConfirmDialog').showModal();
}

function confirmMoveTargets(){
  if(!moveSource?.items?.length) return;
  const targets=validMoveTargets();
  if($('#moveConfirmDialog').open) $('#moveConfirmDialog').close();
  moveSourcesToGrid(targets);
}

function openMoveToBulk(){
  if(!moveSource?.items?.length || !moduleEnabled('bulk')) return;

  const sources=moveSourceItems();
  if(sources.length!==moveSourceCount()){
    moveSource=null;
    moveTargetKeys.clear();
    render();
    return alert('Une des bouteilles à déplacer n’est plus disponible.');
  }

  const cave=activeCave();
  $('#moveBulkCave').textContent=`${cave.code} · ${cave.name}`;

  const sameBulkLocation=sources.length===1 &&
    sources[0].descriptor.type==='bulk' &&
    sources[0].item.caveId===activeCaveId;

  $('#moveBulkLocation').value=sameBulkLocation
    ? String(sources[0].item.locationText||'')
    : '';

  $('#moveBulkDialog').showModal();
}

function completeMoveToBulk(){
  if(!moveSource?.items?.length || !moduleEnabled('bulk')) return;

  const sources=moveSourceItems();
  const needed=moveSourceCount();

  if(sources.length!==needed){
    if($('#moveBulkDialog').open) $('#moveBulkDialog').close();
    moveSource=null;
    moveTargetKeys.clear();
    render();
    return alert('Une des bouteilles à déplacer n’est plus disponible.');
  }

  const location=$('#moveBulkLocation').value.trim();
  const cave=activeCave();

  sources.forEach(({descriptor,item})=>{
    if(descriptor.type==='bulk'){
      item.caveId=activeCaveId;
      item.locationText=location;
    }else{
      bulk.push({
        id:`bulk_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        caveId:activeCaveId,
        refId:item.refId,
        locationText:location,
        addedAt:new Date().toISOString(),
        bulk:true
      });
      item.refId=null;
    }
  });

  if($('#moveBulkDialog').open) $('#moveBulkDialog').close();

  finishMoveMode(
    needed===1
      ? `Bouteille déplacée vers ${cave.code} · Vrac · ${bulkLocationLabel(location)}.`
      : `${needed} bouteilles déplacées vers ${cave.code} · Vrac · ${bulkLocationLabel(location)}.`
  );
}

function slotKey(x){
  if(x?.bulk) return `bulk|${x.id}`;
  return positionKey(x.caveId,x.casier,x.ligne,x.position);
}

function emptyTargetsFromSelection(){
  return inv.filter(x=>selectedEmptyKeys.has(slotKey(x)) && !x.refId);
}

function clearEmptySelection(){
  selectedEmptyKeys.clear();
  emptyTapTimers.forEach(t=>clearTimeout(t));
  emptyTapTimers.clear();
}

function occupiedTargetsFromSelection(){
  return inv.filter(x=>selectedOccupiedKeys.has(slotKey(x)) && x.refId && ref(x.refId));
}
function clearOccupiedSelection(){
  selectedOccupiedKeys.clear();
  occupiedTapTimers.forEach(t=>clearTimeout(t));
  occupiedTapTimers.clear();
}
function toggleOccupiedSelection(x){
  if(!x.refId) return;
  clearEmptySelection();
  const key=slotKey(x);
  if(selectedOccupiedKeys.has(key)) selectedOccupiedKeys.delete(key);
  else selectedOccupiedKeys.add(key);
  render();
}
function prepareExitTargets(x){
  const selectedTargets=occupiedTargetsFromSelection();
  if(selectedOccupiedKeys.has(slotKey(x)) && selectedTargets.length) exitTargets=selectedTargets;
  else exitTargets=[x];
  selected=x;
}
function handleOccupiedSlotClick(x,r){
  if(moveSource?.items?.length){
    if(isMoveSourceGridSlot(x)) return;
    alert('Cet emplacement est déjà occupé. Choisis une place vide.');
    return;
  }

  const key=slotKey(x);
  const existing=occupiedTapTimers.get(key);
  if(existing){
    clearTimeout(existing); occupiedTapTimers.delete(key); toggleOccupiedSelection(x); return;
  }
  const timer=setTimeout(()=>{
    occupiedTapTimers.delete(key);
    if(selectedOccupiedKeys.has(key)) openBatchExitDialog(x);
    else editRef(x,r);
  },280);
  occupiedTapTimers.set(key,timer);
}
function openBatchExitDialog(x){
  prepareExitTargets(x);
  const items=exitTargets.map(p=>{
    const r=ref(p.refId);
    return `<div><b>${esc(r?.vin||'Vin')}</b><small>${esc(p.emplacement)}</small></div>`;
  }).join('');
  $('#batchExitCount').textContent=`${exitTargets.length} bouteille${exitTargets.length>1?'s':''} sélectionnée${exitTargets.length>1?'s':''}`;
  $('#batchExitList').innerHTML=items;
  showDialog($('#batchExitDialog'));
}

function toggleEmptySelection(x){
  if(x.refId) return;
  clearOccupiedSelection();
  const key=slotKey(x);
  if(selectedEmptyKeys.has(key)) selectedEmptyKeys.delete(key);
  else selectedEmptyKeys.add(key);
  render();
}

function handleEmptySlotClick(x){
  if(moveSource?.items?.length){
    completeMoveToGrid(x);
    return;
  }

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
  if(!caveById(activeCaveId)) activeCaveId=config.caves[0].id;
  const activeDef=activeCave();
  if(activeDef.casiers===0) activeCasier=0;
  else if(activeCasier<1 || activeCasier>activeDef.casiers) activeCasier=1;

  selectedEmptyKeys.forEach(key=>{
    const x=inv.find(p=>slotKey(p)===key);
    if(!x || x.refId) selectedEmptyKeys.delete(key);
  });
  selectedOccupiedKeys.forEach(key=>{
    const x=inv.find(p=>slotKey(p)===key);
    if(!x || !x.refId) selectedOccupiedKeys.delete(key);
  });

  renderStats();
  applyModuleVisibility();
  updateMoveBanner();
  renderBulk();
  const q=$('#search').value.trim().toLowerCase();
  const cave=activeCave();
  if(!cave) return;
  const g=$('#grid');
  g.style.setProperty('--bpl',cave.positions);
  g.innerHTML='';

  if(cave.casiers===0&&cave.lignes===0&&cave.positions===0){
    g.innerHTML='<div class="bulk-only-grid-message"><b>📦 Cave en vrac uniquement</b><span>Aucun casier n’est configuré pour cette cave.</span></div>';
  }

  inv.filter(x=>x.caveId===activeCaveId && x.casier===activeCasier).forEach(x=>{
    const r=ref(x.refId);
    const hay=r?[r.vin,r.domaine,r.millesime,r.couleur,r.format,x.emplacement].join(' ').toLowerCase():'';
    const b=document.createElement('button');
    b.type='button';
    b.dataset.line=x.ligne; b.dataset.pos=x.position;
    const isMultiSelected=!r && selectedEmptyKeys.has(slotKey(x));
    const isExitSelected=!!r && selectedOccupiedKeys.has(slotKey(x));
    const isMoveSource=isMoveSourceGridSlot(x);
    const isMoveTarget=!!moveSource?.items?.length && !r;
    const isMoveTargetSelected=isMoveTarget && moveTargetKeys.has(slotKey(x));
    b.className=`slot ${r?'occupied':'empty'}${isMultiSelected?' multi-selected':''}${isExitSelected?' exit-selected':''}${isMoveSource?' move-source':''}${isMoveTarget?' move-target':''}${isMoveTargetSelected?' move-target-selected':''}`;
    if(r){
      const wc=wineClass(r.couleur);
      const ac=ageClass(r.millesime);
      b.innerHTML=`
        ${isExitSelected?'<span class="exit-check">✓</span>':''}
        ${isMoveSource?'<span class="move-source-badge">Départ</span>':''}
        <span class="vintage-strip age-color ${ac}">${esc(r.millesime||'Sans année')}</span>
        <span class="slot-main wine-color ${wc}">
          <span class="pos">L${x.ligne}·P${x.position}</span>
          ${isMagnumFormat(r.format)?'<span class="magnum-badge">Magnum</span>':''}
          <span class="name">${esc(r.vin)}</span>
          ${r.domaine?`<span class="domain">${esc(r.domaine)}</span>`:''}
          ${maturityGaugeHtml(r)}
        </span>
      `;
    }else{
      b.innerHTML=`
        <span class="pos">L${x.ligne}·P${x.position}</span>
        <span class="name">${moveSource?.items?.length
          ? (isMoveTargetSelected ? `✓ Destination ${[...moveTargetKeys].indexOf(slotKey(x))+1} · toucher pour valider` : '→ Déplacer ici')
          : (isMultiSelected?'✓ Sélectionnée':'＋ Vide')}</span>
      `;
    }
    b.addEventListener('click',()=>r?handleOccupiedSlotClick(x,r):handleEmptySlotClick(x));
    g.appendChild(b);
  });
  $$('.tab').forEach(b=>b.classList.toggle('active',Number(b.dataset.c)===activeCasier));
  renderConsumption();
  if(moduleEnabled('sales')) renderSales();
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
  [$('#dialog'),$('#addDialog'),$('#voiceDialog'),$('#rankingDialog'),$('#photoDialog'),$('#configDialog'),$('#batchExitDialog'),$('#saleDialog'),$('#bulkAddDialog'),$('#bulkActionDialog'),$('#consumptionDialog'),$('#salesHistoryDialog'),$('#drinkRatingDialog'),$('#moveBulkDialog'),$('#moveConfirmDialog'),$('#undoHistoryDialog')].forEach(d=>{ if(d.open) d.close(); });
  dialogHistory=false;
  selected=null;
  pendingAddRefId='';
  editScope=null;
  addTargets=[];
  exitTargets=[];
  saleTargets=[];
  pendingBulkRefId='';bulkDraft=null;bulkActionIds=[];drinkTargets=[];moveSource=null;moveTargetKeys.clear();
  voiceExactRefId='';
  voiceSimilarRefId='';
  stopVoiceRecognition(true);
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
$('#batchExitDialog').addEventListener('click',backdropClose);
$('#saleDialog').addEventListener('click',backdropClose);
$('#bulkAddDialog').addEventListener('click',backdropClose);
$('#bulkActionDialog').addEventListener('click',backdropClose);

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
  $('#where').textContent=selected?.bulk?bulkTarget(selected).emplacement:selected.emplacement;

  const sameCount=inv.filter(p=>p.refId===r.id).length+bulk.filter(p=>p.refId===r.id).length;
  $('#editAllBottles').hidden=sameCount<2;
  $('#editAllBottles').textContent=`✏️ Toutes les bouteilles (×${sameCount})`;

  $('#bottleView').hidden=false;
  $('#bottleEdit').hidden=true;
  $('#viewActions').hidden=false;
  $('#editActions').hidden=true;
}


function sameWineIdentity(a,b){
  if(!a||!b) return false;
  return (
    normalizeSearchText(a.vin||'')===normalizeSearchText(b.vin||'') &&
    normalizeSearchText(a.domaine||'')===normalizeSearchText(b.domaine||'') &&
    String(a.millesime||'').trim()===String(b.millesime||'').trim() &&
    normalizeSearchText(a.couleur||'')===normalizeSearchText(b.couleur||'') &&
    normalizeSearchText(a.format||'')===normalizeSearchText(b.format||'')
  );
}

function identityUnchanged(original,vals){
  return sameWineIdentity(original,vals);
}

function currentIdenticalBottles(reference){
  const out=[];
  inv.forEach(x=>{
    if(!x.refId) return;
    const r=ref(x.refId);
    if(r && sameWineIdentity(r,reference)) out.push({kind:'grid',item:x,ref:r});
  });
  bulk.forEach(x=>{
    if(!x.refId) return;
    const r=ref(x.refId);
    if(r && sameWineIdentity(r,reference)) out.push({kind:'bulk',item:x,ref:r});
  });
  return out;
}

function applyMaturityToIdenticalBottles(reference,start,end){
  const matches=currentIdenticalBottles(reference);
  const refIds=new Set(matches.map(x=>x.ref.id));
  refs.forEach(r=>{
    if(refIds.has(r.id)){
      r.maturiteDebut=start;
      r.maturiteFin=end;
    }
  });
  return matches.length;
}

function showBottleEdit(r,scope='all'){
  editScope=scope;
  fill(r);

  const sameCount=inv.filter(p=>p.refId===r.id).length+bulk.filter(p=>p.refId===r.id).length;
  if(scope==='single'){
    $('#where').textContent=(selected?.bulk?bulkTarget(selected).emplacement:selected.emplacement)+' · modification de cette bouteille uniquement';
    $('#save').textContent='Enregistrer cette bouteille';
  }else{
    $('#where').textContent=(selected?.bulk?bulkTarget(selected).emplacement:selected.emplacement)+` · modification de ${sameCount} bouteille${sameCount>1?'s':''}`;
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
    const bulkCount=bulk.filter(p=>p.refId===r.id).length;
    const consumedCount=consumed.filter(e=>e.refId===r.id).length;
    const soldCount=sales.filter(e=>e.refId===r.id).length;
    const canDelete=usedCount===0 && bulkCount===0 && consumedCount===0 && soldCount===0;

    return `
      <div class="pick-result-row${canDelete?'':' no-delete'}">
        <button type="button"
                class="pick-result wine-color ${wineClass(r.couleur)} ${r.id===pendingAddRefId?'active':''}"
                data-pick-id="${esc(r.id)}">
          <b>${esc(r.vin)}${r.millesime?` · ${esc(r.millesime)}`:''}</b>
          <span>${esc(r.domaine||'Domaine non renseigné')}${r.format?` · ${esc(r.format)}`:''}</span>
          <small>
            ${usedCount} bouteille${usedCount>1?'s':''} en casier${bulkCount?` · ${bulkCount} en vrac`:''}
            ${consumedCount?` · ${consumedCount} bue${consumedCount>1?'s':''}`:''}${soldCount?` · ${soldCount} vendue${soldCount>1?'s':''}`:''}
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
  $('#voiceColor').value='';
  $('#voiceFormat').value='75 cl';
  $('#voiceMatch').hidden=true;
  $('#voiceMatch').className='voice-match';
  $('#voiceMatch').innerHTML='';
  $('#voiceContinue').disabled=true;
  $('#voiceStatus').textContent='Dicte une ou plusieurs informations avec leur mot-clé. Le format est déjà réglé sur 75 cl.';
  $('#voiceStart').textContent='🎤 Commencer la dictée';
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


function voiceMissingFields(){
  const fields=[
    ['domaine',$('#voiceDomaine').value.trim()],
    ['cuvée',$('#voiceCuvee').value.trim()],
    ['année',$('#voiceYear').value.trim()],
    ['prix',$('#voicePrice').value.trim()],
    ['couleur',$('#voiceColor').value.trim()],
    ['format',$('#voiceFormat').value.trim()]
  ];
  return fields.filter(([,value])=>!value).map(([name])=>name);
}

function voiceProgressText(){
  const values=[
    ['Domaine',$('#voiceDomaine').value.trim()],
    ['Cuvée',$('#voiceCuvee').value.trim()],
    ['Année',$('#voiceYear').value.trim()],
    ['Prix',$('#voicePrice').value.trim()],
    ['Couleur',$('#voiceColor').value.trim()],
    ['Format',$('#voiceFormat').value.trim()]
  ];
  return values.map(([name,value])=>value?`✓ ${name}`:`○ ${name}`).join(' · ');
}

function normalizeVoiceColor(value){
  const c=normalizeSearchText(value)
    .replace(/[,:;.\-]+$/g,'')
    .trim();

  const allowed={
    rouge:'Rouge',
    blanc:'Blanc',
    rose:'Rosé',
    effervescent:'Effervescent'
  };
  return allowed[c]||'';
}

function normalizeVoiceFormat(value){
  let f=normalizeSearchText(value)
    .replace(/,/g,'.')
    .replace(/\s+/g,' ')
    .replace(/[;:]+$/g,'')
    .trim();

  if(!f) return '';

  if(/\bmagnum\b/.test(f)) return 'Magnum';

  let m=f.match(/\b(\d+(?:\.\d+)?)\s*(cl|centilitres?|centilitre)\b/);
  if(m){
    const n=Number(m[1]);
    if(Number.isFinite(n) && n>0 && n<=1000){
      return `${Number.isInteger(n)?n:String(n).replace('.',',')} cl`;
    }
  }

  m=f.match(/\b(\d+(?:\.\d+)?)\s*(l|litres?|litre)\b/);
  if(m){
    const n=Number(m[1]);
    if(Number.isFinite(n) && n>0 && n<=10){
      return `${String(n).replace('.',',')} L`;
    }
  }

  return '';
}

function voiceKeywordMatches(text){
  const norm=normalizeSearchText(text)
    .replace(/[€]/g,' euros ')
    .replace(/\s+/g,' ')
    .trim();

  const keywordRe=/\b(domaine|cuvee|cuve|annee|millesime|prix|couleur|format)\b/g;
  const matches=[];
  let m;

  while((m=keywordRe.exec(norm))){
    const raw=m[1];
    let field=raw;
    if(raw==='cuvee'||raw==='cuve') field='cuvee';
    if(raw==='annee'||raw==='millesime') field='year';
    if(raw==='couleur') field='color';
    matches.push({field,index:m.index,end:m.index+m[0].length});
  }

  return {norm,matches};
}

function parseVoicePartial(text){
  const original=String(text||'').trim();
  if(!original) return {errors:[]};

  const {norm,matches}=voiceKeywordMatches(original);
  const result={errors:[]};

  // Tous les champs doivent avoir leur mot-clé. Aucun remplissage implicite.
  matches.forEach((match,i)=>{
    const end=i+1<matches.length ? matches[i+1].index : norm.length;
    let value=norm.slice(match.end,end)
      .trim()
      .replace(/^[,:;.\-]+|[,:;.\-]+$/g,'')
      .trim();

    if(!value){
      result.errors.push(`Aucune valeur après « ${match.field} »`);
      return;
    }

    if(match.field==='domaine'){
      result.domaine=value;
    }else if(match.field==='cuvee'){
      result.cuvee=value;
    }else if(match.field==='year'){
      const y=value.match(/\b(?:19|20)\d{2}\b/);
      if(y) result.year=y[0];
      else result.errors.push(`Année « ${value} » non reconnue`);
    }else if(match.field==='prix'){
      const p=value.match(/\d+(?:[.,]\d+)?/);
      if(p) result.price=normalizeVoiceNumber(p[0]);
      else result.errors.push(`Prix « ${value} » non reconnu`);
    }else if(match.field==='color'){
      const color=normalizeVoiceColor(value);
      if(color) result.color=color;
      else result.errors.push(`Couleur « ${value} » non reconnue (Rouge / Blanc / Rosé / Effervescent)`);
    }else if(match.field==='format'){
      const format=normalizeVoiceFormat(value);
      if(format) result.format=format;
      else result.errors.push(`Format « ${value} » non reconnu`);
    }
  });

  if(!matches.length){
    result.errors.push('Aucun mot-clé reconnu');
  }

  return result;
}

function applyVoicePartial(partial){
  if(!partial || typeof partial!=='object') return {count:0,errors:[]};

  let count=0;

  if(partial.domaine){
    $('#voiceDomaine').value=partial.domaine;
    count++;
  }
  if(partial.cuvee){
    $('#voiceCuvee').value=partial.cuvee;
    count++;
  }
  if(partial.year && /^(?:19|20)\d{2}$/.test(String(partial.year))){
    $('#voiceYear').value=partial.year;
    count++;
  }
  if(partial.price){
    $('#voicePrice').value=normalizeVoiceNumber(partial.price);
    count++;
  }
  if(partial.color){
    $('#voiceColor').value=partial.color;
    count++;
  }
  if(partial.format){
    $('#voiceFormat').value=partial.format;
    count++;
  }

  analyzeVoiceBottle();
  return {count,errors:Array.isArray(partial.errors)?partial.errors:[]};
}

function updateVoiceProgressStatus(prefix='',errors=[]){
  const missing=voiceMissingFields();
  const progress=voiceProgressText();
  const warning=errors.length ? ` · ⚠ ${errors.join(' · ')}` : '';

  if(!missing.length){
    $('#voiceStatus').textContent=
      `${prefix?prefix+' ':''}${progress} · Tout est renseigné. Vérifie puis appuie sur Continuer.${warning}`;
    return;
  }

  $('#voiceStatus').textContent=
    `${prefix?prefix+' ':''}${progress} · Il manque : ${missing.join(', ')}. Tu peux rappuyer sur le micro pour continuer.${warning}`;
}

function voiceBottleKey(v){
  return {
    domaine:normalizeSearchText(v.domaine||'').trim(),
    cuvee:normalizeSearchText(v.cuvee||v.vin||'').trim(),
    year:String(v.year||v.millesime||'').trim(),
    color:normalizeSearchText(v.color||v.couleur||'').trim(),
    format:normalizeSearchText(v.format||'75 cl').replace(/,/g,'.').replace(/\s+/g,' ').trim()
  };
}

function analyzeVoiceBottle(){
  const data={
    domaine:$('#voiceDomaine').value.trim(),
    cuvee:$('#voiceCuvee').value.trim(),
    year:$('#voiceYear').value.trim(),
    price:normalizeVoiceNumber($('#voicePrice').value),
    color:$('#voiceColor').value.trim(),
    format:$('#voiceFormat').value.trim()||'75 cl'
  };

  $('#voicePrice').value=data.price;
  $('#voiceFormat').value=data.format;

  const ready=!!(
    data.domaine &&
    data.cuvee &&
    /^\d{4}$/.test(data.year) &&
    data.price &&
    ['Rouge','Blanc','Rosé','Effervescent'].includes(data.color) &&
    data.format
  );
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
    return rk.domaine===key.domaine &&
      rk.cuvee===key.cuvee &&
      rk.year===key.year &&
      rk.color===key.color &&
      rk.format===key.format;
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
    $('#voiceStatus').textContent='La dictée vocale n’est pas disponible dans ce navigateur. Vous pouvez saisir les 6 champs manuellement.';
    $('#voiceStart').disabled=true;
  }else{
    $('#voiceStart').disabled=false;
  }

  $('#addDialog').close();
  showDialog($('#voiceDialog'));
}

function stopVoiceRecognition(abort=true){
  const current=voiceRecognition;
  voiceRecognition=null;

  if(current){
    try{
      if(abort) current.abort();
      else current.stop();
    }catch(e){}
  }

  $('#voiceStart')?.classList.remove('listening');
  if($('#voiceStart')) $('#voiceStart').textContent='🎤 Continuer la dictée';
}

function startVoiceRecognition(){
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRecognition){
    $('#voiceStatus').textContent='Reconnaissance vocale indisponible dans ce navigateur.';
    return;
  }

  // Empêche totalement plusieurs reconnaissances simultanées.
  if(voiceRecognition) return;

  const recognition=new SpeechRecognition();
  voiceRecognition=recognition;
  recognition.lang='fr-FR';

  // Retour au fonctionnement simple et stable :
  // une pression = une écoute, aucune relance automatique.
  recognition.continuous=false;
  recognition.interimResults=false;
  recognition.maxAlternatives=1;

  $('#voiceStart').classList.add('listening');
  $('#voiceStart').textContent='🎤 Écoute en cours…';
  $('#voiceStatus').textContent=
    `${voiceProgressText()} · Parle maintenant. Tu peux donner une seule information ou plusieurs.`;

  let gotResult=false;

  recognition.onresult=e=>{
    gotResult=true;
    const transcript=e.results?.[0]?.[0]?.transcript||'';
    $('#voiceTranscript').textContent=transcript||'—';

    const partial=parseVoicePartial(transcript);
    const applied=applyVoicePartial(partial);
    const {count,errors}=applied;

    if(count){
      updateVoiceProgressStatus(
        `${count} information${count>1?'s':''} ajoutée${count>1?'s':''}.`,
        errors
      );
    }else{
      updateVoiceProgressStatus('Je n’ai pas reconnu de nouvelle information.',errors);
    }
  };

  recognition.onerror=e=>{
    if(e.error==='aborted') return;

    const messages={
      'not-allowed':'Autorisation du microphone refusée.',
      'audio-capture':'Microphone indisponible.',
      'no-speech':'Aucune parole détectée. Les informations déjà saisies sont conservées.',
      'network':'La reconnaissance vocale n’a pas pu se connecter.'
    };

    $('#voiceStatus').textContent=
      messages[e.error]||'La dictée a échoué. Les informations déjà saisies sont conservées.';
  };

  recognition.onend=()=>{
    if(voiceRecognition===recognition) voiceRecognition=null;
    $('#voiceStart').classList.remove('listening');
    $('#voiceStart').textContent='🎤 Continuer la dictée';

    if(!gotResult){
      const missing=voiceMissingFields();
      if(missing.length){
        $('#voiceStatus').textContent=
          `${voiceProgressText()} · Il manque : ${missing.join(', ')}. Appuie sur le micro pour continuer.`;
      }
    }
  };

  try{
    recognition.start();
  }catch(e){
    voiceRecognition=null;
    $('#voiceStart').classList.remove('listening');
    $('#voiceStart').textContent='🎤 Continuer la dictée';
    $('#voiceStatus').textContent='Impossible de démarrer la dictée. Réessaie.';
  }
}

function continueVoiceBottle(){
  analyzeVoiceBottle();
  if($('#voiceContinue').disabled) return;
  stopVoiceRecognition(true);

  const domaine=$('#voiceDomaine').value.trim();
  const cuvee=$('#voiceCuvee').value.trim();
  const year=$('#voiceYear').value.trim();
  const price=Number(normalizeVoiceNumber($('#voicePrice').value))||0;
  const color=$('#voiceColor').value.trim();
  const format=$('#voiceFormat').value.trim()||'75 cl';

  if(voiceExactRefId){
    const r=ref(voiceExactRefId);

    if(editScope==='newbulkvoice' && bulkDraft){
      const count=createBulkEntries(
        voiceExactRefId,
        bulkDraft.caveId,
        bulkDraft.location,
        bulkDraft.qty
      );

      if(r && price>0 && !Number(r.prix)) r.prix=price;

      bulkDraft=null;
      editScope=null;
      selected=null;
      persist();
      render();
      requestClose($('#voiceDialog'));
      setTimeout(()=>alert(`${count} bouteille${count>1?'s':''} ajoutée${count>1?'s':''} en vrac.`),120);
      return;
    }

    // Ajout vocal normal dans les casiers.
    const count=applyRefToAddTargets(voiceExactRefId);
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
    couleur:color,
    format,
    prix:price,
    maturiteDebut:'',
    maturiteFin:''
  } : {
    id:'',
    domaine,
    vin:cuvee,
    millesime:year,
    couleur:color,
    format,
    prix:price,
    maturiteDebut:'',
    maturiteFin:''
  };

  const fromBulkVoice=editScope==='newbulkvoice' && !!bulkDraft;
  editScope=fromBulkVoice?'newbulk':'new';
  $('#dialogTitle').textContent='Nouveau vin';
  $('#where').textContent=fromBulkVoice
    ? `${selected.emplacement} · ${bulkDraft.qty} bouteille${bulkDraft.qty>1?'s':''}`
    : selected.emplacement+' · nouvelle référence';
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
  const bulkCount=bulk.filter(p=>p.refId===id).length;
  const consumedCount=consumed.filter(e=>e.refId===id).length;
  const soldCount=sales.filter(e=>e.refId===id).length;

  if(usedCount>0 || bulkCount>0 || consumedCount>0 || soldCount>0){
    const details=[];
    if(usedCount>0) details.push(`${usedCount} en casier`);
    if(bulkCount>0) details.push(`${bulkCount} en vrac`);
    if(consumedCount>0) details.push(`${consumedCount} dans l’historique des bouteilles bues`);
    if(soldCount>0) details.push(`${soldCount} dans l’historique des ventes`);
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

  // Chrome/Android focalise sinon automatiquement le champ Rechercher
  // et ouvre le clavier. À l'ouverture, on reste en consultation.
  requestAnimationFrame(()=>{
    const title=$('#addDialogTitle');
    if(title) title.focus({preventScroll:true});
  });
}

$('#addDialog').addEventListener('close',()=>{
  const search=$('#pickSearch');
  if(search) search.blur();
});

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
  stopVoiceRecognition(true);
  requestClose($('#voiceDialog'));
});
['voiceDomaine','voiceCuvee','voiceYear','voicePrice','voiceColor','voiceFormat'].forEach(id=>{
  $('#'+id).addEventListener('input',analyzeVoiceBottle);
  $('#'+id).addEventListener('change',analyzeVoiceBottle);
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
  let maturityPropagation=null;

  if(existed){
    const originalId=selected.refId;
    const original=ref(originalId);
    const sameCount=inv.filter(p=>p.refId===originalId).length+bulk.filter(p=>p.refId===originalId).length;

    const maturityChanged=
      String(original?.maturiteDebut||'')!==String(vals.maturiteDebut||'') ||
      String(original?.maturiteFin||'')!==String(vals.maturiteFin||'');

    // Même si une ancienne modification a déjà séparé une bouteille dans une
    // nouvelle référence, on retrouve les bouteilles identiques par
    // domaine + cuvée + millésime + couleur + format, en ignorant la maturité.
    const identicalBeforeSave =
      editScope==='single' && identityUnchanged(original,vals)
        ? currentIdenticalBottles(original)
        : [];

    if(editScope==='single' && maturityChanged && identicalBeforeSave.length>1){
      const maturityLabel=
        vals.maturiteDebut || vals.maturiteFin
          ? `${vals.maturiteDebut||'…'} → ${vals.maturiteFin||'…'}`
          : 'non renseignée';

      const applyToAll=confirm(
        `La maturité a été modifiée (${maturityLabel}).\n\n`+
        `Appliquer cette maturité aux ${identicalBeforeSave.length} bouteilles identiques ?\n\n`+
        `Oui = maturité pour toutes les bouteilles identiques.\n`+
        `Annuler = maturité uniquement pour cette bouteille.`
      );

      if(applyToAll){
        maturityPropagation={
          reference:{...original},
          start:vals.maturiteDebut,
          end:vals.maturiteFin
        };
      }
    }

    if(editScope==='single' && sameCount>1){
      // Dupliquer la référence : les autres champs restent propres à cette bouteille.
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

    if(maturityPropagation){
      applyMaturityToIdenticalBottles(
        maturityPropagation.reference,
        maturityPropagation.start,
        maturityPropagation.end
      );
    }
  }else{
    vals.id='r'+Date.now();
    refs.push(vals);

    if(editScope==='new' && addTargets.length){
      applyRefToAddTargets(vals.id);
    }else if(editScope==='newbulk' && bulkDraft){
      createBulkEntries(vals.id,bulkDraft.caveId,bulkDraft.location,bulkDraft.qty);
      bulkDraft=null;
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

$('#sellBottle').addEventListener('click',()=>{
  if(!moduleEnabled('sales')||!selected||!selected.refId)return;
  saleTargets=[selected?.bulk?bulkTarget(selected):selected];
  $('#dialog').close();
  openSaleDialog(saleTargets,true);
});

$('#batchMove').addEventListener('click',beginMoveBatch);
$('#batchSell').addEventListener('click',()=>{
  const targets=exitTargets.slice();
  $('#batchExitDialog').close();
  openSaleDialog(targets,true);
});
$('#batchRemove').addEventListener('click',()=>{
  const targets=exitTargets.filter(x=>x.refId);
  if(!targets.length)return;
  if(!confirm(`Sortir ${targets.length} bouteille${targets.length>1?'s':''} sans enregistrer de vente ?`))return;
  targets.forEach(x=>x.refId=null);
  clearOccupiedSelection();exitTargets=[];
  persist();render();
  requestClose($('#batchExitDialog'));
});
$('#batchCancel').addEventListener('click',()=>requestClose($('#batchExitDialog')));
$('#saleCancel').addEventListener('click',()=>requestClose($('#saleDialog')));
$('#saleConfirm').addEventListener('click',confirmSale);
$('#saleApplyCommon').addEventListener('click',()=>{
  const v=$('#saleCommonPrice').value.trim();
  if(v==='')return;
  $$('.sale-price').forEach(i=>i.value=v);
  renderSalePreview();
});
$('#saleRows').addEventListener('input',e=>{if(e.target.classList.contains('sale-price'))renderSalePreview();});

$('#consumed').addEventListener('click',()=>{
  if(!selected || !selected.refId) return;
  if(!ref(selected.refId)) return;
  openDrinkRatingDialog([{item:selected}]);
});

$('#moveBottle').addEventListener('click',beginMoveBottle);

$('#remove').addEventListener('click',()=>{
  if(!selected || !confirm('Sortir cette bouteille de la cave ?')) return;
  if(selected.bulk) removeBulkIds([selected.id]);
  else selected.refId=null;
  persist(); render();
  requestClose($('#dialog'));
});
$('#cancel').addEventListener('click',()=>requestClose($('#dialog')));
$('#cancelAdd').addEventListener('click',()=>requestClose($('#addDialog')));
['f_millesime','f_maturiteDebut','f_maturiteFin'].forEach(id=>$('#'+id).addEventListener('input',updateMaturityPreview));

$('#undoAction').addEventListener('click',undoLastAction);
$('#redoAction').addEventListener('click',redoLastAction);
$('#openUndoHistory').addEventListener('click',()=>{
  renderUndoHistory();
  $('#undoFromHistory').disabled=!historyState.undo.length;
  $('#redoFromHistory').disabled=!historyState.redo.length;
  showDialog($('#undoHistoryDialog'));
});
$('#undoHistoryClose').addEventListener('click',()=>requestClose($('#undoHistoryDialog')));
$('#undoHistoryDialog').addEventListener('click',backdropClose);
$('#undoFromHistory').addEventListener('click',()=>{
  undoLastAction();
  $('#undoFromHistory').disabled=!historyState.undo.length;
  $('#redoFromHistory').disabled=!historyState.redo.length;
  renderUndoHistory();
});
$('#redoFromHistory').addEventListener('click',()=>{
  redoLastAction();
  $('#undoFromHistory').disabled=!historyState.undo.length;
  $('#redoFromHistory').disabled=!historyState.redo.length;
  renderUndoHistory();
});

$('#openConfig').addEventListener('click',()=>openConfigDialog(false));
$('#configSave').addEventListener('click',applyConfiguration);
$('#configCancel').addEventListener('click',()=>{
  if(config) requestClose($('#configDialog'));
});
$('#cfgCaveCount').addEventListener('change',syncConfigCaveCount);
$('#cfgCaveCount').addEventListener('input',()=>{$('#configError').hidden=true;});
$('#cfgCavesList').addEventListener('input',e=>{
  if(e.target.matches('[data-field="code"]')) e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,3);
  $('#configError').hidden=true;updateConfigCapacityPreview();
});
$('#cfgCavesList').addEventListener('change',e=>{
  if(e.target.matches('[data-field="bulkEnabled"]')){
    $('#configError').hidden=true;
    updateConfigCapacityPreview();
  }
});
['cfgModuleSales'].forEach(id=>$('#'+id).addEventListener('change',()=>{$('#configError').hidden=true;}));
['cfgStockLow','cfgStockMedium','cfgStockHigh'].forEach(id=>{
  $('#'+id).addEventListener('input',()=>{
    $('#configError').hidden=true;
    renderStockThresholdPreview();
  });
});

$('#search').addEventListener('input',showSearchResults);
$('#searchAllCaves').addEventListener('change',()=>{
  if($('#search').value.trim()) showSearchResults();
  else hideResultPanel();
});
$$('.maturity-filter').forEach(b=>b.addEventListener('click',()=>{
  const zone=Number(b.dataset.zone);

  if(b.classList.contains('active')){
    clearMaturityFilter();
    clearYearFilter();
    clearStockFilter();
    hideResultPanel();
    return;
  }

  showMaturityResults(zone);
}));

$$('.stock-filter').forEach(b=>b.addEventListener('click',()=>{
  const bucket=b.dataset.stock;

  if(b.classList.contains('active')){
    clearStockFilter();
    hideResultPanel();
    return;
  }

  showStockResults(bucket);
}));

$('#caveTabs').addEventListener('click',async e=>{
  const b=e.target.closest('.cave-tab');if(!b)return;
  activeCaveId=b.dataset.caveId;
  activeCasier=activeCave()?.casiers===0 ? 0 : 1;
  $('#search').value='';clearMaturityFilter();clearYearFilter();clearStockFilter();hideResultPanel();
  render();await refreshPhotoButtons();
});

$('#casierTabs').addEventListener('click',async e=>{
  const b=e.target.closest('.tab');
  if(!b) return;
  activeCasier=Number(b.dataset.c);
  $('#search').value='';
  clearMaturityFilter();
  clearYearFilter();
  clearStockFilter();
  hideResultPanel();
  render();
  await refreshPhotoButtons();
});

$('#openBulkAdd').addEventListener('click',openBulkAdd);
$('#moveToBulk').addEventListener('click',openMoveToBulk);
$('#confirmMoveBulk').addEventListener('click',completeMoveToBulk);
$('#cancelMoveBulk').addEventListener('click',()=>$('#moveBulkDialog').close());
$('#moveBulkDialog').addEventListener('click',backdropClose);
$('#cancelMove').addEventListener('click',cancelMoveMode);
$('#moveConfirmYes').addEventListener('click',confirmMoveTargets);
$('#moveConfirmNo').addEventListener('click',()=>$('#moveConfirmDialog').close());
$('#moveConfirmDialog').addEventListener('click',backdropClose);
$('#bulkPickSearch').addEventListener('input',()=>{pendingBulkRefId='';renderBulkPickResults();});
$('#bulkPickResults').addEventListener('click',e=>{
  const b=e.target.closest('[data-bulk-pick]');if(!b)return;
  pendingBulkRefId=b.dataset.bulkPick;renderBulkPickResults();
});
$('#bulkVoiceAdd').addEventListener('click',openBulkVoiceAdd);
$('#bulkUseRef').addEventListener('click',()=>{
  const v=bulkAddValues();if(!v||!pendingBulkRefId)return;
  const n=createBulkEntries(pendingBulkRefId,v.caveId,v.location,v.qty);
  pendingBulkRefId='';persist();render();requestClose($('#bulkAddDialog'));
  setTimeout(()=>alert(`${n} bouteille${n>1?'s':''} ajoutée${n>1?'s':''} en vrac.`),80);
});
$('#bulkNewRef').addEventListener('click',()=>{
  const v=bulkAddValues();if(!v)return;
  bulkDraft=v;pendingBulkRefId='';
  $('#bulkAddDialog').close();
  selected={bulk:true,caveId:v.caveId,refId:null,emplacement:`${caveById(v.caveId)?.code||''} · Vrac · ${v.location}`,locationText:v.location};
  editScope='newbulk';
  $('#dialogTitle').textContent='Nouveau vin';
  $('#where').textContent=selected.emplacement+' · '+v.qty+' bouteille'+(v.qty>1?'s':'');
  fill(null);$('#bottleView').hidden=true;$('#bottleEdit').hidden=false;$('#viewActions').hidden=true;$('#editActions').hidden=false;
  $('#dialog').showModal();
});
$('#bulkAddCancel').addEventListener('click',()=>requestClose($('#bulkAddDialog')));
$('#bulkList').addEventListener('click',e=>{const b=e.target.closest('[data-bulk-open]');if(b)openBulkGroup(b.dataset.bulkOpen);});
$('#bulkActionDrink').addEventListener('click',drinkBulkSelection);
$$('[data-drink-rating]').forEach(btn=>btn.addEventListener('click',()=>finalizeDrinkRating(btn.dataset.drinkRating)));
$('#drinkLater').addEventListener('click',()=>finalizeDrinkRating('neutral'));
$('#drinkRatingCancel').addEventListener('click',()=>{
  drinkTargets=[];
  requestClose($('#drinkRatingDialog'));
});
$('#drinkRatingDialog').addEventListener('click',backdropClose);
$('#bulkActionRemove').addEventListener('click',removeBulkSelection);
$('#bulkActionSell').addEventListener('click',()=>{
  const items=selectedBulkActionItems();if(!items.length||!moduleEnabled('sales'))return;
  $('#bulkActionDialog').close();openSaleDialog(items.map(bulkTarget),true);
});
$('#bulkActionMove').addEventListener('click',beginMoveBulkSelection);
$('#bulkActionEdit').addEventListener('click',()=>{
  const item=selectedBulkActionItems()[0];if(!item)return;
  const r=ref(item.refId);if(!r)return;
  $('#bulkActionDialog').close();editRef(item,r);
});
$('#bulkActionClose').addEventListener('click',()=>requestClose($('#bulkActionDialog')));


$('#openConsumptionWindow').addEventListener('click',()=>{
  $('#consumptionSearch').value='';
  renderConsumption();
  showDialog($('#consumptionDialog'));
});
$('#consumptionDialogClose').addEventListener('click',()=>requestClose($('#consumptionDialog')));
$('#consumptionDialog').addEventListener('click',backdropClose);

$('#openSalesWindow').addEventListener('click',()=>{
  if(!moduleEnabled('sales'))return;
  $('#salesSearch').value='';
  renderSales();
  showDialog($('#salesHistoryDialog'));
});
$('#salesHistoryClose').addEventListener('click',()=>requestClose($('#salesHistoryDialog')));
$('#salesHistoryDialog').addEventListener('click',backdropClose);

$('#salesList').addEventListener('click',e=>{
  const toggle=e.target.closest('[data-sale-tx-toggle]');
  if(!toggle)return;
  const detail=$('#'+toggle.dataset.saleTxToggle);
  if(detail)detail.hidden=!detail.hidden;
});

$('#openConsumedRanking').addEventListener('click',()=>{
  renderConsumedRanking();
  showDialog($('#rankingDialog'));
});
$('#rankingClose').addEventListener('click',()=>requestClose($('#rankingDialog')));
$('#rankingDialog').addEventListener('click',backdropClose);

$('#salesSearch').addEventListener('input',renderSales);
$('#salesPeriod').addEventListener('change',()=>{initSalesPeriod();renderSales();});
$('#salesFrom').addEventListener('change',renderSales);
$('#salesTo').addEventListener('change',renderSales);

$('#consumptionSearch').addEventListener('input',renderConsumption);
$('#consumptionPeriod').addEventListener('change',()=>{
  initConsumptionPeriod();
  renderConsumption();
});
$('#consumptionFrom').addEventListener('change',renderConsumption);
$('#consumptionTo').addEventListener('change',renderConsumption);
$('#consumptionAnnotatedOnly').addEventListener('change',renderConsumption);
$('#consumptionList').addEventListener('click',e=>{
  const commentOpen=e.target.closest('[data-comment-open]');
  if(commentOpen){
    const id=commentOpen.dataset.commentOpen;
    $$('[data-comment-editor]').forEach(el=>el.hidden=el.dataset.commentEditor!==id ? true : !el.hidden);
    return;
  }
  const commentSave=e.target.closest('[data-comment-save]');
  if(commentSave){
    const id=commentSave.dataset.commentSave;
    const box=$(`[data-comment-editor="${id}"]`);
    setConsumedComment(id,box?.querySelector('textarea')?.value||'');
    return;
  }
  const commentCancel=e.target.closest('[data-comment-cancel]');
  if(commentCancel){
    const box=$(`[data-comment-editor="${commentCancel.dataset.commentCancel}"]`);
    if(box) box.hidden=true;
    return;
  }

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

function formatBackupDate(iso){
  const d=new Date(iso);
  if(Number.isNaN(d.getTime())) return 'Jamais';
  return d.toLocaleString('fr-FR',{
    day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit'
  }).replace(',',' à');
}

function readInternalBackup(){
  try{
    const raw=localStorage.getItem(KINTERNALBACKUP);
    if(!raw) return null;
    const d=JSON.parse(raw);
    if(!d || !Array.isArray(d.inv) || !Array.isArray(d.refs)) return null;
    return d;
  }catch(e){
    return null;
  }
}

function renderLastBackup(){
  const internal=readInternalBackup();
  const iso=internal?.exportedAt || localStorage.getItem(KBACKUP) || '';
  const el=$('#lastBackupDate');
  if(el) el.textContent=iso?formatBackupDate(iso):'Jamais';

  const btn=$('#restoreInternalBackup');
  if(btn){
    btn.disabled=!internal;
    btn.title=internal
      ? `Copie navigateur du ${formatBackupDate(internal.exportedAt)}`
      : 'Aucune sauvegarde interne disponible';
  }
}

function downloadBackupFallback(json,filename){
  const blob=new Blob([json],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

async function saveBackupFileOnDevice(json,filename){
  const blob=new Blob([json],{type:'application/json'});

  if(typeof window.showSaveFilePicker==='function'){
    try{
      const handle=await window.showSaveFilePicker({
        suggestedName:filename,
        types:[{
          description:'Sauvegarde Ma Cave (JSON)',
          accept:{'application/json':['.json']}
        }]
      });

      const writable=await handle.createWritable();
      await writable.write(blob);
      await writable.close();

      return {method:'picker',saved:true};
    }catch(err){
      if(err?.name==='AbortError'){
        return {method:'picker',saved:false,cancelled:true};
      }

      // Si l'accès direct échoue pour une raison technique,
      // on conserve toujours un moyen de récupérer le fichier.
      downloadBackupFallback(json,filename);
      return {method:'download',saved:true,fallback:true};
    }
  }

  downloadBackupFallback(json,filename);
  return {method:'download',saved:true};
}

function makeBackupPayload(){
  return {
    version:5600,
    app:'ma-cave-configurable-v5.6',
    exportedAt:new Date().toISOString(),
    config,inv,refs,consumed,sales,bulk
  };
}

function normalizeRestoredBackup(d){
  if(!d || !Array.isArray(d.inv) || !Array.isArray(d.refs)) throw new Error('invalid');

  const restoredConfig=normalizeConfig(d.config)||deriveConfigFromInventory(d.inv);
  if(!restoredConfig) throw new Error('invalid');

  // Compatibilité des anciennes sauvegardes mono-cave.
  const migrated=migrateBackupCaves(d,restoredConfig);

  return {
    oldMonoCave:!d.config || !Array.isArray(d.config?.caves),
    config:restoredConfig,
    inv:buildInventory(restoredConfig,migrated.inv),
    refs:Array.isArray(d.refs)?d.refs:[],
    consumed:Array.isArray(migrated.consumed)?migrated.consumed:[],
    sales:Array.isArray(migrated.sales)?migrated.sales:[],
    bulk:Array.isArray(migrated.bulk)?migrated.bulk:[]
  };
}

function applyRestoredBackup(d,sourceLabel='Sauvegarde'){
  const restored=normalizeRestoredBackup(d);

  config=restored.config;
  inv=restored.inv;
  refs=restored.refs;
  consumed=restored.consumed;
  sales=restored.sales;
  bulk=restored.bulk;

  consumed.forEach(e=>{
    if(!['verygood','good','bad','verybad','neutral'].includes(e.rating)) e.rating='neutral';
    if(e.comment===undefined)e.comment='';
    e.bulk=!!e.bulk;
  });

  bulk=bulk.filter(e=>e&&e.refId).map((e,i)=>({
    id:String(e.id||`bulk_${Date.now()}_${i}`),
    caveId:String(e.caveId||config.caves[0].id),
    refId:String(e.refId),
    locationText:e.locationText!==undefined
      ? String(e.locationText||'').trim()
      : String(e.emplacement||'').replace(/^.*?Vrac\s*·?\s*/i,'').trim(),
    addedAt:e.addedAt||new Date().toISOString(),
    bulk:true
  }));

  if(bulk.length){
    const cavesWithBulk=new Set(bulk.map(x=>x.caveId));
    config.caves.forEach(c=>{
      if(cavesWithBulk.has(c.id)) c.bulkEnabled=true;
    });
  }

  sales.forEach(e=>{
    e.costPrice=Number(e.costPrice??0)||0;
    e.salePrice=Number(e.salePrice??0)||0;
    e.costKnown=e.costKnown!==undefined?!!e.costKnown:e.costPrice>0;
    e.profit=e.costKnown?e.salePrice-e.costPrice:null;
  });

  refs.forEach(r=>{
    if(r.maturiteDebut===undefined) r.maturiteDebut='';
    if(r.maturiteFin===undefined) r.maturiteFin='';
  });

  activeCaveId=config.caves[0].id;
  activeCasier=config.caves[0]?.casiers===0 ? 0 : 1;
  clearEmptySelection();
  clearOccupiedSelection();
  persist(`Restauration · ${sourceLabel}`);
  render();
  renderSales();
  refreshPhotoButtons();

  return restored;
}

$('#export').addEventListener('click',async ()=>{
  const payload=makeBackupPayload();
  const json=JSON.stringify(payload,null,2);
  const filename='sauvegarde-ma-cave-configurable-v5-6.json';

  // Copie 1 : sauvegarde interne du navigateur.
  let internalSaved=false;
  try{
    localStorage.setItem(KINTERNALBACKUP,json);
    localStorage.setItem(KBACKUP,payload.exportedAt);
    internalSaved=true;
  }catch(e){
    internalSaved=false;
  }

  // Copie 2 : fichier sur le téléphone.
  // Si disponible, le navigateur laisse choisir l'emplacement et le nom.
  // Sinon, téléchargement classique dans le dossier habituel.
  let deviceResult={saved:false};
  try{
    deviceResult=await saveBackupFileOnDevice(json,filename);
  }catch(e){
    deviceResult={saved:false,error:true};
  }

  renderLastBackup();

  if(deviceResult.cancelled){
    alert(
      internalSaved
        ? 'La copie navigateur a bien été enregistrée. La sauvegarde sur le téléphone a été annulée.'
        : 'La sauvegarde sur le téléphone a été annulée et la copie navigateur n’a pas pu être enregistrée.'
    );
    return;
  }

  if(!internalSaved && deviceResult.saved){
    alert(
      'Le fichier a bien été enregistré sur le téléphone, mais la copie de secours dans le navigateur n’a pas pu être créée.'
    );
    return;
  }

  if(internalSaved && !deviceResult.saved){
    alert(
      'La copie navigateur a bien été enregistrée, mais le fichier sur le téléphone n’a pas pu être créé.'
    );
    return;
  }

  if(deviceResult.fallback){
    alert(
      'La copie navigateur est enregistrée. Le choix direct de l’emplacement a échoué : le fichier a été téléchargé dans le dossier habituel.'
    );
  }
});

$('#restoreInternalBackup').addEventListener('click',()=>{
  const d=readInternalBackup();
  if(!d){
    renderLastBackup();
    return alert('Aucune sauvegarde interne disponible.');
  }

  const date=formatBackupDate(d.exportedAt);
  const bottleCount=(Array.isArray(d.inv)?d.inv.filter(x=>x?.refId).length:0) +
    (Array.isArray(d.bulk)?d.bulk.filter(x=>x?.refId).length:0);

  if(!confirm(
    `Restaurer la copie navigateur du ${date} ?\n\n`+
    `${bottleCount} bouteille${bottleCount>1?'s':''} enregistrée${bottleCount>1?'s':''} dans cette sauvegarde.\n\n`+
    `Les données actuelles de l’application seront remplacées.`
  )) return;

  try{
    const restored=applyRestoredBackup(d,'copie navigateur');
    alert(restored.oldMonoCave
      ? 'Copie navigateur restaurée. Les anciennes données sans cave ont été placées dans Cave 1.'
      : 'Copie navigateur restaurée avec succès.');
  }catch(err){
    alert('La copie navigateur est invalide.');
  }
});

$('#import').addEventListener('change',async e=>{
  const f=e.target.files?.[0];
  if(!f) return;

  try{
    const d=JSON.parse(await f.text());
    const restored=applyRestoredBackup(d,'fichier JSON');

    alert(restored.oldMonoCave
      ? 'Ancienne sauvegarde restaurée. Les données sans information de cave ont été placées dans Cave 1.'
      : 'Sauvegarde restaurée avec les caves, modules, consommations, ventes et stock vrac.');
  }catch(err){
    alert('Sauvegarde invalide.');
  }

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
function photoKey(caveId,casier,slot){ return `${caveId}-c${casier}-${slot}`; }

async function refreshPhotoButtons(){
  $('#photoCasier').textContent=`${activeCave()?.code||''} · ${activeCasier}`;
  const cur=await photoGet(photoKey(activeCaveId,activeCasier,'current'));
  const prev=await photoGet(photoKey(activeCaveId,activeCasier,'previous'));
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
    const cur=await photoGet(photoKey(activeCaveId,activeCasier,'current'));
    if(cur) await photoSet(photoKey(activeCaveId,activeCasier,'previous'),cur);
    const blob=file;
    await photoSet(photoKey(activeCaveId,activeCasier,'current'),{
      blob,
      name:file.name||'photo',
      type:file.type,
      date:new Date().toISOString()
    });
    await refreshPhotoButtons();
    alert(`Photo ${activeCave()?.code||''} · casier ${activeCasier} enregistrée.`);
  }catch(e){
    console.error(e);
    alert("Impossible d'enregistrer la photo. L'espace de stockage du navigateur est peut-être insuffisant.");
  }
}
async function showPhoto(slot){
  const obj=await photoGet(photoKey(activeCaveId,activeCasier,slot));
  if(!obj) return alert(slot==='current'?'Aucune photo actuelle.':'Aucune photo précédente.');
  const url=URL.createObjectURL(obj.blob);
  const img=$('#photoViewerImg');
  const cleanup=()=>{
    if(img.dataset.url){ URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
  };
  cleanup();
  img.src=url;
  img.dataset.url=url;
  $('#photoViewerTitle').textContent=`${activeCave()?.code||''} · Casier ${activeCasier} · ${slot==='current'?'Photo actuelle':'Photo précédente'}`;
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


window.addEventListener('resize',scheduleTabCentering);

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
  if(dx<0&&activeCave()&&activeCasier<activeCave().casiers) activeCasier++;
  else if(dx>0&&activeCasier>1) activeCasier--;
  else return;
  render(); refreshPhotoButtons();
  document.querySelector('.tabs').scrollIntoView({behavior:'smooth',block:'start'});
},{passive:true});

if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
initConsumptionPeriod();
initSalesPeriod();

if(config){
  inv=buildInventory(config,inv);
  persist(); // historyReady=false : simple normalisation de démarrage, non historisée
  historyReady=true;
  render();
  renderSales();
  renderHistoryControls();
  renderLastBackup();
  refreshPhotoButtons();
}else{
  historyReady=true;
  renderHistoryControls();
  renderLastBackup();
  $('#count').textContent='0';
  $('#free').textContent='—';
  openConfigDialog(true);
}
