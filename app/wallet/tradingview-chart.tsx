import type {EquityListing} from '@/lib/markets/equities';

export function TradingViewChart({listing}:{listing:EquityListing}) {
  const exchange = listing.mic==='XETR'?'XETR':'NASDAQ';
  const symbol=exchange+':'+listing.symbol;
  const source='https://www.tradingview.com/symbols/'+exchange+'-'+listing.symbol+'/';
  const config=JSON.stringify({
    symbol,interval:'D',autosize:true,theme:'light',timezone:'Etc/UTC',locale:'en',
    allow_symbol_change:false,hide_side_toolbar:true,hide_top_toolbar:false,hide_volume:true,
    save_image:false,withdateranges:true,
  });
  // A data document has an opaque origin even with allow-same-origin. The nested vendor
  // chart retains its own origin. Do not change this to srcDoc or a SharkAI-hosted page.
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://s3.tradingview.com; style-src 'unsafe-inline'; frame-src https://www.tradingview-widget.com; connect-src https://widget-sheriff.tradingview-widget.com; base-uri 'none'; form-action 'none'">
<style>html,body,.tradingview-widget-container{height:100%;width:100%;margin:0}.tradingview-widget-copyright{text-align:center;font:13px/32px system-ui;color:#394767;background:white}.tradingview-widget-copyright a{color:#304b8a}</style>
<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget" style="height:calc(100% - 32px);width:100%"></div>
<div class="tradingview-widget-copyright"><a href="${source}" rel="noopener nofollow" target="_blank">${symbol} chart</a> by TradingView</div>
<script src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>${config}</script></div></html>`;
  return <div>
    <iframe key={symbol} title={'Графика на '+listing.symbol+' от TradingView'} referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{display:'block',width:'100%',height:'clamp(300px,55vh,480px)',border:0,borderRadius:12}}
      src={'data:text/html;charset=utf-8,'+encodeURIComponent(html)}/>
    <p className="micro"><a href={source} target="_blank" rel="noopener noreferrer">Отвори {listing.symbol} в TradingView</a>
      {' · '}{exchange==='XETR'?'Xetra · цени в края на борсовия ден':'Cboe One · данни със закъснение'}</p>
  </div>;
}
