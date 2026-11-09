document.querySelectorAll("[data-copy]").forEach(b=>b.addEventListener("click",()=>{
  const tip=b.querySelector(".tip"),show=t=>{if(tip)tip.textContent=t;b.classList.add("copied");clearTimeout(b._t);b._t=setTimeout(()=>{b.classList.remove("copied");if(tip)tip.textContent=""},1800)};
  navigator.clipboard.writeText(b.dataset.copy).then(()=>show("Copied! Paste it in a terminal")).catch(()=>show("Copy failed, select it by hand"));
}))
