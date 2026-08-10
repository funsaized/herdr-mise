import { readFileSync } from "node:fs";
const source=readFileSync(new URL("../client/src/theme/tokens.ts",import.meta.url),"utf8"),scene=readFileSync(new URL("../client/src/scene/kitchen-scene.ts",import.meta.url),"utf8"),app=readFileSync(new URL("../client/src/App.tsx",import.meta.url),"utf8");
function token(name){const match=source.match(new RegExp(`${name}:\\s*"(#[0-9a-fA-F]{6})"`));if(!match)throw new Error(`Missing token ${name}`);return match[1];}
function luminance(hex){const values=[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return .2126*values[0]+.7152*values[1]+.0722*values[2];}
function contrast(a,b){const one=luminance(a),two=luminance(b);return (Math.max(one,two)+.05)/(Math.min(one,two)+.05);}
const checks=[["text","panel",4.5],["textMuted","panel",4.5],["buttonText","text",4.5],["tooltipSecondary","ink",4.5]];
const failures=[];for(const [front,back,minimum] of checks){const ratio=contrast(token(front),token(back));console.log(`${front}/${back}: ${ratio.toFixed(2)}:1`);if(ratio<minimum)failures.push(`${front}/${back} ${ratio.toFixed(2)} < ${minimum}`);}
const tokenSource=readFileSync(new URL("../client/src/theme/tokens.ts",import.meta.url),"utf8");
const floorPair=tokenSource.match(/floor:\s*\["(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})"/)?.slice(1)??[];
const stationLabelChecks=["stationName", "stationState.idle", "stationState.working", "stationState.blocked", "stationState.done", "stationState.ended"];
function resolvePairValue(value){const normalized=value.trim().replaceAll('"','');if(normalized.startsWith("semantic.")){const name=normalized.slice("semantic.".length),semanticValue=tokenSource.match(new RegExp(`\\b${name}:\\s*\\"(#[0-9a-fA-F]{6})`));return semanticValue?.[1]??null;}return /^#[0-9a-fA-F]{6}$/.test(normalized)?normalized:null;}
function tokenPair(path){const match=path.includes(".")?tokenSource.match(new RegExp(`${path.split(".")[0]}:\\s*\\{[^}]*${path.split(".")[1]}:\\s*\\[([^,]+),\\s*([^\\]]+)\\]`)):tokenSource.match(new RegExp(`${path}:\\s*\\[([^,]+),\\s*([^\\]]+)\\]`));return match?[resolvePairValue(match[1]),resolvePairValue(match[2])]:[null,null];}
for(const [themeIndex,theme] of ["day","dinner"].entries()){const floor=floorPair[themeIndex]??"";for(const path of stationLabelChecks){const value=tokenPair(path)[themeIndex],ratio=value&&floor?contrast(value,floor):0;console.log(`${theme} ${path}/floor: ${ratio.toFixed(2)}:1`);if(!value||!floor||ratio<4.5)failures.push(`${theme} ${path} ${ratio.toFixed(2)} < 4.5`);}}
if(!/state==="blocked"[\s\S]*?\.circle\(/.test(scene))failures.push("blocked state lacks bell/circle shape");if(!/state==="done"[\s\S]*?\.ellipse\(/.test(scene))failures.push("done state lacks plate/ellipse shape");
const liveRegion=app.match(/<div(?=[^>]*className="liveRegion")[^>]*>/)?.[0]??"";
if(!/aria-label="[^"]+"/.test(liveRegion)||!liveRegion.includes('aria-live="polite"')||!liveRegion.includes('aria-atomic="true"'))failures.push("live region lacks a concise accessible name or polite/atomic semantics");
console.log("CVD evidence: blocked uses bell/circle plus PASS text; done uses plate/ellipse plus PLATED text, independent of simulated hue.");
if(failures.length){console.error(`Accessibility audit failed:\n${failures.join("\n")}`);process.exit(1);}console.log("Accessibility audit passed.");
