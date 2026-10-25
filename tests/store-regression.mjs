import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const context = vm.createContext({window:{}});
vm.runInContext(read('assets/js/promotions.js'), context);
const engine = context.window.PromotionEngine;
const base={id:'base',name:'Brazalete',price:18000,product_type:'base'};
const charm={id:'charm',name:'Charm',price:5000,product_type:'charm'};
const promo={id:'bundle',name:'Brazalete + 3 charms',active:true,type:'price',price:25000,requirements:[{matcher:'product_type',value:'base',quantity:1},{matcher:'product_type',value:'charm',quantity:3}]};
const cart=[base,charm,charm,charm];
assert.equal(engine.calculate(cart,[base,charm],[promo]).total,25000);
assert.equal(engine.calculate([base,charm],[base,charm],[promo]).discount,0);
assert.equal(engine.calculate(cart,[base,charm],[{...promo,active:false}]).discount,0);
assert.equal(engine.calculate([...cart,...cart],[base,charm],[promo]).total,50000);
const gift={...promo,id:'gift',type:'gift',gift:'Bolsa',requirements:[{matcher:'product_type',value:'base',quantity:1}]};
const exclusive={...promo,exclusive:true};
assert.equal(engine.calculate(cart,[base,charm],[exclusive,gift]).applications.length,1);
assert.equal(engine.parse(JSON.stringify([null,{},promo,{...promo,requirements:[null]}])).length,1);
assert.equal(engine.parse('{bad').length,0);
for(const file of ['assets/js/script.js','assets/js/checkout.js']){
 const source=read(file);
 // Storefront's declarations precede cart parsing; isolate the guarded storage read.
 const parsing=source.match(/try \{\n  const savedCart[^]*?\n\} catch \{[^]*?\n\}/)[0];
 for(const data of ['{}','null','[null,{}]','not JSON',JSON.stringify([charm])]){
  const c=vm.createContext({localStorage:{getItem:()=>data}});vm.runInContext('let cart=[];'+parsing,c);
  assert.equal(vm.runInContext('cart.length',c),data===JSON.stringify([charm])?1:0);
 }
}
const admin=read('assets/js/admin.js');
const persist=admin.match(/async function persistPromotions\([^]*?\n\}/)[0];
let fail=true;
const c=vm.createContext({supabase:{from:()=>({upsert:async()=>({error:fail?new Error('offline'):null})})},localStorage:{setItem(){}},renderPromotions(){},message(){}});
vm.runInContext('let promotions=[{id:"original"}];'+persist,c);
await assert.rejects(vm.runInContext('persistPromotions("saved",[{id:"new"}])',c));
assert.equal(vm.runInContext('promotions[0].id',c),'original');
fail=false;await vm.runInContext('persistPromotions("saved",[{id:"new"}])',c);
assert.equal(vm.runInContext('promotions[0].id',c),'new');
const client=read('assets/js/supabase-client.js');let creations=0;
const clientContext=vm.createContext({loadSupabaseModule:async()=>({createClient:()=>({id:++creations})}),SUPABASE_URL:'test',SUPABASE_PUBLISHABLE_KEY:'test'});
vm.runInContext(client.slice(client.indexOf('let clientPromise')).replace('export function','function'),clientContext);
const clients=await Promise.all([vm.runInContext('createSupabaseClient()',clientContext),vm.runInContext('createSupabaseClient()',clientContext)]);
assert.equal(creations,1);assert.equal(clients[0],clients[1]);
console.log('OK: descuentos, cantidades, exclusividad, datos dañados, guardado fallido y conexión compartida.');
