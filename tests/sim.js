// Minimal Panorama mock to exercise build_autolevel.js logic.
const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
let clock=0; Date.now=()=>clock;
let scheduled=[];
class P{constructor(type,id,parent){this.type=type;this.id=id||'';this.kids=[];this.cls=new Set();this.attrs={};this.style={};this.text='';this.parent=parent||null;this.events={};if(parent)parent.kids.push(this);}
 IsValid(){return true} BHasClass(c){return this.cls.has(c)} Children(){return this.kids.map(k=>new Proxy(k,{get:(t,key)=>key==='__t'?t:Reflect.get(t,key)}))} GetParent(){return this.parent}
 FindChildTraverse(id){for(const k of this.kids){if(k.id===id)return k;const r=k.FindChildTraverse(id);if(r)return r}return null}
 FindChildrenWithClassTraverse(c){let o=[];for(const k of this.kids){if(k.cls.has(c))o.push(k);o=o.concat(k.FindChildrenWithClassTraverse(c))}return o}
 GetAttributeString(k,d){return k in this.attrs?this.attrs[k]:d} SetAttributeString(k,v){this.attrs[k]=v}
 SetPanelEvent(n,f){this.events[n]=f} AddClass(c){this.cls.add(c)} RemoveClass(c){this.cls.delete(c)} SetHasClass(c,v){v?this.cls.add(c):this.cls.delete(c)} MoveChildAfter(a,b){a=a.__t||a;b=b.__t||b;const k=this.kids;const ia=k.indexOf(a);if(ia<0)return;k.splice(ia,1);const ib=k.indexOf(b);k.splice(ib+1,0,a)} MoveChildBefore(a,b){const t=x=>x&&x.__t?x.__t:x;const k=this.kids;const ia=k.indexOf(t(a)),ib=k.indexOf(t(b));if(ia<0||ib<0)return;k.splice(ia,1);k.splice(k.indexOf(t(b)),0,t(a))} DeleteAsync(){this.parent.kids=this.parent.kids.filter(x=>x!==this)}}
const win=new P('Panel','WindowRoot'); const hud=new P('Panel','Hud',win);
const ctx=new P('Panel','DataFeed',hud);
const sig=new P('Panel','hud_signature',new P('Panel','AbilitiesContainer',hud));
const state=[0,0,0,0]; const boughtAt=[]; // -1 locked, else tier
let points=0, suggestion=0;
const slots=[];
for(let i=1;i<=4;i++){const s=new P('Panel','slot_signature_'+i,sig);const b=new P('Panel','AbilityButton',s);for(let n=1;n<=3;n++)new P('Panel','AbilityUnlock'+n,b);new P('Panel','badge',s);slots.push(s)}
const shopHdr=new P('Label','HeroFavoritesHeaderLabel',hud); shopHdr.text="Haze's Recommended Mods";
const outer=new P('Panel','SelectedBuildOuter',hud); const bn=new P('Label','bn',outer); bn.cls.add('SelectedBuildName'); bn.text='My Haze build';
function render(){slots.forEach((s,i)=>{s.cls=new Set();const t=state[i];if(t<0)s.cls.add('not_trained');else s.cls.add('Tier'+t);
 const b=s.FindChildTraverse('AbilityButton');for(let n=1;n<=3;n++){const p=b.FindChildTraverse('AbilityUnlock'+n);p.cls=new Set();if(t>=n)p.cls.add('hasAbilityUpgrade');if(t===n&&boughtAt[i]!==undefined&&clock-boughtAt[i]<10000)p.cls.add('canUndo');if(t+1===n&&points>=1&&!global.hideAfford)p.cls.add('canAffordUpgrade')}
 const badge=s.FindChildTraverse('badge');badge.cls=new Set();if(i===suggestion)badge.cls.add('build_suggestion');});}
const log=[];
const webStore={}; const htmlHandlers=[]; let webOnline=true;
function fakePage(panel,url){ if(!webOnline) return; const hash=decodeURIComponent(url.split('#')[1]||''); let r; try{r=JSON.parse(hash)}catch(e){return}
  let rep; if(r.o==='hello') rep={i:r.i,ok:true,o:'ready',v:1}; else if(r.o==='get') rep={i:r.i,ok:true,v:webStore[r.k]===undefined?null:webStore[r.k]}; else if(r.o==='set'){webStore[r.k]=r.v; rep={i:r.i,ok:true}}
  scheduled.push({at:clock+200,f:()=>htmlHandlers.filter(h=>h.p===panel).forEach(h=>h.f(panel.id,'BALS1:'+JSON.stringify(rep)))}); }
global.$={GetContextPanel:()=>ctxQueue.shift(),Msg:m=>log.push(m),Schedule:(d,f)=>scheduled.push({at:clock+d*1000,f}),
 CreatePanel:(t,p,id)=>{const n=new P(t,id,p); if(t==='HTML') n.SetURL=(u)=>fakePage(n,u); return n;},RegisterForUnhandledEvent(){},RegisterEventHandler(ev,p,f){if(ev==='HTMLTitle')htmlHandlers.push({p:p.__t||p,f});},
 DispatchEvent(name,a){if(name==='CitadelConCommand'){const i=+a.split(' ')[1];if(points>=1&&state[i]<3){state[i]++;points--;buys.push(i);boughtAt[i]=clock}render()}}};
const buys=[];
function run(ms){const end=clock+ms;while(true){scheduled.sort((a,b)=>a.at-b.at);if(!scheduled.length||scheduled[0].at>end)break;const s=scheduled.shift();clock=s.at;s.f()}clock=end}
function panelBtn(id){return win.FindChildTraverse(id)}
function click(id){panelBtn(id).events.onactivate()}
const ctx2=new P('Panel','BaseHudRoot',win); hud.parent=ctx2; win.kids=[ctx2]; ctx2.kids.push(hud); var ctxQueue=[ctx2,ctx]; win.attrs.BuildAutoLevelSettings=JSON.stringify({showBar:true}); eval(src); eval(src);
const check=(name,cond)=>{console.log((cond?'PASS ':'FAIL ')+name); if(!cond)process.exitCode=1};
render(); run(2000);
// 1: auto buys suggested slot
points=1; suggestion=1; render(); run(1500);
check('buys suggested ability 2', buys.length===1&&buys[0]===1&&state[1]===1);
// 2: user refunds it -> pause, no rebuy
state[1]=0; points=1; render(); run(3000);
check('refund pauses (no rebuy)', buys.length===1 && log.some(l=>l.includes('paused: you refunded ability 2')));
// user spends elsewhere manually
state[2]=1; points=0; render(); run(1600);
check('spending the refunded point resumes', buys.length===1 && log.some(l=>l.includes('resumed (the refunded point was spent again)')));
// 3: next new point is spent automatically
points=1; suggestion=0; render(); run(1500);
check('next point auto-spent after resume', buys.length===2 && buys[1]===0);
// refund but do not re-spend: stays paused even when a new point arrives
state[0]=0; points=1; render(); run(1000); points=2; render(); run(2000);
check('refund without re-spend stays paused', buys.length===2);
state[3]=1; points=1; render(); run(1600);
check('re-spend resumes', log.filter(l=>l.includes('refunded point was spent again')).length===2);
run(1500); check('then auto spends the new point', buys.length===3);
// 7: global off
const b7=buys.length; click('BALBarEnabled'); points=1; render(); run(2000); check('off blocks', buys.length===b7);
click('BALBarEnabled');
// 8: settings saved on window root
check('settings stored', !!win.attrs.BuildAutoLevelSettings);
console.log(log.filter(l=>/paused|resumed|hero|build:/.test(l)).join('\n'));
// 9: Max now with no build suggestion spends all points on lowest abilities
run(2000); points=0; render(); run(500); suggestion=-1; state.splice(0,4,1,1,1,0); points=3; render(); run(1000);
const b9=buys.length; check('no suggestion -> idle', true);
click('BALBarMax'); run(8000);
check('max now spends all points', points===0 && buys.length===b9+3);
// 10: Undo refunds pip with canUndo
const pip=slots[3].FindChildTraverse('AbilityButton').FindChildTraverse('AbilityUnlock1'); pip.cls.add('canUndo');
const origDispatch=$.DispatchEvent; let undone=false;
$.DispatchEvent=(n,a)=>{if(n==='Activated'&&a===pip){undone=true;state[3]--;points++;render();}else origDispatch(n,a)};
click('BALBarUndo'); run(4500);
check('undo clicks refundable pip and pauses', undone && log.some(l=>l.includes('paused: Undo pressed')));
console.log('state',state,'points',points);
const panels=win.FindChildrenWithClassTraverse ? null : null;
let count=0,vis=null;(function walk(p){for(const k of p.kids){if(k.id==='BuildAutoLevelPanel'){count++;vis=k.style.visibility}walk(k)}})(win);
check('exactly one settings panel, visible', count===1 && vis==='visible');
// 11: cursor class hides panel when shop closed
function panelVis(){let v=null;(function w(p){for(const k of p.kids){if(k.id==='BuildAutoLevelPanel')v=k.style.visibility;w(k)}})(win);return v}
hud.cls.add('gShopOpen'); run(1000); check('panel visible with shop open', panelVis()==='visible');
hud.cls.delete('gShopOpen'); run(1000); check('panel hidden with shop closed', panelVis()==='collapse');
// 12: sandbox - unlimited points, no affordability classes; Max now forces
global.hideAfford=true; click('BALBarResume'); state.splice(0,4,0,0,0,0); points=999; suggestion=2; render(); run(3000);
const before=buys.length; check('auto does not act without affordability', buys.length===before);
click('BALBarMax'); run(15000);
check('forced Max now maxes all abilities', state.every(x=>x===3));
// 13: forced with zero points stops cleanly
state.splice(0,4,0,0,0,0); points=0; render(); click('BALBarMax'); run(5000);
check('forced with no points stops burst', log.some(l=>l.includes('Max now: "')&&l.includes('not accepted')));
// 14: Esc menu MOD entry + full-page hub with list
const esc=new P('Panel','EscRoot',hud); new P('Panel','RightSide',esc); const menu=new P('Panel','Menu',esc); const sub=new P('Panel','SubOptions',menu);
new P('Panel','FeedbackRow',sub); const hpc=new P('Button','HPColorsEntry',sub); const hpl=new P('Label','',hpc); hpl.text='HP COLORS'; let hpcOpened=0; hpc.events.onactivate=()=>hpcOpened++;
const setRow=new P('Panel','SettingsRow',sub);
const origD=$.DispatchEvent; $.DispatchEvent=(n,a,...r)=>{if(n==='Activated'&&(a===hpc||a.__t===hpc)){hpcOpened++;return;}return origD(n,a,...r)};
run(2000);
const entry=sub.FindChildTraverse('ModHubMenuEntry');
check('MOD entry added before Settings', !!entry && sub.kids.indexOf(entry)===sub.kids.indexOf(setRow)-1 && entry.kids[0].text==='MOD');
check('HP COLORS own entry hidden', hpc.style.visibility==='collapse');
const hubP=esc.FindChildTraverse('ModHubPanel');
check('hub hidden until clicked', !!hubP && hubP.style.visibility==='collapse');
entry.events.onactivate(); run(500);
check('click opens hub', hubP.cls.has('ModHubOpen') && hubP.style.visibility==='visible');
const list=hubP.FindChildTraverse('ModHubList');
const titles=list.kids.map(k=>k.kids[0].text);
check('list shows Build Auto-Level and HP COLORS', titles.includes('Build Auto-Level') && titles.includes('HP COLORS  >'));
check('our section shown', hubP.FindChildTraverse('ModHubSection_BuildAutoLevel').style.visibility==='visible');
const en=hubP.FindChildTraverse('BALHubEnabled'); const was=JSON.parse(win.attrs.BuildAutoLevelSettings).enabled;
en.events.onactivate(); check('hub toggle changes setting', JSON.parse(win.attrs.BuildAutoLevelSettings).enabled!==was);
en.events.onactivate();
list.kids[titles.indexOf('HP COLORS  >')].events.onactivate();
check('HP COLORS item opens its page and closes hub', hpcOpened===1 && !hubP.cls.has('ModHubOpen'));
$.DispatchEvent=origD;
run(3000); let ne=0;(function w(p){for(const k of p.kids){if(k.id==='ModHubMenuEntry')ne++;w(k)}})(win);
check('only one MOD entry after many ticks', ne===1);
// 15: build list rows get a toggle after the name
const sel=new P('Panel','HeroBuildSelector',win);
const rows=['Max Damage','Vindicta','Starter'].map(n=>{const r=new P('Panel','nameRow',new P('Panel','item',sel));const l=new P('Label','BuildName',r);l.text=n;new P('Panel','PopularityContainer',r);return r;});
run(2000);
check('every build row has a toggle', rows.every(r=>!!r.FindChildTraverse('BALRowToggle')));
check('toggle sits right after the name', rows.every(r=>r.kids[1].id==='BALRowToggle'));
const t2=rows[1].FindChildTraverse('BALRowToggle'); t2.events.onactivate();
check('row toggle switches that build off', JSON.parse(win.attrs.BuildAutoLevelSettings).buildOff['Vindicta']===true && t2.kids[0].text==='AL: OFF');
check('other rows stay on', rows[0].FindChildTraverse('BALRowToggle').kids[0].text==='AL: ON');
t2.events.onactivate();
// 16: HUD bar off
click('BALHubBar'); hud.cls.add('gShopOpen'); run(1000);
check('HUD bar can be switched off', panelVis()==='collapse');

// 17: sandbox test tools - block injected, HUD bar hidden
const tools=new P('Panel','hero_tools',hud); hud.cls.add('gShopOpen'); click('BALHubBar'); run(2000);
check('block injected into test tools', !!tools.FindChildTraverse('BALToolsHost'));
click('BALHubBar'); run(1500); check('quick controls off hides tools block', tools.FindChildTraverse('BALToolsHost').style.visibility==='collapse'); click('BALHubBar'); run(1500); check('quick controls on shows tools block', tools.FindChildTraverse('BALToolsHost').style.visibility==='visible');
const host=tools.FindChildTraverse('BALToolsHost'); check('tools: actions row before settings', host.kids.findIndex(k=>k.FindChildTraverse&&k.FindChildTraverse('BALToolsMax'))<host.kids.findIndex(k=>k.id==='BALToolsBlock'));
check('HUD bar hidden in sandbox', panelVis()==='collapse');
click('BALToolsMax'); check('tools Max now works', log.some(l=>l.includes('Max now pressed')));
// 18: cursor class found on a listener deeper in the tree
tools.parent.kids=tools.parent.kids.filter(k=>k!==tools); (function inv(p){p.IsValid=()=>false;p.kids.forEach(inv)})(tools);
hud.cls.delete('gShopOpen'); const listener=new P('Panel','ShopRoot',hud); run(1500);
check('bar hidden when no listener has the class', panelVis()==='collapse');
listener.cls.add('gScoreboardOpen'); run(1500);
check('bar shown when a listener has gScoreboardOpen', panelVis()==='visible');

// 19: Pause/Resume toggle
const before19=buys.length; click('BALBarResume'); check('pause button pauses', log.some(l=>l.includes('paused: paused by you')));
click('BALBarResume'); check('second press resumes', log.some(l=>l.includes('resumed (Resume pressed)')));

// 20: MOD page closes when the Esc menu closes
entry.events.onactivate(); run(1000); check('hub reopened', hubP.cls.has('ModHubOpen'));
esc.cls.add('Hidden'); run(500); check('hub closes when Esc menu hides', !hubP.cls.has('ModHubOpen'));
esc.cls.delete('Hidden'); run(500); check('hub stays closed when Esc menu reopens', !hubP.cls.has('ModHubOpen'));
// 21: Esc while the MOD page is open closes only the page
entry.events.onactivate(); run(500); check('hub open again', hubP.cls.has('ModHubOpen'));
hubP.events.oncancel(); check('oncancel closes hub', !hubP.cls.has('ModHubOpen'));
// 22: ancestor hidden (menu parent) closes hub
entry.events.onactivate(); run(1000); hud.cls.add('Hidden'); run(500); check('ancestor change closes hub', !hubP.cls.has('ModHubOpen')); hud.cls.delete('Hidden');
// 23: [noAL] tag in build name
bn.text='MAX Damage [noAL]'; run(2000); const before23=buys.length; points=1; suggestion=1; state[1]=Math.min(state[1],2); render(); run(2000);
check('[noAL] build is never auto-levelled', buys.length===before23 && log.some(l=>l.includes('build: MAX Damage [noAL]')));
bn.text='My Haze [AL]'; run(2000);
// 24: debug dump runs
log.length=0; click('BALHubDump'); check('debug dump completes', log.some(l=>l.includes('end dump')));
console.log(log.filter(l=>/globals|\$ members/.test(l)).join('\n').slice(0,300));

// 25: web settings store
run(6000);
entry.events.onactivate(); run(500); check('web store connected', hubP.FindChildTraverse('ModHubSection_BuildAutoLevel').kids.some(k=>String(k.text).includes('saved (web store)'))); hubP.events.oncancel();
const t25=rows[0].FindChildTraverse('BALRowToggle'); t25.events.onactivate(); run(2000);
check('build switch saved to the web store', !!webStore['bal.settings'] && JSON.parse(webStore['bal.settings']).buildOff['Max Damage']===true);
t25.events.onactivate(); run(2000);
check('switching back is saved too', !JSON.parse(webStore['bal.settings']).buildOff['Max Damage']);
t25.events.onactivate(); run(2000);
// 26: a new map (fresh HUD and window) gets its settings back from the web store
const win2=new P('Panel','WindowRoot2'); const hud2=new P('Panel','Hud',win2); const ctx3=new P('Panel','DataFeed',hud2);
const sig2=new P('Panel','hud_signature',new P('Panel','AbilitiesContainer',hud2));
for(let i=1;i<=4;i++){const s2=new P('Panel','slot_signature_'+i,sig2);const b2=new P('Panel','AbilityButton',s2);for(let n=1;n<=3;n++)new P('Panel','AbilityUnlock'+n,b2);}
ctxQueue.push(ctx3); log.length=0; eval(src); run(8000);
check('new map restores settings from the web store', log.some(l=>l.includes('settings loaded from the web store')) && JSON.parse(win2.attrs.BuildAutoLevelSettings||'{}').buildOff['Max Damage']===true);
// 27: HUD repaint flicker is not a refund
bn.text='Some Build'; run(2000); log.length=0;
state.splice(0,4,1,1,1,1); points=0; suggestion=0; render(); run(2000);
state[3]=0; render(); run(500); state[3]=1; render(); run(2000);
check('short flicker does not pause', !log.some(l=>l.includes('paused: you refunded')));
state.splice(0,4,0,0,0,0); render(); run(2000); state.splice(0,4,1,1,1,1); render(); run(2000);
check('several abilities dropping at once is ignored', !log.some(l=>l.includes('paused: you refunded')) && log.some(l=>l.includes('not a refund, ignored')));
boughtAt[2]=clock; render(); run(600); state[2]=0; render(); run(2000);
check('a real refund still pauses', log.some(l=>l.includes('paused: you refunded ability 3')));
state[2]=1; render(); run(2000);
check('and resumes after re-spending', log.some(l=>l.includes('refunded point was spent again')));

// 28: a drop on an ability with nothing refundable (ultimate repaint) is ignored
log.length=0; state.splice(0,4,1,1,1,1); boughtAt.length=0; render(); run(16000);
state[3]=0; render(); run(2500); state[3]=1; render(); run(2000);
check('drop without a refundable pip does not pause', !log.some(l=>l.includes('paused: you refunded')) && log.some(l=>l.includes('HUD repaint, ignored')));
