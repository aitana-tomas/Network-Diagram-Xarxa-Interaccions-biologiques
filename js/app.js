/**
 * INTERACCIONS — lògica de la visualització.
 *
 * Aquest fitxer llegeix les dades locals, aplica els filtres i construeix
 * la xarxa amb D3.js. El gràfic mostra la xarxa general; els detalls s’obren
 * només quan l’usuari selecciona un tàxon (principi "details on demand").
 */
(() => {
  // Funció auxiliar per accedir als elements de la interfície pel seu identificador.
  const $ = id => document.getElementById(id);
  const svg = d3.select("#network");
  // Traducció dels codis originals d’interacció per mostrar-los en català.
  const relationNames = {eats:"menja", parasiteOf:"paràsit de", preysOn:"depreda"};
  // Estat principal de la visualització: dades, simulació física i selecció actual.
  let rows = [], simulation = null, zoom = null, graphRoot, linksLayer, nodesLayer, labelsLayer;
  let activeNodes = [], activeEdges = [], chosen = null;
  // Format numèric localitzat en català.
  const fmt = n => new Intl.NumberFormat("ca-ES").format(n);

  // D3 transforma source/target en objectes node durant la simulació.
  // Aquesta funció retorna l’identificador abans i després d’aquesta transformació.
  const endId = x => typeof x === "object" ? x.id : x;
  const clean = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  // 1. PREPARACIÓ DE LA XARXA
  // Aplica els filtres, agrupa les files repetides i calcula els indicadors
  // de cada tàxon. La variable weight conserva quants registres originals
  // representa cada connexió agrupada.
  /**
   * Aplica els filtres, agrupa els registres repetits i calcula els indicadors
   * de cada tàxon. Després delega el dibuix a draw().
   */
  function render() {
    if (!rows.length) return;
    const type = $("relation").value, min = +$("minWeight").value;
    $("weightValue").value = min; $("weightValue").textContent = min;
    let filtered = rows.filter(r => type === "all" || r.interaction_type === type);
    // Només es fusionen les files amb el mateix origen, destinació i tipus
    // d’interacció. Cada coincidència incrementa el pes de la connexió.
    const grouped = new Map();
    for (const r of filtered) {
      const key = JSON.stringify([r.source_taxon_name,r.target_taxon_name,r.interaction_type]);
      if (!grouped.has(key)) grouped.set(key,{source:r.source_taxon_name,target:r.target_taxon_name,type:r.interaction_type,weight:0});
      grouped.get(key).weight++;
    }
    let edges = [...grouped.values()].filter(e=>e.weight>=min);
    // No es limita la xarxa als nodes més connectats: es conserven totes les
    // connexions agrupades que compleixen els filtres actius.
    // Es crea un node per cada tàxon present en una connexió que ha superat
    // els filtres. No s’aplica cap límit artificial al nombre de nodes.
    const map = new Map();
    for (const e of edges) {
      if(!map.has(e.source))map.set(e.source,{id:e.source,name:e.source,incoming:0,outgoing:0,records:0});
      if(!map.has(e.target))map.set(e.target,{id:e.target,name:e.target,incoming:0,outgoing:0,records:0});
      map.get(e.source).outgoing++;map.get(e.source).records+=e.weight;
      map.get(e.target).incoming++;map.get(e.target).records+=e.weight;
    }
    const nodes=[...map.values()].map(n=>({...n,degree:n.incoming+n.outgoing}));
    activeNodes=nodes;activeEdges=edges;
    // Resum dinàmic de la xarxa després d’aplicar els filtres.
    $("summary").textContent=`${fmt(nodes.length)} tàxons · ${fmt(edges.length)} connexions · ${fmt(edges.reduce((s,e)=>s+e.weight,0))} registres`;
    $("message").textContent=edges.length?"":"No hi ha connexions amb aquests filtres.";
    draw(nodes,edges);
    if(chosen && !map.has(chosen.id)) selectNode(null);
    else if(chosen) selectNode(map.get(chosen.id)||null);
  }
  // 2. DIBUIX I SIMULACIÓ FÍSICA
  // Crea les capes SVG, els nodes, les connexions, les etiquetes i els controls
  // de zoom/arrossegament. La simulació es reinicia quan canvien els filtres.
  /**
   * Dibuixa la xarxa amb D3: línies dirigides, nodes, etiquetes, zoom i arrossegament.
   * Els nodes són cercles de color; no es carreguen imatges ni recursos externs.
   */
  function draw(nodes,edges) {
    if(simulation)simulation.stop();
    svg.selectAll("*").remove();
    const rect=svg.node().getBoundingClientRect(), w=Math.max(300,rect.width), h=Math.max(300,rect.height);
    svg.attr("viewBox",`0 0 ${w} ${h}`);
    // Definicions SVG reutilitzables, inclosa la punta de fletxa de les arestes.
    const defs=svg.append("defs");
    // Punta d'aresta compacta; el punt d'ancoratge coincideix amb la punta.
    defs.append("marker").attr("id","arrow").attr("viewBox","0 -5 10 10")
      .attr("refX",9).attr("refY",0).attr("markerWidth",5).attr("markerHeight",5)
      .attr("orient","auto").attr("markerUnits","userSpaceOnUse")
      .append("path").attr("d","M0,-4L9,0L0,4Z").attr("fill","#a9b8b0");
    graphRoot=svg.append("g");
    linksLayer=graphRoot.append("g");
    // Capes separades per controlar l'ordre visual: connexions, nodes i etiquetes.
    nodesLayer=graphRoot.append("g");
    labelsLayer=graphRoot.append("g");
    // El zoom transforma la xarxa com un sol grup. Les etiquetes secundàries
    // apareixen progressivament per evitar saturar la vista general.
    zoom=d3.zoom().scaleExtent([.12,8]).on("zoom",e=>{
      graphRoot.attr("transform",e.transform);
      // Per evitar una massa de text en la vista general, les etiquetes
      // apareixen progressivament quan l'usuari fa zoom.
      if (labelsLayer) labelsLayer.selectAll("text").attr("opacity", d => e.transform.k >= 1.15 || d.degree >= 12 ? 1 : 0);
    });
    svg.call(zoom).on("dblclick.zoom",null);
    // La mida del node depèn del grau (entrants + sortints); el gruix de
    // cada connexió depèn del nombre de registres originals que representa.
    const maxD=d3.max(nodes,d=>d.degree)||1, maxW=d3.max(edges,d=>d.weight)||1;
    // En xarxes grans, els nodes són més petits per poder representar-los tots.
    const dense = nodes.length > 700;
    const radius=d3.scaleSqrt().domain([1,maxD]).range(dense?[2.5,10]:[6,17]);
    const link=linksLayer.selectAll("line").data(edges).join("line").attr("class","link").attr("stroke-width",e=>.6+Math.sqrt(e.weight/maxW)*1.6).attr("marker-end","url(#arrow)");
    const node=nodesLayer.selectAll("circle").data(nodes,d=>d.id).join("circle").attr("class","node").attr("r",d=>radius(d.degree))
      .attr("fill",d=>d.incoming&&d.outgoing?"#8ea6a0":d.outgoing?"#5d8274":"#c68e7b")
      .on("click",(event,d)=>{event.stopPropagation();selectNode(d);})
      .on("pointerenter",(event,d)=>{if(!chosen)highlight(d);})
      .on("pointerleave",()=>{if(!chosen)highlight(null);});
    const label=labelsLayer.selectAll("text").data(nodes.filter(d=>d.degree>=3),d=>d.id).join("text").attr("class","label")
      .attr("opacity",d=>d.degree>=12?1:0).text(d=>d.name.length>25?d.name.slice(0,23)+"…":d.name);
    // Permet moure nodes manualment; en acabar l’arrossegament, s’alliberen
    // les coordenades perquè la simulació pugui continuar ajustant la xarxa.
    node.call(d3.drag().on("start",(e,d)=>{if(!e.active)simulation.alphaTarget(.2).restart();d.fx=d.x;d.fy=d.y;})
      .on("drag",(e,d)=>{d.fx=e.x;d.fy=e.y;}).on("end",(e,d)=>{if(!e.active)simulation.alphaTarget(0);d.fx=null;d.fy=null;}));
    // Forces de D3: atracció de les connexions, repulsió, centrat i col·lisió.
    // Si la xarxa és gran, es compacta amb distàncies i forces més petites.
    simulation=d3.forceSimulation(nodes).force("link",d3.forceLink(edges).id(d=>d.id).distance(dense?18:55).strength(dense?.18:.3))
      .force("charge",d3.forceManyBody().strength(dense?-18:-95)).force("center",d3.forceCenter(w/2,h/2))
      .force("collide",d3.forceCollide().radius(d=>radius(d.degree)+(dense?1.2:3))).force("x",d3.forceX(w/2).strength(.02)).force("y",d3.forceY(h/2).strength(.02))
      .on("tick",()=>{
        // Retalla cada aresta als perímetres dels nodes: així la línia no entra
        // sota els cercles i la punta de la fletxa queda visible a la vora del destí.
        link
          .attr("x1",e=>{
            const dx=e.target.x-e.source.x, dy=e.target.y-e.source.y;
            const distance=Math.hypot(dx,dy)||1;
            return e.source.x+(dx/distance)*(radius(e.source.degree)+1);
          })
          .attr("y1",e=>{
            const dx=e.target.x-e.source.x, dy=e.target.y-e.source.y;
            const distance=Math.hypot(dx,dy)||1;
            return e.source.y+(dy/distance)*(radius(e.source.degree)+1);
          })
          .attr("x2",e=>{
            const dx=e.target.x-e.source.x, dy=e.target.y-e.source.y;
            const distance=Math.hypot(dx,dy)||1;
            return e.target.x-(dx/distance)*(radius(e.target.degree)+3);
          })
          .attr("y2",e=>{
            const dx=e.target.x-e.source.x, dy=e.target.y-e.source.y;
            const distance=Math.hypot(dx,dy)||1;
            return e.target.y-(dy/distance)*(radius(e.target.degree)+3);
          });
        node.attr("cx",d=>d.x).attr("cy",d=>d.y);
        label.attr("x",d=>d.x+radius(d.degree)+4).attr("y",d=>d.y+3);
      });
    svg.on("click",()=>selectNode(null));
    if(chosen)highlight(nodes.find(n=>n.id===chosen.id)||null);
  }
  // 3. RESSALTAT DE VEÏNS
  // Destaca el tàxon seleccionat i les seves connexions directes, i atenua la resta.
  /**
   * Ressalta el tàxon seleccionat i les seves connexions directes.
   * Quan no hi ha selecció, restaura la visibilitat de tota la xarxa.
   */
  function highlight(d) {
    if(!nodesLayer)return;
    if(!d){nodesLayer.selectAll("circle").classed("dim",false);linksLayer.selectAll("line").classed("dim",false);return;}
    const near=new Set([d.id]);
    activeEdges.forEach(e=>{const s=endId(e.source),t=endId(e.target);if(s===d.id)near.add(t);if(t===d.id)near.add(s);});
    nodesLayer.selectAll("circle").classed("dim",n=>!near.has(n.id));
    linksLayer.selectAll("line").classed("dim",e=>endId(e.source)!==d.id&&endId(e.target)!==d.id);
  }
  // 4. DETALLS DEL TÀXON ("DETAILS ON DEMAND")
  // El panell només s’obre quan l’usuari selecciona un node i no ocupa espai
  // permanentment. Així es pot explorar la xarxa sense perdre context.
  /**
   * Obre o tanca la finestra emergent de detalls sota demanda.
   * Les connexions es mostren ordenades per freqüència, amb un màxim de 12.
   */
  function selectNode(d) {
    chosen=d;
    const popup=$("nodePopup");
    if(!d){popup.hidden=true;highlight(null);return;}
    $("popupTitle").textContent=d.name;
    $("incoming").textContent=fmt(d.incoming);
    $("outgoing").textContent=fmt(d.outgoing);
    $("records").textContent=fmt(d.records);
    // Recupera les connexions adjacents, indica la direcció i les ordena per
    // freqüència. Es mostren fins a 12 elements per mantenir el panell llegible.
    const related=activeEdges.filter(e=>endId(e.source)===d.id||endId(e.target)===d.id)
      .map(e=>({
        name:endId(e.source)===d.id?endId(e.target):endId(e.source),
        direction:endId(e.source)===d.id?"Sortint":"Entrant",
        type:relationNames[e.type]||e.type||"interacció",
        weight:e.weight
      }))
      .sort((a,b)=>b.weight-a.weight||a.name.localeCompare(b.name,"ca"));
    const list=$("connectionList");
    list.replaceChildren();
    if(!related.length){
      const empty=document.createElement("p");empty.className="popup-empty";empty.textContent="No hi ha connexions amb els filtres actuals.";list.append(empty);
    } else {
      related.slice(0,12).forEach(r=>{
        const item=document.createElement("div");item.className="connection-item";
        const main=document.createElement("div");main.className="connection-main";
        const name=document.createElement("span");name.className="connection-name";name.textContent=r.name;
        const meta=document.createElement("span");meta.className="connection-meta";meta.textContent=`${r.direction} · ${r.type}`;
        const count=document.createElement("span");count.className="connection-count";count.textContent=fmt(r.weight);
        main.append(name,meta);item.append(main,count);list.append(item);
      });
      if(related.length>12){const more=document.createElement("p");more.className="popup-empty";more.textContent=`+ ${fmt(related.length-12)} connexions més`;list.append(more);}
    }
    popup.hidden=false;
    highlight(d);
  }
  $("closeNodePopup").addEventListener("click",()=>selectNode(null));
  document.addEventListener("keydown",e=>{if(e.key==="Escape")selectNode(null);});
  // 5. CONTROLS: ajuda contextual, filtres, reinici i adaptació a la finestra.
  const helpButton = $("helpButton"), helpPopup = $("helpPopup");
  function setHelp(open) { helpPopup.hidden = !open; helpButton.setAttribute("aria-expanded", String(open)); }
  helpButton.addEventListener("click", e => { e.stopPropagation(); setHelp(helpPopup.hidden); });
  $("closeHelp").addEventListener("click", () => setHelp(false));
  document.addEventListener("click", e => { if (!helpPopup.contains(e.target) && e.target !== helpButton) setHelp(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") setHelp(false); });
  $("relation").addEventListener("change",()=>{chosen=null;render();});
  $("minWeight").addEventListener("input",()=>{chosen=null;render();});
  $("reset").addEventListener("click",()=>{$("relation").value="all";$("minWeight").value=1;chosen=null;render();});
  window.addEventListener("resize",()=>{if(rows.length)render();});

  // 6. TEXTOS DELS QUATRE APARTATS INFORMATIUS.
  // Cada botó obre el text corresponent sense navegar a una pàgina nova.
  const infoContent = {
    visualization: `<h2>Visualització</h2><p>Els nodes representen tàxons i les fletxes, les interaccions biològiques registrades entre ells. El color diferencia els tipus d'interacció, el gruix de les connexions indica el nombre de registres agrupats i la mida dels nodes depèn del nombre de connexions entrants i sortints.</p><p>Utilitza el selector per canviar el tipus d'interacció i la barra per establir-ne la freqüència mínima. Arrossega els nodes, fes zoom i selecciona un node per consultar-ne els detalls.</p>`,
    limitations: `<h2>Limitacions</h2><p>Les dades no representen necessàriament totes les interaccions presents a la natura: depenen dels estudis disponibles i de la cobertura de GloBI. Els registres repetits poden correspondre a una mateixa combinació de tàxons i tipus d'interacció.</p><p>Els tàxons poden pertànyer a diferents nivells taxonòmics i els filtres aplicats condicionen l'estructura de la xarxa visible. La llicència aplicable pot variar segons el conjunt de dades d'origen.</p>`,
    source: `<h2>Procedència i citació</h2><p><strong>Font:</strong> <a href="https://www.globalbioticinteractions.org/" target="_blank" rel="noopener noreferrer">Global Biotic Interactions (GloBI)</a>, una base de dades oberta d'interaccions biològiques entre organismes.</p><p><strong>Citació:</strong> Poelen, J. H., Simons, J. D., &amp; Mungall, C. J. (2014). <em>Global Biotic Interactions: An open infrastructure to share and analyze species-interaction datasets</em>. <em>Ecological Informatics, 24</em>, 148–159. <a href="https://doi.org/10.1016/j.ecoinf.2014.08.005" target="_blank" rel="noopener noreferrer">https://doi.org/10.1016/j.ecoinf.2014.08.005</a>.</p><p><strong>Data de descàrrega:</strong> 24 d’octubre de 2026.</p><p><strong>Llicència:</strong> <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">Creative Commons Reconeixement 4.0 Internacional (CC BY 4.0)</a>. Com que GloBI integra dades de diverses fonts, cal consultar les metadades i les llicències dels conjunts originals; no s'ha confirmat una única llicència aplicable a tots els registres.</p><p><a href="https://www.globalbioticinteractions.org/data" target="_blank" rel="noopener noreferrer">Dades i descàrregues de GloBI</a> · <a href="https://www.globalbioticinteractions.org/about" target="_blank" rel="noopener noreferrer">Com citar GloBI</a> · <a href="https://github.com/globalbioticinteractions/globalbioticinteractions" target="_blank" rel="noopener noreferrer">Repositori i informació sobre la llicència</a>.</p>`,
    preparation: `<h2>Fitxer original i tractament de les dades</h2><p><strong>Fitxer original:</strong> <code>interaction.csv</code>.</p><p>S'han exclòs els registres sense tàxon d'origen, tàxon de destinació o tipus d'interacció. Després, els registres s'agrupen per tàxon d'origen, tàxon de destinació i tipus d'interacció. Cada connexió incorpora una variable <code>weight</code> que indica el nombre de registres originals que representa.</p><p><strong>Registres:</strong> el fitxer original conté 4.097 files; 4.096 tenen un tipus d'interacció identificat: <code>parasiteOf</code> (3.622), <code>eats</code> (463) i <code>preysOn</code> (11). La xarxa ja no limita els tàxons més connectats: representa totes les connexions agrupades que compleixen els filtres actius. Les xifres del resum canvien en modificar el tipus d'interacció o la freqüència mínima.</p><p>Per mantenir la llegibilitat quan hi ha molts tàxons, les etiquetes es mostren progressivament en fer zoom; selecciona qualsevol node per consultar-ne els detalls.</p>`
  };
  const infoPanel = $("infoPanel"), infoBody = $("infoContent");
  document.querySelectorAll(".info-button").forEach(button => button.addEventListener("click", () => {
    const opening = button.getAttribute("aria-expanded") !== "true";
    document.querySelectorAll(".info-button").forEach(other => other.setAttribute("aria-expanded", "false"));
    if (!opening) { infoPanel.hidden = true; return; }
    button.setAttribute("aria-expanded", "true");
    infoBody.innerHTML = infoContent[button.dataset.panel] || "";
    infoPanel.hidden = false;
    infoPanel.scrollIntoView({behavior:"smooth", block:"nearest"});
  }));
  $("closeInfoPanel").addEventListener("click", () => {
    infoPanel.hidden = true;
    document.querySelectorAll(".info-button").forEach(button => button.setAttribute("aria-expanded", "false"));
  });
  try {
    // El CSV s'inclou com a variable en un fitxer JavaScript local. Això permet
    // obrir index.html directament sense peticions de dades ni errors CORS.
    const data = d3.csvParse(window.INTERACTIONS_CSV || "");
    rows = data.filter(d => d.source_taxon_name && d.target_taxon_name && d.interaction_type);
    if (!rows.length) { $("message").textContent = "No hi ha dades vàlides."; return; }
    $("message").textContent = "";
    render();
  } catch (error) {
    console.error(error);
    $("message").textContent = "No s’han pogut llegir les dades.";
  }
})();