// Netlify Function: /api/price?symbol=XDEV.MI | /api/price?symbol=FR0010870956 | /api/price?symbol=LU3040324488
// Gestisce:
// - Ticker Yahoo (es. XDEV.MI, ENI.MI)
// - ISIN obbligazioni Borsa Italiana (es. FR0010870956) -> /borsa/obbligazioni/mot/...
// - ISIN fondi Borsa Italiana (es. LU3040324488) -> /borsa/fondi/dettaglio/...

const CORS = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' };

const BROWSER_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'it-IT,it;q=0.9,en;q=0.8',
  'Cache-Control':'no-cache',
};

function isISIN(s){
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test((s||'').trim().toUpperCase());
}

// ── Yahoo Finance ────────────────────────────────────────────────────────────
async function getYahooPrice(symbol){
  for(const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']){
    for(const range of ['1d','5d']){
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      try {
        const r = await fetch(url, {headers:{
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept':'application/json','Accept-Language':'en-US,en;q=0.9',
        }});
        if(!r.ok) continue;
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        if(!res) continue;
        const price = res.meta?.regularMarketPrice;
        if(price && price > 0) return +price;
        const closes = res.indicators?.quote?.[0]?.close;
        if(closes){ for(let i=closes.length-1;i>=0;i--){ if(closes[i]>0) return +closes[i]; } }
      } catch(e){ continue; }
    }
  }
  return null;
}

// ── Borsa Italiana Obbligazioni ──────────────────────────────────────────────
async function getBIBondPrice(isin){
  const url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/euro-obbligazioni/scheda/${isin}-MOTX.html?lang=it`;
  try {
    const r = await fetch(url, {headers: BROWSER_HEADERS});
    if(!r.ok) return null;
    const html = await r.text();
    const m1 = html.match(/class="summary-value"[\s\S]{0,300}?<strong>([\d]+[,.][\d]+)<\/strong>/);
    if(m1) return parseFloat(m1[1].replace(',','.'));
    const m2 = html.match(/Prezzo ufficiale[\s\S]{0,300}?class="t-text -right">([\d]+[,.][\d]+)<\/span>/);
    if(m2) return parseFloat(m2[1].replace(',','.'));
    const rx = /class="t-text -right">([\d]+[,.][\d]+)<\/span>/g;
    let m;
    while((m=rx.exec(html))!==null){
      const v=parseFloat(m[1].replace(',','.'));
      if(v>50&&v<200) return v;
    }
  } catch(e){}
  return null;
}

// ── Borsa Italiana Fondi ─────────────────────────────────────────────────────
// URL formato: /borsa/fondi/dettaglio/CODICE.html
// Il codice NON e l'ISIN ma un codice interno BI — lo ricaviamo cercando l'ISIN nella pagina di ricerca
async function getBIFundPrice(isin){
  // Step 1: cerca il codice fondo tramite la pagina di ricerca BI
  const searchUrl = `https://www.borsaitaliana.it/borsa/fondi/lista.html?isin=${isin}&lang=it`;
  try {
    const rs = await fetch(searchUrl, {headers: BROWSER_HEADERS});
    if(!rs.ok) return null;
    const searchHtml = await rs.text();

    // Estrai il link alla scheda fondo dalla pagina di lista
    // Pattern: href="/borsa/fondi/dettaglio/XXXXXXXX.html"
    const linkMatch = searchHtml.match(/href="(\/borsa\/fondi\/dettaglio\/[A-Z0-9]+\.html)"/i);
    if(!linkMatch) {
      // Prova anche il pattern alternativo con query string
      const linkMatch2 = searchHtml.match(/href="(\/borsa\/fondi\/dettaglio\/[^"]+\.html[^"]*)"/i);
      if(!linkMatch2) return null;
    }

    const detailPath = (linkMatch || searchHtml.match(/href="(\/borsa\/fondi\/dettaglio\/[^"]+\.html[^"]*)"/i))[1];
    const detailUrl = 'https://www.borsaitaliana.it' + detailPath;

    // Step 2: scarica la pagina dettaglio e cerca il prezzo/NAV
    const rd = await fetch(detailUrl, {headers: BROWSER_HEADERS});
    if(!rd.ok) return null;
    const html = await rd.text();

    return extractFundPrice(html);
  } catch(e){ return null; }
}

// Alternativa: URL diretto se conosciamo il codice interno (passato come ticker)
async function getBIFundPriceDirect(biCode){
  const url = `https://www.borsaitaliana.it/borsa/fondi/dettaglio/${biCode}.html`;
  try {
    const r = await fetch(url, {headers: BROWSER_HEADERS});
    if(!r.ok) return null;
    const html = await r.text();
    return extractFundPrice(html);
  } catch(e){ return null; }
}

function extractFundPrice(html){
  // Pattern 1: summary-value (stesso pattern obbligazioni)
  const m1 = html.match(/class="summary-value"[\s\S]{0,300}?<strong>([\d]+[,.][\d]+)<\/strong>/);
  if(m1) return parseFloat(m1[1].replace(',','.'));

  // Pattern 2: "Valore quota" o "NAV"
  const m2 = html.match(/(?:Valore quota|NAV|Valore unit)[\s\S]{0,300}?>([\d]+[,.][\d]+)</i);
  if(m2) return parseFloat(m2[1].replace(',','.'));

  // Pattern 3: t-text -right con valore plausibile per fondo (tipicamente 1-9999)
  const rx = /class="t-text -right">([\d]+[,.][\d]{2,4})<\/span>/g;
  let m;
  while((m=rx.exec(html))!==null){
    const v = parseFloat(m[1].replace(',','.'));
    if(v > 0.5 && v < 99999) return v;
  }

  // Pattern 4: cerca numeri decimali nel range tipico dei fondi
  const nums = html.match(/\b(\d{1,5}[,.]\d{2,4})\b/g);
  if(nums){
    for(const n of nums){
      const v = parseFloat(n.replace(',','.'));
      if(v > 0.5 && v < 99999) return v;
    }
  }
  return null;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async function(event){
  if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:CORS,body:''};

  const params = event.queryStringParameters||{};
  const symbol = (params.symbol||'').trim().toUpperCase();
  const debug  = params.debug === '1';

  if(!symbol) return {statusCode:400,headers:CORS,body:JSON.stringify({error:'symbol required'})};

  let price = null;
  let method = '';
  let debugInfo = {};

  if(isISIN(symbol)){
    // Prova prima obbligazioni BI
    price = await getBIBondPrice(symbol);
    if(price !== null){ method = 'BI-bond'; }

    // Se non trovato, prova fondi BI tramite ricerca
    if(price === null){
      price = await getBIFundPrice(symbol);
      if(price !== null){ method = 'BI-fund'; }
    }

    // Fallback Yahoo
    if(price === null){
      price = await getYahooPrice(symbol);
      if(price !== null){ method = 'Yahoo'; }
    }
  } else {
    // Ticker diretto (es. XDEV.MI) o codice BI fondo (es. 2FADB1045294)
    // Prova prima Yahoo
    price = await getYahooPrice(symbol);
    if(price !== null){ method = 'Yahoo'; }

    // Se non trovato e assomiglia a un codice BI fondo (alfanumerico), prova BI direct
    if(price === null && /^[A-Z0-9]{10,14}$/.test(symbol)){
      price = await getBIFundPriceDirect(symbol);
      if(price !== null){ method = 'BI-fund-direct'; }
    }
  }

  if(price !== null){
    const body = debug
      ? JSON.stringify({symbol, price, method})
      : JSON.stringify({symbol, price});
    return {statusCode:200, headers:CORS, body};
  }

  return {
    statusCode:404, headers:CORS,
    body:JSON.stringify({error:'price not found', symbol, method_tried: debug?method:undefined})
  };
};
