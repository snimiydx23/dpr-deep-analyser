const express  = require('express');
const path     = require('path');
const pdfParse = require('pdf-parse');
const app      = express();
const PORT     = process.env.PORT || 4000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROVIDERS = {
  // groq free tier: 12000 TPM hard limit. maxCtx=6000 chars keeps prompt+output well under limit.
  groq:      { keyEnv:'GROQ_API_KEY',      maxTok:1500, maxCtx:5000,  getUrl:()=>'https://api.groq.com/openai/v1/chat/completions',          getHdr:(k)=>({'Content-Type':'application/json','Authorization':`Bearer ${k}`}), build:({p,t})=>JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:t,temperature:0.15,messages:[{role:'user',content:p}]}),     parse:(d)=>{ if(d.error)throw new Error(d.error.message||JSON.stringify(d.error)); return d.choices?.[0]?.message?.content||''; } },
  gemini:    { keyEnv:'GEMINI_API_KEY',     maxTok:4000, maxCtx:18000, getUrl:(k)=>`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${k}`, getHdr:()=>({'Content-Type':'application/json'}), build:({p,t})=>JSON.stringify({contents:[{parts:[{text:p}]}],generationConfig:{maxOutputTokens:t,temperature:0.15}}), parse:(d)=>{ if(d.error)throw new Error(d.error.message||JSON.stringify(d.error)); return d.candidates?.[0]?.content?.parts?.[0]?.text||''; } },
  anthropic: { keyEnv:'ANTHROPIC_API_KEY',  maxTok:4000, maxCtx:18000, getUrl:()=>'https://api.anthropic.com/v1/messages',                   getHdr:(k)=>({'Content-Type':'application/json','x-api-key':k,'anthropic-version':'2023-06-01'}), build:({p,t})=>JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:t,messages:[{role:'user',content:p}]}), parse:(d)=>{ if(d.error)throw new Error(d.error.message||JSON.stringify(d.error)); return (d.content||[]).map(b=>b.text||'').join(''); } },
  openai:    { keyEnv:'OPENAI_API_KEY',     maxTok:4000, maxCtx:18000, getUrl:()=>'https://api.openai.com/v1/chat/completions',              getHdr:(k)=>({'Content-Type':'application/json','Authorization':`Bearer ${k}`}), build:({p,t})=>JSON.stringify({model:'gpt-4o-mini',max_tokens:t,temperature:0.15,messages:[{role:'user',content:p}]}),          parse:(d)=>{ if(d.error)throw new Error(d.error.message||JSON.stringify(d.error)); return d.choices?.[0]?.message?.content||''; } },
  mistral:   { keyEnv:'MISTRAL_API_KEY',    maxTok:4000, maxCtx:18000, getUrl:()=>'https://api.mistral.ai/v1/chat/completions',              getHdr:(k)=>({'Content-Type':'application/json','Authorization':`Bearer ${k}`}), build:({p,t})=>JSON.stringify({model:'mistral-small-latest',max_tokens:t,temperature:0.15,messages:[{role:'user',content:p}]}),      parse:(d)=>{ if(d.error)throw new Error(d.error.message||JSON.stringify(d.error)); return d.choices?.[0]?.message?.content||''; } },
};

console.log('\n=== DPR Analyser — Provider Status ===');
Object.entries(PROVIDERS).forEach(([n,c])=>{ const k=process.env[c.keyEnv]; console.log(`  ${n.padEnd(10)}: ${k?'OK ('+k.slice(0,12)+'...)':'not set'}`); });
console.log('=======================================\n');

async function callProvider(provider, prompt) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const key = process.env[cfg.keyEnv];
  if (!key?.trim()) throw new Error(`${provider} API key not configured.`);
  const url = cfg.getUrl(key);
  const r = await fetch(url, { method:'POST', headers:cfg.getHdr(key), body:cfg.build({p:prompt, t:cfg.maxTok}) });
  const d = await r.json();
  return cfg.parse(d);
}

async function extractPdfText(base64) {
  const buf = Buffer.from(base64,'base64');
  const d = await pdfParse(buf);
  let t = d.text||'';
  t = t.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/([A-Z]{2,})([A-Z][a-z])/g,'$1 $2')
        .replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  return { text: t, pages: d.numpages };
}

function detectUnit(text) {
  const cr = (text.match(/\b(crore|cr\.)/gi)||[]).length;
  const lk = (text.match(/\b(lakh|lac|lakhs)\b/gi)||[]).length;
  return lk > cr ? 'lakhs' : 'crores';
}

// SECTION-WISE PROMPTS
function buildSectionPrompt(section, pdfText, unit, maxCtx) {
  const unitNote = unit==='lakhs'
    ? 'AMOUNTS ARE IN LAKHS — convert to Crores by dividing by 100.'
    : 'Amounts are in Crores.';

  const text = pdfText.slice(0, maxCtx || 18000);

  const prompts = {
    overview: `Extract Project Overview from this DPR. ${unitNote}
Return ONLY valid JSON (no markdown):
{
  "companyName": "exact legal name",
  "constitution": "Private Limited Company / Public Limited Company / LLP / Partnership / Proprietorship",
  "incorporationDate": "DD-MMM-YYYY",
  "projectType": "new/expansion/diversification",
  "promoters": "comma-separated names",
  "registeredAddress": "full address",
  "factoryAddress": "full address",
  "activity": "main business activity",
  "rawMaterials": "key raw materials",
  "workingDays": "number",
  "workingHours": "number",
  "rateOfInterest": "9.00%",
  "dscr": "overall DSCR value",
  "irr": "IRR %",
  "bep": "BEP %",
  "implementationPeriod": "months or description",
  "cod": "Commercial Operation Date"
}
DPR: ${text}`,

    capacity: `Extract Capacity & Products from this DPR. Return ONLY valid JSON:
{
  "products": [{"name":"product name","capacity":"value with unit","unit":"MT/MW/KL etc"}],
  "totalInstalledCapacity": "summary",
  "firstYearCapacity": "% utilisation",
  "secondYearCapacity": "% utilisation",
  "thirdYearCapacity": "% utilisation"
}
DPR: ${text}`,

    cop: `Extract Cost of Project and Means of Finance. ${unitNote}
Return ONLY valid JSON with ALL numbers in CRORES (plain decimal, no commas):
{
  "costOfProject": {
    "land": "0.00",
    "buildingShed": "0.00",
    "plantMachinery": "0.00",
    "electricalInstallation": "0.00",
    "miscFixedAssets": "0.00",
    "deposits": "0.00",
    "contingencies": "0.00",
    "preOperativeExp": "0.00",
    "workingCapitalMargin": "0.00",
    "total": "0.00"
  },
  "meansOfFinance": {
    "promoterContribution": "0.00",
    "unsecuredLoan": "0.00",
    "bankTermLoan": "0.00",
    "workingCapitalFundBased": "0.00",
    "workingCapitalNonFund": "0.00",
    "total": "0.00"
  },
  "debtEquityRatio": "value",
  "promoterContributionPct": "value%"
}
DPR: ${text}`,

    financial: `Extract Financial Projections from this DPR. ${unitNote}
Return ONLY valid JSON with numbers in Crores:
{
  "years": ["2029-30","2030-31","2031-32"],
  "turnover": ["0.00","0.00","0.00"],
  "grossProfit": ["0.00","0.00","0.00"],
  "grossProfitPct": ["0%","0%","0%"],
  "profitBeforeTax": ["0.00","0.00","0.00"],
  "profitAfterTax": ["0.00","0.00","0.00"],
  "dscr": ["0.00","0.00","0.00"],
  "overallDscr": "0.00",
  "irr": "0.00%",
  "bep": "0.00%",
  "repaymentTenure": "months",
  "moratorium": "months",
  "repaymentStart": "date",
  "repaymentEnd": "date"
}
DPR: ${text}`,

    management: `Extract Management & Promoter Profile from this DPR. Return ONLY valid JSON:
{
  "directors": [{"name":"","designation":"","experience":"","background":""}],
  "keyStrengths": "bullet points of management strengths",
  "groupConcerns": "associate / sister concerns",
  "existingBanking": "existing banking arrangements if any"
}
DPR: ${text}`,

    market: `Extract Market & Product details from this DPR. Return ONLY valid JSON:
{
  "targetMarkets": "markets",
  "competitors": "major competitors if mentioned",
  "rawMaterialSources": "sources",
  "salesStrategy": "sales approach",
  "exportPotential": "yes/no and details",
  "marketOutlook": "brief market outlook from DPR"
}
DPR: ${text}`,

    security: `Extract Security & Collateral details from this DPR. Return ONLY valid JSON:
{
  "primarySecurity": "primary security details",
  "collateralSecurity": "collateral security details",
  "personalGuarantee": "guarantors",
  "collateralCoverageEstimate": "approx X%",
  "insuranceDetails": "insurance if mentioned"
}
DPR: ${text}`
  };

  return prompts[section] || prompts.overview;
}

app.get('/api/providers', (req,res)=>{
  const av = Object.entries(PROVIDERS).filter(([,c])=>{ const k=process.env[c.keyEnv]; return k&&k.trim(); }).map(([n])=>n);
  res.json({ providers: av });
});

app.get('/api/health', (req,res)=>{
  const st={};
  Object.entries(PROVIDERS).forEach(([n,c])=>{ st[n]=!!process.env[c.keyEnv]; });
  res.json({ ok:true, node:process.version, providers:st });
});

// Extract text from uploaded PDF
app.post('/api/extract-text', async (req,res)=>{
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return res.status(400).json({ error:'pdfBase64 required' });
  try {
    const { text, pages } = await extractPdfText(pdfBase64);
    const unit = detectUnit(text);
    res.json({ text: text.slice(0,20000), pages, unit, length: text.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Analyse one section
app.post('/api/analyse-section', async (req,res)=>{
  const { provider, section, pdfText, unit } = req.body;
  if (!provider||!section||!pdfText) return res.status(400).json({ error:'provider, section, pdfText required' });
  try {
    const cfg    = PROVIDERS[provider];
    if (!cfg) return res.status(400).json({ error:`Unknown provider: ${provider}` });
    const prompt = buildSectionPrompt(section, pdfText, unit||'lakhs', cfg.maxCtx);
    const raw    = await callProvider(provider, prompt);
    // Parse JSON from response
    const clean  = raw.replace(/```json|```/g,'').trim();
    const match  = clean.match(/\{[\s\S]*\}/);
    let data = {};
    if (match) try { data = JSON.parse(match[0]); } catch(e) {
      // Fix trailing commas
      try { data = JSON.parse(match[0].replace(/,\s*([}\]])/g,'$1')); } catch(e2) { data = { _raw: raw }; }
    }
    res.json({ ok:true, section, data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log(`DPR Analyser on port ${PORT}`));
