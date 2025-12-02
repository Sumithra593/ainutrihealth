// src/App.jsx
import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

export default function App(){
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [status, setStatus] = useState('Idle');
  const [results, setResults] = useState(null);
  const [history, setHistory] = useState(()=>{ try{return JSON.parse(localStorage.getItem('ia_history')||'[]')}catch{return []} });
  const fileRef = useRef();

  useEffect(()=>{ localStorage.setItem('ia_history', JSON.stringify(history)) },[history]);

  function onFile(f){
    if(!f) return;
    if(f.size>15*1024*1024){ alert('Max 15MB'); return }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setStatus('Ready');
  }

  // scoring function for an ingredient (returns 0-100)
  function scoreIngredient({ name = '', allergens = [], additives = [], nutrition = {} }){
    let score = 100;

    const lowered = String(name).toLowerCase();

    // Allergens: heavy penalty
    if (Array.isArray(allergens) && allergens.length){
      score -= Math.min(60, allergens.length * 20); // up to -60 for multiple allergens
    }

    // Additives: moderate penalty
    if (Array.isArray(additives) && additives.length){
      score -= Math.min(30, additives.length * 10);
    }

    // Known "unhealthy" keywords
    if (/sugar|fructose|glucose|corn syrup|high fructose|maltodextrin/i.test(name)) {
      score -= 15;
    }
    if (/fat|oil|butter|cream|hydrogenated|shortening/i.test(name)) {
      score -= 10;
    }
    if (/salt|sodium|sodium chloride/i.test(name)) {
      score -= 5;
    }

    // Penalize artificial color / E-numbers
    if (/e\d{2,3}|tartrazine|sunset yellow|azo dye|caramel color/i.test(name)) {
      score -= 10;
    }

    // Penalize extremely short / garbled OCR results
    if (String(name).trim().length < 3 || /[^a-zA-Z0-9\s\-\.,()\/%]/.test(name)) {
      score -= 10;
    }

    // If nutrition shows very high calories (backend may supply), penalize
    const cal = Number(nutrition?.calories || nutrition?.kcal || 0);
    if (!Number.isNaN(cal) && cal > 0) {
      if (cal > 400) score -= 20;
      else if (cal > 200) score -= 8;
    }

    // clamp to 0-100
    if (score < 0) score = 0;
    if (score > 100) score = 100;
    return Math.round(score);
  }

  // Heuristic to decide whether a line is likely an ingredient (and should be scored)
  function isLikelyIngredient(name, source = 'unknown'){
    if(!name || !String(name).trim()) return false;
    const s = String(name).trim();
    const lowered = s.toLowerCase();

    // Always accept if source explicitly structured from backend: 'structured' or 'token'
    if (source === 'structured' || source === 'token') return true;

    // Reject very short or obviously non-ingredient lines
    if (s.length < 3) return false;
    if (/^[\d\W_]+$/.test(s)) return false; // only numbers/symbols

    // Common non-ingredient patterns often present on packaging
    const nonIngredientPatterns = [
      'best before', 'best-before', 'use by', 'use-by', 'expiry', 'expiry date', 'manufactured', 'manufacturer',
      'distributed by', 'packed in', 'net wt', 'net weight', 'contains', 'store in', 'serve', 'storage', 'customer care',
      'consumer care', 'phone', 'tel', 'email', 'www.', 'http', 'ingredients panel', 'ingredient panel', 'nutrition facts',
      'nutrition information', 'brand', 'barcode', 'barcode no', 'barcode no.', 'made in', 'product of', 'barcode', 'mrp',
      'price', 'batch no', 'batch', 'batch no.', 'imported by', 'keep', 'refrigerate', 'best before end'
    ];
    for (const pat of nonIngredientPatterns) {
      if (lowered.includes(pat)) return false;
    }

    // Lines that look like nutrition rows (contain kcal/kj/% or g/ml with numeric values)
    if (/\b(kcal|kj|calories|per 100g|per 100 ml)\b/i.test(s)) return false;
    if (/\b\d+(\.\d+)?\s?(g|mg|kg|ml|l|%)\b/i.test(s) && /\d/.test(s)) {
      // could be a nutrition row — exclude
      return false;
    }

    // If a line is ALL CAPS and short, it may be a header, not ingredient
    if (s === s.toUpperCase() && s.split(/\s+/).length <= 4) return false;

    // If the suspected line contains many punctuation marks or slashes suggesting metadata, exclude
    if ((s.match(/[\/,;:]/g) || []).length > 3) return false;

    // Otherwise treat as probable ingredient
    return true;
  }

  async function send(){
    if(!file) return alert('Choose file');
    setStatus('Uploading');
    const fd = new FormData();
    fd.append('file', file);
    try{
      const res = await axios.post(`${BACKEND}/predict`, fd, { headers: {'Content-Type':'multipart/form-data'} });
      const data = res.data;
      // debug: show full server response (remove in production)
      console.log('predict response:', data);

      const processed = processBackendData(data);
      processed.raw = data; // keep raw for debugging if needed

      setResults(processed);
      setHistory(h=>[{ts:Date.now(), fileName:file.name, results:processed}, ...h].slice(0,50));
      setStatus('Done');
    }catch(e){
      console.error(e);
      setStatus('Error');
      alert('Backend error: '+(e.message||e));
    }
  }

  function processBackendData(data){
    const COMMON_ALLERGENS = [
      'peanut','tree nut','milk','egg','soy','wheat','fish','shellfish','sesame','mustard','celery','sulphites'
    ];

    // Compose ingredient list from structured or unstructured fields
    // We'll keep item objects with { name, source: 'structured'|'token'|'ocr', originalItem }
    let rawItems = [];

    if (Array.isArray(data.ingredients) && data.ingredients.length) {
      // structured ingredients (prefer these)
      rawItems = data.ingredients.map(i => {
        if (typeof i === 'string') return { name: i, source: 'structured', original: i };
        // if object, try to extract name property
        const name = i.name || i.text || i.label || (typeof i === 'string' ? i : '');
        return { name: name, source: 'structured', original: i };
      });
    } else if (Array.isArray(data.tokens) && data.tokens.length) {
      rawItems = data.tokens.map(t => ({ name: (typeof t === 'string' ? t : (t.name||t.text||'')), source: 'token', original: t }));
    } else if (typeof data.ingredients_text === 'string' && data.ingredients_text.trim()) {
      // split and mark as from 'ocr' (apply heuristics later)
      rawItems = data.ingredients_text.split(/\r?\n|,|;/).map(s => ({ name: s.trim(), source: 'ocr', original: s.trim() })).filter(x=>x.name);
    } else if (typeof data.ocr_text === 'string' && data.ocr_text.trim()) {
      // last resort: parse the ocr text into lines and mark source 'ocr'
      rawItems = data.ocr_text.split(/\r?\n/).map(s => ({ name: s.trim(), source: 'ocr', original: s.trim() })).filter(x=>x.name);
    }

    // Map rawItems into processed ingredient-like objects and compute health only for likely ingredients
    const ingredients = rawItems.map((i) => {
      const name = (i.name || '').trim();
      const lowered = name.toLowerCase();

      const allergensFound = COMMON_ALLERGENS.filter(a =>
        lowered.includes(a) ||
        (a === 'tree nut' && /almond|walnut|cashew|hazelnut|pecan|pistachio/.test(lowered))
      );

      const additives = [];
      if(/tartrazine|sunset yellow|e102|e110/i.test(name)) additives.push('azo dye');

      const nutri = (i.original && i.original.nutrition) ? i.original.nutrition : (i.original && i.original.nutri ? i.original.nutri : {});
      const rec = [];
      if(allergensFound.length) rec.push({type:'allergen', message:`Contains potential allergens: ${allergensFound.join(', ')}`});
      if(additives.length) rec.push({type:'additive', message:`Contains additives: ${additives.join(', ')}`});
      if((nutri.calories||0) > 400) rec.push({type:'nutrition', message:'High calorie content — consider portion control'});

      const confidence = (typeof i.original?.confidence === 'number') ? i.original.confidence : (typeof i.original?.conf === 'number' ? i.original.conf : null);

      // decide if we treat this as a true ingredient
      const likely = isLikelyIngredient(name, i.source);

      // compute ingredient health score ONLY if likely is true
      const ingredient_health_score = likely ? scoreIngredient({ name, allergens: allergensFound, additives, nutrition: nutri }) : null;

      return {
        name: name || '(unknown)',
        original: i.original,
        source: i.source,
        confidence: confidence,
        nutrition: nutri,
        allergens: allergensFound,
        additives,
        recommendations: rec,
        is_ingredient: likely,
        ingredient_health_score
      };
    });

    // Build overall flags and suggestions (unchanged behavior, but allergen list deduped below)
    const overall = [];
    const anyAll = ingredients.some(x=>x.allergens?.length);
    if(anyAll) overall.push({type:'critical', message:'Product likely contains allergens. Not safe for allergic consumers.'});
    const anyAdd = ingredients.some(x=>x.additives?.length);
    if(anyAdd) overall.push({type:'warning', message:'Contains food additives — check regulatory limits and advised intake.'});

    const altSuggestions = ingredients.filter(i=> (i.nutrition?.calories||0) > 200).slice(0,3).map(i=>({name:i.name, suggestion:'Choose fresh whole-food alternative (e.g., fruits, vegetables)'}));
    if(altSuggestions.length) overall.push({type:'suggestion', message:'Alternatives available', alternatives:altSuggestions});

    const health_score = (typeof data.health_score === 'number') ? data.health_score : (typeof data.health === 'number' ? data.health : null);
    const topAllergens = Array.isArray(data.allergens) ? data.allergens : (data.allergen ? [data.allergen] : []);

    const backendRecommendations = data.recommendations || data.recs || data.suggestions || [];

    return {
      ingredients,
      overall,
      health_score,
      allergens: topAllergens,
      backend_recommendations: Array.isArray(backendRecommendations) ? backendRecommendations : [backendRecommendations]
    };
  }

  // Helper to collect "display recommendations" from various places and dedupe them
  function gatherDisplayRecommendations(results){
    const byBackend = results.backend_recommendations || (results.raw && results.raw.recommendations) || [];
    const fromOverall = (results.overall || []).flatMap(o =>
      o.alternatives ? o.alternatives.map(a=>({type:'alternative', name:a.name, suggestion: a.suggestion || a.suggest || ''})) : []
    );
    const suggestionsFromIngredients = (results.ingredients || []).flatMap(i => (i.recommendations || []).map(r => ({type: r.type || 'note', message: r.message || r})));
    const merged = [...byBackend, ...fromOverall, ...suggestionsFromIngredients];

    // Remove duplicates (based on a key derived from message/name+suggestion/string value)
    const unique = [];
    const seen = new Set();
    for (const r of merged) {
      let key;
      if (typeof r === 'string') key = `str:${r}`;
      else if (r && r.message) key = `msg:${r.message}`;
      else if (r && r.name) key = `name:${r.name}::${r.suggestion || ''}`;
      else key = `obj:${JSON.stringify(r)}`;

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }
    return unique;
  }

  // Build a unique list of allergens to display (from results.allergens + per-ingredient allergens)
  function gatherUniqueAllergens(results){
    const set = new Set();
    if (Array.isArray(results.allergens)) {
      results.allergens.forEach(a => { if (a) set.add(String(a).trim()) });
    }
    (results.ingredients || []).forEach(ing => {
      (ing.allergens || []).forEach(a => { if (a) set.add(String(a).trim()) });
    });
    return Array.from(set);
  }

  // ---------- Sanitization & filtering helpers moved outside JSX ----------
  const cleanName = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.replace(/[\u2018\u2019\u201C\u201D“”"`]/g, '')
               .replace(/[\u2012\u2013\u2014]/g, '-')
               .replace(/[^\w\s\-\(\)\/,\.]/g, '')
               .replace(/\s{2,}/g, ' ')
               .trim();
    return s.replace(/[-_,\.\s\/]+$/g, '').trim();
  };

  const looksLikeIngredient = (name) => {
    if (!name) return false;
    const cleaned = name.replace(/[\d\W_]/g, '');
    if (cleaned.length <= 1) return false;
    if (!/[A-Za-z\u00C0-\u024F]/.test(name)) return false;
    return true;
  };

  function getVisibleIngredients(resultsObj, confThresh = 0.35) {
    if (!resultsObj) return [];
    const visible = (resultsObj.ingredients || [])
      .map(ing => ({ ...ing, name: cleanName(ing && ing.name) }))
      .filter(ing => {
        if (!ing || !ing.name) return false;
        if (ing.is_ingredient === false) return false;
        if (ing.is_ingredient !== true &&
            (ing.confidence == null || ing.confidence < confThresh)) {
          return false;
        }
        if (!looksLikeIngredient(ing.name)) return false;
        return true;
      });

    // dedupe by name (case-insensitive) while preserving order
    const deduped = [];
    const seen = new Set();
    for (const item of visible) {
      const key = (item.name || '').toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
    }
    return deduped;
  }

  // Compute visible ingredients for rendering
  const visibleIngredients = getVisibleIngredients(results);

  // Render
  return (
    <div className="min-h-screen p-6">
      <div className="max-w-6xl mx-auto">
        <header className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Ingredient OCR & Allergen Detector</h1>
          <div className="text-sm text-slate-500">Backend: <code>{BACKEND}</code></div>
        </header>
        <main className="grid lg:grid-cols-3 gap-6">
          <aside className="lg:col-span-1 bg-white p-4 rounded shadow">
            <h2 className="font-semibold">Upload</h2>
            <div className="mt-3">
              <img src={previewUrl} className="mx-auto max-h-40 object-contain" alt="preview" />
              <div className="flex gap-2 justify-center mt-2">
                <input type="file" ref={fileRef} className="hidden" onChange={e=>onFile(e.target.files[0])} accept="image/*" />
                <button onClick={()=>fileRef.current?.click()} className="px-4 py-2 bg-indigo-600 text-white rounded">Choose</button>
                <button onClick={send} className="px-4 py-2 bg-green-600 text-white rounded" disabled={!file}>Upload</button>
              </div>
              <div className="text-xs text-slate-500 mt-2">Max 15MB</div>
            </div>
            <div className="mt-3 text-xs text-slate-500">Status: {status}</div>
          </aside>

          <section className="lg:col-span-2 bg-white p-4 rounded shadow">
            <h2 className="font-semibold">Results</h2>

            {results ? (
              <div>
                <div className="mt-2">
                  <strong>Health score: </strong>
                  {results.health_score == null ? <span className="text-slate-500">N/A</span> : <span>{results.health_score}</span>}
                </div>

                <div className="mt-2">
                  <strong>Top-level Allergens: </strong>
                  {(() => {
                    const uniqueAll = gatherUniqueAllergens(results);
                    return (uniqueAll && uniqueAll.length) ? <span>{uniqueAll.join(', ')}</span> : <span className="text-slate-500">None detected</span>;
                  })()}
                </div>

                {/* Recommendations & Alternatives */}
                <div className="mt-4">
                  <h3 className="font-medium">Recommendation </h3>
                  <div className="mt-2 space-y-2">
                    {(() => {
                      const recs = gatherDisplayRecommendations(results);
                      if (!recs || !recs.length) return <div className="text-slate-500">No recommendations available.</div>;
                      return recs.map((r, idx) => {
                        if (typeof r === 'string') return <div key={idx} className="p-2 bg-slate-50 rounded">{r}</div>;
                        if (r.name) {
                          return <div key={idx} className="p-2 bg-slate-50 rounded"><strong>{r.name}</strong>{r.suggestion ? <div className="text-sm mt-1">{r.suggestion}</div> : null}</div>;
                        }
                        if (r.message) {
                          return <div key={idx} className="p-2 bg-slate-50 rounded">{r.message}</div>;
                        }
                        return <div key={idx} className="p-2 bg-slate-50 rounded">{JSON.stringify(r)}</div>;
                      });
                    })()}
                  </div>
                </div>

                {/* Ingredients list */}
                <div className="mt-4 grid gap-3">
                  {visibleIngredients.length === 0 ? (
                    <div className="text-slate-500">No detected ingredients.</div>
                  ) : (
                    visibleIngredients.map((ing, i) => (
                      <div key={i} className={"p-3 rounded " + (ing.is_ingredient ? "bg-slate-50" : "bg-white border")}>
                        <div className="flex justify-between">
                          <strong>{ing.name}</strong>
                          <div className="text-xs">{(ing.confidence != null) ? ((ing.confidence || 0) * 100).toFixed(1) + '%' : ''}</div>
                        </div>

                        <div className="mt-2 text-sm">
                          <strong>Health Score:&nbsp;</strong>
                          {(ing.is_ingredient === false || ing.ingredient_health_score == null) ? (
                            <span className="text-slate-500">N/A</span>
                          ) : (
                            <span className={
                              ing.ingredient_health_score > 70 ? "text-green-600"
                              : ing.ingredient_health_score > 40 ? "text-amber-600"
                              : "text-red-600"
                            }>
                              {ing.ingredient_health_score}/100
                            </span>
                          )}
                          { !ing.is_ingredient ? <span className="ml-2 text-xs text-slate-400"> (not treated as ingredient)</span> : null }
                        </div>

                        <div className="mt-2">Allergens: {(ing.allergens || []).join(', ') || 'None'}</div>
                        {ing.additives && ing.additives.length ? <div className="mt-1 text-sm">Additives: {ing.additives.join(', ')}</div> : null}
                      </div>
                    ))
                  )}
                </div>

                {/* Overall Recommendations */}
                <div className="mt-4">
                  <h3 className="font-medium">Overall Recommendations</h3>
                  <div className="mt-2 space-y-2">
                    {(results.overall||[]).map((o,oi)=>(
                      <div key={oi} className={"p-2 rounded " + (o.type==='critical'? 'bg-red-50 text-red-700' : o.type==='warning'? 'bg-amber-50 text-amber-700' : 'bg-slate-50')}>
                        {o.message}
                        {o.alternatives? (<div className="mt-1 text-sm">Alternatives: {o.alternatives.map(a=>a.name).join(', ')}</div>) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-slate-500">No results yet.</div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
