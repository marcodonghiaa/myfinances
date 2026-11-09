document.querySelectorAll("[data-copy]").forEach(b=>b.addEventListener("click",()=>{
  const box=b.closest(".ctas"),hint=box&&box.nextElementSibling&&box.nextElementSibling.classList.contains("hint")?box.nextElementSibling:null;
  const say=h=>{if(hint)hint.innerHTML=h};
  navigator.clipboard.writeText(b.dataset.copy).then(()=>{
    b.classList.add("copied");setTimeout(()=>b.classList.remove("copied"),1500);
    say('Copied. Paste it in a terminal on your computer.');
  }).catch(()=>say("Copy failed. Select the command and copy it by hand."));
}))
