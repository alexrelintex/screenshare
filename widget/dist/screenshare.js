"use strict";(()=>{var l=r=>r<0?0:r>1?1:r;function f(r,e,t){return t.width<=0||t.height<=0?{x:0,y:0}:{x:l((r-t.left)/t.width),y:l((e-t.top)/t.height)}}function g(r,e){return{x:e.left+l(r.x)*e.width,y:e.top+l(r.y)*e.height}}function m(r){if(typeof r!="object"||r===null)return!1;let e=r;return e.type==="cursor"&&typeof e.x=="number"&&typeof e.y=="number"&&Number.isFinite(e.x)&&Number.isFinite(e.y)}function h(r,e,t=()=>Date.now()){let s=-1/0,i=null,n=null,d=a=>{s=t(),r(...a)},o=(...a)=>{let u=t()-s;if(u>=e){d(a);return}n=a,i===null&&(i=setTimeout(()=>{if(i=null,n){let C=n;n=null,d(C)}},e-u))};return o.flush=()=>{if(i!==null&&(clearTimeout(i),i=null),n){let a=n;n=null,d(a)}},o.cancel=()=>{i!==null&&(clearTimeout(i),i=null),n=null},o}var x=new Set(["welcome","peer-joined","peer-left","offer","answer","ice","error"]);function v(r){let e;try{e=JSON.parse(r)}catch{return null}if(typeof e!="object"||e===null||Array.isArray(e))return null;let t=e.type;if(typeof t!="string"||!x.has(t))return null;let s=e;switch(t){case"welcome":if(typeof s.peerId!="string"||!Array.isArray(s.peers))return null;break;case"peer-joined":case"peer-left":if(typeof s.peerId!="string")return null;break;case"offer":case"answer":if(typeof s.sdp!="string")return null;break;case"ice":if(!("candidate"in s))return null;break;case"error":if(typeof s.code!="string")return null;break}return e}function b(r,e){if(!e)throw new Error("room is required");return`${r.replace(/\/+$/,"").replace(/^http(s?):/,"ws$1:")}/ws/${encodeURIComponent(e)}`}var w=[{urls:"stun:stun.l.google.com:19302"}],y="cursor",c=class{constructor(e){this.opts=e}ws=null;pc=null;channel=null;stream=null;peerPresent=!1;remoteDescriptionSet=!1;pendingCandidates=[];state="idle";closed=!1;get connectionState(){return this.state}setState(e,t){this.state!==e&&(this.state=e,this.opts.onState?.(e,t))}fail(e){let t=e instanceof Error?e:new Error(String(e));this.opts.onError?.(t),this.setState("failed",t.message)}async connect(){let e=b(this.opts.signaling,this.opts.room);await new Promise((t,s)=>{let i=!1,n=new WebSocket(e);this.ws=n,n.onopen=()=>this.setState("waiting-for-peer"),n.onerror=()=>{i||(i=!0,s(new Error(`signaling connection failed: ${e}`)))},n.onclose=()=>{this.closed||this.setState("disconnected","signaling closed")},n.onmessage=d=>{let o=v(d.data);o&&(o.type==="welcome"&&!i&&(i=!0,this.peerPresent=o.peers.length>0,t()),this.handle(o))}})}send(e){this.ws?.readyState===WebSocket.OPEN&&this.ws.send(JSON.stringify(e))}ensurePeerConnection(){if(this.pc)return this.pc;let e=new RTCPeerConnection({iceServers:this.opts.iceServers??w});return this.pc=e,e.onicecandidate=t=>{this.send({type:"ice",candidate:t.candidate?t.candidate.toJSON():null})},e.ontrack=t=>{let[s]=t.streams;s&&this.opts.onRemoteStream?.(s)},e.onconnectionstatechange=()=>{switch(e.connectionState){case"connected":this.setState("connected");break;case"failed":this.setState("failed","ice failed \u2014 a TURN server is likely required");break;case"disconnected":this.setState("disconnected");break}},this.opts.role==="host"?this.attachChannel(e.createDataChannel(y,{ordered:!1})):e.ondatachannel=t=>{t.channel.label===y&&this.attachChannel(t.channel)},e}attachChannel(e){this.channel=e,e.onmessage=t=>{let s;try{s=JSON.parse(t.data)}catch{return}m(s)&&this.opts.onRemoteCursor?.({x:s.x,y:s.y})}}async share(e){if(this.opts.role!=="host")throw new Error("only the host can share");this.stream=e;let t=this.ensurePeerConnection();for(let s of e.getTracks())t.addTrack(s,e);this.peerPresent&&await this.offer()}async offer(){let e=this.ensurePeerConnection();this.setState("negotiating");try{let t=await e.createOffer();await e.setLocalDescription(t),this.send({type:"offer",sdp:t.sdp??""})}catch(t){this.fail(t)}}async handle(e){try{switch(e.type){case"peer-joined":this.peerPresent=!0,this.opts.role==="host"&&this.stream&&await this.offer();break;case"peer-left":this.peerPresent=!1,this.remoteDescriptionSet=!1,this.pendingCandidates=[],this.setState("waiting-for-peer","peer left");break;case"offer":{if(this.opts.role!=="viewer")return;let t=this.ensurePeerConnection();this.setState("negotiating"),await t.setRemoteDescription({type:"offer",sdp:e.sdp}),this.remoteDescriptionSet=!0,await this.drainCandidates();let s=await t.createAnswer();await t.setLocalDescription(s),this.send({type:"answer",sdp:s.sdp??""});break}case"answer":{if(this.opts.role!=="host"||!this.pc)return;await this.pc.setRemoteDescription({type:"answer",sdp:e.sdp}),this.remoteDescriptionSet=!0,await this.drainCandidates();break}case"ice":{if(!e.candidate)return;if(!this.pc||!this.remoteDescriptionSet){this.pendingCandidates.push(e.candidate);return}await this.pc.addIceCandidate(e.candidate);break}case"error":this.fail(new Error(`signaling error: ${e.code}`));break}}catch(t){this.fail(t)}}async drainCandidates(){if(!this.pc)return;let e=this.pendingCandidates;this.pendingCandidates=[];for(let t of e)try{await this.pc.addIceCandidate(t)}catch{}}sendCursor(e){this.channel?.readyState==="open"&&this.channel.send(JSON.stringify({type:"cursor",x:e.x,y:e.y}))}close(){this.closed=!0,this.channel?.close(),this.stream?.getTracks().forEach(e=>e.stop()),this.pc?.close(),this.ws?.close(),this.channel=null,this.stream=null,this.pc=null,this.ws=null,this.setState("closed")}};var S=30,E=`
  :host {
    all: initial;
    display: block;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #e8e8ea;
    --ss-bg: #16161a;
    --ss-accent: #4f8cff;
  }
  .wrap {
    position: relative;
    background: var(--ss-bg);
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #2a2a31;
  }
  .stage { position: relative; aspect-ratio: 16 / 9; background: #0d0d10; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; background: #0d0d10; }
  .empty {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: #7a7a85; font-size: 14px; text-align: center; padding: 16px;
    /* This overlay covers the whole stage. Without pointer-events:none it eats
       every pointermove and the remote cursor silently never sends. */
    pointer-events: none;
  }
  /* Once cleared it should not occupy the stage at all. */
  .empty:empty { display: none; }
  .bar {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-top: 1px solid #2a2a31;
  }
  button {
    font: inherit; font-size: 14px; font-weight: 500;
    padding: 7px 14px; border-radius: 7px; border: 0;
    background: var(--ss-accent); color: #fff; cursor: pointer;
  }
  button:hover:not(:disabled) { filter: brightness(1.1); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.stop { background: #3a3a44; }
  .state { font-size: 13px; color: #9b9ba6; margin-left: auto; display: flex; gap: 7px; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b77; }
  .dot[data-s="connected"] { background: #35c07a; }
  .dot[data-s="negotiating"], .dot[data-s="waiting-for-peer"] { background: #e0a83a; }
  .dot[data-s="failed"] { background: #e0574a; }
  .pointer {
    position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px;
    border-radius: 50%; pointer-events: none; opacity: 0;
    background: rgba(79,140,255,.45); border: 2px solid var(--ss-accent);
    transition: opacity .2s;
  }
  .pointer.on { opacity: 1; }
`,p=class extends HTMLElement{static observedAttributes=["room","signaling","mode"];captureSource;session=null;root;video;pointer;shareBtn;stopBtn;stateText;stateDot;emptyMsg;sendCursor=h(e=>{},1e3/S);get room(){return this.getAttribute("room")??""}get signaling(){return this.getAttribute("signaling")??""}get mode(){return this.getAttribute("mode")==="viewer"?"viewer":"host"}restartQueued=!1;connectedCallback(){this.root||(this.root=this.attachShadow({mode:"open"})),this.build(),this.begin()}disconnectedCallback(){this.teardown()}attributeChangedCallback(e,t,s){t===s||!this.isConnected||this.restartQueued||(this.restartQueued=!0,queueMicrotask(()=>{this.restartQueued=!1,this.isConnected&&(this.teardown(),this.build(),this.begin())}))}teardown(){this.sendCursor.cancel(),this.session?.close(),this.session=null}build(){this.root.replaceChildren();let e=document.createElement("style");e.textContent=E;let t=document.createElement("div");t.className="wrap",t.innerHTML=`
      <div class="stage">
        <video part="video" autoplay playsinline muted></video>
        <div class="empty"></div>
        <div class="pointer"></div>
      </div>
      <div class="bar">
        <button class="share"></button>
        <button class="stop" disabled>Stop</button>
        <span class="state"><span class="dot"></span><span class="label">idle</span></span>
      </div>`,this.root.append(e,t),this.video=t.querySelector("video"),this.pointer=t.querySelector(".pointer"),this.shareBtn=t.querySelector("button.share"),this.stopBtn=t.querySelector("button.stop"),this.stateText=t.querySelector(".label"),this.stateDot=t.querySelector(".dot"),this.emptyMsg=t.querySelector(".empty");let s=this.mode==="host";this.shareBtn.textContent=s?"Share screen":"Waiting for host",this.shareBtn.disabled=!s,this.emptyMsg.textContent=s?"Click \u201CShare screen\u201D to start.":"Waiting for the host to share\u2026",this.shareBtn.addEventListener("click",()=>void this.startShare()),this.stopBtn.addEventListener("click",()=>this.stopShare()),this.mode==="viewer"&&(this.sendCursor=h(i=>this.session?.sendCursor(i),1e3/S),this.video.addEventListener("pointermove",i=>{this.sendCursor(f(i.clientX,i.clientY,this.videoRect()))}),this.video.addEventListener("pointerleave",()=>this.sendCursor.flush()))}videoRect(){let e=this.video.getBoundingClientRect();return{left:e.left,top:e.top,width:e.width,height:e.height}}setState(e,t){this.stateText.textContent=t?`${e} \u2014 ${t}`:e,this.stateDot.dataset.s=e,this.dispatchEvent(new CustomEvent("ss-state",{detail:{state:e,detail:t},bubbles:!0,composed:!0}))}async begin(){if(!this.room||!this.signaling){this.setState("idle","waiting for room / signaling attributes");return}this.session=new c({signaling:this.signaling,room:this.room,role:this.mode,onState:(e,t)=>this.setState(e,t),onRemoteStream:e=>{this.video.srcObject=e,this.emptyMsg.textContent="",this.video.play().catch(()=>{}),this.dispatchEvent(new CustomEvent("ss-stream",{detail:{stream:e},bubbles:!0,composed:!0}))},onRemoteCursor:e=>this.showPointer(e),onError:e=>{this.dispatchEvent(new CustomEvent("ss-error",{detail:{error:e},bubbles:!0,composed:!0}))}});try{await this.session.connect()}catch(e){this.setState("failed",e instanceof Error?e.message:String(e))}}showPointer(e){let t=this.video.getBoundingClientRect(),s=this.getBoundingClientRect(),i=g(e,{left:t.left-s.left,top:t.top-s.top,width:t.width,height:t.height});this.pointer.style.transform=`translate(${i.x}px, ${i.y}px)`,this.pointer.classList.add("on"),this.dispatchEvent(new CustomEvent("ss-cursor",{detail:e,bubbles:!0,composed:!0}))}async startShare(){if(this.session)try{let t=await(this.captureSource??(()=>navigator.mediaDevices.getDisplayMedia({video:!0,audio:!1})))();t.getVideoTracks()[0]?.addEventListener("ended",()=>this.stopShare()),this.video.srcObject=t,this.emptyMsg.textContent="",this.video.play().catch(()=>{}),await this.session.share(t),this.shareBtn.disabled=!0,this.stopBtn.disabled=!1,this.dispatchEvent(new CustomEvent("ss-sharing",{bubbles:!0,composed:!0}))}catch(e){let t=e.name;if(t==="NotAllowedError"||t==="AbortError")return;this.setState("failed",e instanceof Error?e.message:String(e))}}stopShare(){let e=this.video.srcObject;e instanceof MediaStream&&e.getTracks().forEach(t=>t.stop()),this.video.srcObject=null,this.emptyMsg.textContent="Sharing stopped.",this.pointer.classList.remove("on"),this.shareBtn.disabled=this.mode!=="host",this.stopBtn.disabled=!0,this.dispatchEvent(new CustomEvent("ss-stopped",{bubbles:!0,composed:!0}))}};var k="screen-share";function M(r=k){typeof customElements>"u"||customElements.get(r)||customElements.define(r,p)}M();})();
//# sourceMappingURL=screenshare.js.map
