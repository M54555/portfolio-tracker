// Netlify Function: /api/price?symbol=...
// Gestisce:
// - Ticker Yahoo (es. XDEV.MI, ENI.MI, BTC-EUR)
// - ISIN obbligazioni Borsa Italiana (es. FR0010870956)
// - Codice fondo Borsa Italiana (es. 2FADB1045294) -> usato come ticker nell'app

const CORS = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' };

const BI_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml',
  'Accept-Language':'it-IT,it;q=0.9',
  'Referer':'https://www.borsaitaliana.it/',
};

function isISIN(s){
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test((s||'').trim().toUpperCase());
}

// Riconosce un codice fondo BI: alfanumerico, 10-14 chars, contiene sia lettere che numeri
// es. 2FADB1045294
function isBIFundCode(s){
  return /^[A-Z0-9]{10,14}$/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && !isISIN(s);
}

// ── Yahoo Finance ────────────────────────────────────────────────────────────
async function getYahooPrice(symbol){
  for(const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']){
    for(const range of ['1d','5d']){
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      try {
        const r = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}});
        if(!r.ok) continue;
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        if(!res) continue;
        const price = res.meta?.regularMarketPrice;
        if(price && price>0) return +price;
        const closes = res.indicators?.quote?.[0]?.close;
        if(closes){ for(let i=closes.length-1;i>=0;i--){ if(closes[i]>0) return +closes[i]; } }
      } catch(e){ continue; }
    }
  }
  return null;
}

// ── Borsa Italiana — Obbligazioni ────────────────────────────────────────────
async function getBIBondPrice(isin){
  const url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/euro-obbligazioni/scheda/${isin}-MOTX.html?lang=it`;
  try {
    const r = await fetch(url,{headers:BI_HEADERS});
    if(!r.ok) return null;
    const html = await r.text();
    const m1 = html.match(/class="summary-value"[\s\S]{0,300}?<strong>([\d]+[,.][\d]+)<\/strong>/);
    if(m1) return parseFloat(m1[1].replace(',','.'));
    const m2 = html.match(/Prezzo ufficiale[\s\S]{0,300}?class="t-text -right">([\d]+[,.][\d]+)<\/span>/);
    if(m2) return parseFloat(m2[1].replace(',','.'));
    const rx = /class="t-text -right">([\d]+[,.][\d]+)<\/span>/g;
    let m; while((m=rx.exec(html))!==null){
      const v=parseFloat(m[1].replace(',','.'));
      if(v>50&&v<200) return v;
    }
  } catch(e){}
  return null;
}

// ── Borsa Italiana — Fondi (codice diretto es. 2FADB1045294) ─────────────────
async function getBIFundPrice(biCode){
  const url = `https://www.borsaitaliana.it/borsa/fondi/dettaglio/${biCode}.html`;
  try {
    const r = await fetch(url,{headers:BI_HEADERS});
    if(!r.ok) return null;
    const html = await r.text();

    // Pattern 1: summary-value (stesso delle obbligazioni)
    const m1 = html.match(/class="summary-value"[\s\S]{0,300}?<strong>([\d]+[,.][\d]+)<\/strong>/);
    if(m1) return parseFloat(m1[1].replace(',','.'));

    // Pattern 2: Valore quota / NAV
    const m2 = html.match(/(?:Valore quota|NAV|Quota|Prezzo)[\s\S]{0,300}?class="t-text -right">([\d]+[,.][\d]+)<\/span>/i);
    if(m2) return parseFloat(m2[1].replace(',','.'));

    // Pattern 3: qualsiasi t-text -right con valore plausibile per fondo
    const rx = /class="t-text -right">([\d]+[,.][\d]{2,4})<\/span>/g;
    let m; while((m=rx.exec(html))!==null){
      const v=parseFloat(m[1].replace(',','.'));
      if(v>0.5&&v<99999) return v;
    }
  } catch(e){}
  return null;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async function(event){
  if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:CORS,body:''};

  const params = event.queryStringParameters||{};
  const symbol = (params.symbol||'').trim().toUpperCase();

  if(!symbol) return {statusCode:400,headers:CORS,body:JSON.stringify({error:'symbol required'})};

  let price = null;

  if(isISIN(symbol)){
    // ISIN: prova obbligazioni BI, poi Yahoo
    price = await getBIBondPrice(symbol);
    if(price===null) price = await getYahooPrice(symbol);
  } else if(isBIFundCode(symbol)){
    // Codice fondo BI (es. 2FADB1045294): pagina dettaglio diretta
    price = await getBIFundPrice(symbol);
    if(price===null) price = await getYahooPrice(symbol);
  } else {
    // Ticker Yahoo (es. XDEV.MI)
    price = await getYahooPrice(symbol);
  }

  if(price!==null)
    return {statusCode:200,headers:CORS,body:JSON.stringify({symbol,price})};

  return {statusCode:404,headers:CORS,body:JSON.stringify({error:'price not found',symbol})};
};
