import {test} from 'node:test';
import assert from 'node:assert/strict';
import {krakenPairRequest, verifiedKrakenReference} from '../app/wallet/crypto-reference';

const at='2026-11-20T20:00:00.000Z', now=Date.parse('2026-11-20T20:01:00.000Z');
const market=(base:string,quote:string,price:string,checked_at=at,status='online')=>({
 status:'available',source:'Kraken Spot',checked_at,rows:[
  {id:'X'+base+quote,base,quote,market_status:status,ticker:{price}}
 ]
});
test('BTC/EUR uses owned public Kraken read endpoint and finite verified price',()=>{
 assert.deepEqual(krakenPairRequest('BTC','EUR'),{pair:'BTC/EUR',inverted:false});
 assert.deepEqual(verifiedKrakenReference('BTC','EUR',market('BTC','EUR','73500.25'),now),
  {rate:73500.25,date:'2026-11-20',source:'Kraken Spot'});
});
test('EUR/BTC inverts a validated BTC/EUR quote',()=>{
 assert.deepEqual(krakenPairRequest('EUR','BTC'),{pair:'BTC/EUR',inverted:true});
 const result=verifiedKrakenReference('EUR','BTC',market('BTC','EUR','73500.25'),now);
 assert.ok(result && Math.abs(result.rate-1/73500.25)<1e-14);
});
test('no crypto symbols do not request Kraken',()=>{
 assert.equal(krakenPairRequest('EUR','GBP'),null);
});
test('unverified, stale and missing Kraken values are never shown as prices',()=>{
 assert.equal(verifiedKrakenReference('BTC','EUR',{status:'unavailable'},now),null);
 assert.equal(verifiedKrakenReference('BTC','EUR',market('ETH','EUR','55'),now),null);
 assert.equal(verifiedKrakenReference('BTC','EUR',market('BTC','EUR','0'),now),null);
 assert.equal(verifiedKrakenReference('BTC','EUR',market('BTC','EUR','NaN'),now),null);
 assert.equal(verifiedKrakenReference('BTC','EUR',market('BTC','EUR','73500.25','2026-11-20T19:55:00.000Z'),now),null);
 assert.equal(verifiedKrakenReference('BTC','EUR',market('BTC','EUR','73500.25',at,'cancel_only'),now),null);
});
