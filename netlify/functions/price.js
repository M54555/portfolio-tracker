// Netlify Function: /api/price?symbol=XDEV.MI | /api/price?symbol=FR0010870956
// Gira server-side sullo stesso dominio Netlify: zero problemi CORS.
// - Ticker Yahoo (es. XDEV.MI, ENI.MI) --> Yahoo Finance API
// - ISIN (es. FR0010870956, BE0000340498) --> Borsa Italiana scraping + fallback Yahoo

const CORS = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' };

function isISIN(s){
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test((s||'').trim().toUpperCase());
}

async function getYahooPrice(symbol){
  const hdrs = {
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept':'application/json',
    'Accept-Language':'en-US,en;q=0.9',
  };
  for(const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']){
    for(const range of ['1d','5d']){
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      try {
        const r = await fetch(url, {headers:hdrs});
        if(!r.ok) continue;
        const j = await r.json();
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        if(!res) continue;
        const price = res.meta && res.meta.regularMarketPrice;
        if(price && price > 0) return +price;
        const closes = res.indicators && res.indicators.quote &&
                       res.indicators.quote[0] && res.indicators.quote[0].close;
        if(closes){
          for(let i = closes.length-1; i >= 0; i--){
            if(closes[i] > 0) return +closes[i];
          }
        }
      } catch(e){ continue; }
    }
  }
  return null;
}

async function getBorsaItalianaPrice(isin){
  const url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/euro-obbligazioni/scheda/${isin}-MOTX.html?lang=it`;
  try {
    const r = await fetch(url, {headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':'text/html,application/xhtml+xml',
      'Accept-Language':'it-IT,it;q=0.9',
    }});
    if(!r.ok) return null;
    const html = await r.text();

    // Pattern 1: prezzo corrente nel summary header
    // <div class="summary-value">...<strong>91,94</strong>
    const m1 = html.match(/class="summary-value"[\s\S]{0,300}?<strong>([\d]+[,.][\d]+)<\/strong>/);
    if(m1) return parseFloat(m1[1].replace(',','.'));

    // Pattern 2: "Prezzo ufficiale" nella tabella dati
    const m2 = html.match(/Prezzo ufficiale[\s\S]{0,300}?class="t-text -right">([\d]+[,.][\d]+)<\/span>/);
    if(m2) return parseFloat(m2[1].replace(',','.'));

    // Pattern 3: qualsiasi span t-text -right con valore plausibile (50-200)
    const rx = /class="t-text -right">([\d]+[,.][\d]+)<\/span>/g;
    let m;
    while((m = rx.exec(html)) !== null){
      const val = parseFloat(m[1].replace(',','.'));
      if(val > 50 && val < 200) return val;
    }
  } catch(e){}
  return null;
}

exports.handler = async function(event){
  if(event.httpMethod === 'OPTIONS'){
    return {statusCode:200, headers:CORS, body:''};
  }
  const symbol = ((event.queryStringParameters||{}).symbol||'').trim().toUpperCase();
  if(!symbol){
    return {statusCode:400, headers:CORS, body:JSON.stringify({error:'symbol required'})};
  }

  let price = null;
  if(isISIN(symbol)){
    price = await getBorsaItalianaPrice(symbol);
    if(price === null) price = await getYahooPrice(symbol);
  } else {
    price = await getYahooPrice(symbol);
  }

  if(price !== null){
    return {statusCode:200, headers:CORS, body:JSON.stringify({symbol, price})};
  }
  return {statusCode:404, headers:CORS, body:JSON.stringify({error:'not found', symbol})};
};
