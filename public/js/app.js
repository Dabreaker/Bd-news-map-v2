'use strict';

// ── State ─────────────────────────────────────────────────────
const S = {
  token:     null,
  username:  null,
  userLat:   null,
  userLon:   null,
  reportLat: null,
  reportLon: null,
  pinInRange:null,
  mapReady:  false,
  activeTab: 'home',
};

// ═══════════════════════════════════════════════════════════════
// NGEOHASH — bundled IIFE
// ═══════════════════════════════════════════════════════════════
(function(){
  const B32='0123456789bcdefghjkmnpqrstuvwxyz';
  function encode(lat,lon,prec){
    let idx=0,bit=0,even=true,hash='';
    let la=-90,La=90,lo=-180,Lo=180;
    while(hash.length<prec){
      if(even){const m=(lo+Lo)/2;if(lon>m){idx=(idx<<1)|1;lo=m;}else{idx<<=1;Lo=m;}}
      else{const m=(la+La)/2;if(lat>m){idx=(idx<<1)|1;la=m;}else{idx<<=1;La=m;}}
      even=!even;
      if(++bit===5){hash+=B32[idx];bit=0;idx=0;}
    }
    return hash;
  }
  function decode_bbox(hash){
    let even=true,la=-90,La=90,lo=-180,Lo=180;
    for(const c of hash){
      const cd=B32.indexOf(c);
      for(let i=4;i>=0;i--){
        const bv=(cd>>i)&1;
        if(even){const m=(lo+Lo)/2;if(bv)lo=m;else Lo=m;}
        else{const m=(la+La)/2;if(bv)la=m;else La=m;}
        even=!even;
      }
    }
    return[la,lo,La,Lo];
  }
  function decode(hash){const b=decode_bbox(hash);return{lat:(b[0]+b[2])/2,lon:(b[1]+b[3])/2};}
  function neighbor(hash,dir){
    const[la,lo,La,Lo]=decode_bbox(hash);
    const c=decode(hash);
    let nlat=c.lat,nlon=c.lon;
    const dla=(La-la),dlo=(Lo-lo);
    if(dir==='n')nlat+=dla; if(dir==='s')nlat-=dla;
    if(dir==='e')nlon+=dlo; if(dir==='w')nlon-=dlo;
    if(dir==='ne'){nlat+=dla;nlon+=dlo;} if(dir==='nw'){nlat+=dla;nlon-=dlo;}
    if(dir==='se'){nlat-=dla;nlon+=dlo;} if(dir==='sw'){nlat-=dla;nlon-=dlo;}
    nlat=Math.max(-90,Math.min(90,nlat));
    nlon=((nlon+180)%360)-180;
    return encode(nlat,nlon,hash.length);
  }
  function neighbors(hash){
    return{n:neighbor(hash,'n'),s:neighbor(hash,'s'),e:neighbor(hash,'e'),w:neighbor(hash,'w'),
           ne:neighbor(hash,'ne'),nw:neighbor(hash,'nw'),se:neighbor(hash,'se'),sw:neighbor(hash,'sw')};
  }
  window._gh={encode,decode_bbox,decode,neighbor,neighbors};
})();

// ═══════════════════════════════════════════════════════════════
// CHUNK MANAGER — lazy loads 5km geohash cells
// Load logic:
//   zoom < 13 (>5km view)  → no markers, evict all
//   zoom 13-15             → L5 chunks only, markers pinned at 50px
//   zoom >= 15             → L5 + L6 sub-chunks, resize up to 200px
// ═══════════════════════════════════════════════════════════════
const CM = {
  loadedL5: new Set(),
  loadedL6: new Set(),
  markers: {},       // id → {layer, cls, thumb, lat, lon}
  _busy: false,

  reset() {
    this.loadedL5.clear();
    this.loadedL6.clear();
    Object.values(this.markers).forEach(m=>{ if(MAP) MAP.removeLayer(m.layer); });
    this.markers={};
  },

  async update(center, zoom) {
    if(this._busy) return;
    this._busy=true;
    try{ await this._run(center,zoom); } finally{ this._busy=false; }
  },

  async _run(center, zoom) {
    const lat=center.lat, lon=center.lng;

    // Below z13 (~5km) → vanish everything
    if(zoom < 13) {
      this._evictAll();
      return;
    }

    // L5 lazy load (always at z>=13)
    const ring5 = this._ring(lat,lon,5,1);
    const new5  = ring5.filter(c=>!this.loadedL5.has(c));
    if(new5.length) {
      new5.forEach(c=>this.loadedL5.add(c));
      const data=await api('GET',`/api/news/chunks?chunks=${new5.join(',')}`);
      if(Array.isArray(data)) this._place(data, zoom);
    }

    // L6 sub-chunk lazy load (only z>=15, finer detail)
    if(zoom>=15) {
      const ring6=this._ring(lat,lon,6,1);
      const new6=ring6.filter(c=>!this.loadedL6.has(c));
      if(new6.length){
        new6.forEach(c=>this.loadedL6.add(c));
        const data=await api('GET',`/api/news/subs?subs=${new6.join(',')}`);
        if(Array.isArray(data)) this._place(data, zoom);
      }
    }

    // Resize all visible markers based on zoom
    this._resize(zoom);

    // Evict markers far from current view center
    this._evictFar(lat, lon, zoom);
  },

  _ring(lat,lon,level,rings) {
    const GH=window._gh;
    const center=GH.encode(lat,lon,level);
    const set=new Set([center]);
    let front=[center];
    for(let r=0;r<rings;r++){
      const next=[];
      for(const c of front){
        Object.values(GH.neighbors(c)).forEach(n=>{ if(!set.has(n)){set.add(n);next.push(n);} });
      }
      front=next;
    }
    return[...set];
  },

  _place(items, zoom) {
    const sz=pinSize(zoom);
    items.forEach(n=>{
      if(this.markers[n.id]) return;
      const diff=(+n.real_score)-(+n.fake_score);
      const cls=diff>2?'pin-real':diff<-2?'pin-fake':'pin-neutral';
      const thumb=n.thumb||'';
      const layer=L.marker([n.lat,n.lon],{icon:buildPin(sz,cls,thumb)}).addTo(MAP);
      layer.on('click',()=>{ MAP.flyTo([n.lat,n.lon],Math.max(MAP.getZoom(),16),{duration:0.5}); openModal(n.id); });
      this.markers[n.id]={layer,cls,thumb,lat:n.lat,lon:n.lon};
    });
  },

  _resize(zoom) {
    const sz=pinSize(zoom);
    Object.values(this.markers).forEach(({layer,cls,thumb})=>{
      layer.setIcon(buildPin(sz,cls,thumb));
    });
  },

  // Beyond maxKm → remove marker from map AND clear its cell from loaded sets
  // so the cell gets re-fetched when user zooms back in
  _evictFar(lat,lon,zoom) {
    const maxKm=zoom<=13?15:zoom<=15?10:5;
    Object.entries(this.markers).forEach(([id,m])=>{
      if(haversine(lat,lon,m.lat,m.lon)>maxKm){
        if(MAP) MAP.removeLayer(m.layer);
        delete this.markers[id];
        // Also invalidate the geohash cell so it gets re-fetched
        const gh5=window._gh.encode(m.lat,m.lon,5);
        const gh6=window._gh.encode(m.lat,m.lon,6);
        this.loadedL5.delete(gh5);
        this.loadedL6.delete(gh6);
      }
    });
  },

  // Zoom < 13: remove all markers AND clear all loaded sets
  // User zooming back in will trigger fresh fetch
  _evictAll() {
    Object.values(this.markers).forEach(m=>{ if(MAP) MAP.removeLayer(m.layer); });
    this.markers={};
    this.loadedL5.clear();
    this.loadedL6.clear();
  },
};

// ── Zoom → marker size ────────────────────────────────────────
// z<13   → 0px  (hidden — CM._evictAll handles this)
// z13-17 → 50px (fixed minimum, no scaling in this range)
// z17-19 → 50px → 200px (linear scale)
function pinSize(z) {
  if(z < 13) return 0;
  if(z < 17) return 50;
  const t=Math.min(1,(z-17)/2);  // 0 at z17, 1 at z19
  return Math.round(50+(200-50)*t);
}

// ── Build image card marker ───────────────────────────────────
function buildPin(size, cls, thumb) {
  if(size===0) return L.divIcon({html:'',iconSize:[0,0],className:''});
  const PH=8;
  const bg=thumb?`background-image:url('${thumb}');background-size:cover;background-position:center;`:'';
  return L.divIcon({
    html:`<div class="nm-pin ${cls}" style="width:${size}px;height:${size}px;${bg}">${!thumb?'<div class="nm-noimg">📰</div>':''}</div>`,
    iconSize:[size,size+PH],
    iconAnchor:[size/2,size+PH],
    className:'',
  });
}

// ── Haversine ─────────────────────────────────────────────────
function haversine(la1,lo1,la2,lo2){
  const R=6371,r=d=>d*Math.PI/180;
  const a=Math.sin(r(la2-la1)/2)**2+Math.cos(r(la1))*Math.cos(r(la2))*Math.sin(r(lo2-lo1)/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ── Relative time in Bengali ──────────────────────────────────
function relTime(u){
  const d=Math.floor(Date.now()/1000)-u;
  if(d<60)   return d+'সে আগে';
  if(d<3600) return Math.floor(d/60)+'মি আগে';
  if(d<86400)return Math.floor(d/3600)+'ঘ আগে';
  return Math.floor(d/86400)+'দিন আগে';
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ── API ───────────────────────────────────────────────────────
async function api(method,url,body,isForm){
  const opts={method,headers:{}};
  if(S.token) opts.headers['Authorization']='Bearer '+S.token;
  if(body){
    if(isForm) opts.body=body;
    else{opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}
  }
  try{
    const r=await fetch(url,opts);
    const ct=r.headers.get('content-type')||'';
    if(!ct.includes('application/json')){
      const t=await r.text();
      console.error('API non-JSON',r.status,t.slice(0,200));
      return{error:'সার্ভার ত্রুটি ('+r.status+')'};
    }
    const data=await r.json();
    data._status=r.status;
    return data;
  }catch(e){console.error('API',e);return{error:'নেটওয়ার্ক ত্রুটি: '+e.message};}
}

// ── Toast ─────────────────────────────────────────────────────
let _tt;
function toast(msg,err){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast show'+(err?' err':'');
  clearTimeout(_tt); _tt=setTimeout(()=>el.classList.remove('show'),3500);
}

// ── GPS — never rejects ───────────────────────────────────────
function getLocation(){
  return new Promise(res=>{
    if(S.userLat!==null) return res({lat:S.userLat,lon:S.userLon});
    if(!navigator.geolocation){S.userLat=23.8103;S.userLon=90.4125;return res({lat:23.8103,lon:90.4125});}
    navigator.geolocation.getCurrentPosition(
      p=>{S.userLat=p.coords.latitude;S.userLon=p.coords.longitude;res({lat:S.userLat,lon:S.userLon});},
      ()=>{if(!S.userLat){S.userLat=23.8103;S.userLon=90.4125;}res({lat:S.userLat,lon:S.userLon});},
      {enableHighAccuracy:true,timeout:8000,maximumAge:30000}
    );
  });
}

// ── Tab router ────────────────────────────────────────────────
function switchTab(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  const el=document.getElementById('screen-'+name);
  if(el) el.classList.add('active');
  S.activeTab=name;
  if(name==='home')    loadHome();
  if(name==='map')     initMap();
  if(name==='explore') loadExplore();
  if(name==='user')    renderUser();
  if(name==='report')  initReportMap();
}

// ═══════════════════════════════════════════════════════════════
// HOME FEED
// ═══════════════════════════════════════════════════════════════
async function loadHome(){
  const el=document.getElementById('home-content');
  el.innerHTML='<div class="spinner"><b></b></div>';
  const{lat,lon}=await getLocation();
  const feed=await api('GET',`/api/feed?lat=${lat}&lon=${lon}`);
  if(!Array.isArray(feed)||!feed.length){
    el.innerHTML=`<div class="empty">
      <div class="e-icon">🗺️</div>
      <p>আশেপাশে এখনো কোনো সংবাদ নেই।<br>আপনিই প্রথম রিপোর্ট করুন!</p>
    </div>`;
    return;
  }
  const pct=n=>{const t=+n.real_score+(+n.fake_score);return t>0?Math.round((+n.real_score/t)*100):50;};
  const hero=feed[0], rest=feed.slice(1,5), later=feed.slice(5);

  el.innerHTML=`
    <div class="feed-wrap">
      <div class="section-label">আপনার আশেপাশে</div>
      <div class="hero-card glass" onclick="openModal('${hero.id}')">
        ${hero.thumb?`<div class="hero-img" style="background-image:url('${esc(hero.thumb)}')"></div>`:'<div class="hero-img hero-noimg">📰</div>'}
        <div class="hero-body">
          <div class="hero-badge ${+hero.real_score>+hero.fake_score?'badge-real':'badge-fake'}">${+hero.real_score>+hero.fake_score?'✓ সত্য':'⚠ সন্দেহজনক'}</div>
          <div class="hero-title">${esc(hero.title)}</div>
          <div class="hero-meta">
            <span>${relTime(hero.created_at)}</span>
            <span>${haversine(lat,lon,hero.lat,hero.lon).toFixed(1)} কিমি দূরে</span>
          </div>
          <div class="truth-bar-wrap"><div class="truth-bar" style="width:${pct(hero)}%"></div></div>
        </div>
      </div>

      ${rest.length?`
      <div class="section-label" style="margin-top:20px">সাম্প্রতিক সংবাদ</div>
      <div class="card-row">
        ${rest.map(n=>`
          <div class="mini-card glass" onclick="openModal('${n.id}')">
            ${n.thumb?`<div class="mini-img" style="background-image:url('${esc(n.thumb)}')"></div>`:'<div class="mini-img mini-noimg">📰</div>'}
            <div class="mini-body">
              <div class="mini-title">${esc(n.title)}</div>
              <div class="mini-meta">
                <span class="score-pill ${+n.real_score>+n.fake_score?'pill-real':'pill-fake'}">${pct(n)}%</span>
                <span>${haversine(lat,lon,n.lat,n.lon).toFixed(1)} কিমি</span>
              </div>
            </div>
          </div>`).join('')}
      </div>`:``}

      ${later.length?`
      <div class="section-label" style="margin-top:20px">আরো সংবাদ</div>
      ${later.map(n=>`
        <div class="list-card glass" onclick="openModal('${n.id}')">
          ${n.thumb?`<div class="list-img" style="background-image:url('${esc(n.thumb)}')"></div>`:'<div class="list-img list-noimg">📰</div>'}
          <div class="list-body">
            <div class="list-title">${esc(n.title)}</div>
            <div class="list-meta">${relTime(n.created_at)} · ${haversine(lat,lon,n.lat,n.lon).toFixed(1)} কিমি</div>
          </div>
          <div class="list-score ${+n.real_score>+n.fake_score?'score-real':'score-fake'}">${pct(n)}%</div>
        </div>`).join('')}`:``}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
// MAP — init once, never re-init
// ═══════════════════════════════════════════════════════════════
let MAP=null, userCircle=null, userDot=null;
let _mapDebounce=null;

async function initMap(){
  if(S.mapReady){
    setTimeout(()=>{ if(MAP){ MAP.invalidateSize(); triggerLoad(); } },80);
    return;
  }
  S.mapReady=true;

  const{lat,lon}=await getLocation();

  MAP=L.map('map',{
    zoomControl:false,
    preferCanvas:true,
    tap:true,
    tapTolerance:15,
  }).setView([lat,lon],15);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'&copy; OpenStreetMap',
    maxZoom:19,
    keepBuffer:2,
    updateWhenIdle:false,
    updateWhenZooming:false,
  }).addTo(MAP);

  L.control.zoom({position:'bottomright'}).addTo(MAP);

  // Wait for map container to be fully rendered before invalidating
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      MAP.invalidateSize();
      drawUserCircle(lat,lon);
      triggerLoad();
    });
  });

  MAP.on('moveend',()=>{ clearTimeout(_mapDebounce); _mapDebounce=setTimeout(triggerLoad,250); });
  MAP.on('zoomend',()=>{ clearTimeout(_mapDebounce); _mapDebounce=setTimeout(triggerLoad,250); });
}

function triggerLoad(){
  if(!MAP) return;
  CM.update(MAP.getCenter(), MAP.getZoom());
}

function drawUserCircle(lat,lon){
  if(userCircle){ userCircle.remove(); userDot&&userDot.remove(); }
  userCircle=L.circle([lat,lon],{
    radius:5000, color:'#00c48c', weight:1.5, opacity:0.5,
    dashArray:'6 6', fillColor:'#00c48c', fillOpacity:0.04, interactive:false,
  }).addTo(MAP);
  userDot=L.circleMarker([lat,lon],{
    radius:8, color:'#fff', weight:2.5,
    fillColor:'#3a5bff', fillOpacity:1, interactive:false,
  }).addTo(MAP);
}

function locateMe(){
  if(!MAP) return;
  S.userLat=null;
  getLocation().then(({lat,lon})=>{
    MAP.flyTo([lat,lon],15,{duration:0.8});
    drawUserCircle(lat,lon);
    toast('অবস্থান আপডেট হয়েছে');
  });
}

// ═══════════════════════════════════════════════════════════════
// REPORT MAP — 5km pin enforcer
// ═══════════════════════════════════════════════════════════════
let RMAP=null, reportPin=null, reportMapReady=false;

async function initReportMap(){
  if(reportMapReady) return;
  reportMapReady=true;

  const{lat,lon}=await getLocation();
  RMAP=L.map('report-map',{zoomControl:true}).setView([lat,lon],14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(RMAP);

  // 5km zone ring
  L.circle([lat,lon],{
    radius:5000, color:'#00c48c', weight:2, opacity:0.8,
    dashArray:'7 5', fillColor:'#00c48c', fillOpacity:0.07, interactive:false,
  }).addTo(RMAP);

  // User dot
  L.circleMarker([lat,lon],{radius:8,color:'#fff',weight:2.5,fillColor:'#3a5bff',fillOpacity:1,interactive:false}).addTo(RMAP);

  const hint=document.getElementById('rmap-hint');
  const badge=document.getElementById('rmap-coords');

  RMAP.on('click',e=>{
    const plat=e.latlng.lat, plon=e.latlng.lng;
    const dist=haversine(lat,lon,plat,plon);
    const ok=dist<=5;
    S.reportLat=plat; S.reportLon=plon; S.pinInRange=ok;
    if(reportPin) reportPin.remove();
    reportPin=L.circleMarker([plat,plon],{radius:10,color:'#fff',weight:2.5,fillColor:ok?'#00c48c':'#ff4060',fillOpacity:1}).addTo(RMAP);
    hint.style.display='none';
    badge.style.display='block';
    badge.textContent=ok?`${dist.toFixed(2)} কিমি — জোনের ভেতরে ✓`:`${dist.toFixed(2)} কিমি — ৫ কিমি সীমার বাইরে ✗`;
    badge.className=ok?'rmap-coords-ok':'rmap-coords-warn';
  });

  setTimeout(()=>RMAP.invalidateSize(),100);
}

function previewImages(input){
  const p=document.getElementById('img-preview');
  p.innerHTML='';
  [...input.files].slice(0,10).forEach(f=>{
    const img=document.createElement('img');
    img.src=URL.createObjectURL(f);
    p.appendChild(img);
  });
}

async function submitReport(){
  if(!S.token){ toast('প্রথমে লগইন করুন',true); switchTab('user'); return; }
  const title=document.getElementById('r-title').value.trim();
  const desc=document.getElementById('r-desc').value.trim();
  const links=document.getElementById('r-links').value.trim();
  const imgs=document.getElementById('r-images').files;
  if(!title){ toast('শিরোনাম আবশ্যক',true); return; }
  if(!S.reportLat){ toast('মানচিত্রে পিন করুন',true); return; }
  if(S.pinInRange===false){ toast('পিন ৫ কিমি সীমার বাইরে আছে',true); return; }
  const ul=S.userLat??S.reportLat, ulo=S.userLon??S.reportLon;
  const btn=document.getElementById('submit-btn');
  btn.disabled=true; btn.textContent='প্রকাশ হচ্ছে...';
  const fd=new FormData();
  fd.append('title',title); fd.append('description',desc);
  fd.append('lat',S.reportLat); fd.append('lon',S.reportLon);
  fd.append('links',links); fd.append('user_lat',ul); fd.append('user_lon',ulo);
  [...imgs].forEach(f=>fd.append('images',f));
  const r=await api('POST','/api/news',fd,true);
  btn.disabled=false; btn.textContent='প্রকাশ করুন';
  if(r.error){ toast('ত্রুটি: '+r.error,true); return; }
  toast('সংবাদ প্রকাশিত হয়েছে!');
  ['r-title','r-desc','r-links'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('r-images').value='';
  document.getElementById('img-preview').innerHTML='';
  const cb=document.getElementById('rmap-coords');
  if(cb){cb.style.display='none';cb.className='';}
  document.getElementById('rmap-hint').style.display='flex';
  S.reportLat=null;S.reportLon=null;S.pinInRange=null;
  if(reportPin){reportPin.remove();reportPin=null;}
  reportMapReady=false;
  if(RMAP){RMAP.remove();RMAP=null;}
  CM.reset(); S.mapReady=false;
  switchTab('home');
}

// ═══════════════════════════════════════════════════════════════
// EXPLORE
// ═══════════════════════════════════════════════════════════════
async function loadExplore(){
  const el=document.getElementById('explore-content');
  el.innerHTML='<div class="spinner"><b></b></div>';
  const{lat,lon}=await getLocation();
  const feed=await api('GET',`/api/feed?lat=${lat}&lon=${lon}`);
  if(!Array.isArray(feed)||!feed.length){
    el.innerHTML='<div class="empty"><div class="e-icon">🔍</div><p>আশেপাশে কিছু নেই।</p></div>';
    return;
  }
  const pct=n=>{const t=+n.real_score+(+n.fake_score);return t>0?Math.round((+n.real_score/t)*100):50;};
  el.innerHTML=`<div class="feed-wrap">
    <div class="section-label">সকল সংবাদ</div>
    ${feed.map(n=>`
      <div class="list-card glass" onclick="openModal('${n.id}')">
        ${n.thumb?`<div class="list-img" style="background-image:url('${esc(n.thumb)}')"></div>`:'<div class="list-img list-noimg">📰</div>'}
        <div class="list-body">
          <div class="list-title">${esc(n.title)}</div>
          <div class="list-meta">${relTime(n.created_at)} · ${haversine(lat,lon,n.lat,n.lon).toFixed(1)} কিমি</div>
        </div>
        <div class="list-score ${+n.real_score>+n.fake_score?'score-real':'score-fake'}">${pct(n)}%</div>
      </div>`).join('')}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════════════════════
async function openModal(newsId){
  const ol=document.getElementById('modal-overlay');
  const ct=document.getElementById('modal-content');
  ct.innerHTML='<div class="spinner"><b></b></div>';
  ol.classList.add('open');
  document.body.style.overflow='hidden';

  const n=await api('GET','/api/news/'+newsId);
  if(n.error){ct.innerHTML=`<div class="empty"><p>${esc(n.error)}</p></div>`;return;}

  const dist=(S.userLat!=null)?haversine(S.userLat,S.userLon,n.lat,n.lon):null;
  const canVote=S.token&&dist!==null&&dist<=5;
  const real=+(n.real_score||0), fake=+(n.fake_score||0);
  const total=real+fake, pct=total>0?Math.round((real/total)*100):50;
  const images=Array.isArray(n.images)?n.images:[];
  const isOwner=S.username&&n.username===S.username;
  const ageS=Math.floor(Date.now()/1000)-(+n.created_at||0);
  const canDel=isOwner&&ageS<10800;
  const minLeft=Math.max(0,Math.round((10800-ageS)/60));

  const carHTML=images.length
    ?`<div class="carousel" id="car-${newsId}">${images.map((src,i)=>`
        <div class="car-slide">
          <img src="${esc(src)}" loading="lazy" onerror="this.closest('.car-slide').style.display='none'"
               style="width:100%;height:220px;object-fit:cover;border-radius:12px;display:block">
          ${images.length>1?`<div class="car-counter">${i+1} / ${images.length}</div>`:''}
        </div>`).join('')}</div>`
    :`<div class="no-img-ph">📷 ছবি যুক্ত নেই</div>`;

  const rawLinks=(n.links||'').trim();
  const linksHTML=rawLinks
    ?rawLinks.split(/[\s,]+/).filter(Boolean)
      .map(l=>`<a href="${esc(l)}" target="_blank" rel="noopener">${esc(l.replace(/^https?:\/\//,'').slice(0,40))}</a>`).join('')
    :'';

  ct.innerHTML=`
    ${carHTML}
    <div class="modal-title">${esc(n.title)}</div>
    <div class="modal-meta-row">
      <span class="meta-chip">✍️ ${esc(n.username)}</span>
      <span class="meta-chip">🕐 ${relTime(+n.created_at)}</span>
      ${dist!=null?`<span class="meta-chip ${dist>5?'chip-warn':''}">${dist>5?'🔴':'🟢'} ${dist.toFixed(2)} কিমি</span>`:''}
    </div>
    ${n.description?`<div class="modal-desc">${esc(n.description)}</div>`:''}

    <div class="truth-meter">
      <div class="tm-label"><span class="tm-fake">মিথ্যা ${fake.toFixed(1)}</span><span class="tm-real">সত্য ${real.toFixed(1)}</span></div>
      <div class="truth-bar-wrap"><div class="truth-bar" style="width:${pct}%"></div></div>
      <div class="tm-pct">${pct}% সত্যতা · ${+(n.vote_count||0)} ভোট</div>
    </div>

    <div class="vote-row">
      <button class="btn-vote btn-real" onclick="castVote('${n.id}','real')" ${!canVote?'disabled':''}>
        ✓ সত্য
      </button>
      <button class="btn-vote btn-fake" onclick="castVote('${n.id}','fake')" ${!canVote?'disabled':''}>
        ✗ মিথ্যা
      </button>
    </div>
    ${!S.token
      ?`<div class="vote-hint">ভোট দিতে লগইন করুন</div>`
      :dist==null
        ?`<div class="vote-hint">ভোট দিতে লোকেশন চালু করুন</div>`
        :dist>5
          ?`<div class="vote-hint chip-warn">আপনি ৫ কিমি বাইরে আছেন (${dist.toFixed(1)} কিমি)</div>`
          :`<div class="vote-hint" style="color:var(--green)">আপনি ${dist.toFixed(2)} কিমি দূরে — ভোট দিতে পারবেন</div>`
    }

    ${linksHTML?`<div class="links-section"><div class="field-label" style="margin-bottom:6px">📎 সূত্র</div><div class="modal-links">${linksHTML}</div></div>`:''}

    <div class="detail-grid">
      <div class="detail-item"><div class="di-label">স্থানাঙ্ক</div><div class="di-val">${(+n.lat).toFixed(4)}°, ${(+n.lon).toFixed(4)}°</div></div>
      <div class="detail-item"><div class="di-label">সময়</div><div class="di-val">${new Date((+n.created_at)*1000).toLocaleString('bn-BD',{hour:'numeric',minute:'2-digit',day:'numeric',month:'short'})}</div></div>
    </div>

    ${canDel?`<button class="btn-delete" onclick="deleteNews('${n.id}')">🗑 মুছুন (${minLeft} মিনিট বাকি)</button>`:''}
  `;
}

function closeModal(e){
  if(e.target===document.getElementById('modal-overlay')){
    document.getElementById('modal-overlay').classList.remove('open');
    document.body.style.overflow='';
  }
}

async function castVote(newsId,type){
  if(!S.token){toast('লগইন করুন',true);return;}
  if(S.userLat==null){toast('লোকেশন চালু করুন',true);return;}
  const r=await api('POST','/api/vote',{news_id:newsId,type,user_lat:S.userLat,user_lon:S.userLon});
  if(r.error){toast(r.error,true);return;}
  toast(`ভোট দেওয়া হয়েছে — ওজন ${r.weight}`);
  openModal(newsId);
}

async function deleteNews(newsId){
  if(!confirm('এই রিপোর্ট মুছে ফেলবেন? এটি পূর্বাবস্থায় ফেরানো যাবে না।')) return;
  const r=await api('DELETE','/api/news/'+newsId);
  if(r.error){toast(r.error,true);return;}
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.style.overflow='';
  if(CM.markers[newsId]){if(MAP)MAP.removeLayer(CM.markers[newsId].layer);delete CM.markers[newsId];}
  toast('রিপোর্ট মুছে ফেলা হয়েছে');
  loadHome();
}

// ═══════════════════════════════════════════════════════════════
// AUTH / USER
// ═══════════════════════════════════════════════════════════════
function renderUser(){
  const el=document.getElementById('user-content');
  if(!S.token){
    el.innerHTML=`
      <div class="topbar"><h1>অ্যাকাউন্ট</h1></div>
      <div class="auth-wrap">
        <div class="auth-tabs">
          <button class="auth-tab active" id="tab-login" onclick="authTab('login')">লগইন</button>
          <button class="auth-tab" id="tab-register" onclick="authTab('register')">নিবন্ধন</button>
        </div>
        <div class="report-form">
          <div>
            <div class="field-label">ইউজারনেম</div>
            <input class="f-input" id="a-user" placeholder="ইউজারনেম লিখুন" autocapitalize="none" autocorrect="off">
          </div>
          <div>
            <div class="field-label">পাসওয়ার্ড</div>
            <input class="f-input" id="a-pass" type="password" placeholder="কমপক্ষে ৬ অক্ষর">
          </div>
          <button class="btn-submit" onclick="doAuth()">প্রবেশ করুন</button>
        </div>
      </div>`;
    return;
  }
  const init=S.username[0].toUpperCase();
  document.getElementById('avatar-btn').textContent=init;
  el.innerHTML=`
    <div class="user-hero">
      <div class="user-avatar-big">${init}</div>
      <div class="user-name">${esc(S.username)}</div>
      <div class="user-trust">বিডি নিউজম্যাপ সদস্য</div>
    </div>
    <div style="padding:0 16px;margin-top:20px">
      <button class="btn-submit" style="background:linear-gradient(135deg,#e02040,#900020)" onclick="logout()">লগআউট</button>
    </div>`;
}

let _authMode='login';
function authTab(m){
  _authMode=m;
  document.getElementById('tab-login').classList.toggle('active',m==='login');
  document.getElementById('tab-register').classList.toggle('active',m==='register');
}
async function doAuth(){
  const username=document.getElementById('a-user').value.trim();
  const password=document.getElementById('a-pass').value;
  if(!username||!password){toast('সব তথ্য দিন',true);return;}
  const r=await api('POST',_authMode==='login'?'/api/login':'/api/register',{username,password});
  if(r.error){toast(r.error,true);return;}
  S.token=r.token; S.username=r.username;
  toast('স্বাগতম, '+r.username+'!');
  renderUser(); loadHome();
}
function logout(){S.token=null;S.username=null;renderUser();toast('লগআউট হয়েছে');}

// ── Boot ──────────────────────────────────────────────────────
(async function init(){
  getLocation();   // warm GPS silently
  loadHome();
})();
