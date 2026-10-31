const sensitive=/^(?!(?:tokens|promptTokens|completionTokens|totalTokens|inputTokens|outputTokens)$).*(?:token|password|secret|authorization|api[-_]?key|cookie|credential)/i;
export function sanitizeDiagnostic(value, knownSecrets=[]) {
  const secrets=new Set(knownSecrets.filter(s=>typeof s==='string'&&s.length>=4));
  const collect=v=>{if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(sensitive.test(k)&&typeof x==='string'&&x)secrets.add(x);else collect(x);}};
  collect(value);
  const clean=v=>{
    if(typeof v==='string'){
      for(const secret of secrets) {
        if(secret.length>=4)v=v.split(secret).join('[已隐藏]');
        else v=v.replace(new RegExp(`\\b${secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'g'),'[已隐藏]');
      }
      return v.replace(/\bBearer\s+[^\s"',;]+/gi,'Bearer [已隐藏]').replace(/((?:token|password|secret|api[-_]?key)\s*[:=]\s*)[^\s"',;]+/gi,'$1[已隐藏]');
    }
    if(Array.isArray(v))return v.map(clean);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sensitive.test(k)?'[已隐藏]':clean(x)]));
    return v;
  };
  return clean(value);
}
