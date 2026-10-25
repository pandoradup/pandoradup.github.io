import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const read=file=>fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
const source=read('assets/js/script.js');const html=read('index.html');
assert(html.indexOf('data-content-pending')<html.indexOf('rel="stylesheet"'));
assert(!html.includes('data-content="hero_button_text">VER CATÁLOGO'));
assert(!source.includes('menu_items'));assert(!source.includes('defaultAnnouncement'));
const nodes=new Map();for(const key of ['hero_title','hero_button_text','hero_button_url','announcement'])nodes.set(key,{textContent:'',innerHTML:'',hasAttribute:()=>false});
const ctx=vm.createContext({document:{body:{classList:{contains:()=>false}},querySelector(selector){if(selector==='[data-hero-button]')return nodes.get('hero_button_url');if(selector==='[data-announcement-track]')return nodes.get('announcement');const match=selector.match(/^\[data-content="([^"]+)"\]$/);return match?nodes.get(match[1])||null:null;},querySelectorAll:()=>[]},renderMultilineContent(){},setStoreBackground(){}});
for(const name of ['escapeHtml']){const start=source.indexOf('const '+name);const end=source.indexOf('\n\n',start);vm.runInContext(source.slice(start,end),ctx);}
for(const name of ['renderAnnouncement','applyStoreContent'])vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0],ctx);
ctx.content=[{key:'hero_title',value:'Tu pulsera, tu historia'},{key:'hero_button_text',value:'DESCUBRIR MIS CHARMS'},{key:'hero_button_url',value:'index.html?category=charms'},{key:'announcement',value:'3 CUOTAS SIN INTERÉS'}];
vm.runInContext('applyStoreContent(content)',ctx);
assert.equal(nodes.get('hero_title').textContent,'Tu pulsera, tu historia');assert.equal(nodes.get('hero_button_text').textContent,'DESCUBRIR MIS CHARMS');assert.equal(nodes.get('hero_button_url').href,'index.html?category=charms');
assert(!nodes.get('announcement').innerHTML.includes('ENVÍOS'));assert.equal((nodes.get('announcement').innerHTML.match(/<span>/g)||[]).length,2);
console.log('OK: texto y destino guardados respetados, sin título recortado ni anuncios agregados.');
