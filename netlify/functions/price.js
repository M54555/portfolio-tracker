const CORS = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' };

const BROWSER_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'it-IT,it;q=0.9,en;q=0.8',
  'Referer':'https://www.borsaitaliana.it/',
};

function isISIN(s){
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test((s||'').trim().toUpperCase());
}

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

async function getBIBondPrice(isin){
  const url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/euro-obbligazioni/scheda/${isin}-MOTX.html?lang=it`;
  try {
    const r = await fetch(url,{headers:BROWSER_HEADERS});
    if(!r.ok) return null;
    const html = await r.text();
    const m1 = html.match(/class="summary-value"[\s\S]{0,300}?<strong>([\d]+[,.][\d]+)<\/strong>/);
    if(m1) return parseFloat(m1[1].replace(',','.'));
    const m2 = html.match(/Prezzo ufficiale[\s\S]{0,300}?class="t-text -right">([\d]+[,.][\d]+)<\/span>/);
    if(m2) return parseFloat(m2[1].replace(',','.'));
    const rx = /class="t-text -right">([\d]+[,.][\d]+)<\/span>/g;
    let m; while((m=rx.exec(html))!==null){ const v=parseFloat(m[1].replace(',','.')); if(v>50&&v<200) return v; }
  } catch(e){}
  return null;
}

function extractFundPrice(html){
  const m1 = html.match(/class="summary-value"[\s\S]{0,300}?<strong>([\d]+[,.][\d]+)<\/strong>/);
  if(m1) return parseFloat(m1[1].replace(',','.'));
  const m2 = html.match(/(?:Valore quota|NAV|nav|Quota)[\s\S]{0,300}?>([\d]+[,.][\d]+)</i);
  if(m2) return parseFloat(m2[1].replace(',','.'));
  const rx = /class="t-text -right">([\d]+[,.][\d]{2,4})<\/span>/g;
  let m; while((m=rx.exec(html))!==null){
    const v=parseFloat(m[1].replace(',','.'));
    if(v>0.5&&v<99999) return v;
  }
  return null;
}

async function getBIFundPrice(isin, debugLog){
  // Prova diversi URL di ricerca BI
  const searchUrls = [
    `https://www.borsaitaliana.it/borsa/fondi/lista.html?isin=${isin}&lang=it`,
    `https://www.borsaitaliana.it/borsa/fondi/ricerca.html?isin=${isin}&lang=it`,
    `https://www.borsaitaliana.it/app/homeit/ricerca?_dc=1&query=${isin}&lang=it`,
  ];

  for(const searchUrl of searchUrls){
    try {
      debugLog.push('Trying: ' + searchUrl);
      const rs = await fetch(searchUrl,{headers:BROWSER_HEADERS});
      debugLog.push('Status: ' + rs.status);
      if(!rs.ok) continue;
      const html = await rs.text();
      debugLog.push('Length: ' + html.length);

      // Cerca link a scheda fondo
      const patterns = [
        /href="(\/borsa\/fondi\/dettaglio\/[A-Z0-9]+\.html)"/gi,
        /href="(\/borsa\/fondi\/[^"]*dettaglio[^"]*\.html[^"]*)"/gi,
        /href="([^"]*\/fondi\/[^"]*\.html[^"]*)"/gi,
      ];

      for(const pat of patterns){
        const m = html.match(pat);
        if(m){
          const linkMatch = m[0].match(/href="([^"]+)"/);
          if(linkMatch){
            const path = linkMatch[1].startsWith('http') ? linkMatch[1] : 'https://www.borsaitaliana.it' + linkMatch[1];
            debugLog.push('Found link: ' + path);
            const rd = await fetch(path,{headers:BROWSER_HEADERS});
            if(!rd.ok){ debugLog.push('Detail page status: '+rd.status); continue; }
            const dhtml = await rd.text();
            debugLog.push('Detail page length: ' + dhtml.length);
            const price = extractFundPrice(dhtml);
            if(price !== null){ debugLog.push('Price found: ' + price); return price; }
            debugLog.push('Price not extracted from detail page');
          }
        }
      }

      // Prova estrazione diretta dalla pagina di ricerca
      const directPrice = extractFundPrice(html);
      if(directPrice !== null){ debugLog.push('Direct price from search: '+directPrice); return directPrice; }

      // Cerca se c'e il prezzo inline nella risposta JSON
      try {
        const j = JSON.parse(html);
        debugLog.push('JSON keys: ' + Object.keys(j).join(','));
      } catch(e){}

      // Mostra primi 500 chars per debug
      debugLog.push('HTML preview: ' + html.slice(0,500).replace(/\n/g,' '));

    } catch(e){
      debugLog.push('Error: ' + e.message);
    }
  }
  return null;
}

exports.handler = async function(event){
  if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:CORS,body:''};

  const params = event.queryStringParameters||{};
  const symbol = (params.symbol||'').trim().toUpperCase();
  const debug  = params.debug==='1';

  if(!symbol) return {statusCode:400,headers:CORS,body:JSON.stringify({error:'symbol required'})};

  const debugLog = [];
  let price = null;
  let method = '';

  if(isISIN(symbol)){
    debugLog.push('Trying BI bond...');
    price = await getBIBondPrice(symbol);
    if(price!==null){ method='BI-bond'; }

    if(price===null){
      debugLog.push('Trying BI fund...');
      price = await getBIFundPrice(symbol, debugLog);
      if(price!==null){ method='BI-fund'; }
    }

    if(price===null){
      debugLog.push('Trying Yahoo...');
      price = await getYahooPrice(symbol);
      if(price!==null){ method='Yahoo'; }
    }
  } else {
    price = await getYahooPrice(symbol);
    if(price!==null){ method='Yahoo'; }
  }

  if(price!==null){
    return {statusCode:200,headers:CORS,
      body:JSON.stringify(debug?{symbol,price,method,log:debugLog}:{symbol,price})};
  }

  return {statusCode:404,headers:CORS,
    body:JSON.stringify({error:'price not found',symbol,log:debug?debugLog:undefined})};
};
