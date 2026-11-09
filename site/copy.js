document.querySelectorAll("[data-copy]").forEach(b=>{
  const lbl=b.querySelector(".lbl"),tip=b.querySelector(".tip"),cp=b.querySelector(".cp"),icon=cp?cp.innerHTML:"";
  const check='<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
  b.addEventListener("click",()=>{
    const show=(t,ok)=>{if(lbl)lbl.textContent=t;if(tip)tip.textContent=t;if(cp&&ok)cp.innerHTML=check;b.classList.add("copied");clearTimeout(b._t);
      b._t=setTimeout(()=>{if(lbl)lbl.textContent=b.dataset.copy;if(tip)tip.textContent="";if(cp)cp.innerHTML=icon;b.classList.remove("copied")},1600)};
    navigator.clipboard.writeText(b.dataset.copy).then(()=>show("Copied!",1)).catch(()=>show("Copy failed",0));
  });
});
