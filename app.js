"use strict";
const $=(s,e=document)=>e.querySelector(s),$$=(s,e=document)=>[...e.querySelectorAll(s)];
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
const sp=(s,re=/;/)=>String(s||"").split(re).map(x=>x.trim()).filter(Boolean);
const money=n=>n.toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const today=()=>new Date().toISOString().slice(0,10);
const same=b=>norm([b.tipo||"livro",b.title,b.tipo==="revista"?[b.number,b.volume,b.month,b.pubDate].join("/"):b.authors].join("|"));
/* filtros: [chave, rótulo, função que extrai os valores de cada item] */
const FAC=[["shelf","Prateleira",b=>[b.shelf]],["author","Autor",b=>sp(b.authors).map(x=>nice(x))],["translator","Tradutor",b=>sp(b.translators)],
["contrib","Organizador / ilustrador",b=>[...sp(b.editors),...sp(b.illustrators)]],["publisher","Editora",b=>[b.publisher]],["year","Ano de publicação",b=>[String(b.pubDate||"")]],["collection","Coleção",b=>[b.collection]],
["category","Categoria",b=>sp(b.categories)],["tag","Etiqueta",b=>b.tags||[]],["person","Pessoa (qualquer função)",b=>[...sp(b.authors),...sp(b.editors),...sp(b.translators),...sp(b.illustrators)].map(x=>nice(x))]];
let db,books=[],goals=[],catalog=[],view="livros",mode="grade",shelfMode="estante",impMode="add",impDest="books",F={q:"",tipo:"",status:"",sort:"added",hits:null};
FAC.forEach(([k])=>F[k]="");
let cur=null,stack=[],IDX={isbn:new Map(),cat:new Map(),key:new Map()};

/* ---------- Banco de dados (Supabase) ----------
   Cada tabela (books, catalog, goals) guarda: id, user_id (dono) e data (o item em JSON).
   As regras de segurança (RLS) em supabase.sql garantem que só o dono enxerga e altera os dados. */
const CFG=window.ACERVO_CONFIG||{};
let sb=null,user=null,admin=false,selMode=false,autores=[],precos=[];const sel=new Set();
const LC=Object.assign({ar:"2/3",w:84,fit:"cover",f:["category","pages","year","shelf","format","tags","price","bdate"]},(()=>{try{return JSON.parse(localStorage.getItem("lc"))||{}}catch{return{}}})());
const TABLES=["books","catalog","goals"],PAGE=1000;
const must=r=>{if(r.error)throw r.error;return r.data};
const strip=o=>{const {id,...d}=o;return d};
const store=n=>({
  async getAll(){const out=[];for(let i=0;;){const d=must(await sb.from(n).select("id,data").order("id").range(i,i+PAGE-1));
    if(!d.length)break;d.forEach(r=>out.push({...r.data,id:r.id}));i+=d.length}return out},
  async add(o){return must(await sb.from(n).insert({data:strip(o)}).select("id").single()).id},
  /* o Postgres devolve os ids na mesma ordem em que as linhas foram inseridas */
  async addMany(a){const ids=[];for(let i=0;i<a.length;i+=200)must(await sb.from(n).insert(a.slice(i,i+200).map(o=>({data:strip(o)}))).select("id")).forEach(r=>ids.push(r.id));return ids},
  async put(o){if(o.id==null)return this.add(o);must(await sb.from(n).update({data:strip(o),updated_at:new Date().toISOString()}).eq("id",o.id));return o.id},
  async putMany(a){for(let i=0;i<a.length;i+=200)must(await sb.from(n).upsert(a.slice(i,i+200).map(o=>({id:o.id,data:strip(o),updated_at:new Date().toISOString()})),{onConflict:"id"}))},
  async delete(id){must(await sb.from(n).delete().eq("id",id))},
  async clear(){must(await sb.from(n).delete().gt("id",0))},
  async delMany(a){for(let i=0;i<a.length;i+=200)must(await sb.from(n).delete().in("id",a.slice(i,i+200)))}
});
const st=n=>store(n);
const rq=r=>Promise.resolve(r);
/* capas enviadas pelo usuário vão para o Storage (bucket "capas"); no banco fica só o endereço */
async function uploadCover(uri){
  const blob=await(await fetch(uri)).blob(),ext=blob.type.includes("png")?"png":"jpg",path=`${user.id}/${crypto.randomUUID()}.${ext}`;
  const r=await sb.storage.from("capas").upload(path,blob,{contentType:blob.type||"image/jpeg",cacheControl:"31536000"});
  if(r.error)throw r.error;return sb.storage.from("capas").getPublicUrl(path).data.publicUrl}
async function uploadCovers(items){
  const todo=items.filter(b=>String(b.cover||"").startsWith("data:")),total=todo.length;let done=0,fail=0;
  const work=async()=>{for(let b;(b=todo.shift());){try{b.cover=await uploadCover(b.cover)}catch{b.cover="";fail++}
    done++;if(total>3&&(done%5===0||done===total))toast(`Enviando capas… ${done}/${total}`)}};
  await Promise.all([work(),work(),work(),work()]);
  if(fail)toast(`${fail} capa(s) não puderam ser enviadas`)}
const load=async()=>{try{[books,goals,catalog,admin,autores,precos]=await Promise.all([user?st("books").getAll():[],user?st("goals").getAll():[],st("catalog").getAll(),user?sb.from("admins").select("user_id").eq("user_id",user.id).then(r=>!r.error&&r.data.length>0):false,st("autores").getAll().catch(()=>[]),st("precos").getAll().catch(()=>[])])}
  catch(e){return toast("Não consegui carregar os dados: "+(e.message||e))}overlay();reindex();render()};

/* ---------- Regras ---------- */
const status=b=>b.end?"Lido":b.pagesRead>0?"Lendo":"Não lido";
const prog=b=>b.end?100:b.pages&&b.pagesRead?Math.min(100,Math.round(b.pagesRead/b.pages*100)):0;
const spent=b=>(b.purchases||[]).reduce((s,x)=>s+(Number(x.price)||0),0)||Number(b.boughtPrice)||0;
const tally=a=>{const m=new Map();a.forEach(x=>m.set(x,(m.get(x)||0)+1));return new Map([...m].sort((x,y)=>String(x[0]).localeCompare(String(y[0]),"pt-BR")))};
const own=()=>books.filter(b=>!b.wish);
const shelves=()=>tally(own().map(b=>b.shelf).filter(Boolean));
const tagsMap=()=>tally(own().flatMap(b=>b.tags||[]));
const pool=()=>view==="explorar"?catalog:books.filter(b=>!!b.wish===(view==="desejos"));
const digits=s=>String(s||"").replace(/\D/g,"");
/* índice para achar rápido se um item do catálogo já está no acervo */
const reindex=()=>{IDX={isbn:new Map(),cat:new Map(),key:new Map()};
  books.forEach(b=>{if(b.catId!=null)IDX.cat.set(b.catId,b);const i=digits(b.isbn);if(i)IDX.isbn.set(i,b);IDX.key.set(same(b),b)})};
const ownedOf=c=>IDX.cat.get(c.id)||(c.isbn&&IDX.isbn.get(digits(c.isbn)))||IDX.key.get(same(c));
function filtered(skipSt){
  const q=F.hits?"":norm(F.q),src=pool().filter(b=>!F.hits||F.hits.includes(b.id));
  const l=src.filter(b=>(!F.tipo||(b.tipo||"livro")===F.tipo)&&(!F.status||skipSt||view==="explorar"||status(b)===F.status)
    &&(!F.launch||isLaunch(b))&&FAC.every(([k,,g])=>!F[k]||g(b).includes(F[k]))
    &&(!q||norm([b.title,b.subtitle,b.authors,b.translators,b.editors,b.isbn,b.shelf,b.publisher,b.categories,b.collection,b.note,b.issn,b.theme,b.number,(b.tags||[]).join(" ")].join(" ")).includes(q)));
  const [kf,dr]=SK[F.sort]||SK.added;
  return l.sort((a,b)=>{const x=kf(a),y=kf(b);return (x<y?-1:x>y?1:0)*dr})}

/* ---------- Referências bibliográficas (ABNT simplificada) ---------- */
const auth=b=>{const a=sp(b.authors),f=x=>{const i=x.indexOf(",");return i<0?x:x.slice(0,i).toUpperCase()+x.slice(i)};return a.length>3?f(a[0])+" et al.":a.map(f).join("; ")};
function cite(b,h){const E=x=>h?esc(x):x,A=auth(b),rev=b.tipo==="revista";
  const T=(h?`<b>${esc(b.title)}</b>`:b.title)+(b.subtitle?": "+E(b.subtitle):"");
  const ed=!rev&&b.edition?b.edition+(/ed/i.test(b.edition)?"":" ed."):"";
  const pub=[b.city&&b.city+":",b.publisher].filter(Boolean).join(" ");
  const end=rev?[b.volume&&"v. "+b.volume,b.number&&"n. "+b.number,[b.month,b.pubDate].filter(Boolean).join(" ")].filter(Boolean).join(", "):b.pubDate;
  const tail=[pub,end].filter(Boolean).join(", ");
  return [A&&E(A)+".",T+".",ed&&E(ed)+".",tail&&E(tail)+"."].filter(Boolean).join(" ")}
const refObj=r=>{if(!r.k)return null;const [s,i]=r.k.split(":");return (s==="b"?books:catalog).find(x=>x.id===+i)};
const refText=(r,h)=>{if(r.t)return h?esc(r.t):r.t;const x=refObj(r);return x?cite(x,h):(h?"<i>(item removido)</i>":"(item removido)")};
const sortRefs=a=>a.sort((x,y)=>norm(refText(x)).localeCompare(norm(refText(y)),"pt-BR"));
const copy=t=>(navigator.clipboard?navigator.clipboard.writeText(t).then(()=>toast("Bibliografia copiada")):Promise.reject()).catch(()=>prompt("Copie o texto abaixo:",t));
const openRef=k=>{const [s,i]=k.split(":");if(!(s==="b"?books:catalog).some(x=>x.id===+i))return toast("Item não encontrado");showItem(s,+i)};

/* ---------- Telas ---------- */
const cover=b=>b.cover?`<img loading="lazy" referrerpolicy="no-referrer" src="${esc(b.cover)}" alt="${esc(b.title)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'nocover',textContent:this.alt}))">`:`<div class="nocover">${esc(b.title)}</div>`;
const label=b=>b.tipo==="revista"?`${b.title}${b.number?" nº "+b.number:""}${b.pubDate?" ("+b.pubDate+")":""}`:b.title;
const sub=b=>b.tipo==="revista"?[b.number&&"Nº "+b.number,b.volume&&"Vol. "+b.volume,[b.month,b.pubDate].filter(Boolean).join("/"),b.periodicity].filter(Boolean).join(" · "):b.authors;
const badge=b=>{if(view!=="explorar")return"";const o=ownedOf(b),LN=isLaunch(b)?'<span class="chip on lan">Lançamento</span> ':"";return LN+(o?`<span class="chip on">${o.wish?"Na lista de desejo":"No acervo"}</span>`:"")};
const mark=b=>{const x=view==="livros"&&!b.wish&&b.tipo!=="revista"?status(b):"";return x&&x!=="Não lido"?`<span class="cb ${x==="Lido"?"ok":""}">${x}</span>`:""};
const gcard=b=>`<article class="card" data-id="${b.id}"><div class="cw">${cover(b)}${mark(b)}</div><h3>${esc(label(b))}</h3>${badge(b)}</article>`;
const card=b=>mode!=="grade"?rowHtml(b):mode==="grade"
  ?`<article class="card" data-id="${b.id}"><div class="cw">${cover(b)}${mark(b)}</div><h3>${esc(label(b))}</h3>${badge(b)}</article>`
  :`<article class="row" data-id="${b.id}"><div class="cv">${cover(b)}</div><div><h3>${esc(b.title)}</h3><p class="m">${esc(sub(b))}</p>
    ${b.rating?`<span class="stars">${"★".repeat(b.rating)}${"☆".repeat(5-b.rating)}</span>`:""}
    ${view==="explorar"?"":`<div class="bar"><i style="width:${prog(b)}%"></i></div>`}
    <p class="m">${b.tipo==="revista"?"Revista · ":""}${view==="explorar"?"":status(b)}${b.pages?" · "+b.pages+" p.":""}${b.publisher?" · "+esc(b.publisher):""}${b.pubDate?" · "+esc(b.pubDate):""}${b.shelf?" · "+esc(b.shelf):""}</p>
    <p>${badge(b)}${(b.tags||[]).map(t=>`<span class="chip">${esc(t)}</span>`).join("")}</p></div></article>`;

function render(){chrome();renderSide();
  const bk=own().filter(b=>b.tipo!=="revista").length;
  const rv=own().length-bk;$("#total").textContent=!user?"":`${bk} ${bk===1?"livro":"livros"} · ${rv} ${rv===1?"revista":"revistas"}`;
  $$("#tabs button").forEach(b=>b.classList.toggle("on",b.dataset.v===view));
  const list=["livros","desejos","explorar"].includes(view);
  $("#tools").hidden=!list;$("#exp").hidden=view!=="explorar";
  const P=pool();
  $("#facets").innerHTML=FAC.map(([k,l,g])=>{const m=tally(P.flatMap(g).filter(Boolean));
    return m.size?`<label>${l}<select data-f="${k}"><option value="">Todos</option>${[...m].map(([v,c])=>`<option value="${esc(v)}" ${F[k]===v?"selected":""}>${esc(v)} (${c})</option>`).join("")}</select></label>`:""}).join("")+'<button id="clr">Limpar filtros</button>';
  const sb=$("#stbar");sb.hidden=view==="explorar"||!list;
  if(!sb.hidden){const base=filtered(true);
    sb.innerHTML=[["","Todos",base.length],...["Não lido","Lendo","Lido"].map(x=>[x,x,base.filter(b=>status(b)===x).length])]
      .map(([v,l,n])=>`<button type="button" class="chip st${F.status===v?" on":""}" data-st="${v}" aria-pressed="${F.status===v}">${l} <span>${n}</span></button>`).join("")}
  $("#main").className="";
  ({autores:vAutores,livros:vLivros,desejos:vLivros,explorar:vLivros,prateleiras:()=>vGroup("shelf"),etiquetas:()=>vGroup("tag"),stats:vStats,metas:vMetas})[view]();
}
function vLivros(){const l=filtered(),ex=view==="explorar";$("#main").className=mode==="grade"?"grid":"lista";
  $("#main").innerHTML=l.length?l.map(card).join(""):`<div class="empty">${ex?(catalog.length?"Nada encontrado no catálogo. Use “Buscar na internet” para trazer novos livros.":"O catálogo está vazio. Use “Buscar na internet”, importe uma planilha ou JSON para o catálogo, ou cadastre manualmente."):books.length?"Nenhum item encontrado com esses filtros.":"Sua estante está vazia. Clique em “Novo item” para começar ou importe um backup."}</div>`;
  $("#cnt").textContent=`${l.length} ${ex?"no catálogo":view==="desejos"?"na lista de desejo":"itens"}`;
  markSel();$("#hitbar").innerHTML=F.hits?'<span class="m">Mostrando os resultados da última busca online.</span> <button id="allc">Ver todo o catálogo</button>':""}
const hh=s=>[...String(s)].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0,7);
const spine=b=>{const h=hh(b.title),hue=[8,24,36,150,196,214,262,338][h%8],w=b.pages?Math.max(26,Math.min(52,Math.round(20+b.pages/22))):32,ht=150+h%36;
  return `<button type="button" class="spine" data-id="${b.id}" title="${esc(b.title)}" style="--hue:${hue};--w:${w}px;--ht:${ht}px"><span>${esc(b.title)}</span></button>`};
const shelfHtml=(n,c)=>{const g=shelfMode==="grade",l=own().filter(b=>b.shelf===n).sort((x,y)=>String(x.title).localeCompare(String(y.title),"pt-BR"));
  return `<section class="shelf"><div class="shh"><b>${esc(n)}</b> <span class="m">(${c})</span><span class="sp"></span><button data-go="shelf" data-n="${esc(n)}">Ver livros</button><button data-ren="shelf" data-n="${esc(n)}">Renomear</button></div>
  ${g?`<div class="grid">${l.map(gcard).join("")}</div>`:`<div class="shrow">${l.map(spine).join("")}</div>`}</section>`};
const shelfTog=()=>`<div class="seg" role="group" aria-label="Modo da prateleira">${[["estante","Estante"],["grade","Grade"]].map(([v,l])=>`<button type="button" class="${shelfMode===v?"on":""}" data-sm="${v}" aria-pressed="${shelfMode===v}">${l}</button>`).join("")}</div>`;
function vGroup(kind){const m=kind==="shelf"?shelves():tagsMap();
  const first=n=>own().find(b=>b.cover&&(kind==="shelf"?b.shelf===n:(b.tags||[]).includes(n)));
  $("#main").innerHTML=m.size?(kind==="shelf"?shelfTog():"")+[...m].map(([n,c])=>{const f=first(n);if(kind==="shelf")return shelfHtml(n,c);
    return `<div class="grp"><div class="av">${f?`<img src="${esc(f.cover)}" referrerpolicy="no-referrer" alt="">`:""}</div><div class="gi"><b>${esc(n)}</b> <span class="m">(${c})</span></div>
    <button data-go="${kind}" data-n="${esc(n)}">Ver livros</button><button data-ren="${kind}" data-n="${esc(n)}">Renomear</button></div>`}).join("")
    :`<div class="empty">Nenhuma ${kind==="shelf"?"prateleira":"etiqueta"} ainda. Defina ao cadastrar um item.</div>`}
const bars=(a,f=x=>x)=>{const mx=Math.max(1,...a.map(x=>x[1]));return a.length?a.map(([n,c])=>`<div class="hb"><span>${esc(n)}</span><i style="width:${c/mx*100}%"></i><b>${f(c)}</b></div>`).join(""):'<p class="m">Sem dados ainda.</p>'};
function vStats(){const o=own(),rd=o.filter(b=>b.end),ln=o.filter(b=>!b.end&&b.pagesRead>0),rated=o.filter(b=>b.rating>0);
  const sum=(a,f)=>a.reduce((s,b)=>s+(Number(f(b))||0),0),top=m=>[...m].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const k=[["Livros",o.filter(b=>b.tipo!=="revista").length],["Revistas",o.filter(b=>b.tipo==="revista").length],["Lidos",rd.length],["Lendo",ln.length],["Não lidos",o.length-rd.length-ln.length],
    ["Lista de desejo",books.filter(b=>b.wish).length],["No catálogo",catalog.length],["Páginas na estante",sum(o,b=>b.pages)],["Páginas lidas",sum(rd,b=>b.pages)+sum(ln,b=>b.pagesRead)],
    ["Investido",money(sum(o,spent))],["Nota média",rated.length?(sum(rated,b=>b.rating)/rated.length).toFixed(2):"–"]];
  const gy=new Map();o.forEach(b=>(b.purchases||[]).forEach(p=>{const y=(p.date||"").slice(0,4)||"s/ data";gy.set(y,(gy.get(y)||0)+(Number(p.price)||0))}));
  $("#main").innerHTML=`<div class="kpis">${k.map(([a,v])=>`<div class="kpi"><b>${v}</b><span>${a}</span></div>`).join("")}</div>
   <h2>Por prateleira</h2>${bars(top(shelves()))}<h2>Por etiqueta</h2>${bars(top(tagsMap()))}<h2>Lidos por ano</h2>${bars([...tally(rd.map(b=>b.end.slice(0,4)))])}
   <h2>Investimento por ano de compra</h2>${bars([...gy].sort(),money)}`}
function vMetas(){const y=new Date().getFullYear();
  $("#main").innerHTML=`<form id="gf" class="gf"><input name="t" placeholder="Nome da meta (ex.: Leituras de ${y})" required><input name="n" type="number" min="1" placeholder="Nº de livros" required><input name="y" type="number" value="${y}" required><button class="pri">Adicionar meta</button></form>`+
  (goals.length?goals.map(g=>{const d=own().filter(b=>b.end&&b.end.startsWith(g.y)).length;
    return `<div class="goal"><b>${esc(g.t)}</b> <span class="m">${d} de ${g.n} livros em ${g.y}</span><div class="bar"><i style="width:${Math.min(100,Math.round(d/g.n*100))}%"></i></div><button class="dg" data-dg="${g.id}">Excluir</button></div>`}).join("")
   :'<div class="empty">Nenhuma meta ainda. A meta conta os itens com data de término no ano escolhido.</div>')}

/* ---------- Formulário ---------- */
const PER=["","semanal","quinzenal","mensal","bimestral","trimestral","semestral","anual","especial"];
/* [campo, rótulo, tipo, opções|"full", datalist, aplica-se a: l=livro r=revista p=só acervo pessoal] */
const FIELDS=[["tipo","Tipo","select",["livro","revista"]],["isbn","ISBN","text","","","l"],["title","Título (do livro ou da revista)","text","full"],["subtitle","Subtítulo","text","full"],
["authors","Autores (separe com ;)","text","full","dl_authors","l"],["translators","Tradutores (separe com ;)","text","full","dl_translators","l"],["editors","Organizadores / comentaristas (;)","text","","dl_editors"],["illustrators","Ilustradores (;)","text","","dl_illustrators","l"],
["number","Número / edição","text","","","r"],["volume","Volume","text","","","r"],["month","Mês / período (ex.: Janeiro, Jan–Mar)","text","","","r"],["periodicity","Periodicidade","select",PER,"","r"],["issn","ISSN","text","","","r"],["city","Local de publicação","text","","dl_city"],["theme","Tema / matéria de capa","text","full","","r"],
["categories","Categorias (separe com ;)","text","","dl_categories"],["publisher","Editora","text","","dl_publisher"],["language","Idioma","text","","dl_language"],["pages","Páginas","number"],["edition","Edição","text","","","l"],["pubDate","Ano de publicação","text"],
["format","Formato","select",["","Capa comum","Capa dura","Brochura","Bolso","E-book","Audiolivro","Impressa","Digital (PDF)"]],["collection","Coleção (ex.: Comentário Bíblico Expositivo)","text","full","collections","l"],["series","Volume / nº na coleção","text","","","l"],
["shelf","Prateleira","text","","shelves","lrp"],["tags","Etiquetas (separe com vírgula)","text","","tagl","lrp"],
["rating","Classificação (0 a 5)","select",["0","1","2","3","4","5"],"","lrp"],["pagesRead","Páginas lidas","number","","","lrp"],["start","Começou a ler em","date","","","lrp"],["end","Terminou de ler em","date","","","lrp"],
["sold","Vendido / doado","text","","","lrp"],["condition","Condição","text","","","lrp"],["copies","Número de cópias","number","","","lrp"],["added","Adicionado em","date","","","lrp"],
["contrib","Outros colaboradores","text","full"],["description","Descrição","textarea","full"],["review","Avaliação / resenha","textarea","full","","lrp"],["note","Anotação curta","text","full","","lrp"],["rereads","Releituras (uma por linha: início – fim)","textarea","full","","lrp"],
["buyUrl","Link da loja (Amazon etc.)","url","full","","l"],
["coverUrl","URL da capa (endereço da imagem na internet)","url","full"]];
const fld=([k,l,t,o,dl,w],b)=>{const v=k==="tags"?(b.tags||[]).join(", "):k==="coverUrl"?(b.cover&&!b.cover.startsWith("data:")?b.cover:""):k==="tipo"?(b.tipo||"livro"):b[k]??"";
  const inp=t==="select"?`<select name="${k}">${o.map(x=>`<option value="${x}" ${String(v).toLowerCase()===x.toLowerCase()?"selected":""}>${x.charAt(0).toUpperCase()+x.slice(1)}</option>`).join("")}</select>`
   :t==="textarea"?`<textarea name="${k}" rows="3">${esc(v)}</textarea>`
   :`<input name="${k}" type="${t}" ${t==="number"?'step="any" min="0"':""} value="${esc(v)}" ${dl?`list="${dl}"`:""} ${k==="title"?"required":""}>`;
  return `<label data-w="${w||"lr"}"${o==="full"?' class="full"':""}>${l}${inp}</label>`};
/* registros repetíveis: compras e empréstimos */
const LOGS={purchases:["Registro de compras",[["date","Data","date"],["price","Preço (R$)","number"],["store","Loja / origem","text"],["state","Estado","select",["Novo","Seminovo","Usado"]]]],
  loans:["Empréstimos",[["date","Data","date"],["who","Pessoa","text"],["dir","Movimento","select",["Emprestei","Peguei emprestado"]],["back","Devolvido em","date"]]]};
const logRow=(k,r={})=>`<div class="lr">${LOGS[k][1].map(([f,l,t,o])=>t==="select"?`<select data-f="${f}" aria-label="${l}">${o.map(x=>`<option ${r[f]===x?"selected":""}>${x}</option>`).join("")}</select>`
  :`<input data-f="${f}" type="${t}" placeholder="${l}" title="${l}" aria-label="${l}" value="${esc(r[f]??"")}" ${f==="store"?'list="stores"':f==="who"?'list="people"':""} ${t==="number"?'step="any" min="0"':""}>`).join("")}<button type="button" data-rmrow aria-label="Remover registro">×</button></div>`;
const logSec=(k,b)=>`<fieldset class="lg" data-k="${k}"><legend>${LOGS[k][0]}</legend><div class="rows">${(b[k]||[]).map(r=>logRow(k,r)).join("")}</div><button type="button" data-addrow="${k}">Adicionar registro</button></fieldset>`;
const thumb=f=>new Promise(ok=>{const i=new Image();i.onload=()=>{const s=Math.min(1,400/i.height),c=document.createElement("canvas");c.width=i.width*s;c.height=i.height*s;
  c.getContext("2d").drawImage(i,0,0,c.width,c.height);ok(c.toDataURL("image/jpeg",.8));URL.revokeObjectURL(i.src)};i.src=URL.createObjectURL(f)});
function toast(t){const e=$("#toast");e.textContent=t;e.classList.add("on");setTimeout(()=>e.classList.remove("on"),3000)}
function applyTipo(f,isB){const r=f.elements.tipo.value==="revista";
  $$("[data-w]",f).forEach(l=>{const w=l.dataset.w,on=w.includes(r?"r":"l")&&(isB||!w.includes("p"));l.hidden=!on;$$("input,select,textarea",l).forEach(x=>x.disabled=!on)});
  $("#lk").hidden=r}

function edit(id,store="books",base,ret){
  const isB=store==="books",arr=isB?books:catalog;
  if(id&&!arr.some(x=>x.id===id))return toast("Item não encontrado");
  const b=structuredClone(id?arr.find(x=>x.id===id):(base||(isB?{tipo:F.tipo||"livro",copies:1,added:today(),wish:view==="desejos",shelf:F.shelf,language:"Pt-Br"}:{tipo:"livro",added:today(),language:"Pt-Br"})));
  if(isB){if(!b.purchases?.length&&(b.boughtDate||b.boughtPrice))b.purchases=[{date:b.boughtDate,price:b.boughtPrice}];
    if(!b.loans?.length&&b.lent)b.loans=[{who:b.lent,dir:"Emprestei"}];
    if(!id&&!b.wish&&!b.purchases?.length)b.purchases=[{}]}
  let refs=b.refs||[];const key=(isB?"b:":"c:")+id;
  const by=id?[...books.map(x=>[x,"b:"+x.id]),...catalog.map(x=>[x,"c:"+x.id])].filter(([x])=>(x.refs||[]).some(r=>r.k===key)):[];
  const d=$("#dlg");
  d.className="";d.innerHTML=`<form id="f"><h2>${id?"Editar":"Novo"} ${isB?"item":"item do catálogo"}</h2><div class="hd" id="pv">${b.cover?`<img src="${esc(b.cover)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">`:""}</div>
  <div class="g">${FIELDS.map(x=>fld(x,b)).join("")}
   <label class="full" data-w="lr">Ou envie uma imagem do computador<input type="file" name="coverFile" accept="image/*"></label>
   <label class="ck" data-w="lr"><input type="checkbox" name="rmCover">Remover capa</label>
   <label class="ck" data-w="lrp"><input type="checkbox" name="signed" ${b.signed?"checked":""}>Autografado</label>
   <label class="ck" data-w="lrp"><input type="checkbox" name="wish" ${b.wish?"checked":""}>Na lista de desejo</label></div>
  ${isB?logSec("purchases",b)+logSec("loans",b):""}
  <fieldset class="refs"><legend>Bibliografia (obras citadas)</legend><div id="rl"></div>
   <div class="rs"><input id="rq" placeholder="Buscar no acervo ou no catálogo para citar" aria-label="Buscar obra para citar"><div id="rr"></div></div>
   <div class="rs2"><input id="rf" placeholder="Ou digite uma referência livre" aria-label="Referência livre"><button type="button" id="rfa">Adicionar</button><button type="button" id="rnew">Cadastrar novo livro</button><button type="button" id="rcp">Copiar bibliografia</button></div>
   ${by.length?`<p class="m">Citado em: ${by.map(([x,k])=>`<button type="button" class="lk" data-op="${k}">${esc(x.title)}</button>`).join(" ")}</p>`:""}</fieldset>
  ${dls()}<datalist id="shelves">${[...shelves().keys()].map(s=>`<option value="${esc(s)}">`).join("")}</datalist>
  <datalist id="collections">${[...new Set([...books,...catalog].map(x=>x.collection).filter(Boolean))].sort().map(s=>`<option value="${esc(s)}">`).join("")}</datalist>
  <datalist id="tagl">${[...tagsMap().keys()].map(s=>`<option value="${esc(s)}">`).join("")}</datalist>
  <div id="amzr" class="rs"></div><div class="ft">${id?'<button type="button" class="dg" id="del">Excluir</button>':""}<button type="button" id="lk">Buscar pelo ISBN</button><button type="button" id="amz">Preencher pelo link da Amazon</button><span class="sp"></span><button type="button" id="cx">Cancelar</button><button class="pri">Salvar</button></div></form>`;
  d.showModal();
  const f=$("#f"),draw=()=>{sortRefs(refs);$("#rl").innerHTML=refs.length?refs.map((r,i)=>`<div class="ri"><span>${refText(r,true)}</span><button type="button" data-rm="${i}">Remover</button></div>`).join(""):'<p class="m">Nenhuma obra citada ainda.</p>'};
  draw();applyTipo(f,isB);f.elements.tipo.onchange=()=>applyTipo(f,isB);wireSug(f);
  f.elements.coverUrl.oninput=e=>{$("#pv").innerHTML=/^https?:\/\//i.test(e.target.value)?`<img src="${esc(e.target.value)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">`:""};
  f.onclick=e=>{const t=e.target.closest("[data-rm],[data-add],[data-op],[data-addrow],[data-rmrow]");if(!t)return;const D=t.dataset;
    if(D.rm!==undefined){refs.splice(+D.rm,1);draw()}
    if(D.add){refs.push({k:D.add});$("#rq").value="";$("#rr").innerHTML="";draw()}
    if(D.op&&confirm("Abrir este item? Alterações não salvas neste formulário serão perdidas."))openRef(D.op);
    if(D.addrow)$(`[data-k="${D.addrow}"] .rows`,f).insertAdjacentHTML("beforeend",logRow(D.addrow));
    if(D.rmrow!==undefined)t.closest(".lr").remove()};
  $("#rq").oninput=e=>{const q=norm(e.target.value);if(!q){$("#rr").innerHTML="";return}
    const have=new Set(refs.map(r=>r.k)),hits=[...(isB?books:[]).map(x=>["b:"+x.id,x,"acervo"]),...catalog.map(x=>["c:"+x.id,x,"catálogo"])]
      .filter(([k,x])=>k!==key&&!have.has(k)&&norm(x.title+" "+(x.authors||"")).includes(q)).slice(0,8);
    $("#rr").innerHTML=hits.map(([k,x,s])=>`<button type="button" data-add="${k}">${esc(x.title)} <span class="m">— ${esc(x.authors||"")} (${s})</span></button>`).join("")||'<p class="m">Nada encontrado. Use “Cadastrar novo livro” ou uma referência livre.</p>'};
  $("#rfa").onclick=()=>{const t=$("#rf").value.trim();if(t){refs.push({t});$("#rf").value="";draw()}};
  $("#rcp").onclick=()=>copy(refs.map(r=>refText(r)).join("\n\n"));
  $("#rnew").onclick=async()=>{const id=await miniBook($("#rq").value);if(id){refs.push({k:"c:"+id});$("#rq").value="";$("#rr").innerHTML="";draw()}};
  f.onkeydown=e=>{if(e.key==="Enter"&&e.target.matches("#rf,#rq")){e.preventDefault();if(e.target.id==="rf")$("#rfa").click()}};
  $("#cx").onclick=()=>ret?paint(ret.s,ret.id):d.close();
  $("#lk").onclick=()=>lookup(f);$("#amz").onclick=()=>amazon(f);
  if(id)$("#del").onclick=async()=>{if(confirm(`Excluir “${b.title}”? Esta ação não pode ser desfeita.`)){await rq(st(store,"readwrite").delete(id));d.close();load()}};
  f.onsubmit=async e=>{e.preventDefault();if(await save(f,id,b,store,refs)===false)return;if(ret){await load();paint(ret.s,ret.id)}else{d.close();load()}};
}
async function save(f,id,old,store,refs){
  const isB=store==="books",fd=new FormData(f),o={};
  FIELDS.forEach(([k,,,,,w])=>{if(isB||!(w||"").includes("p"))o[k]=String(fd.get(k)??"").trim()});
  const cu=o.coverUrl;delete o.coverUrl;
  if(cu&&!/^https?:\/\//i.test(cu)){toast("A URL da capa deve começar com http:// ou https://");return false}
  o.tipo=o.tipo||"livro";
  if(isB){o.tags=sp(o.tags,/,/);["pages","pagesRead","rating","copies"].forEach(k=>o[k]=o[k]===""?"":Number(o[k]));
    o.signed=!!fd.get("signed");o.wish=!!fd.get("wish");
    ["purchases","loans"].forEach(k=>o[k]=$$(`[data-k="${k}"] .lr`,f).map(r=>{const x={};$$("[data-f]",r).forEach(i=>{const v=i.value.trim();if(v)x[i.dataset.f]=i.type==="number"?Number(v):v});return x})
      .filter(x=>Object.keys(x).some(z=>z!=="dir"&&z!=="state")))}
  else o.pages=o.pages===""?"":Number(o.pages);
  o.refs=refs;
  if(!id&&(isB?books:catalog).some(b=>same(b)===same(o))&&!confirm("Este item já está cadastrado. Adicionar mesmo assim?"))return false;
  o.cover=old.cover||"";const file=fd.get("coverFile");
  if(file&&file.size)o.cover=await uploadCover(await thumb(file));else if(cu)o.cover=cu;else if(!o.cover.startsWith("data:"))o.cover="";
  if(fd.get("rmCover"))o.cover="";
  if(o.pages&&o.pagesRead>o.pages)o.pagesRead=o.pages;
  const m={...old,...o};if(isB){delete m.boughtDate;delete m.boughtPrice;delete m.lent}
  if(id)m.id=id;if(!isB)m.sy=1;const po=m.priceObs;delete m.priceObs;
  const nid=await rq(st(store,"readwrite").put(m));if(isB){if(m.id==null)m.id=nid;await pushCat(m);if(m.catId!=null){if(po)await addPrice(m.catId,po);for(const p of m.purchases||[])await addPrice(m.catId,{...p,src:"compra"})}}
}
async function lookup(f){
  const isbn=digits(f.elements.isbn.value);if(!isbn)return toast("Digite o ISBN primeiro");
  try{const it=await byIsbn(isbn.length===10?i10to13(isbn):isbn);if(!it)return toast("ISBN não encontrado em nenhuma base");
    const set=(k,x)=>{if(x&&f.elements[k]&&!f.elements[k].value)f.elements[k].value=x};
    ["title","subtitle","authors","publisher","pages","pubDate","language","categories","description"].forEach(k=>set(k,it[k]));
    if(it.cover){set("coverUrl",it.cover);f.elements.coverUrl.dispatchEvent(new Event("input"))}
    toast("Dados preenchidos. Confira antes de salvar.");
  }catch{toast("Sem conexão com a internet. Preencha manualmente.")}
}

/* ---------- Explorar: catálogo local + busca online ---------- */
const PROV={
  google:{n:"Google Livros",async q(t,pt){const r=await(await fetch("https://www.googleapis.com/books/v1/volumes?maxResults=30&q="+encodeURIComponent(t)+(pt?"&langRestrict=pt":""))).json();
    return (r.items||[]).map(i=>{const v=i.volumeInfo,ids=v.industryIdentifiers||[];
      return {title:v.title,subtitle:v.subtitle||"",authors:(v.authors||[]).join("; "),publisher:v.publisher||"",pubDate:(v.publishedDate||"").slice(0,4),pages:v.pageCount||"",
        isbn:(ids.find(x=>x.type==="ISBN_13")||ids[0]||{}).identifier||"",categories:(v.categories||[]).join("; "),language:v.language||"",description:v.description||"",
        cover:(v.imageLinks?.thumbnail||"").replace("http:","https:"),src:"Google Livros"}})}},
  ol:{n:"Open Library",async q(t,pt){const r=await(await fetch("https://openlibrary.org/search.json?limit=30&fields=title,subtitle,author_name,first_publish_year,publisher,isbn,number_of_pages_median,language,subject,cover_i&q="+encodeURIComponent(t)+(pt?"&language=por":""))).json();
    return (r.docs||[]).map(x=>({title:x.title,subtitle:x.subtitle||"",authors:(x.author_name||[]).join("; "),publisher:(x.publisher||[])[0]||"",pubDate:String(x.first_publish_year||""),pages:x.number_of_pages_median||"",
      isbn:(x.isbn||[]).find(i=>i.length===13)||(x.isbn||[])[0]||"",categories:(x.subject||[]).slice(0,4).join("; "),language:(x.language||[])[0]||"",
      cover:x.cover_i?`https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg`:"",src:"Open Library"}))}}};
async function searchOnline(){if(!need())return;
  const q=F.q.trim();if(!q)return toast("Digite no campo de busca: título, autor, ISBN ou assunto");
  const p=PROV[$("#prov").value];toast(`Buscando no ${p.n}…`);
  let items;try{items=await p.q(q,$("#pt").checked)}catch{return toast("Não consegui buscar. Verifique a conexão com a internet.")}
  const ids=[];let novos=0;
  for(const it of items){if(!it.title)continue;const x={tipo:"livro",added:today(),...it};
    const ex=catalog.find(c=>(x.isbn&&c.isbn===x.isbn)||same(c)===same(x));
    if(ex)ids.push(ex.id);else{const id=await rq(st("catalog","readwrite").add(x));ids.push(id);catalog.push({...x,id});novos++}}
  F.hits=ids;await load();toast(`${ids.length} resultados, ${novos} novos salvos no catálogo`);
}
const toBook=(c,extra)=>{const b={...c,...extra,copies:1,added:today(),tags:c.tags||[],catId:c.id,refs:structuredClone(c.refs||[])};delete b.id;delete b.src;return b};
/* ---------- Pop-up de detalhes do item ---------- */
const akey=a=>{a=String(a||"").trim();const i=a.indexOf(",");return norm(i<0?a:a.slice(i+1)+" "+a.slice(0,i)).replace(/\s+/g," ").trim()};
const nice=a=>{a=String(a||"").trim();const i=a.indexOf(",");return i<0?a:(a.slice(i+1).trim()+" "+a.slice(0,i).trim())};
const ckey=c=>norm(c).replace(/\s+/g," ").trim();
const fmtD=d=>{const m=String(d||"").match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}/${m[2]}/${m[1]}`:(d||"")};
const volTxt=v=>/^\d+$/.test(String(v).trim())?"Vol. "+String(v).trim():String(v);
const L=v=>sp(v).join(", ");
/* tudo o que existe: acervo + lista de desejo + catálogo (sem repetir o que já está no acervo) */
const everything=()=>[...books.map(r=>({s:"b",r})),...catalog.filter(c=>!ownedOf(c)).map(r=>({s:"c",r}))];
const byTitle=(x,y)=>String(x.r.title).localeCompare(String(y.r.title),"pt-BR",{numeric:true});
const vnum=e=>parseFloat((String(e.r.series||"").match(/\d+(?:[.,]\d+)?/)||[""])[0].replace(",","."))||1e9;
const byVol=(x,y)=>vnum(x)-vnum(y)||byTitle(x,y);
const byEdition=(x,y)=>(parseInt(y.r.pubDate)||0)-(parseInt(x.r.pubDate)||0)||(parseFloat(y.r.number)||0)-(parseFloat(x.r.number)||0);
/* grupos de "mais livros": um por autor (até 3) e um da coleção */
function related_old(s,r){
  const me=same(r),mine=s==="c"?ownedOf(r):null,out=[];
  const rest=everything().filter(e=>e.r!==r&&e.r!==mine&&same(e.r)!==me);
  if(r.tipo==="revista"){
    const t=norm(r.title),l=rest.filter(e=>e.r.tipo==="revista"&&norm(e.r.title)===t).sort(byEdition);
    if(l.length)out.push({h:`Outras edições de ${r.title}`,l,k:"ed"});
    return out}
  const eds=everything().filter(e=>e.r!==r&&e.r!==mine&&same(e.r)===me).sort(byEdition);
  if(eds.length)out.push({h:"Outras edições",l:eds,k:"ed2"});
  sp(r.authors).slice(0,3).forEach(a=>{const k=akey(a),
    l=rest.filter(e=>e.r.tipo!=="revista"&&sp(e.r.authors).some(x=>akey(x)===k)).sort(byTitle);
    if(l.length)out.push({h:`Mais livros de ${nice(a)}`,l,k:"au"})});
  if(r.collection){const k=ckey(r.collection),
    l=rest.filter(e=>e.r.tipo!=="revista"&&e.r.collection&&ckey(e.r.collection)===k).sort(byVol);
    if(l.length)out.push({h:`Outros livros da coleção ${r.collection}`,l,k:"co"})}
  return out}
const where=e=>e.s==="c"?"Catálogo":e.r.wish?"Lista de desejo":"No acervo";
const rc=(e,kind)=>{const r=e.r,v=kind==="co"&&r.series?volTxt(r.series):kind==="ed2"?[r.publisher,r.pubDate].filter(Boolean).join(" · "):r.tipo==="revista"?[r.number&&"nº "+r.number,r.pubDate].filter(Boolean).join(" · "):(r.pubDate||"");
  return `<button type="button" class="pprc" data-open="${e.s}:${r.id}" title="${esc(r.title)}"><span class="pprv">${cover(r)}</span><span class="pprt">${esc(r.title)}</span>${v?`<span class="pprg">${esc(v)}</span>`:""}<span class="pprg${e.s==="b"?" in":""}">${where(e)}</span></button>`};
const relSec=g=>`<section class="ppsec"><div class="pph"><h3>${esc(g.h)} <span class="m">(${g.l.length})</span></h3>${g.l.length>4?`<button type="button" class="lk" data-all>Ver todos (${g.l.length})</button>`:""}</div><div class="pprow">${g.l.map(e=>rc(e,g.k)).join("")}</div></section>`;
const dlRow=(l,v)=>v||v===0?`<div><dt>${l}</dt><dd>${v}</dd></div>`:"";

/* abre o pop-up de um item. nav=true guarda o item atual para o botão "Voltar" */
function showItem(s,id,nav){
  if(!(s==="b"?books:catalog).some(x=>x.id===id))return toast("Item não encontrado");
  if(nav&&cur)stack.push(cur);else stack=[];
  paint(s,id)}
function paint(s,id){
  const r=(s==="b"?books:catalog).find(x=>x.id===id);if(!r)return toast("Item não encontrado");
  cur={s,id};
  const d=$("#dlg"),B=s==="b",rev=r.tipo==="revista",o=B?null:ownedOf(r),E=esc;
  const chips=[rev?"Revista":"Livro",B?(r.wish?"Lista de desejo":status(r)):"Catálogo"].map(x=>`<span class="chip">${x}</span>`).join("")
    +(o?`<span class="chip on">${o.wish?"Na lista de desejo":"No acervo"}</span>`:"");
  const by=rev?"":sp(r.authors).map(a=>`<button type="button" class="lk ppau" data-filter="person:${E(nice(a))}" title="Ver os livros de ${E(nice(a))} nesta lista">${E(nice(a))}</button>`).join(", ");
  const org=sp(r.editors).map(a=>`<button type="button" class="lk ppau" data-filter="person:${E(nice(a))}" title="Ver as obras de ${E(nice(a))}">${E(nice(a))}</button>`).join(", ");
  const showProg=B&&!r.wish&&(r.end||r.pagesRead>0);
  const info=[["Tradutores",E(L(r.translators))],["Organizadores / editores",E(L(r.editors))],["Ilustradores",E(L(r.illustrators))],["Outros colaboradores",E(r.contrib)],
    ["Editora",E(r.publisher)],["Local",E(r.city)],["Edição",E(r.edition)],["Número",E(r.number)],["Volume",E(r.volume)],["Mês",E(r.month)],["Periodicidade",E(r.periodicity)],
    ["ISSN",E(r.issn)],["Tema",E(r.theme)],["ISBN",E(r.isbn)],["Idioma",E(r.language)],["Formato",E(r.format)],
    ["Série / volume",r.collection?"":E(r.series)],["Prateleira",E(r.shelf)],["Loja",r.buyUrl&&/^https?:/i.test(r.buyUrl)?`<a href="${E(r.buyUrl)}" target="_blank" rel="noopener noreferrer">Abrir link</a>`:""],["Fonte",E(r.src)]].map(([l,v])=>dlRow(l,v)).join("");
  let mine="";
  if(B){const lo=(r.loans||[]).filter(x=>!x.back).map(x=>`${x.dir==="Peguei emprestado"?"Peguei emprestado de":"Emprestado a"} ${E(x.who||"?")}${x.date?" em "+fmtD(x.date):""}`).join("<br>");
    mine=[["Começou a ler",fmtD(r.start)],["Terminou de ler",fmtD(r.end)],["Páginas lidas",r.pagesRead?(r.pages?`${r.pagesRead} de ${r.pages}`:r.pagesRead):""],["Cópias",r.copies>1?r.copies:""],
      ["Condição",E(r.condition)],["Estado na compra",E(((r.purchases||[])[0]||{}).state)],["Autografado",r.signed?"Sim":""],["Investido",spent(r)?money(spent(r)):""],["Vendido / doado",E(r.sold)],["Anotação",E(r.note)],["Empréstimo em aberto",lo]].map(([l,v])=>dlRow(l,v)).join("")}
  const grp=related(s,r),rel=grp.map(relSec).join(""),neds=(grp.find(g=>g.k==="ed2")||{l:[]}).l.length;
  const meta=[r.pages&&r.pages+" páginas",r.pubDate&&"publicado em "+r.pubDate,neds&&(neds+1)+" edições no catálogo"].filter(Boolean).join(" · ");
  const subj=[...sp(r.categories).map(v=>["category",v]),...(B?(r.tags||[]).map(v=>["tag",v]):[])];
  const subjHtml=subj.length?`<p class="ppsu">${subj.map(([k,v])=>`<button type="button" class="chip" data-filter="${k}:${E(v)}">${E(v)}</button>`).join("")}</p>`:"";
  const foot=B?`${r.wish?'<button type="button" class="pri" data-act="own">Já tenho: mover para o acervo</button>':""}<span class="sp"></span><button type="button" class="${r.wish?"":"pri"}" data-act="edit">Editar</button>`
    :`${admin?'<button type="button" class="dg" data-act="del">Remover do catálogo</button><button type="button" data-act="edit">Editar dados</button>':""}<span class="sp"></span>${o?'<button type="button" class="pri" data-act="owned">Abrir no '+(o.wish?"lista de desejo":"acervo")+"</button>":'<button type="button" data-act="wish">Lista de desejo</button><button type="button" class="pri" data-act="add">Adicionar ao acervo</button>'}`;
  const key=s+":"+id,cited=[...books.map(x=>["b:"+x.id,x]),...(s==="c"?catalog.map(x=>["c:"+x.id,x]):[])].filter(([k,x])=>k!==key&&(x.refs||[]).some(z=>z.k===key));
  d.className="pop";
  d.innerHTML=`<div class="pptop">${stack.length?'<button type="button" data-act="back">‹ Voltar</button>':"<span></span>"}<button type="button" class="px" data-act="close" aria-label="Fechar">×</button></div>
  <div class="ppw" tabindex="-1"><div class="pphero"><div class="ppcv">${cover(r)}</div><div class="ppin">
    <p class="ppch">${chips}</p><h2>${E(r.title)}</h2>${r.subtitle?`<p class="ppsub">${E(r.subtitle)}</p>`:""}
    ${by?`<p class="ppby">${by}</p>`:rev&&sub(r)?`<p class="ppby">${E(sub(r))}</p>`:""}
    ${org?`<p class="ppby">${rev?"Organização / comentário":"Organização"}: ${org}</p>`:""}
    ${meta?`<p class="ppmt">${E(meta)}</p>`:""}
    ${r.collection?`<p class="ppco">Coleção <b>${E(r.collection)}</b>${r.series?" · "+E(volTxt(r.series)):""}</p>`:""}
    ${B&&r.rating?`<p class="stars" aria-label="Nota ${r.rating} de 5">${"★".repeat(r.rating)}${"☆".repeat(5-r.rating)}</p>`:""}
    ${subjHtml}
    ${showProg?`<div class="bar"><i style="width:${prog(r)}%"></i></div><p class="m">${r.end?"Lido":prog(r)+"% lido"}</p>`:""}
  </div></div>
  ${info?`<dl class="ppdl">${info}</dl>`:""}
  ${r.description?`<section class="ppsec"><h3>Sobre o livro</h3><p class="ppdx${r.description.length<420?" open":""}">${E(r.description)}</p>${r.description.length<420?"":'<button type="button" class="lk" data-more>Continuar lendo</button>'}</section>`:""}
  ${B&&r.review?`<section class="ppsec"><h3>Minha resenha</h3><p class="desc">${E(r.review)}</p></section>`:""}
  ${mine?`<section class="ppsec"><h3>Meu exemplar</h3><dl class="ppdl">${mine}</dl></section>`:""}
  ${rel}
  ${refsOf(r,s).length?`<section class="ppsec"><h3>Referências bibliográficas</h3>${sortRefs(refsOf(r,s)).map(x=>`<p class="ref">${refText(x,true)}${x.k&&refObj(x)?` <button type="button" class="lk" data-open="${E(x.k)}">abrir</button>`:""}</p>`).join("")}</section>`:""}
  ${priceSec(s,r)}${cited.length?`<section class="ppsec"><h3>Citado em</h3><p>${cited.map(([k,x])=>`<button type="button" class="lk" data-open="${k}">${E(x.title)}</button>`).join(" · ")}</p></section>`:""}<div class="ft">${foot}</div></div>`;
  if(!d.open)d.showModal();
  $(".ppw",d).focus({preventScroll:true});d.scrollTop=0}
async function popClick(e){
  const d=e.currentTarget;if(!d.classList.contains("pop"))return;
  if(e.target===d)return d.close();
  const t=e.target.closest("[data-open],[data-act],[data-all],[data-filter],[data-more]");if(!t)return;
  if(t.hasAttribute("data-more")){const p=t.previousElementSibling,on=p.classList.toggle("open");t.textContent=on?"Mostrar menos":"Continuar lendo";return}
  if(t.dataset.filter){const i=t.dataset.filter.indexOf(":"),k=t.dataset.filter.slice(0,i),v=t.dataset.filter.slice(i+1),c=cur;d.close();
    FAC.forEach(([x])=>F[x]="");F.hits=null;F.q="";F.tipo="";F.status="";["#q","#ftp"].forEach(x=>$(x).value="");F[k]=v;
    view=c&&c.s==="c"?"explorar":(c&&(books.find(x=>x.id===c.id)||{}).wish?"desejos":"livros");render();$("#adv").open=true;scrollTo(0,0);return}
  if(t.dataset.open){const [s,i]=t.dataset.open.split(":");return showItem(s,+i,true)}
  if(t.hasAttribute("data-all")){const sc=t.closest(".ppsec"),on=sc.classList.toggle("all");
    t.textContent=on?"Recolher":`Ver todos (${$$(".pprc",sc).length})`;return}
  const a=t.dataset.act;if(a==="close")return d.close();
  if(a==="back"){const p=stack.pop();return p&&paint(p.s,p.id)}
  if(!cur)return;const {s,id}=cur,r=(s==="b"?books:catalog).find(x=>x.id===id);if(!r)return;
  if(a==="price")return priceDlg(s,id,r);
  if(["wish","add","own"].includes(a)&&!need())return;
  if(a==="edit")edit(id,s==="b"?"books":"catalog",null,{s,id});
  if(a==="own"){await rq(st("books","readwrite").put({...r,wish:false}));await load();paint(s,id);toast("Movido para o acervo")}
  if(a==="wish"){await rq(st("books","readwrite").add(toBook(r,{wish:true})));await load();paint(s,id);toast("Adicionado à lista de desejo")}
  if(a==="add")edit(null,"books",toBook(r,{wish:false}));
  if(a==="owned"){const o=ownedOf(r);if(o)showItem("b",o.id,true)}
  if(a==="del"&&confirm(`Remover “${r.title}” do catálogo?`)){await rq(st("catalog","readwrite").delete(id));d.close();load()}}
$("#dlg").addEventListener("click",popClick);
$("#dlg").addEventListener("close",()=>{cur=null;stack=[]});

async function rename(kind,n){
  const nv=(prompt("Novo nome:",n)||"").trim();if(!nv||nv===n)return;const ch=[];
  books.forEach(b=>{if(kind==="shelf"&&b.shelf===n){b.shelf=nv;ch.push(b)}
    if(kind==="tag"&&(b.tags||[]).includes(n)){b.tags=[...new Set(b.tags.map(t=>t===n?nv:t))];ch.push(b)}});
  await store("books").putMany(ch);load()}

/* ---------- Backup e importação ---------- */
const dl=(name,txt,type)=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([txt],{type}));a.download=name;a.click()};
const COLS=[["Tipo",b=>b.tipo||"livro"],["Título",b=>b.title],["Autores",b=>b.authors],["Tradutores",b=>b.translators],["Editores",b=>b.editors],["Ilustradores",b=>b.illustrators],["Editora",b=>b.publisher],["Ano",b=>b.pubDate],["Edição",b=>b.edition],["Páginas",b=>b.pages],["ISBN",b=>b.isbn],["Categorias",b=>b.categories],["Coleção",b=>b.collection],["Volume na coleção",b=>b.series],["Prateleira",b=>b.shelf],["Etiquetas",b=>(b.tags||[]).join(", ")],["Status",b=>b.wish?"Desejo":status(b)],["Nota",b=>b.rating],["Preço",b=>spent(b)||""],["Data da compra",b=>b.purchases?.[0]?.date||b.boughtDate||""],["URL da capa",b=>b.cover&&!b.cover.startsWith("data:")?b.cover:""],["Número",b=>b.number],["Volume",b=>b.volume],["Mês",b=>b.month],["Periodicidade",b=>b.periodicity],["ISSN",b=>b.issn],["Tema",b=>b.theme],["Local",b=>b.city],["Começou a ler em",b=>b.start],["Terminou de ler em",b=>b.end],["Páginas lidas",b=>b.pagesRead],["Lista de desejo",b=>b.wish?"sim":""]];
const csv=l=>"\ufeff"+[COLS.map(c=>c[0]),...l.map(b=>COLS.map(c=>c[1](b)))].map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(";")).join("\r\n");
const EXEMPLO=[{tipo:"livro",title:"Livro de exemplo",authors:"Sobrenome, Nome; Outro Autor",translators:"Tradutor Exemplo",publisher:"Editora Exemplo",pubDate:"2020",pages:200,isbn:"9781234567890",categories:"Teologia",collection:"Coleção Exemplo",series:"1",shelf:"Prateleira A",tags:["Devocional"],rating:4,purchases:[{date:"2026-09-28",price:50}],cover:"https://exemplo.com/capa.jpg"},
{tipo:"revista",title:"Revista Exemplo",publisher:"Editora Exemplo",pubDate:"2025",number:"120",volume:"3",month:"Janeiro",periodicity:"trimestral",theme:"Tema da edição",city:"São Paulo"}];
/* nomes de colunas aceitos na importação (sem acento, minúsculas) */
const AL={title:"titulo|title|nome|titulo da revista|revista|livro",authors:"autores|autor|author|authors",translators:"tradutores|tradutor",editors:"editores|organizadores|organizador",illustrators:"ilustradores|ilustrador",subtitle:"subtitulo|subtitle",publisher:"editora|publisher",pubDate:"ano|ano de publicacao|data da publicacao|publicado em",
pages:"paginas|pages|numero de paginas",isbn:"isbn|isbn13|isbn10",shelf:"prateleira|estante|shelf",tags:"etiquetas|etiqueta|tags",categories:"categorias|categoria|genero|assuntos",language:"idioma|language",format:"formato|format",
edition:"edicao",collection:"colecao|collection",series:"serie|serie / volume|volume na colecao",rating:"nota|classificacao|avaliacao|rating",pagesRead:"paginas lidas",start:"comecou a ler em|inicio da leitura",end:"terminou de ler em|fim da leitura|data de termino",
boughtDate:"data da compra",boughtPrice:"preco|preco pago|valor",coverUrl:"url da capa|capa|cover|imagem",description:"descricao|sinopse",note:"anotacao|anotacao curta|observacoes|obs",condition:"condicao",copies:"copias|numero de copias",
tipo:"tipo",number:"numero|n|numero da edicao",volume:"volume|vol",month:"mes|mes de publicacao",periodicity:"periodicidade",issn:"issn",theme:"tema|materia de capa|tema da edicao",city:"local|local de publicacao|cidade",wish:"lista de desejo|desejo"};
const M={};Object.entries(AL).forEach(([k,v])=>v.split("|").forEach(a=>M[a]=k));
const num=v=>{const n=parseFloat(String(v).replace(/[^\d,.-]/g,"").replace(/\.(?=\d{3}\b)/g,"").replace(",","."));return isNaN(n)?"":n};
const toISO=v=>{v=String(v).trim();if(/^\d{5}$/.test(v))return new Date(Date.UTC(1899,11,30)+ +v*864e5).toISOString().slice(0,10);
  let m=v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);if(m)return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  m=v.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);return m?`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`:""};
function parseCSV(t){t=t.replace(/^\ufeff/,"");const l1=t.split("\n")[0],d=l1.split(";").length>l1.split(",").length?";":",";
  const rows=[];let row=[],c="",q=false;
  for(let i=0;i<t.length;i++){const ch=t[i];
    if(q){if(ch==='"'){if(t[i+1]==='"'){c+='"';i++}else q=false}else c+=ch}
    else if(ch==='"')q=true;
    else if(ch===d){row.push(c);c=""}
    else if(ch==="\n"||ch==="\r"){if(ch==="\r"&&t[i+1]==="\n")i++;row.push(c);rows.push(row);row=[];c=""}
    else c+=ch}
  if(c||row.length){row.push(c);rows.push(row)}
  return rows}
/* Leitor de .xlsx sem bibliotecas: descompacta o ZIP com DecompressionStream */
async function unzip(buf){
  const v=new DataView(buf),u=new Uint8Array(buf),td=new TextDecoder(),out={};
  let e=u.length-22;while(e>=0&&v.getUint32(e,true)!==0x06054b50)e--;
  if(e<0)throw 0;
  let p=v.getUint32(e+16,true);
  for(let i=v.getUint16(e+10,true);i>0;i--){
    const meth=v.getUint16(p+10,true),cs=v.getUint32(p+20,true),nl=v.getUint16(p+28,true),xl=v.getUint16(p+30,true),cl=v.getUint16(p+32,true),off=v.getUint32(p+42,true);
    const name=td.decode(u.subarray(p+46,p+46+nl));p+=46+nl+xl+cl;
    if(!/^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(name))continue;
    const s=off+30+v.getUint16(off+26,true)+v.getUint16(off+28,true),data=u.subarray(s,s+cs);
    out[name]=meth===0?td.decode(data):await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  }
  return out}
const colIdx=r=>{let n=0;for(const ch of r.replace(/\d/g,""))n=n*26+ch.charCodeAt(0)-64;return n-1};
async function readXlsx(file){
  const z=await unzip(await file.arrayBuffer()),P=t=>new DOMParser().parseFromString(t,"application/xml"),tx=e=>[...e.getElementsByTagName("t")].map(x=>x.textContent).join("");
  const ss=z["xl/sharedStrings.xml"]?[...P(z["xl/sharedStrings.xml"]).getElementsByTagName("si")].map(tx):[];
  const sn=Object.keys(z).filter(k=>/worksheets\/sheet\d+\.xml$/.test(k)).sort((a,b)=>a.localeCompare(b,"en",{numeric:true}))[0];
  if(!sn)throw 0;
  return [...P(z[sn]).getElementsByTagName("row")].map(r=>{const row=[];
    [...r.getElementsByTagName("c")].forEach(c=>{const t=c.getAttribute("t"),v=c.getElementsByTagName("v")[0]?.textContent??"";
      row[colIdx(c.getAttribute("r"))]=t==="s"?ss[+v]:t==="inlineStr"?tx(c):v});
    return row})}
function rowToBook(h,r){
  const b={tipo:"livro",copies:1,added:today()},pr={};
  h.forEach((k,i)=>{const v=String(r[i]??"").trim();if(!k||!v)return;
    if(k==="tags")b.tags=sp(v,/[,;]/);
    else if(k==="boughtPrice"){const n=num(v);if(n!=="")pr.price=n}
    else if(k==="boughtDate"){const d=toISO(v);if(d)pr.date=d}
    else if(["pages","pagesRead","rating","copies"].includes(k)){const n=num(v);if(n!=="")b[k]=n}
    else if(["start","end"].includes(k)){const d=toISO(v);if(d)b[k]=d}
    else if(k==="pubDate")b[k]=v.match(/\d{4}/)?.[0]||v;
    else if(k==="tipo")b.tipo=/rev/i.test(v)?"revista":"livro";
    else if(k==="wish")b.wish=/^(s|sim|1|x|true|yes)/i.test(norm(v));
    else if(k==="coverUrl"){if(/^https?:\/\//i.test(v))b.cover=v}
    else b[k]=v});
  if(Object.keys(pr).length)b.purchases=[pr];
  b.tags=b.tags||[];if(b.rating>5)b.rating=5;
  return b}
async function importSheet(f,dest){
  const ext=f.name.split(".").pop().toLowerCase();
  if(ext==="xls")return toast("Arquivos .xls antigos não são suportados. Salve a planilha como .xlsx ou .csv.");
  let rows;try{rows=ext==="xlsx"?await readXlsx(f):parseCSV(await f.text())}catch{return toast("Não consegui ler a planilha. Use um arquivo .xlsx ou .csv válido.")}
  rows=rows.filter(r=>r&&r.some(c=>String(c??"").trim()));
  const h=Array.from(rows.shift()||[],x=>M[norm(x).trim()]||"");
  if(!h.includes("title"))return toast("Não encontrei a coluna “Título”. Baixe o modelo de planilha.");
  const seen=new Set((dest==="catalog"?catalog:books).map(same));let add=0,dup=0;
  const arr=[];
  rows.forEach(r=>{const b=rowToBook(h,r);if(!b.title)return;const k=same(b);if(seen.has(k)){dup++;return}seen.add(k);arr.push(b);add++});
  await store(dest).addMany(arr);$("#dlg").close();await load();toast(`${add} itens importados${dup?`, ${dup} ignorados (já existiam)`:""}`);
}
async function importJSON(d){
  const map={};
  if(impMode==="replace")for(const n of ["books","goals"])await store(n).clear();
  const ins=async(n,a,p)=>{const src=a.map(b=>({o:b.id,b:{...b}}));src.forEach(x=>delete x.b.id);
    await uploadCovers(src.map(x=>x.b));const ids=await store(n).addMany(src.map(x=>x.b));
    src.forEach((x,i)=>{map[p+x.o]=p+ids[i];x.b.id=ids[i]});return src.map(x=>x.b)};
  const ib=await ins("books",d.books||[],"b:"),ic=await ins("catalog",d.catalog||[],"c:");
  for(const [n,l] of [["books",ib],["catalog",ic]]){const ch=l.filter(b=>b.refs?.length);
    ch.forEach(b=>{b.refs=b.refs.map(r=>r.k?{k:map[r.k]||r.k}:r)});if(ch.length)await store(n).putMany(ch)}
  await store("goals").addMany((d.goals||[]).map(g=>{const {id,...x}=g;return x}));
}
/* dados antigos guardados neste navegador (versão sem nuvem) */
async function localData(){
  if(!indexedDB.databases)return null;
  if(!(await indexedDB.databases()).some(x=>x.name==="acervo-biblico-v2"))return null;
  const d=await new Promise((ok,er)=>{const r=indexedDB.open("acervo-biblico-v2");r.onsuccess=()=>ok(r.result);r.onerror=()=>er(r.error)});
  try{const g=n=>d.objectStoreNames.contains(n)?new Promise((ok,er)=>{const r=d.transaction(n).objectStore(n).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>er(r.error)}):[];
    const o={books:await g("books"),catalog:await g("catalog"),goals:await g("goals")};return o.books.length+o.catalog.length+o.goals.length?o:null}finally{d.close()}}
async function migrateLocal(o){impMode="add";toast("Enviando dados para a nuvem…");await importJSON(o);await load();toast("Dados enviados para a nuvem")}

function backup(){const d=$("#dlg"),day=today();
  d.className="";d.innerHTML=`<h2>Backup e importação</h2><p class="m">Seus dados ficam na nuvem (Supabase). Mesmo assim, exporte um backup de vez em quando.</p>
  <div class="bkl"><button id="ej">Exportar backup completo (JSON: acervo, catálogo, metas e bibliografias)</button>
  <button id="ec">Exportar acervo em planilha (CSV)</button><button id="ek">Exportar catálogo em planilha (CSV)</button>
  <button id="im" class="pri">Importar planilha CSV ou Excel para o acervo</button><button id="ik" class="pri">Importar planilha CSV ou Excel para o catálogo (Explorar)</button>
  <button id="tm">Baixar modelo de planilha</button>
  <button id="ia">Restaurar backup JSON e adicionar aos dados atuais</button><button id="ir" class="dg">Restaurar backup JSON e substituir tudo</button><button id="ml" hidden>Enviar para a nuvem os dados antigos deste navegador</button><button id="sl">Verificar e sincronizar o acervo com a biblioteca</button><button id="cx">Fechar</button></div>`;
  d.showModal();
  localData().then(o=>{if(o&&$("#ml")){$("#ml").hidden=false;$("#ml").onclick=()=>{d.close();migrateLocal(o)}}}).catch(()=>{});
  const pick=(m,t)=>{impMode=m;impDest=t;$("#fileImp").click()};
  $("#cx").onclick=()=>d.close();
  $("#sl").onclick=syncAll;$("#ej").onclick=()=>dl(`acervo-${day}.json`,JSON.stringify({versao:3,books,goals,catalog}),"application/json");
  $("#ec").onclick=()=>dl(`acervo-${day}.csv`,csv(books),"text/csv");
  $("#ek").onclick=()=>dl(`catalogo-${day}.csv`,csv(catalog),"text/csv");
  $("#tm").onclick=()=>dl("modelo-importacao.csv",csv(EXEMPLO),"text/csv");
  $("#im").onclick=()=>pick("add","books");$("#ik").onclick=()=>pick("add","catalog");$("#ia").onclick=()=>pick("add",null);
  $("#ir").onclick=()=>{if(confirm("Isto apaga acervo, catálogo e metas atuais antes de restaurar. Continuar?"))pick("replace",null)};
}
$("#fileImp").onchange=async e=>{const f=e.target.files[0];if(!f)return;
  try{
    if(!/\.json$/i.test(f.name))await importSheet(f,impDest||"books");
    else{const d=JSON.parse(await f.text());if(!Array.isArray(d.books))throw 0;await importJSON(d);$("#dlg").close();await load();toast("Backup restaurado")}
  }catch{toast("Arquivo inválido")}
  finally{e.target.value=""}};

/* ---------- Eventos ---------- */
$("#tabs").onclick=e=>{const v=e.target.dataset.v;if(v){if(!["explorar","autores"].includes(v)&&!need())return;view=v;sel.clear();selMode=false;F.launch=false;FAC.forEach(([k])=>F[k]="");F.hits=null;render()}};
$("#add").onclick=()=>edit();$("#bk").onclick=backup;
$("#addcat").onclick=()=>need()&&edit(null,"catalog");$("#srch").onclick=searchOnline;
$("#q").oninput=e=>{F.q=e.target.value;F.hits=null;render()};
$("#q").onkeydown=e=>{if(e.key==="Enter"&&view==="explorar"&&user)searchOnline()};
[["#ftp","tipo"],["#so","sort"]].forEach(([s,k])=>$(s).onchange=e=>{F[k]=e.target.value;render()});
$("#stbar").onclick=e=>{const t=e.target.closest("[data-st]");if(t){F.status=t.dataset.st;render()}};
$("#facets").onchange=e=>{const k=e.target.dataset.f;if(k){F[k]=e.target.value;render()}};
$("#facets").onclick=e=>{if(e.target.id==="clr"){FAC.forEach(([k])=>F[k]="");F.q="";F.hits=null;$("#q").value="";render()}};
$("#hitbar").onclick=e=>{if(e.target.id==="allc"){F.hits=null;render()}};
$("#vm").onclick=e=>{mode=mode==="grade"?"lista":"grade";e.target.textContent=mode==="grade"?"Ver em lista":"Ver em grade";render()};
$("#rnd").onclick=()=>{const c=own().filter(b=>status(b)==="Não lido"&&(F.tipo?(b.tipo||"livro")===F.tipo:b.tipo!=="revista"));c.length?showItem("b",c[Math.floor(Math.random()*c.length)].id):toast("Nenhum item não lido encontrado")};
$("#main").onclick=async e=>{
  const t=e.target.closest("[data-id],[data-go],[data-ren],[data-dg],[data-sm]");if(!t)return;const D=t.dataset;
  if(D.sm){shelfMode=D.sm;return render()}
  if(D.id){if(selMode){const n=+D.id;sel.has(n)?sel.delete(n):sel.add(n);return markSel()}showItem(view==="explorar"?"c":"b",Number(D.id))}
  if(D.go){F.shelf=D.go==="shelf"?D.n:"";F.tag=D.go==="tag"?D.n:"";view="livros";render()}
  if(D.ren)rename(D.ren,D.n);
  if(D.dg&&confirm("Excluir esta meta?")){await rq(st("goals","readwrite").delete(Number(D.dg)));load()}};
$("#main").onsubmit=async e=>{e.preventDefault();if(e.target.id!=="gf")return;const fd=new FormData(e.target);
  await rq(st("goals","readwrite").add({t:fd.get("t"),n:Number(fd.get("n")),y:String(fd.get("y"))}));load()};

/* ---------- Acesso público, ajustes da lista, seleção, Amazon, sugestões ---------- */
let signup=false;
const need=()=>{if(user)return true;$("#dlg").open&&$("#dlg").close();authBox("Entre ou crie sua conta para guardar livros no seu acervo.");return false};
const refsOf=(r,s)=>(r.refs||[]).filter(x=>s!=="c"||!x.k||x.k[0]==="c");
const IC={editors:'<circle cx="12" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>',theme:'<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/>',category:'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
pages:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8"/>',
year:'<path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/>',
shelf:'<path d="m16 6 4 14M12 6v14M8 8v12M4 4v16"/>',
format:'<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
tags:'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
price:'<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 18V6"/>',
bdate:'<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
publisher:'<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
status:'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'};
const ico=k=>`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${IC[k]}</svg>`;
const LF=[["editors","Organizador / comentarista",b=>b.tipo==="revista"?sp(b.editors).map(x=>esc(nice(x))).join(", "):""],["theme","Tema",b=>b.tipo==="revista"?esc(b.theme):""],["category","Categoria",b=>esc(L(b.categories))],["pages","Páginas",b=>b.pages?b.pages+" p.":""],["year","Ano de publicação",b=>esc(b.pubDate)],["shelf","Prateleira",b=>esc(b.shelf)],["format","Formato",b=>esc(b.format)],
["tags","Etiquetas",b=>(b.tags||[]).map(t=>`<span class="chip">${esc(t)}</span>`).join("")],["price","Valor",b=>spent(b)?money(spent(b)):""],
["bdate","Data da compra",b=>fmtD((b.purchases||[]).map(x=>x.date).filter(Boolean).sort().pop()||b.boughtDate)],["publisher","Editora",b=>esc(b.publisher)],["status","Status",b=>view==="explorar"||b.wish||b.tipo==="revista"?"":status(b)]];
const rowHtml=b=>`<article class="row" data-id="${b.id}"><div class="cv">${cover(b)}</div><div class="rb"><h3>${esc(label(b))}</h3><p class="m">${esc(sub(b))}</p>
 ${b.rating?`<span class="stars">${"★".repeat(b.rating)}${"☆".repeat(5-b.rating)}</span>`:""}${view==="explorar"||b.wish?"":`<div class="bar"><i style="width:${prog(b)}%"></i></div>`}
 <div class="meta">${LF.filter(([k])=>LC.f.includes(k)||k==="editors"||k==="theme").map(([k,l,g])=>{const v=g(b);return v?`<span title="${l}">${ico(k)}${v}</span>`:""}).join("")}</div><p>${badge(b)}</p></div></article>`;
const applyLC=()=>{const r=document.documentElement.style;r.setProperty("--cvw",LC.w+"px");r.setProperty("--cvar",LC.ar);r.setProperty("--cvfit",LC.fit)};
function cfgDlg(){const d=$("#dlg");d.className="";
 d.innerHTML=`<h2>Ajustes da lista</h2><div class="g"><label>Proporção da capa<select id="car">${[["2/3","Retrato 2:3 (padrão)"],["3/4","Retrato 3:4"],["1/1","Quadrada 1:1"],["4/3","Paisagem 4:3"],["16/9","Paisagem 16:9"]].map(([v,l])=>`<option value="${v}" ${LC.ar===v?"selected":""}>${l}</option>`).join("")}</select></label>
 <label>Largura da capa: <span id="cwv">${LC.w}</span> px<input id="cw" type="range" min="50" max="220" value="${LC.w}"></label>
 <label>Ajuste da imagem<select id="cfit"><option value="cover" ${LC.fit==="cover"?"selected":""}>Preencher (corta o excesso)</option><option value="contain" ${LC.fit==="contain"?"selected":""}>Mostrar inteira</option></select></label></div>
 <fieldset><legend>Informações exibidas</legend><div class="g">${LF.filter(x=>x[0]!=="editors"&&x[0]!=="theme").map(([k,l])=>`<label class="ck"><input type="checkbox" data-cf="${k}" ${LC.f.includes(k)?"checked":""}>${l}</label>`).join("")}</div></fieldset><div class="ft"><span class="sp"></span><button type="button" id="cfok" class="pri">Fechar</button></div>`;
 d.showModal();
 const go=()=>{LC.ar=$("#car").value;LC.w=+$("#cw").value;LC.fit=$("#cfit").value;LC.f=$$("[data-cf]",d).filter(x=>x.checked).map(x=>x.dataset.cf);$("#cwv").textContent=LC.w;
  try{localStorage.setItem("lc",JSON.stringify(LC))}catch{}applyLC();render()};
 d.oninput=go;$("#cfok").onclick=()=>{d.oninput=null;d.close()}}
function chrome(){const ex=view==="explorar",can=(user&&(view==="livros"||view==="desejos"))||(ex&&admin);
 $("#addi").hidden=!user;$("#sidb").hidden=!["livros","desejos","explorar"].includes(view);$("#in").hidden=!!user;$("#out").hidden=!user;$("#add").hidden=!user;$("#bk").hidden=!user;$("#rnd").hidden=!user;
 $$("#tabs button").forEach(b=>b.hidden=!user&&!["explorar","autores"].includes(b.dataset.v));
 if(!can){selMode=false;sel.clear()}
 $("#selb").hidden=!can;$("#selact").hidden=!selMode;$("#selb").textContent=selMode?"Sair da seleção":"Selecionar";$("#cfg").hidden=mode!=="lista"}
const markSel=()=>{$$("#main [data-id]").forEach(e=>e.classList.toggle("sel",selMode&&sel.has(+e.dataset.id)));$("#selc").textContent=sel.size+" selecionado(s)"};
function bulk(){const ex=view==="explorar",ids=[...sel];if(!ids.length)return toast("Selecione itens primeiro");
 const FD=[["categories","Categorias",1],["tags","Etiquetas",1],["authors","Autores",1],["translators","Tradutores",1],["shelf","Prateleira"],["publisher","Editora"],["format","Formato"],["language","Idioma"],["collection","Coleção"],["city","Local"],["pubDate","Ano"]].filter(([k])=>!(ex&&(k==="tags"||k==="shelf"))),d=$("#dlg");
 d.className="";d.innerHTML=`<h2>Editar ${ids.length} item(ns) em massa</h2><div class="g"><label>Campo<select id="bf">${FD.map(([k,l])=>`<option value="${k}">${l}</option>`).join("")}</select></label><label>Ação<select id="bm"><option value="set">Substituir</option><option value="add">Adicionar</option><option value="rm">Remover</option></select></label>
 <label class="full">Valor (listas: separe com ; — etiquetas: com vírgula)<input id="bv"></label></div><div class="ft"><span class="sp"></span><button type="button" id="bx">Cancelar</button><button type="button" id="bok" class="pri">Aplicar</button></div>`;
 d.showModal();$("#bx").onclick=()=>d.close();
 $("#bok").onclick=async()=>{const k=$("#bf").value,m=$("#bm").value,v=$("#bv").value.trim(),list=!!FD.find(x=>x[0]===k)[2],vals=sp(v,k==="tags"?/,/:/;/),arr=ex?catalog:books,it=ids.map(i=>arr.find(x=>x.id===i)).filter(Boolean);
  if(!list&&m!=="set")return toast("Adicionar/Remover só vale para campos de lista");
  it.forEach(b=>{const cu=k==="tags"?(b.tags||[]):sp(b[k]),nv=!list?v:m==="add"?[...new Set([...cu,...vals])]:m==="rm"?cu.filter(x=>!vals.includes(x)):vals;b[k]=(k==="tags"||!list)?nv:nv.join("; ")});
  if(ex)it.forEach(b=>b.sy=1);await store(ex?"catalog":"books").putMany(it);if(!ex){toast("Sincronizando com a biblioteca…");for(const b of it)await pushCat(b)}d.close();sel.clear();selMode=false;load();toast(`${it.length} itens atualizados`)}}
$("#selb").onclick=()=>{selMode=!selMode;sel.clear();render()};
$("#sela").onclick=()=>{filtered().forEach(b=>sel.add(b.id));markSel()};
$("#selm").onclick=bulk;$("#cfg").onclick=cfgDlg;
$("#seld").onclick=async()=>{const ids=[...sel];if(!ids.length)return toast("Selecione itens primeiro");if(!confirm(`Excluir ${ids.length} item(ns)? Não dá para desfazer.`))return;
 await store(view==="explorar"?"catalog":"books").delMany(ids);sel.clear();selMode=false;load()};
/* sugestões a partir do que já existe no banco */
const uniq=f=>[...new Set([...books,...catalog].flatMap(f).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),"pt-BR"));
const dls=()=>[["dl_authors",b=>[...sp(b.authors),...sp(b.editors)]],["dl_translators",b=>sp(b.translators)],["dl_editors",b=>[...sp(b.authors),...sp(b.editors)]],["dl_illustrators",b=>sp(b.illustrators)],["dl_categories",b=>sp(b.categories)],["dl_publisher",b=>[b.publisher]],["dl_city",b=>[b.city]],["dl_language",b=>[b.language]],["stores",b=>(b.purchases||[]).map(x=>x.store)],["people",b=>(b.loans||[]).map(x=>x.who)]]
 .map(([id,g])=>`<datalist id="${id}">${uniq(g).map(s=>`<option value="${esc(s)}">`).join("")}</datalist>`).join("");
function wireSug(f){Object.entries({authors:";",translators:";",editors:";",illustrators:";",categories:";",tags:","}).forEach(([k,s])=>{const i=f.elements[k],dl=$("#"+(k==="tags"?"tagl":"dl_"+k));if(!i||!dl)return;
 const all=[...dl.options].map(o=>o.value);
 i.addEventListener("input",()=>{const v=i.value,p=v.lastIndexOf(s),pre=p<0?"":v.slice(0,p+1)+" ",t=norm(v.slice(p+1).trim());
  dl.innerHTML=t?all.filter(x=>norm(x).includes(t)).slice(0,30).map(x=>`<option value="${esc(pre+x)}">`).join(""):""})})}
/* Amazon: o navegador não consegue ler a página (CORS), então usamos o código ASIN/ISBN do link e o título do endereço */
const i10to13=s=>{const b="978"+s.slice(0,9);let t=0;[...b].forEach((c,i)=>t+=(+c)*(i%2?3:1));return b+(10-t%10)%10};
function amzParse(u){let x;try{x=new URL(u)}catch{return null}if(!/(^|\.)(amazon\.|amzn\.)/i.test(x.hostname))return null;
 const m=x.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|d)\/([A-Z0-9]{10})/i),sm=x.pathname.match(/^\/([^/]+)\/dp\//);
 return {asin:m?m[1].toUpperCase():"",slug:sm?decodeURIComponent(sm[1]).replace(/[-_+]/g," "):""}}
function fillForm(f,it){const set=(k,x)=>{if(x&&f.elements[k]&&!f.elements[k].value)f.elements[k].value=x};
 ["title","subtitle","authors","publisher","pages","pubDate","language","categories","description","isbn"].forEach(k=>set(k,it[k]));
 if(it.cover){set("coverUrl",it.cover);f.elements.coverUrl.dispatchEvent(new Event("input"))}}
async function amazon(f){const u=f.elements.buyUrl.value.trim();if(!u)return toast("Cole o link da Amazon no campo “Link da loja”");
 const p=amzParse(u);if(!p)return toast("Esse não parece um link completo da Amazon (links curtos amzn.to não funcionam: abra e copie o endereço da barra)");
 const box=$("#amzr");box.innerHTML="";toast("Buscando…");
 try{let its=[];
  if(/^\d{9}[\dX]$/.test(p.asin)){const n=i10to13(p.asin);const one=await byIsbn(n);its=one?[one]:[];
   if(its[0]){fillForm(f,its[0]);return toast("Dados preenchidos pelo ISBN do link. Confira antes de salvar.")}}
  if(!p.slug)return toast("Não consegui identificar o livro nesse link (e-book Kindle sem título no endereço). Use o ISBN ou o título.");
  its=(await PROV.google.q(p.slug,false)).slice(0,6);if(!its.length)return toast("Nada encontrado para esse link");
  box.innerHTML='<p class="m">Escolha o livro certo:</p>'+its.map((x,i)=>`<button type="button" data-pk="${i}">${esc(x.title)} <span class="m">— ${esc(x.authors)} ${esc(x.pubDate)}</span></button>`).join("");
  box.onclick=e=>{const t=e.target.closest("[data-pk]");if(t){fillForm(f,its[+t.dataset.pk]);box.innerHTML="";toast("Dados preenchidos. Confira antes de salvar.")}};
 }catch{toast("Não consegui buscar. Verifique a conexão.")}}
applyLC();

/* ---------- Entrada rápida: BrasilAPI, ISBN em lote, câmera, favorito da Amazon, menu lateral ---------- */
PROV.br={n:"BrasilAPI",async q(t){const m=String(t).match(/\d{10,13}/);if(!m)return[];const r=await fetch("https://brasilapi.com.br/api/isbn/v1/"+m[0]);if(!r.ok)return[];const v=await r.json();
 return [{title:v.title,subtitle:v.subtitle||"",authors:(v.authors||[]).join("; "),publisher:v.publisher||"",pubDate:String(v.year||""),pages:v.page_count||"",isbn:v.isbn||m[0],categories:(v.subjects||[]).join("; "),language:"",description:v.synopsis||"",cover:v.cover_url||"",city:v.location||"",src:"BrasilAPI"}].filter(x=>x.title)}};
const byIsbn=async n=>{for(const k of ["br","google","ol"]){try{const r=await PROV[k].q(k==="br"?n:"isbn:"+n,false);if(r[0]){const x=r[0];if(/^(pt|por)/i.test(x.language||""))x.language="Pt-Br";return x}}catch{}}return null};
async function isbnAdd(txt,wish){const l=[...new Set(txt.split(/[\s,;]+/).map(digits).filter(x=>x.length===10||x.length===13))].map(x=>x.length===10?i10to13(x):x);
 if(!l.length)return toast("Nenhum ISBN válido");const arr=[];let miss=0,dup=0,i=0;
 for(const n of l){toast(`Buscando ${++i}/${l.length}…`);if(IDX.isbn.get(n)){dup++;continue}
  let c=catalog.find(x=>digits(x.isbn)===n);
  if(!c){const it=await byIsbn(n);if(it){c={tipo:"livro",added:today(),...it,isbn:n};delete c.src;try{c.id=await store("catalog").add(c);catalog.push(c)}catch{c=null}}}
  if(c)arr.push(toBook(c,{wish})) ;else{miss++;arr.push({tipo:"livro",title:"ISBN "+n+" (completar dados)",isbn:n,copies:1,added:today(),tags:[],wish,purchases:[]})}}
 if(arr.length)await store("books").addMany(arr);$("#dlg").close();await load();
 toast(`${arr.length} adicionados${miss?`, ${miss} sem dados (complete na edição)`:""}${dup?`, ${dup} já existiam`:""}`)}
async function scan(ta){if(!("BarcodeDetector" in window))return toast("Este navegador não lê código de barras. Use o Chrome no celular ou digite o ISBN.");
 let st;try{st=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}})}catch{return toast("Sem acesso à câmera")}
 const v=document.createElement("video");v.srcObject=st;v.setAttribute("playsinline","");v.muted=true;await v.play();
 const box=$("#scv");box.innerHTML="";box.append(v);box.insertAdjacentHTML("beforeend",'<button type="button" id="scx">Parar câmera</button>');
 let on=true;$("#scx").onclick=()=>on=false;const bd=new BarcodeDetector({formats:["ean_13"]}),seen=new Set(ta.value.split(/\s+/));
 while(on&&$("#dlg").open&&$("#scv")){try{for(const c of await bd.detect(v)){const t=c.rawValue;if(/^97[89]\d{10}$/.test(t)&&!seen.has(t)){seen.add(t);ta.value=(ta.value.trim()+"\n"+t).trim();toast("Lido: "+t)}}}catch{}await new Promise(r=>setTimeout(r,300))}
 st.getTracks().forEach(t=>t.stop());if($("#scv"))$("#scv").innerHTML=""}
/* favorito que lê a página da Amazon no seu navegador (como o conector do Zotero) */
const BM=APP=>"javascript:"+encodeURIComponent("("+function(A){try{
 var t=function(s){var e=document.querySelector(s);return e?e.textContent.replace(/\s+/g," ").trim():""},b=document.body.innerText,m=function(r){var x=b.match(r);return x?x[1].trim():""};
 var d={title:t("#productTitle")||t("#ebooksProductTitle"),
  authors:[].slice.call(document.querySelectorAll("#bylineInfo .author a.a-link-normal,.author .a-link-normal")).map(function(a){return a.textContent.trim()}).filter(function(x,i,a){return x&&a.indexOf(x)===i}).join("; "),
  isbn:m(/ISBN-13[\s\u200e\u200f:]*([\d-]{13,17})/i).replace(/\D/g,""),publisher:m(/(?:Editora|Publisher)[\s\u200e\u200f:]*([^\n;(]+)/i),pages:m(/(\d+)\s*p[áa]ginas/i),
  language:m(/(?:Idioma|Language)[\s\u200e\u200f:]*([^\n]+)/i),pubDate:m(/(?:Editora|Publisher)[^\n]*?(\d{4})/i),
  description:(document.querySelector("#bookDescription_feature_div")||{innerText:""}).innerText.trim().slice(0,1200),
  cover:(document.querySelector("#landingImage,#imgBlkFront,#ebooksImgBlkFront")||{}).src||"",buyUrl:location.origin+location.pathname,price:(function(){var e=document.querySelector("#corePrice_feature_div .a-offscreen,.a-price .a-offscreen");return e?e.textContent.replace(/[^\d,.]/g,"").replace(/\./g,"").replace(",","."):""})()};
 window.open(A+"#add="+encodeURIComponent(JSON.stringify(d)))}catch(e){alert("Não consegui ler esta página da Amazon.")}}.toString()+")("+JSON.stringify(APP)+")");
let pend=null;
(()=>{const m=location.hash.match(/^#add=(.+)/);if(!m)return;
 try{const d=JSON.parse(decodeURIComponent(m[1])),o={};["title","authors","isbn","publisher","pages","language","pubDate","description","cover","buyUrl"].forEach(k=>{if(d[k]!=null&&d[k]!=="")o[k]=k==="pages"?(Number(d[k])||""):String(d[k]).slice(0,3000)});
  ["cover","buyUrl"].forEach(k=>{if(o[k]&&!/^https:\/\//i.test(o[k]))delete o[k]});{const pr=parseFloat(d.price);if(pr>0&&pr<100000)o.price=pr}if(o.title)pend=o}catch{}
 history.replaceState(null,"",location.pathname+location.search)})();
const takePend=()=>{if(!pend)return;const {price,...o}=pend;pend=null;edit(null,"books",{priceObs:price?{price,date:today(),store:"Amazon",url:o.buyUrl,src:"Amazon"}:undefined,tipo:"livro",copies:1,added:today(),tags:[],wish:false,language:"Pt-Br",purchases:[{store:"Amazon",state:"Novo"}],...o})};
function quick(){const d=$("#dlg"),APP=location.origin+location.pathname;d.className="";
 d.innerHTML=`<h2>Adicionar livros rápido</h2><p class="m">Digite ou escaneie os ISBNs (um por linha). O app procura no catálogo compartilhado, na BrasilAPI (CBL e Mercado Editorial), no Google Livros e na Open Library. O que não for achado entra só com o ISBN, para você completar.</p>
 <textarea id="qi" rows="6" placeholder="9788527300000"></textarea><div id="scv"></div>
 <label class="ck2"><input type="checkbox" id="qw"> Adicionar à lista de desejo</label>
 <div class="ft"><button type="button" id="qs">Escanear código de barras</button><span class="sp"></span><button type="button" id="qx">Fechar</button><button type="button" id="qg" class="pri">Buscar e adicionar</button></div>
 <fieldset><legend>Pela página da Amazon</legend><p class="m">Arraste o botão abaixo para a barra de favoritos. Depois, em qualquer livro da Amazon, clique nele: os dados vêm para cá e você só confere e salva.</p><p><a class="chip on" href="${esc(BM(APP))}" onclick="return false">Enviar para o Acervo</a></p></fieldset>`;
 d.showModal();$("#qx").onclick=()=>d.close();$("#qs").onclick=()=>scan($("#qi"));$("#qg").onclick=()=>isbnAdd($("#qi").value,$("#qw").checked)}
$("#addi").onclick=quick;
/* menu lateral de categorias e etiquetas */
let sideOn=innerWidth>=900;
function renderSide(){const s=$("#side"),on=["livros","desejos","explorar"].includes(view)&&sideOn;s.hidden=!on;if(!on)return;const P=pool(),
 mk=(k,t,m)=>m.size?`<h3>${t}</h3>`+[...m].map(([v,c])=>`<button type="button" class="sb${F[k]===v?" on":""}" data-sf="${k}" data-v="${esc(v)}"><span>${esc(v)}</span><b>${c}</b></button>`).join(""):"";
 s.innerHTML=`<button type="button" class="sb${!F.category&&!F.tag&&!F.launch?" on":""}" data-sf="">Tudo</button>`+(view==="explorar"?`<button type="button" class="sb${F.launch?" on":""}" data-sf="launch"><span>Lançamentos</span></button>`:"")+mk("category","Categorias",tally(P.flatMap(b=>sp(b.categories))))+(view==="explorar"?"":mk("tag","Etiquetas",tally(P.flatMap(b=>b.tags||[]))))}
$("#side").onclick=e=>{const t=e.target.closest("[data-sf]");if(!t)return;const k=t.dataset.sf;if(k==="launch"){F.launch=!F.launch;return render()}F.launch=false;F.category="";F.tag="";if(k)F[k]=t.dataset.v;F.hits=null;render()};
$("#sidb").onclick=()=>{sideOn=!sideOn;render()};

/* ---------- Biblioteca compartilhada, autores, ordenação, citar novo livro ---------- */
const pd=b=>(b.purchases||[]).map(x=>x.date).filter(Boolean).sort().pop()||b.boughtDate||"";
const SK={title:[b=>norm(b.title),1],title_d:[b=>norm(b.title),-1],author:[b=>norm(b.authors),1],publisher:[b=>norm(b.publisher),1],rating:[b=>b.rating||0,-1],
 year:[b=>parseInt(b.pubDate)||0,-1],year_a:[b=>parseInt(b.pubDate)||9999,1],added:[b=>String(b.added||""),-1],added_a:[b=>String(b.added||"9999"),1],pdate:[b=>pd(b),-1],pdate_a:[b=>pd(b)||"9999",1]};
/* campos da obra (iguais para todos) x campos do meu exemplar (shelf, tags, nota, leitura, compras, empréstimos…) */
const SH=["tipo","title","subtitle","authors","translators","editors","illustrators","publisher","city","language","pages","edition","pubDate","format","isbn","categories","collection","series","description","cover","number","volume","month","periodicity","issn","theme","buyUrl","contrib"];
const shared=o=>{const x={};SH.forEach(k=>{if(o[k]!==undefined)x[k]=o[k]});return x};
const diffSh=(c,sh)=>SH.some(k=>sh[k]!==undefined&&JSON.stringify(sh[k]??"")!==JSON.stringify(c[k]??""));
const overlay=()=>{const cm=new Map(catalog.map(c=>[c.id,c]));books.forEach(b=>{const c=cm.get(b.catId);if(c&&c.sy&&!b.detach)SH.forEach(k=>{if(c[k]!==undefined)b[k]=c[k]})})};
const putStrict=async(n,o)=>{const r=must(await sb.from(n).update({data:strip(o),updated_at:new Date().toISOString()}).eq("id",o.id).select("id"));if(!r.length)throw new Error("sem permissão para alterar o item compartilhado")};
async function pushCat(b){try{const d0=!!b.detach;let c=b.catId!=null?catalog.find(x=>x.id===b.catId):null;
 if(!c)c=catalog.find(x=>(b.isbn&&digits(x.isbn)===digits(b.isbn))||same(x)===same(b));
 const sh=shared(b);
 if(!c){const n={added:today(),...sh,sy:1};n.id=await store("catalog").add(n);catalog.push(n);c=n}
 else{const real=diffSh(c,sh);if(real||!c.sy){try{Object.assign(c,sh,{sy:1});await putStrict("catalog",c);b.detach=false}
  catch{if(real){b.detach=true;toast("Alteração salva só no seu exemplar: a biblioteca só pode ser alterada pelo administrador ou por quem cadastrou o item.")}}}}
 if(b.catId!==c.id||!!b.detach!==d0){b.catId=c.id;await store("books").put(b)}
}catch(e){toast("Não consegui atualizar a biblioteca: "+(e.message||e))}}
async function syncAll(){let add=0,link=0,upd=0;toast("Verificando…");const ch=[];
 for(const b of books){let c=b.catId!=null?catalog.find(x=>x.id===b.catId):null;
  if(!c)c=catalog.find(x=>(b.isbn&&digits(x.isbn)===digits(b.isbn))||same(x)===same(b));
  const sh=shared(b);
  if(!c){const n={added:today(),...sh,sy:1};n.id=await store("catalog").add(n);catalog.push(n);c=n;add++}
  else if(!c.sy){try{Object.assign(c,sh,{sy:1});await putStrict("catalog",c);upd++}catch{}}
  if(b.catId!==c.id){b.catId=c.id;ch.push(b);link++}}
 if(ch.length)await store("books").putMany(ch);$("#dlg").close();await load();toast(`Biblioteca: ${add} criados, ${link} vinculados, ${upd} sincronizados`)}
/* cadastrar rapidamente um livro para citar */
function miniBook(q){return new Promise(ok=>{const d=document.createElement("dialog");let done=false,cv="";
 d.innerHTML=`<form><h2>Novo livro para citar</h2><div class="g"><label class="full">Título<input name="title" required value="${esc(q||"")}"></label><label class="full">Autores (separe com ;)<input name="authors" list="dl_authors"></label>
 <label>Editora<input name="publisher" list="dl_publisher"></label><label>Ano<input name="pubDate"></label><label>Local<input name="city" list="dl_city"></label><label>ISBN<input name="isbn"></label></div>
 <div class="ft"><button type="button" id="mi">Buscar pelo ISBN</button><span class="sp"></span><button type="button" id="mx">Cancelar</button><button class="pri">Salvar e citar</button></div></form>`;
 document.body.append(d);d.showModal();const f=$("form",d),end=v=>{if(done)return;done=true;d.close();d.remove();ok(v)};
 d.onclose=()=>end(null);$("#mx",d).onclick=()=>end(null);
 $("#mi",d).onclick=async()=>{const n=digits(f.elements.isbn.value);if(!n)return toast("Digite o ISBN");const it=await byIsbn(n.length===10?i10to13(n):n);if(!it)return toast("ISBN não encontrado");
  ["title","authors","publisher","pubDate","city"].forEach(k=>{if(it[k]&&!f.elements[k].value)f.elements[k].value=it[k]});cv=it.cover||""};
 f.onsubmit=async e=>{e.preventDefault();const o={tipo:"livro",added:today(),language:"Pt-Br",sy:1,cover:cv};for(const [k,v] of new FormData(f))o[k]=String(v).trim();
  const ex=catalog.find(x=>same(x)===same(o)||(o.isbn&&digits(x.isbn)===digits(o.isbn)));if(ex)return end(ex.id);
  try{o.id=await store("catalog").add(o);catalog.push(o);end(o.id)}catch(er){toast("Não foi possível salvar: "+(er.message||er));end(null)}}})}
/* página de autores e organizadores */
const auInfo=k=>autores.find(a=>a.key===k)||{};
const personMap=()=>{const m=new Map(),add=(n,role,e)=>{const k=akey(n);if(!k)return;let p=m.get(k);if(!p)m.set(k,p={k,name:nice(n),w:0,o:0,mine:0,items:[]});
  if(!p.items.includes(e)){p.items.push(e);if(e.s==="b"&&!e.r.wish)p.mine++}p[role]++};
 everything().forEach(e=>{sp(e.r.authors).forEach(n=>add(n,"w",e));sp(e.r.editors).forEach(n=>add(n,"o",e))});return m};
let AQ="";
function vAutores(){const pm=[...personMap().values()],top=pm.slice().sort((a,b)=>b.items.length-a.items.length||a.name.localeCompare(b.name,"pt-BR")).slice(0,15);
 $("#main").innerHTML=`<h2>Obras por autor / organizador no sistema</h2>${bars(top.map(p=>[p.name,p.items.length]))}
 ${user?`<h2>No meu acervo</h2>${bars(pm.filter(p=>p.mine).sort((a,b)=>b.mine-a.mine).slice(0,15).map(p=>[p.name,p.mine]))}`:""}
 <h2>Todos (${pm.length})</h2><input id="aq" type="search" placeholder="Buscar autor ou organizador" value="${esc(AQ)}"><div id="aul" style="margin-top:10px"></div>`;
 const draw=()=>{const q=norm(AQ);$("#aul").innerHTML=pm.filter(p=>!q||norm(p.name).includes(q)).sort((a,b)=>norm(a.name).localeCompare(norm(b.name))).slice(0,200).map(p=>{const i=auInfo(p.k);
  return `<div class="grp"><div class="av">${i.photo?`<img src="${esc(i.photo)}" referrerpolicy="no-referrer" alt="">`:""}</div><div class="gi"><b>${esc(p.name)}</b><div class="m">${p.items.length} no sistema · ${p.w} como autor · ${p.o} como organizador${user?` · ${p.mine} no meu acervo`:""}</div></div><button data-au="${esc(p.k)}">Informações e obras</button></div>`}).join("")||'<p class="m">Ninguém encontrado.</p>'};
 draw();$("#aq").oninput=e=>{AQ=e.target.value;draw()}}
function auDlg(k){const p=personMap().get(k)||{name:k,items:[]},i=auInfo(k),d=$("#dlg");d.className="";
 d.innerHTML=`<h2>${esc(p.name)}</h2><div class="pphero">${i.photo?`<div class="ppcv"><img src="${esc(i.photo)}" referrerpolicy="no-referrer" alt="" style="width:100%;border-radius:6px"></div>`:""}<div class="ppin">
 <p class="m">${[i.nationality,i.born&&"nasc. "+i.born,i.died&&"falec. "+i.died].filter(Boolean).map(esc).join(" · ")}</p>${i.site&&/^https?:/i.test(i.site)?`<p><a href="${esc(i.site)}" target="_blank" rel="noopener noreferrer">Site</a></p>`:""}
 <p class="desc">${esc(i.bio||"Sem biografia cadastrada.")}</p></div></div>
 <h3>Obras (${p.items.length})</h3><div>${p.items.map(e=>`<button type="button" class="lk" data-aw="${e.s}:${e.r.id}">${esc(label(e.r))}</button>`).join(" · ")}</div>
 ${user?`<fieldset><legend>Informações do autor</legend><div class="g"><label>Nacionalidade<input id="an" value="${esc(i.nationality||"")}"></label><label>Nascimento<input id="ab" value="${esc(i.born||"")}"></label><label>Falecimento<input id="ad" value="${esc(i.died||"")}"></label>
 <label>Foto (URL)<input id="ap" value="${esc(i.photo||"")}"></label><label class="full">Site<input id="as" value="${esc(i.site||"")}"></label><label class="full">Biografia<textarea id="abio" rows="5">${esc(i.bio||"")}</textarea></label></div></fieldset>`:""}
 <div class="ft"><button type="button" id="aw">Ver obras na lista</button><span class="sp"></span><button type="button" id="acl">Fechar</button>${user?'<button type="button" id="asv" class="pri">Salvar informações</button>':""}</div>`;
 d.showModal();$("#acl").onclick=()=>d.close();
 $$("[data-aw]",d).forEach(b=>b.onclick=()=>{const [s,id]=b.dataset.aw.split(":");d.close();showItem(s,+id)});
 $("#aw").onclick=()=>{d.close();FAC.forEach(([x])=>F[x]="");F.person=p.name;F.hits=null;F.q="";F.tipo="";F.status="";["#q","#ftp"].forEach(x=>$(x).value="");view="explorar";render();$("#adv").open=true;scrollTo(0,0)};
 if(user)$("#asv").onclick=async()=>{const ph=$("#ap").value.trim();if(ph&&!/^https?:\/\//i.test(ph))return toast("A foto deve ser um endereço http(s)");
  const o={...i,key:k,name:p.name,nationality:$("#an").value.trim(),born:$("#ab").value.trim(),died:$("#ad").value.trim(),photo:ph,site:$("#as").value.trim(),bio:$("#abio").value.trim()};
  try{if(i.id!=null)await putStrict("autores",o);else await store("autores").add(o);d.close();await load();toast("Informações salvas")}
  catch(er){toast("Não foi possível salvar: só o administrador ou quem cadastrou o autor pode alterar.")}}}
$("#main").addEventListener("click",e=>{const t=e.target.closest("[data-au]");if(t)auDlg(t.dataset.au)});
function related(s,r){const me=same(r),mine=s==="c"?ownedOf(r):null,out=[],rest=everything().filter(e=>e.r!==r&&e.r!==mine&&same(e.r)!==me),rev=r.tipo==="revista";
 if(rev){const t=norm(r.title),l=rest.filter(e=>e.r.tipo==="revista"&&norm(e.r.title)===t).sort(byEdition);if(l.length)out.push({h:`Outras edições de ${r.title}`,l,k:"ed"})}
 else{const eds=everything().filter(e=>e.r!==r&&e.r!==mine&&same(e.r)===me).sort(byEdition);if(eds.length)out.push({h:"Outras edições",l:eds,k:"ed2"})}
 const seen=new Set(),pp=x=>[...sp(x.authors),...sp(x.editors),...sp(x.translators),...sp(x.illustrators)];
 [...sp(r.authors),...sp(r.editors)].forEach(a=>{const k=akey(a);if(!k||seen.has(k)||seen.size>=4)return;seen.add(k);
  const l=rest.filter(e=>!(rev&&e.r.tipo==="revista"&&norm(e.r.title)===norm(r.title))&&pp(e.r).some(x=>akey(x)===k)).sort(byTitle);
  if(l.length)out.push({h:`Outras obras de ${nice(a)}`,l,k:"au"})});
 if(!rev&&r.collection){const k=ckey(r.collection),l=rest.filter(e=>e.r.tipo!=="revista"&&e.r.collection&&ckey(e.r.collection)===k).sort(byVol);
  if(l.length)out.push({h:`Outros livros da coleção ${r.collection}`,l,k:"co"})}
 return out}

/* ---------- Lançamentos e histórico de preços ---------- */
const LAUNCH_M=6; /* meses: obra publicada nos últimos 6 meses (ou no ano corrente, quando só há o ano) */
const isLaunch=b=>{if(b.tipo==="revista")return false;const s=String(b.pubDate||"").trim(),n=new Date();let y,m,x=s.match(/^(\d{4})(?:[-/](\d{1,2}))?/);
 if(x){y=+x[1];m=x[2]?+x[2]:0}else{x=s.match(/(\d{1,2})[/-](\d{4})$/);if(!x)return false;y=+x[2];m=+x[1]}
 if(!m)return y>=n.getFullYear();return (n.getFullYear()-y)*12+(n.getMonth()+1-m)<=LAUNCH_M};
const isbn10=n=>{n=String(n||"").replace(/[^\dX]/gi,"").toUpperCase();if(n.length===10)return n;if(!/^978\d{10}$/.test(n))return"";const b=n.slice(3,12);let s=0;[...b].forEach((c,i)=>s+=(+c)*(10-i));const k=(11-s%11)%11;return b+(k===10?"X":k)};
const keepaLink=r=>{const a=(r.buyUrl&&(amzParse(r.buyUrl)||{}).asin)||isbn10(r.isbn);return a?` <a href="https://keepa.com/#!product/12-${a}" target="_blank" rel="noopener noreferrer">Ver no Keepa</a> · <a href="https://www.amazon.com.br/dp/${a}" target="_blank" rel="noopener noreferrer">Ver na Amazon</a>`:""};
async function addPrice(cid,o){if(cid==null||!(+o.price>0)||!o.date)return;const price=Math.round(+o.price*100)/100;
 if(precos.some(p=>p.cat===cid&&p.date===o.date&&p.price===price&&(p.store||"")===(o.store||"")))return;
 const n={cat:cid,date:o.date,price,store:o.store||"",url:o.url||"",state:o.state||"",src:o.src||"manual"};
 try{n.id=await store("precos").add(n);precos.push(n)}catch{}}
const priceSvg=l=>{if(l.length<2)return"";const W=600,H=150,P=26,xs=l.map(p=>+new Date(p.date)),ys=l.map(p=>p.price),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys),
 sx=t=>P+(x1===x0?0:(t-x0)/(x1-x0))*(W-2*P),sy=v=>H-P-(y1===y0?.5:(v-y0)/(y1-y0))*(H-2*P);
 return `<svg viewBox="0 0 ${W} ${H}" class="pch" role="img" aria-label="Histórico de preços"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${l.map(p=>sx(+new Date(p.date)).toFixed(1)+","+sy(p.price).toFixed(1)).join(" ")}"/>${l.map(p=>`<circle cx="${sx(+new Date(p.date)).toFixed(1)}" cy="${sy(p.price).toFixed(1)}" r="3.5" fill="currentColor"><title>${fmtD(p.date)}: ${money(p.price)}</title></circle>`).join("")}<text x="4" y="12" font-size="11" fill="currentColor">${money(y1)}</text><text x="4" y="${H-6}" font-size="11" fill="currentColor">${money(y0)}</text></svg>`};
const priceOf=(s,r)=>{const cid=s==="c"?r.id:r.catId;return {cid,l:cid==null?[]:precos.filter(p=>p.cat===cid).sort((a,b)=>a.date<b.date?-1:1)}};
const priceSec=(s,r)=>{const {cid,l}=priceOf(s,r);if(cid==null)return"";const ps=l.map(p=>p.price);
 return `<section class="ppsec"><div class="pph"><h3>Histórico de preços</h3><button type="button" class="lk" data-act="price">${user?"Registrar / ver detalhes":"Ver detalhes"}</button></div>${l.length?`<p class="m">Último: <b>${money(ps[ps.length-1])}</b> (${fmtD(l[l.length-1].date)}) · menor ${money(Math.min(...ps))} · maior ${money(Math.max(...ps))} · ${l.length} registro(s)</p>${priceSvg(l)}`:'<p class="m">Sem registros de preço ainda.</p>'}</section>`};
function priceDlg(s,id,r){const {cid,l}=priceOf(s,r),d=$("#dlg");if(cid==null)return toast("Sincronize o livro com a biblioteca primeiro");d.className="";const ps=l.map(p=>p.price);
 d.innerHTML=`<h2>Preços — ${esc(label(r))}</h2>${ps.length?`<div class="kpis"><div class="kpi"><b>${money(ps[ps.length-1])}</b><span>Último (${fmtD(l[l.length-1].date)})</span></div><div class="kpi"><b>${money(Math.min(...ps))}</b><span>Menor</span></div><div class="kpi"><b>${money(Math.max(...ps))}</b><span>Maior</span></div><div class="kpi"><b>${money(ps.reduce((a,b)=>a+b,0)/ps.length)}</b><span>Média de ${ps.length}</span></div></div>`:'<p class="m">Nenhum preço registrado ainda.</p>'}
 ${priceSvg(l)}<div>${l.slice().reverse().map(p=>`<div class="ri"><span>${fmtD(p.date)} — <b>${money(p.price)}</b>${p.store?" · "+esc(p.store):""}${p.state?" · "+esc(p.state):""}${p.src&&p.src!=="manual"?` <span class="m">(${esc(p.src)})</span>`:""}${/^https?:\/\//i.test(p.url||"")?` · <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">link</a>`:""}</span>${user?`<button type="button" class="dg" data-pd="${p.id}">Excluir</button>`:""}</div>`).join("")}</div>
 ${user?`<fieldset><legend>Registrar preço</legend><div class="g"><label>Data<input id="pdt" type="date" value="${today()}"></label><label>Preço (R$)<input id="ppr" type="number" step="0.01" min="0"></label><label>Loja<input id="pst" list="stores" value="Amazon"></label><label>Estado<select id="pse"><option>Novo</option><option>Seminovo</option><option>Usado</option></select></label><label class="full">Link (opcional)<input id="pur" type="url" value="${esc(r.buyUrl||"")}"></label></div></fieldset>`:'<p class="m">Entre para registrar preços.</p>'}
 <p class="m">O histórico é compartilhado e alimentado por compras registradas, pelo favorito da Amazon e por registros manuais; o app não consulta a Amazon sozinho.${keepaLink(r)}</p>
 <div class="ft"><span class="sp"></span><button type="button" id="pcl">Voltar</button>${user?'<button type="button" id="psv" class="pri">Registrar</button>':""}</div>`;
 d.open||d.showModal();$("#pcl").onclick=()=>showItem(s,id);
 $$("[data-pd]",d).forEach(b=>b.onclick=async()=>{const pid=+b.dataset.pd;try{const x=must(await sb.from("precos").delete().eq("id",pid).select("id"));if(!x.length)return toast("Só o administrador ou quem registrou pode excluir");precos=precos.filter(p=>p.id!==pid);priceDlg(s,id,r)}catch(e){toast("Não foi possível excluir")}});
 if(user)$("#psv").onclick=async()=>{const price=parseFloat($("#ppr").value),url=$("#pur").value.trim();if(!(price>0))return toast("Informe o preço");if(url&&!/^https?:\/\//i.test(url))return toast("O link deve começar com http(s)");
  await addPrice(cid,{date:$("#pdt").value||today(),price,store:$("#pst").value.trim(),state:$("#pse").value,url,src:"manual"});priceDlg(s,id,r)}}

/* ---------- Login e inicialização ---------- */
const authBox=(msg,err)=>{$("#auth").hidden=false;$("#am").textContent=msg||"";$("#ae").textContent=err||""};
const enter=async u=>{user=u;document.body.classList.remove("lock");$("#auth").hidden=true;$("#who").textContent=u.email||"";$("#af").reset();
  await load();
  takePend();try{if(!books.length&&!catalog.length&&!goals.length){const o=await localData();
    if(o&&confirm(`Encontrei ${o.books.length} itens e ${o.catalog.length} no catálogo salvos neste navegador. Enviar para a nuvem agora?`))await migrateLocal(o)}}catch{}};
$("#af").onsubmit=async e=>{e.preventDefault();const f=e.target,b=f.querySelector("button");b.disabled=true;$("#ae").textContent="";
  const cr={email:f.email.value.trim(),password:f.pw.value},r=signup?await sb.auth.signUp(cr):await sb.auth.signInWithPassword(cr);b.disabled=false;
  if(r.error)return $("#ae").textContent=/invalid/i.test(r.error.message)?"E-mail ou senha incorretos.":"Não foi possível entrar: "+r.error.message;
  if(!r.data.session)return $("#ae").textContent="Conta criada! Confirme o e-mail enviado e depois entre.";enter(r.data.user)};
$("#out").onclick=()=>sb.auth.signOut();
$("#in").onclick=()=>authBox("Entre ou crie sua conta.");$("#acx").onclick=()=>$("#auth").hidden=true;
$("#atog").onclick=()=>{signup=!signup;$("#asub").textContent=signup?"Criar conta":"Entrar";$("#atog").textContent=signup?"Já tenho conta":"Criar conta"};
addEventListener("unhandledrejection",e=>{toast("Erro ao falar com o servidor: "+(e.reason?.message||e.reason||"tente novamente"));e.preventDefault()});
async function start(){
  if(!window.supabase||!CFG.SUPABASE_URL||!CFG.SUPABASE_ANON_KEY||/SEU-PROJETO|SUA-CHAVE/.test(CFG.SUPABASE_URL+CFG.SUPABASE_ANON_KEY))
    return authBox("Falta configurar o Supabase: preencha a URL e a chave no arquivo config.js.");
  sb=supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange(ev=>{if(ev==="SIGNED_OUT"){user=null;books=[];catalog=[];goals=[];$("#dlg").open&&$("#dlg").close();view="explorar";admin=false;load()}});
  const {data}=await sb.auth.getSession();
  data.session?enter(data.session.user):(view="explorar",load().then(()=>pend&&need()))}
start();
