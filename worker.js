export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/search" && request.method === "POST") {
      return handleSearch(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "المسار غير موجود." }, 404);
    }
    return env.ASSETS.fetch(request);
  }
};

async function handleSearch(request, env) {
  if (!env.GEMINI_API_KEY) return json({ error: "لم يتم إعداد GEMINI_API_KEY في أسرار Cloudflare." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "طلب غير صالح." }, 400); }
  const products = Array.isArray(body.products) ? body.products.slice(0, 25) : [];
  if (!products.length) return json({ error: "أضف منتجاً واحداً على الأقل." }, 400);

  const clean = products.map(p => ({
    name: String(p.name || "").slice(0, 100),
    brand: String(p.brand || "").slice(0, 100),
    aliases: String(p.aliases || "").slice(0, 180),
    kind: ["wholesale","retail","both"].includes(p.kind) ? p.kind : "wholesale",
    target: Number.isFinite(Number(p.target)) && p.target !== null ? Number(p.target) : null
  })).filter(p => p.name);

  const prompt = `
أنت محلل بحث سوق جزائري. ابحث عبر Google Search عن أحدث معلومات منشورة على الإنترنت حول المنتجات التالية في الجزائر.
لكل منتج، ابحث بالاسم كما هو وبالتهجئات البديلة وبالعربية والفرنسية، مع صيغ مثل prix gros Algérie، grossiste، fournisseur، distributeur، prix carton.
العملة DZD/DA. المطلوب هو أسعار منشورة علناً مع مصدر يمكن فتحه.

قواعد صارمة:
- لا تخترع سعراً أو مورداً أو ولاية أو تاريخاً أو رابطاً.
- لا تعتبر سعر التجزئة سعراً للجملة. ميّز price_type: "جملة" أو "تجزئة" أو "غير واضح".
- إذا كان السعر غير ظاهر في المصدر، اجعل price_dzd = null.
- لا تعتبر عدم ظهور إعلان دليلاً على نفاد المنتج. استخدم status "لم يُعثر على سعر موثوق" عند عدم وجود دليل.
- إذا كان المصدر قديماً، اذكر تاريخ الإعلان كما هو أو "غير مذكور"، ولا تقدمه كسعر حالي مؤكد.
- لا تضع رابط الصفحة الرئيسية إذا كان رابط الإعلان/المنتج متاحاً.
- لا تعرض نتائج لا تتعلق بنفس المنتج أو نفس الحجم/العبوة. اذكر اختلاف العبوة في notes.
- لا تخلط بين سعر الوحدة وسعر الكرتون. وضح وحدة البيع.
- لا تستنتج الولاية من اسم الموقع؛ اذكرها فقط إذا صرّح بها المصدر.
- confidence تكون "مرتفع" فقط عندما يظهر السعر والمنتج بوضوح في المصدر؛ وإلا "متوسط" أو "منخفض".
- لا تكرر نفس الإعلان.

أعد JSON فقط بالشكل التالي:
{
 "results": [
  {
   "product": "اسم المنتج",
   "status": "تم العثور على عروض / لم يُعثر على سعر موثوق",
   "summary": "ملخص قصير بالعربية",
   "offers": [
    {
     "price_dzd": 0,
     "seller": "اسم المورد كما ورد",
     "wilaya": "الولاية أو غير مذكورة",
     "price_type": "جملة/تجزئة/غير واضح",
     "unit": "للحبة/للكرتون/غير واضح",
     "date": "تاريخ الإعلان أو غير مذكور",
     "confidence": "مرتفع/متوسط/منخفض",
     "url": "رابط المصدر الأصلي",
     "notes": "ملاحظة عن العبوة أو شروط السعر"
    }
   ]
  }
 ]
}

المنتجات:
${JSON.stringify(clean)}
`;

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    });
  } catch {
    return json({ error: "تعذر الاتصال بخدمة البحث حالياً." }, 502);
  }
  const raw = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const message = raw?.error?.message || "فشل طلب Gemini. تحقق من المفتاح والحصة المتاحة.";
    return json({ error: message }, upstream.status === 429 ? 429 : 502);
  }
  const candidate = raw?.candidates?.[0];
  const text = candidate?.content?.parts?.map(p => p.text || "").join("\n") || "";
  let parsed;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch {
    return json({ error: "وصلت نتيجة من الذكاء الاصطناعي لكن تعذر قراءتها كبيانات منظمة. حاول مرة أخرى." }, 502);
  }
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const citations = chunks.map(c => c.web).filter(w => w?.uri).map(w => ({ title: w.title || w.uri, url: w.uri }));
  return json({ ...parsed, citations, searchedAt: new Date().toISOString() });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
